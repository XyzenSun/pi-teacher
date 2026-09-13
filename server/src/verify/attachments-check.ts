/**
 * attachments-check：附件 API 的独立真实验证。
 *
 * 独立性是刻意的：本脚本自己装一个最小 Express（request-security → requireAuth →
 * createAttachmentsRouter）、自己开一个临时 SQLite 文件、自己建临时工作目录，
 * 不引 index.ts 的 buildApp、不共用数据库单例、不碰 ~/pi-teacher——所以它既不会
 * 被同时在改的 Schema/会话代码带崩，也不会影响任何正在运行的服务器。
 *
 * 真数据库、真文件系统、真 HTTP、真符号链接，全程无 mock：附件的语义就是「磁盘上
 * 到底有什么」，mock 掉文件系统等于什么都没验。
 *
 * 跑法：npx tsx src/verify/attachments-check.ts
 */
import express from "express";
import Database from "better-sqlite3";
import { createServer } from "node:http";
import { connect } from "node:net";
import { promises as fs, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { apiRequestSecurity } from "../security/request-security.ts";
import { initCookieSigning, requireAuth, buildSessionCookie } from "../auth/middleware.ts";
import { createLoginSession } from "../auth/session-store.ts";
import { createAttachmentsRouter } from "../routes/attachments.ts";
import { apiErrorHandler } from "../routes/http.ts";
import {
  describeNonImageAttachments,
  encodeAttachmentId,
  formatAttachmentSize,
  getAttachment,
  isImageAttachment,
  listAttachments,
  readAttachmentImage,
  readAttachmentImages,
  renameLegacyAttachmentDirs,
} from "../session/attachments.ts";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}`);
    if (detail !== undefined) console.error(`      ${JSON.stringify(detail)?.slice(0, 400)}`);
  }
}

// —— 真实图片素材（1x1 位图，magic 头真实有效）——
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const GIF_BYTES = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const HTML_BYTES = Buffer.from("<script>fetch('/api/auth/me')</script>", "utf8");
const SVG_BYTES = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>", "utf8");

/**
 * 只建 getPiSession 需要的两张表。刻意不调 db/schema.ts：附件功能与业务 Schema
 * 无关（附件没有数据库表），而 Schema 此刻正在被改——依赖它只会引入假失败。
 */
function createMinimalSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE space (
      id   INTEGER PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE pi_session (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      space_id         INTEGER NOT NULL REFERENCES space(id),
      name             TEXT,
      work_path        TEXT NOT NULL UNIQUE,
      path             TEXT NOT NULL UNIQUE,
      agents_md_id     INTEGER NOT NULL DEFAULT 0,
      teach_style_id   INTEGER,
      enable_make_card INTEGER NOT NULL DEFAULT 1,
      review_topic_id  INTEGER,
      created_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare("INSERT INTO space (id, type, name) VALUES (2, 'learn', '验证空间')").run();
}

function insertPiSession(db: Database.Database, workPath: string): number {
  mkdirSync(workPath, { recursive: true });
  const info = db
    .prepare("INSERT INTO pi_session (space_id, work_path, path) VALUES (2, ?, ?)")
    .run(workPath, path.join(workPath, "session.jsonl"));
  return Number(info.lastInsertRowid);
}

interface Fetched {
  status: number;
  headers: Headers;
  text: string;
  json: any;
  bytes: Buffer;
}

async function main(): Promise<void> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "attachments-check-"));
  const db = new Database(path.join(homeDir, "verify.db"));
  db.pragma("foreign_keys = ON");
  createMinimalSchema(db);

  // 三个会话：正常会话 / files 是符号链接的会话 / work_path 已被删的会话
  const workPath = path.join(homeDir, "learn", "2", "pi", "1");
  const sessionId = insertPiSession(db, workPath);
  const linkedWorkPath = path.join(homeDir, "learn", "2", "pi", "2");
  const linkedSessionId = insertPiSession(db, linkedWorkPath);
  const missingWorkPath = path.join(homeDir, "learn", "2", "pi", "3");
  const missingSessionId = insertPiSession(db, missingWorkPath);
  await fs.rm(missingWorkPath, { recursive: true, force: true });

  // 逃逸目标：符号链接指向工作目录之外
  const outsideDir = path.join(homeDir, "outside");
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(path.join(outsideDir, "secret.txt"), "TOP-SECRET", "utf8");
  symlinkSync(outsideDir, path.join(linkedWorkPath, "files"));

  initCookieSigning("attachments-check-key");
  const cookie = buildSessionCookie(createLoginSession("xyzen").token).split(";")[0];

  // 本脚本自己挂 apiRequestSecurity，因此显式钉住开关姿态：附件语义不该随
  // 部署环境的 PI_TEACHER_REQUEST_SECURITY 取值、或将来默认值变动而漂移。
  process.env.PI_TEACHER_REQUEST_SECURITY = "true";

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "10mb" }));
  app.use("/api", apiRequestSecurity);
  app.use("/api", requireAuth); // 认证先于附件路由：raw 解析器只在登录后才缓冲请求体
  app.use("/api/conversations/:id", createAttachmentsRouter({ db, homeDir, dataDir: homeDir }));
  app.use(apiErrorHandler);

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  /** 所有响应体都要检查「不含绝对路径」，所以统一在这里收集。 */
  const responseBodies: string[] = [];

  async function request(
    method: string,
    pathname: string,
    options: { headers?: Record<string, string>; body?: Buffer | string; anonymous?: boolean } = {},
  ): Promise<Fetched> {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: { ...(options.anonymous ? {} : { Cookie: cookie }), ...(options.headers ?? {}) },
      body: options.body as any,
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    const text = buffer.toString("utf8");
    responseBodies.push(text);
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      // 二进制下载响应不是 JSON
    }
    return { status: response.status, headers: response.headers, text, json, bytes: buffer };
  }

  /**
   * 原始 HTTP 请求：不经 WHATWG URL 解析。fetch() 会在发出前把 `%2E` 这类点段
   * 归一掉（`/attachments/%2E` → `/attachments/`），路径根本到不了服务端；要验
   * 服务端对畸形请求行的处理，只能自己拼请求行。
   */
  function rawRequest(method: string, requestTarget: string): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port }, () => {
        socket.write(
          `${method} ${requestTarget} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nCookie: ${cookie}\r\nConnection: close\r\n\r\n`,
        );
      });
      let raw = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        raw += chunk;
      });
      socket.on("error", reject);
      socket.on("end", () => {
        const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1] ?? 0);
        const text = raw.slice(raw.indexOf("\r\n\r\n") + 4);
        responseBodies.push(text);
        resolve({ status, text });
      });
    });
  }

  const upload = (
    conversationId: number | string,
    fileName: string,
    body: Buffer,
    extra: Record<string, string> = {},
  ) =>
    request("POST", `/api/conversations/${conversationId}/attachments`, {
      headers: {
        "Content-Type": "application/octet-stream",
        "X-File-Name": encodeURIComponent(fileName),
        ...extra,
      },
      body,
    });

  try {
    // ============ 1. 上传成功路径 ============
    console.log("\n[1] 上传：协议、落盘、返回契约");
    let r = await upload(sessionId, "讲义封面.png", PNG_BYTES, { "X-File-Type": "image/png" });
    check("上传 PNG 返回 201", r.status === 201, { status: r.status, body: r.text });
    const uploaded = r.json?.attachment;
    check(
      "返回契约 { id, relativePath, name, mimeType, size }",
      uploaded?.id === encodeAttachmentId("讲义封面.png") &&
        uploaded?.relativePath === "files/讲义封面.png" &&
        uploaded?.name === "讲义封面.png" &&
        uploaded?.mimeType === "image/png" &&
        uploaded?.size === PNG_BYTES.length,
      uploaded,
    );
    const onDisk = await fs.readFile(path.join(workPath, "files", "讲义封面.png"));
    check("字节原样落在 work_path/files/", onDisk.equals(PNG_BYTES));
    const mode = (await fs.stat(path.join(workPath, "files", "讲义封面.png"))).mode & 0o777;
    check("落盘权限 0600（附件只属于本机用户）", mode === 0o600, mode.toString(8));

    r = await upload(sessionId, "笔记.txt", Buffer.from("纯文本附件", "utf8"));
    check("上传文本附件成功", r.status === 201, r.text);
    check("文本附件 MIME 由扩展名推出", r.json?.attachment?.mimeType === "text/plain", r.json);

    r = await upload(sessionId, "讲义封面.png", PNG_BYTES);
    check("同名附件冲突 409（绝不覆盖）", r.status === 409, { status: r.status, body: r.text });
    const stillOriginal = await fs.readFile(path.join(workPath, "files", "讲义封面.png"));
    check("冲突后磁盘内容未被改写", stillOriginal.equals(PNG_BYTES));

    // 纯 ASCII 名字客户端可能不做 encodeURIComponent，要兼容
    r = await request("POST", `/api/conversations/${sessionId}/attachments`, {
      headers: { "Content-Type": "application/octet-stream", "X-File-Name": "plain-ascii.png" },
      body: PNG_BYTES,
    });
    check("未 encodeURIComponent 的 ASCII 名字也接受", r.status === 201 && r.json?.attachment?.name === "plain-ascii.png", r.json);

    // WEBP：四种可 inline 位图里剩下的一种，magic 走 RIFF....WEBP 分支
    const webpBytes = Buffer.concat([
      Buffer.from("RIFF"),
      Buffer.from([0x1a, 0x00, 0x00, 0x00]),
      Buffer.from("WEBPVP8L"),
      Buffer.alloc(18, 0x20),
    ]);
    r = await upload(sessionId, "示意图.webp", webpBytes);
    check("上传 WEBP 且 magic 识别", r.status === 201 && r.json?.attachment?.mimeType === "image/webp", r.json);

    r = await request("POST", `/api/conversations/${sessionId}/attachments`, {
      headers: { "X-File-Name": "no-content-type.png" },
      body: PNG_BYTES,
    });
    check("完全不带 Content-Type 被拒 415", r.status === 415, { status: r.status, body: r.text });

    // wx（O_CREAT|O_EXCL）的并发语义：同名并发上传只能有一个赢，另一个 409
    const raceResults = await Promise.all([
      upload(sessionId, "并发.png", PNG_BYTES),
      upload(sessionId, "并发.png", PNG_BYTES),
      upload(sessionId, "并发.png", PNG_BYTES),
    ]);
    check(
      "同名并发上传恰好一个 201、其余 409",
      raceResults.filter((x) => x.status === 201).length === 1 && raceResults.filter((x) => x.status === 409).length === 2,
      raceResults.map((x) => x.status),
    );

    // ============ 2. 上传拒绝路径 ============
    console.log("\n[2] 上传：非法文件名与协议错误");
    for (const badName of [
      "../evil.txt",
      "../../etc/passwd",
      "sub/child.txt",
      "windows\\path.txt",
      ".",
      "..",
      ".hidden",
      "/etc/passwd",
      "  ",
      "x".repeat(300),
    ]) {
      const bad = await upload(sessionId, badName, Buffer.from("x"));
      check(`非法文件名被拒 400：${JSON.stringify(badName).slice(0, 30)}`, bad.status === 400, {
        status: bad.status,
        body: bad.text,
      });
    }
    // 控制字符不能走 encodeURIComponent 之外的路径，单独构造
    r = await request("POST", `/api/conversations/${sessionId}/attachments`, {
      headers: { "Content-Type": "application/octet-stream", "X-File-Name": "bad%00name.txt" },
      body: Buffer.from("x"),
    });
    check("文件名含 NUL 被拒 400", r.status === 400, r.text);

    r = await request("POST", `/api/conversations/${sessionId}/attachments`, {
      headers: { "Content-Type": "application/octet-stream" },
      body: Buffer.from("x"),
    });
    check("缺 X-File-Name 被拒 400", r.status === 400, r.text);

    r = await request("POST", `/api/conversations/${sessionId}/attachments`, {
      headers: { "Content-Type": "application/json", "X-File-Name": "a.txt" },
      body: JSON.stringify({ a: 1 }),
    });
    check("非 octet-stream 被拒 415", r.status === 415, { status: r.status, body: r.text });

    r = await upload(sessionId, "空文件.txt", Buffer.alloc(0));
    check("空内容被拒 400", r.status === 400, r.text);

    r = await upload(sessionId, "type坏.png", PNG_BYTES, { "X-File-Type": "not-a-mime" });
    check("X-File-Type 格式非法被拒 400", r.status === 400, r.text);

    const oversize = Buffer.alloc(17 * 1024 * 1024, 0x41);
    r = await upload(sessionId, "超大.bin", oversize);
    check("超过 16mb 被拒 413", r.status === 413, { status: r.status, body: r.text.slice(0, 200) });
    check(
      "被拒的超大文件没有落盘",
      !(await fs
        .stat(path.join(workPath, "files", "超大.bin"))
        .then(() => true)
        .catch(() => false)),
    );

    // ============ 3. 认证顺序 ============
    console.log("\n[3] 认证先于 body 解析");
    r = await request("POST", `/api/conversations/${sessionId}/attachments`, {
      anonymous: true,
      headers: { "Content-Type": "application/octet-stream", "X-File-Name": "anon.png" },
      body: PNG_BYTES,
    });
    check("未登录上传 401", r.status === 401, r.text);
    check(
      "未登录时文件未落盘（raw 解析器根本没运行）",
      !(await fs
        .stat(path.join(workPath, "files", "anon.png"))
        .then(() => true)
        .catch(() => false)),
    );
    r = await request("GET", `/api/conversations/${sessionId}/attachments`, { anonymous: true });
    check("未登录列表 401", r.status === 401, r.text);
    r = await request("GET", `/api/conversations/${sessionId}/file-index`, { anonymous: true });
    check("未登录 file-index 401", r.status === 401, r.text);

    // ============ 4. 列表：从真实磁盘算 ============
    console.log("\n[4] 列表：磁盘即事实");
    // 模型自己写出的文件（没经过上传接口）也必须能被列出
    writeFileSync(path.join(workPath, "files", "模型画的图.gif"), GIF_BYTES);
    // 干扰项：符号链接、隐藏文件、非法名文件、子目录
    symlinkSync(path.join(outsideDir, "secret.txt"), path.join(workPath, "files", "偷看.txt"));
    writeFileSync(path.join(workPath, "files", ".hidden-note"), "hidden", "utf8");
    mkdirSync(path.join(workPath, "files", "子目录"), { recursive: true });

    r = await request("GET", `/api/conversations/${sessionId}/attachments`);
    check("列表 200", r.status === 200, r.text);
    const names: string[] = (r.json?.attachments ?? []).map((a: any) => a.name);
    check("列出上传的附件", names.includes("讲义封面.png") && names.includes("笔记.txt"), names);
    check("列出模型直接写出的文件（不依赖数据库登记）", names.includes("模型画的图.gif"), names);
    check("符号链接不出现在列表里", !names.includes("偷看.txt"), names);
    check("隐藏文件不出现在列表里", !names.includes(".hidden-note"), names);
    check("子目录不出现在列表里", !names.includes("子目录"), names);
    const gifMeta = (r.json?.attachments ?? []).find((a: any) => a.name === "模型画的图.gif");
    check(
      "列表元信息现算（GIF magic + 真实大小）",
      gifMeta?.mimeType === "image/gif" && gifMeta?.size === GIF_BYTES.length,
      gifMeta,
    );
    check(
      "列表每项都带 relativePath 且不含绝对路径",
      (r.json?.attachments ?? []).every((a: any) => a.relativePath === `files/${a.name}`),
      r.json,
    );

    // 目录不存在时是空数组而不是错误（「还没上传过」不是异常）
    const emptyWorkPath = path.join(homeDir, "learn", "2", "pi", "4");
    const emptySessionId = insertPiSession(db, emptyWorkPath);
    r = await request("GET", `/api/conversations/${emptySessionId}/attachments`);
    check("没有 files 目录时返回空数组", r.status === 200 && Array.isArray(r.json?.attachments) && r.json.attachments.length === 0, r.json);

    r = await request("GET", `/api/conversations/${missingSessionId}/attachments`);
    check("work_path 已不存在时 404", r.status === 404, { status: r.status, body: r.text });

    // ============ 5. 符号链接目录：不许跨出去 ============
    console.log("\n[5] files 目录是符号链接时一律 403");
    r = await request("GET", `/api/conversations/${linkedSessionId}/attachments`);
    check("列表 403", r.status === 403, { status: r.status, body: r.text });
    r = await upload(linkedSessionId, "写进去.png", PNG_BYTES);
    check("上传 403", r.status === 403, { status: r.status, body: r.text });
    check(
      "链接目标目录未被写入",
      !(await fs
        .stat(path.join(outsideDir, "写进去.png"))
        .then(() => true)
        .catch(() => false)),
    );
    r = await request("GET", `/api/conversations/${linkedSessionId}/attachments/secret.txt`);
    check("经链接目录下载 403", r.status === 403, { status: r.status, body: r.text });

    // ============ 6. 下载：Content-Type / Disposition / nosniff ============
    console.log("\n[6] 下载：MIME 判定与呈现策略");
    r = await request("GET", `/api/conversations/${sessionId}/attachments/${encodeURIComponent("讲义封面.png")}`);
    check("按文件名下载 200", r.status === 200, r.status);
    check("字节完整", r.bytes.equals(PNG_BYTES));
    check("Content-Type = image/png", r.headers.get("content-type") === "image/png", r.headers.get("content-type"));
    check("默认 Content-Disposition: attachment", (r.headers.get("content-disposition") ?? "").startsWith("attachment;"), r.headers.get("content-disposition"));
    check(
      "Content-Disposition 带 RFC5987 中文名且不含目录",
      (r.headers.get("content-disposition") ?? "").includes(`filename*=UTF-8''${encodeURIComponent("讲义封面.png")}`) &&
        !(r.headers.get("content-disposition") ?? "").includes("/"),
      r.headers.get("content-disposition"),
    );
    check("X-Content-Type-Options: nosniff", r.headers.get("x-content-type-options") === "nosniff");
    check("Cache-Control 不进共享缓存", (r.headers.get("cache-control") ?? "").includes("no-store"), r.headers.get("cache-control"));

    r = await request("GET", `/api/conversations/${sessionId}/attachments/${encodeAttachmentId("讲义封面.png")}`);
    check("按上传返回的 id 下载同一文件", r.status === 200 && r.bytes.equals(PNG_BYTES), r.status);

    r = await request(
      "GET",
      `/api/conversations/${sessionId}/attachments/${encodeURIComponent("讲义封面.png")}?inline=1`,
    );
    check("PNG ?inline=1 → inline 呈现", (r.headers.get("content-disposition") ?? "").startsWith("inline;"), r.headers.get("content-disposition"));
    check("inline 时仍带 nosniff", r.headers.get("x-content-type-options") === "nosniff");

    r = await request("GET", `/api/conversations/${sessionId}/attachments/${encodeURIComponent("模型画的图.gif")}?inline=1`);
    check("GIF ?inline=1 → inline 呈现", (r.headers.get("content-disposition") ?? "").startsWith("inline;"), r.headers.get("content-disposition"));

    r = await request("GET", `/api/conversations/${sessionId}/attachments/${encodeURIComponent("示意图.webp")}?inline=1`);
    check("WEBP ?inline=1 → inline 呈现", (r.headers.get("content-disposition") ?? "").startsWith("inline;"), r.headers.get("content-disposition"));

    await upload(sessionId, "手册.pdf", Buffer.concat([Buffer.from("%PDF-"), Buffer.from("1.7 body")]));
    r = await request("GET", `/api/conversations/${sessionId}/attachments/${encodeURIComponent("手册.pdf")}?inline=1`);
    check("PDF 即便请求 inline 也强制下载（只有位图能 inline）", (r.headers.get("content-disposition") ?? "").startsWith("attachment;"), r.headers.get("content-disposition"));
    check("PDF 的 MIME 由 magic 识别", r.headers.get("content-type") === "application/pdf", r.headers.get("content-type"));

    await upload(sessionId, "陷阱.html", HTML_BYTES);
    r = await request("GET", `/api/conversations/${sessionId}/attachments/${encodeURIComponent("陷阱.html")}?inline=1`);
    check("HTML 即便请求 inline 也强制下载", (r.headers.get("content-disposition") ?? "").startsWith("attachment;"), r.headers.get("content-disposition"));
    check("HTML 的 Content-Type 带 charset", (r.headers.get("content-type") ?? "").startsWith("text/html; charset=utf-8"), r.headers.get("content-type"));

    await upload(sessionId, "图标.svg", SVG_BYTES);
    r = await request("GET", `/api/conversations/${sessionId}/attachments/${encodeURIComponent("图标.svg")}?inline=1`);
    check("SVG 即便请求 inline 也强制下载", (r.headers.get("content-disposition") ?? "").startsWith("attachment;"), r.headers.get("content-disposition"));

    await upload(sessionId, "伪装.png", HTML_BYTES);
    r = await request("GET", `/api/conversations/${sessionId}/attachments/${encodeURIComponent("伪装.png")}?inline=1`);
    check(
      "扩展名伪装成 png 的 HTML 降级为 octet-stream",
      r.headers.get("content-type") === "application/octet-stream",
      r.headers.get("content-type"),
    );
    check("伪装文件不许 inline", (r.headers.get("content-disposition") ?? "").startsWith("attachment;"), r.headers.get("content-disposition"));

    // ============ 7. 下载：寻址攻击面 ============
    console.log("\n[7] 下载：路径穿越与符号链接");
    for (const badTarget of ["%2Fetc%2Fpasswd", "%2E%2E%2F%2E%2E%2Fetc%2Fpasswd", "..%5C..%5Cwindows"]) {
      const bad = await request("GET", `/api/conversations/${sessionId}/attachments/${badTarget}`);
      check(`非法寻址被拒 400：${badTarget}`, bad.status === 400, { status: bad.status, body: bad.text });
      check(`拒绝响应里不含任何绝对路径：${badTarget}`, !bad.text.includes(homeDir), bad.text);
    }
    // 这些请求行经 fetch 会被 URL 解析归一（%2E → 点段折叠），必须裸 socket 发
    for (const badTarget of ["%2E", "%2E%2E", "..", "."]) {
      const bad = await rawRequest("GET", `/api/conversations/${sessionId}/attachments/${badTarget}`);
      check(`畸形请求行不落到附件（400/404）：${badTarget}`, bad.status === 400 || bad.status === 404, {
        status: bad.status,
        body: bad.text.slice(0, 160),
      });
      check(`畸形请求行的响应不含绝对路径：${badTarget}`, !bad.text.includes(homeDir), bad.text.slice(0, 160));
    }
    r = await request("GET", `/api/conversations/${sessionId}/attachments/${encodeURIComponent("偷看.txt")}`);
    check("attachments 内的符号链接不可下载（404/403）", r.status === 404 || r.status === 403, { status: r.status, body: r.text });
    check("符号链接目标内容没有泄漏", !r.text.includes("TOP-SECRET"), r.text.slice(0, 80));

    r = await request("GET", `/api/conversations/${sessionId}/attachments/${encodeURIComponent("不存在.png")}`);
    check("不存在的附件 404", r.status === 404, r.status);
    r = await request("GET", `/api/conversations/${sessionId}/attachments/${encodeURIComponent(".hidden-note")}`);
    check("隐藏文件不可下载", r.status === 400 || r.status === 404, { status: r.status, body: r.text });
    r = await request("GET", `/api/conversations/abc/attachments`);
    check("非数字对话 id 400", r.status === 400, r.text);
    r = await request("GET", `/api/conversations/999999/attachments`);
    check("不存在的对话 404", r.status === 404, r.text);

    // ============ 8. file-index ============
    console.log("\n[8] file-index：只搜本对话工作目录");
    writeFileSync(path.join(workPath, "MISSION.md"), "# 使命", "utf8");
    writeFileSync(path.join(workPath, "session.jsonl"), '{"type":"session"}\n', "utf8");
    writeFileSync(path.join(workPath, ".env"), "SECRET=1", "utf8");
    writeFileSync(path.join(workPath, "prod.env"), "SECRET=2", "utf8");
    mkdirSync(path.join(workPath, "essence"), { recursive: true });
    writeFileSync(path.join(workPath, "essence", "第一课.md"), "内容", "utf8");
    mkdirSync(path.join(workPath, ".git"), { recursive: true });
    writeFileSync(path.join(workPath, ".git", "config"), "[core]", "utf8");
    mkdirSync(path.join(workPath, "node_modules", "pkg"), { recursive: true });
    writeFileSync(path.join(workPath, "node_modules", "pkg", "index.js"), "module.exports={}", "utf8");
    symlinkSync(outsideDir, path.join(workPath, "外链目录"));
    symlinkSync(path.join(outsideDir, "secret.txt"), path.join(workPath, "外链文件.txt"));

    r = await request("GET", `/api/conversations/${sessionId}/file-index`);
    check("file-index 200", r.status === 200, r.text);
    const files: string[] = r.json?.files ?? [];
    check("q 为空时列出全部真实文件", files.includes("MISSION.md") && files.includes("essence/第一课.md"), files);
    check("包含会话文件目录下的文件（相对路径带目录）", files.includes("files/讲义封面.png"), files);
    check("跳过 JSONL 会话历史", !files.some((f) => f.endsWith(".jsonl")), files);
    check("跳过 .env 与 prod.env", !files.includes(".env") && !files.includes("prod.env"), files);
    check("跳过隐藏目录 .git", !files.some((f) => f.startsWith(".git")), files);
    check("跳过 node_modules", !files.some((f) => f.startsWith("node_modules")), files);
    check("跳过符号链接（目录与文件）", !files.includes("外链文件.txt") && !files.some((f) => f.startsWith("外链目录")), files);
    check("绝不返回工作目录外的文件", !files.some((f) => f.includes("secret.txt")), files);
    check("路径全是相对路径", files.every((f) => !f.startsWith("/")), files);

    r = await request("GET", `/api/conversations/${sessionId}/file-index?q=${encodeURIComponent("第一课")}`);
    check("q 过滤命中", (r.json?.files ?? []).includes("essence/第一课.md"), r.json);
    check("q 过滤排除不相关文件", !(r.json?.files ?? []).includes("MISSION.md"), r.json);
    r = await request("GET", `/api/conversations/${sessionId}/file-index?q=zzz-不可能存在`);
    check("q 无命中返回空数组 + truncated=false", (r.json?.files ?? []).length === 0 && r.json?.truncated === false, r.json);

    // 无权指定搜索根：cwd 参数被忽略，结果仍限于本会话工作目录
    r = await request("GET", `/api/conversations/${sessionId}/file-index?cwd=%2Fetc&q=passwd`);
    check("cwd 参数无效（不能当全盘浏览器）", (r.json?.files ?? []).length === 0, r.json);

    // 上限与 truncated
    const manyDir = path.join(workPath, "many");
    mkdirSync(manyDir, { recursive: true });
    for (let index = 0; index < 260; index += 1) {
      writeFileSync(path.join(manyDir, `file-${String(index).padStart(3, "0")}.txt`), "x", "utf8");
    }
    r = await request("GET", `/api/conversations/${sessionId}/file-index?q=file-`);
    check("超过 200 条时截断到 200", (r.json?.files ?? []).length === 200, (r.json?.files ?? []).length);
    check("截断时 truncated=true", r.json?.truncated === true, r.json?.truncated);

    // ============ 9. prompt 命令用的只读辅助 ============
    console.log("\n[9] getAttachment / readAttachmentImage（供 prompt 命令复用）");
    const metaById = getAttachment(db, sessionId, encodeAttachmentId("讲义封面.png"));
    const metaByName = getAttachment(db, sessionId, "讲义封面.png");
    check("getAttachment 支持 id 与 name 两种寻址且结果一致", metaById.name === metaByName.name && metaById.id === metaByName.id, {
      metaById,
      metaByName,
    });
    check("getAttachment 只出相对路径", metaByName.relativePath === "files/讲义封面.png", metaByName);

    const image = readAttachmentImage(db, sessionId, encodeAttachmentId("讲义封面.png"));
    check("readAttachmentImage 返回 { data, mimeType }", image.mimeType === "image/png" && typeof image.data === "string", {
      mimeType: image.mimeType,
      dataLength: image.data.length,
    });
    check(
      "data 是磁盘真实字节的 base64（用户不需要自己发 base64）",
      Buffer.from(image.data, "base64").equals(PNG_BYTES),
    );
    const images = readAttachmentImages(db, sessionId, [encodeAttachmentId("讲义封面.png"), "模型画的图.gif"]);
    check("批量读取保持入参顺序", images.length === 2 && images[0].mimeType === "image/png" && images[1].mimeType === "image/gif", images.map((i) => i.mimeType));

    const rejects = (fn: () => unknown): { status?: number; message?: string } => {
      try {
        fn();
        return {};
      } catch (error) {
        const httpError = error as { status?: number; message?: string };
        return { status: httpError.status, message: httpError.message };
      }
    };
    check("非图片附件不能当图片喂给模型（400）", rejects(() => readAttachmentImage(db, sessionId, "笔记.txt")).status === 400, rejects(() => readAttachmentImage(db, sessionId, "笔记.txt")));
    check("伪装成 png 的 HTML 不能当图片（400）", rejects(() => readAttachmentImage(db, sessionId, "伪装.png")).status === 400);
    check("SVG 不能当图片（400）", rejects(() => readAttachmentImage(db, sessionId, "图标.svg")).status === 400);
    check("符号链接不能当图片（404/403）", [403, 404].includes(rejects(() => readAttachmentImage(db, sessionId, "偷看.txt")).status ?? 0));
    check("穿越路径不能当图片（400）", rejects(() => readAttachmentImage(db, sessionId, "../../etc/passwd")).status === 400);
    check("不存在的附件 404", rejects(() => getAttachment(db, sessionId, "无此文件.png")).status === 404);
    check(
      "辅助函数的错误消息不含绝对路径",
      !JSON.stringify(rejects(() => readAttachmentImage(db, sessionId, "../../etc/passwd"))).includes(homeDir),
    );
    // 直接调用与 HTTP 必须给出同一份列表（现取一次 HTTP，不用第 4 节的旧快照——
    // 那之后又上传了 html/svg/伪装.png）
    const httpListNow = await request("GET", `/api/conversations/${sessionId}/attachments`);
    const httpNames: string[] = (httpListNow.json?.attachments ?? []).map((a: any) => a.name);
    const directNames = listAttachments(db, sessionId).map((meta) => meta.name);
    check("listAttachments 直接调用与 HTTP 结果一致", JSON.stringify(directNames) === JSON.stringify(httpNames), {
      direct: directNames,
      http: httpNames,
    });

    // ============ 9b. 注入文案与一次性迁移（ADR-0038） ============
    console.log("\n[9b] 非图片注入文案与 attachments/ → files/ 迁移");
    check("图片判定只认四种位图", isImageAttachment(metaByName) && !isImageAttachment(getAttachment(db, sessionId, "笔记.txt")));
    check("大小格式化：B / KB / MB", formatAttachmentSize(512) === "512 B" && formatAttachmentSize(12 * 1024) === "12 KB"
      && formatAttachmentSize(Math.round(1.5 * 1024 * 1024)) === "1.5 MB" && formatAttachmentSize(2 * 1024 * 1024) === "2 MB");
    const noteMeta = getAttachment(db, sessionId, "笔记.txt");
    const injected = describeNonImageAttachments([metaByName, noteMeta]);
    check("注入文案只列非图片、含文件名 / 相对路径 / 大小", injected === `用户上传了文件「笔记.txt」，路径 files/笔记.txt（${formatAttachmentSize(noteMeta.size)}）。`, injected);
    check("只有图片时注入文案为空", describeNonImageAttachments([metaByName]) === "");
    // 迁移：旧目录改名、并存不动、无旧目录跳过；用 lstat 判断，符号链接的 attachments 不当目录
    const legacyWorkPath = path.join(homeDir, "learn", "2", "pi", "5");
    const legacySessionId = insertPiSession(db, legacyWorkPath);
    mkdirSync(path.join(legacyWorkPath, "attachments"));
    writeFileSync(path.join(legacyWorkPath, "attachments", "旧文件.txt"), "legacy", "utf8");
    const bothWorkPath = path.join(homeDir, "learn", "2", "pi", "6");
    insertPiSession(db, bothWorkPath);
    mkdirSync(path.join(bothWorkPath, "attachments"));
    mkdirSync(path.join(bothWorkPath, "files"));
    const linkedLegacyWorkPath = path.join(homeDir, "learn", "2", "pi", "7");
    insertPiSession(db, linkedLegacyWorkPath);
    symlinkSync(outsideDir, path.join(linkedLegacyWorkPath, "attachments"));
    const migration = renameLegacyAttachmentDirs(db);
    check("迁移只改名一个、并存的记为 skipped", migration.renamed === 1 && migration.skipped === 1, migration);
    check("旧目录已改名且文件随之移动", !(await fs.lstat(path.join(legacyWorkPath, "attachments")).then(() => true).catch(() => false))
      && (await fs.readFile(path.join(legacyWorkPath, "files", "旧文件.txt"), "utf8")) === "legacy");
    check("并存的两个目录都保持原样", (await fs.lstat(path.join(bothWorkPath, "attachments"))).isDirectory() && (await fs.lstat(path.join(bothWorkPath, "files"))).isDirectory());
    check("符号链接的 attachments 不被当目录迁移", (await fs.lstat(path.join(linkedLegacyWorkPath, "attachments"))).isSymbolicLink()
      && !(await fs.lstat(path.join(linkedLegacyWorkPath, "files")).then(() => true).catch(() => false)));
    r = await request("GET", `/api/conversations/${legacySessionId}/attachments`);
    check("迁移后的文件经列表可见且路径是 files/", r.status === 200 && r.json.attachments.some((a: any) => a.name === "旧文件.txt" && a.relativePath === "files/旧文件.txt"), r.json);
    check("再跑一次迁移是幂等的", JSON.stringify(renameLegacyAttachmentDirs(db)) === JSON.stringify({ renamed: 0, skipped: 1 }));

    // ============ 10. 全局不变量：绝对路径永不出接口 ============
    console.log("\n[10] 全局不变量");
    const leaking = responseBodies.filter((body) => body.includes(homeDir) || body.includes("/tmp/"));
    check(`所有 ${responseBodies.length} 个响应体都不含绝对路径`, leaking.length === 0, leaking.slice(0, 2));

    // ============ 11. request-security 总开关（默认关） ============
    // 默认关闭是本仓库的刻意选择：关闭时两道校验都放行，打开时恢复 403。
    // 注意必须用原始 socket：fetch/undici 会把调用方给的 Host 头丢掉，
    // 用 fetch 根本打不到 Host 校验那一段，会得到一个「以为验了其实没验」的结论。
    console.log("\n[11] request-security 开关");
    {
      const probeApp = express();
      probeApp.use("/api", apiRequestSecurity);
      probeApp.use("/api", (_req, res) => { res.json({ ok: true }); });
      const probeServer = createServer(probeApp);
      await new Promise<void>((resolve) => probeServer.listen(0, "127.0.0.1", resolve));
      const probePort = (probeServer.address() as { port: number }).port;

      const raw = (head: string): Promise<{ status: number; text: string }> => new Promise((resolve, reject) => {
        const socket = connect({ host: "127.0.0.1", port: probePort }, () => {
          socket.write(`${head}Connection: close\r\n\r\n`);
        });
        let data = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => { data += chunk; });
        socket.on("error", reject);
        socket.on("end", () => resolve({
          status: Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0),
          text: data.slice(data.indexOf("\r\n\r\n") + 4),
        }));
      });

      // 三段请求：外部域名 Host、同源 Host + 跨站 Origin、同源 Host + 同源 Origin
      const foreignHost = `GET /api/anything HTTP/1.1\r\nHost: evil.example.com\r\nOrigin: http://attacker.example.com\r\n`;
      const crossOrigin = `GET /api/anything HTTP/1.1\r\nHost: 127.0.0.1:${probePort}\r\nOrigin: http://attacker.example.com\r\nSec-Fetch-Site: cross-site\r\n`;
      const sameOrigin = `GET /api/anything HTTP/1.1\r\nHost: 127.0.0.1:${probePort}\r\nOrigin: http://127.0.0.1:${probePort}\r\nSec-Fetch-Site: same-origin\r\n`;
      const errorOf = (text: string): string => { try { return JSON.parse(text).error; } catch { return ""; } };

      try {
        delete process.env.PI_TEACHER_REQUEST_SECURITY;
        check("未设置（默认）：不做 Host 校验，外部域名 Host 放行", (await raw(foreignHost)).status === 200);
        check("未设置（默认）：不做同源校验，跨站 Origin 放行", (await raw(crossOrigin)).status === 200);

        process.env.PI_TEACHER_REQUEST_SECURITY = "false";
        check("取值 false：同样关闭", (await raw(foreignHost)).status === 200);
        process.env.PI_TEACHER_REQUEST_SECURITY = "TURE";
        check("取值拼错（TURE）：保持默认关闭，不会误开防护", (await raw(foreignHost)).status === 200);

        process.env.PI_TEACHER_REQUEST_SECURITY = "true";
        const hostBlocked = await raw(foreignHost);
        check("取值 true：外部域名 Host 被 403", hostBlocked.status === 403, { status: hostBlocked.status });
        check("  ↳ 错误信息为 Invalid Host header", errorOf(hostBlocked.text) === "Invalid Host header", { body: hostBlocked.text.slice(0, 120) });
        const originBlocked = await raw(crossOrigin);
        check("取值 true：跨站 Origin 被 403", originBlocked.status === 403, { status: originBlocked.status });
        check("  ↳ 错误信息为 Cross-origin API requests are not allowed", errorOf(originBlocked.text) === "Cross-origin API requests are not allowed", { body: originBlocked.text.slice(0, 120) });
        check("取值 true：同源请求仍 200", (await raw(sameOrigin)).status === 200);

        process.env.PI_TEACHER_REQUEST_SECURITY = "1";
        check("取值 1：也算开启", (await raw(foreignHost)).status === 403);
      } finally {
        delete process.env.PI_TEACHER_REQUEST_SECURITY;
        probeServer.close();
      }
    }

    console.log(`\n结果：${passed} 通过，${failed} 失败`);
  } finally {
    server.close();
    db.close();
    await fs.rm(homeDir, { recursive: true, force: true }).catch(() => {});
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("attachments-check 异常退出：", error);
  process.exit(1);
});
