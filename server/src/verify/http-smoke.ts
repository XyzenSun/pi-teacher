import assert from "node:assert/strict";
import { randomBytes, randomInt } from "node:crypto";
import { promises as fs, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import type { Agent } from "@earendil-works/pi-agent-core";
import { buildApp } from "../index.ts";
import { closeDatabase } from "../db/connection.ts";
import { initializeSchema } from "../db/schema.ts";
import { getSessionWrapper, shutdownAllSessions } from "../bridge/agent-session-wrapper.ts";
import { getPiSession, sessionKeyFor } from "../session/repository.ts";
import { REMINDER_TEXT_DEFAULTS } from "../prompts/defaults.ts";

/** 真实 Express、SQLite、文件与模型；不写 server/dev-data 或用户的部署数据。 */
let passed = 0;
let skipped = 0;
/** 真实 provider payload 里逐条消息检查信封：只有非 assistant 消息携带才算我们注入的证据。 */
function payloadHasNonAssistantEnvelope(payloadJson: string, envelope: string): boolean {
  let payload: { messages?: Array<{ role?: string; content?: unknown }> };
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return payloadJson.includes(envelope);
  }
  if (!Array.isArray(payload.messages)) return payloadJson.includes(envelope);
  return payload.messages.some((message) => message.role !== "assistant" && JSON.stringify(message.content ?? "").includes(envelope));
}

/** provider payload 里最后一条 user 消息的纯文本；openai-completions 把 content 发成字符串或 parts 数组，两种都读。 */
function lastUserTextInPayload(payloadJson: string): string {
  const payload = JSON.parse(payloadJson) as { messages?: Array<{ role?: string; content?: unknown }> };
  const content = [...(payload.messages ?? [])].reverse().find((message) => message.role === "user")?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => (part && typeof part === "object" && (part as { type?: string }).type === "text" ? [(part as { text: string }).text] : [])).join("");
}

/** 首轮标题生成复用 onPayload，不能把最后一次请求当作对话请求；按本轮原始输入定位后再严格断言提醒。 */
function payloadForPrompt(captured: readonly string[], submittedMessage: string): string {
  const payload = captured.find((candidate) => {
    const text = lastUserTextInPayload(candidate);
    return text === submittedMessage || text.startsWith(`${submittedMessage}\n\n`);
  });
  assert.ok(payload !== undefined, "provider payload 中缺少本轮用户消息");
  return payload;
}

/** 失败诊断只看命中点前后的片段：payload 开头永远是系统提示词，截前 300 字看不出泄漏来自哪条消息。 */
function excerptAround(text: string, needle: string, radius = 220): string {
  const at = text.indexOf(needle);
  return at < 0 ? text.slice(0, radius) : text.slice(Math.max(0, at - radius), at + needle.length + radius);
}

function check(name: string, condition: unknown): asserts condition {
  assert.ok(condition, name);
  console.log(`  ✓ ${name}`);
  passed += 1;
}
async function waitFor(condition: () => boolean | Promise<boolean>, label: string, timeout = 180_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待超时：${label}`);
}

async function main(): Promise<void> {
  process.env.PI_TEACHER_PROVIDER ??= "agnes";
  process.env.PI_TEACHER_MODEL ??= "agnes-2.5-flash";
  process.env.PI_TEACHER_IDLE_TIMEOUT_MS = "3600000";
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-teacher-http-"));
  const { app, db } = await buildApp({ homeDir });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let cookie = "";
  const streamControllers: AbortController[] = [];
  const streamTasks: Promise<void>[] = [];

  // 验证脚本是协议边界，JSON 形状由下面逐条真实断言收窄。
  async function api(method: string, endpoint: string, body?: unknown, authenticated = true) {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method, headers: { "Content-Type": "application/json", ...(authenticated && cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json() as any;
    check(`${method} ${endpoint} 不泄露部署路径`, !JSON.stringify(json).includes(homeDir));
    return { status: response.status, json, headers: response.headers };
  }
  function openEvents(id: number) {
    const events: Array<Record<string, any>> = [];
    const controller = new AbortController();
    streamControllers.push(controller);
    const task = (async () => {
      const response = await fetch(`${baseUrl}/api/conversations/${id}/events`, { headers: { Cookie: cookie }, signal: controller.signal });
      check("SSE 返回真实事件流", response.status === 200 && response.headers.get("content-type")?.includes("text/event-stream"));
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (frame.startsWith("data: ")) events.push(JSON.parse(frame.slice(6)));
          }
        }
      } finally { reader.releaseLock(); }
    })().catch((error: unknown) => {
      if (!controller.signal.aborted) throw error;
    });
    streamTasks.push(task);
    return events;
  }
  async function prompt(id: number, message: string, extras: Record<string, unknown> = {}) {
    const result = await api("POST", `/api/conversations/${id}/command`, { type: "prompt", message, ...extras });
    check("prompt 被真实 preflight 接受", result.status === 200 && result.json.success);
    await waitFor(() => !getSessionWrapper(sessionKeyFor(id))?.isRunning(), "模型完成回复");
    const history = getSessionWrapper(sessionKeyFor(id))!.inner.sessionManager.getEntries();
    const lastAssistant = [...history].reverse().find((entry) => entry.type === "message" && entry.message.role === "assistant");
    check("真模型没有返回错误停止", lastAssistant?.type === "message" && lastAssistant.message.role === "assistant" && lastAssistant.message.stopReason !== "error");
  }

  try {
    console.log("\n[1] Schema 与认证");
    initializeSchema(db, homeDir);
    for (const relative of ["AGENTS.md", "USER.md", "materials/index.md", "materials/origins", "assets", "llm-text-to-img"]) {
      check(`初始化补建全局 ${relative}`, existsSync(path.join(homeDir, relative)));
    }
    const globalAgentsMd = await fs.readFile(path.join(homeDir, "AGENTS.md"), "utf8");
    const globalUserMdBefore = await fs.readFile(path.join(homeDir, "USER.md"), "utf8");
    initializeSchema(db, homeDir);
    check("重复初始化不改全局 AGENTS.md 字节", (await fs.readFile(path.join(homeDir, "AGENTS.md"), "utf8")) === globalAgentsMd);
    const spaces = db.prepare("SELECT id,type FROM space ORDER BY id").all() as Array<{ id: number; type: string }>;
    check("固定 Space 唯一且类型正确", spaces.length === 2 && spaces[0].id === 0 && spaces[0].type === "ta" && spaces[1].id === 1 && spaces[1].type === "review");
    check("旧 session 表不存在", !db.prepare("SELECT name FROM sqlite_master WHERE name='session'").get());
    check("旧 session_id 列不存在", !(db.prepare("PRAGMA table_info(pi_session)").all() as Array<{ name: string }>).some((column) => column.name === "session_id"));
    check("重复初始化只产生一条助教", (db.prepare("SELECT COUNT(*) AS n FROM pi_session WHERE space_id=0").get() as { n: number }).n === 1);
    let result = await api("GET", "/api/auth/status");
    check("首次启动要求 setup", result.json.needsSetup === true);
    check("匿名访问受保护 API 返回 401", (await api("GET", "/api/workspaces", undefined, false)).status === 401);
    result = await api("POST", "/api/auth/setup", { username: "验收用户", password: "acceptance-password-123" });
    check("setup 创建真实用户", result.status === 200 && result.json.success);
    const setCookie = result.headers.get("set-cookie") ?? "";
    check("cookie 使用 HttpOnly 与 SameSite", setCookie.includes("HttpOnly") && setCookie.includes("SameSite=Lax"));
    cookie = setCookie.split(";")[0];
    check("setup 幂等保护", (await api("POST", "/api/auth/setup", { username: "第二用户", password: "another-pass" })).status === 409);
    check("错误密码被拒绝", (await api("POST", "/api/auth/login", { username: "验收用户", password: "wrong" })).status === 401);
    result = await api("POST", "/api/auth/login", { username: "验收用户", password: "acceptance-password-123" });
    cookie = (result.headers.get("set-cookie") ?? "").split(";")[0];
    check("真实登录成功", result.status === 200 && (await api("GET", "/api/auth/me")).json.username === "验收用户");

    console.log("\n[2] Space、模板与独立 Pi Session");
    const promptLibrary = (await api("GET", "/api/prompts")).json;
    const learnTemplate = promptLibrary.agentsMd.find((template: any) => template.type === "learn");
    const reviewTemplate = promptLibrary.agentsMd.find((template: any) => template.type === "review");
    check("初始化有三类可用模板与教学风格", learnTemplate?.prompt && reviewTemplate?.prompt && promptLibrary.agentsMd.some((template: any) => template.type === "ta") && promptLibrary.teachStyles.length > 0);
    check("固定助教模板可编辑", (await api("PATCH", "/api/prompts/agents-md/0", { description: "固定助教验收" })).status === 200);
    check("不能创建第二个助教模板", (await api("POST", "/api/prompts/agents-md", { type: "ta", name: "重复", prompt: "重复" })).status === 400);
    check("固定 Space 不可改名", (await api("PATCH", "/api/workspaces/0", { name: "新名称" })).status === 403);
    check("固定 Space 不可删除", (await api("DELETE", "/api/workspaces/1")).status === 403);
    result = await api("POST", "/api/workspaces", { name: "HTTP 验收学习" });
    check("创建学习 Space", result.status === 201 && result.json.space.type === "learn");
    const spaceId = result.json.space.id as number;
    check("学习 Space 身份不占固定 ID", spaceId >= 2);
    check("Space 重名被拒", (await api("POST", "/api/workspaces", { name: "HTTP 验收学习" })).status === 409);
    check("模板类型不匹配被拒", (await api("POST", "/api/conversations", { spaceId, agentsMdId: reviewTemplate.id })).status === 400);
    check("助教不可创建", (await api("POST", "/api/conversations", { spaceId: 0, agentsMdId: 0 })).status === 403);
    check("不存在的复习 Topic 被拒", (await api("POST", "/api/conversations", { spaceId: 1, agentsMdId: reviewTemplate.id, reviewTopicId: 999999 })).status === 400);
    check("学习不能指定 Topic", (await api("POST", "/api/conversations", { spaceId, agentsMdId: learnTemplate.id, reviewTopicId: 1 })).status === 400);
    check("创建不能携带模型", (await api("POST", "/api/conversations", { spaceId, agentsMdId: learnTemplate.id, modelId: "x" })).status === 400);
    result = await api("POST", "/api/conversations", { spaceId, agentsMdId: learnTemplate.id, teachStyleId: promptLibrary.teachStyles[0].id });
    check("创建学习 Pi Session", result.status === 201);
    const id = result.json.conversation.id as number;
    check("客户端只得到稳定数字 ID", Number.isSafeInteger(id) && !("sessionKey" in result.json.conversation) && !("path" in result.json.conversation));
    const firstRow = getPiSession(db, id);
    check("Pi 独立目录符合 ADR0030", firstRow.work_path === path.join(homeDir, "learn", String(spaceId), "pi", String(id)));
    const firstAgents = await fs.readFile(path.join(firstRow.work_path, "AGENTS.md"), "utf8");
    const firstStyle = await fs.readFile(path.join(firstRow.work_path, "style.md"), "utf8");
    check("提示词真实投影", firstAgents === learnTemplate.prompt && firstStyle === promptLibrary.teachStyles[0].prompt);
    check("空对话真实 JSONL header 已落盘", JSON.parse((await fs.readFile(firstRow.path, "utf8")).split("\n")[0]).id === sessionKeyFor(id));
    const second = await api("POST", "/api/conversations", { spaceId, agentsMdId: learnTemplate.id, enableMakeCard: false });
    check("同 Space 可创建第二条 Pi", second.status === 201);
    const secondRow = getPiSession(db, second.json.conversation.id);
    check("两个 Pi 不共享目录和 JSONL", secondRow.work_path !== firstRow.work_path && secondRow.path !== firstRow.path);
    check("新 Pi 未覆盖旧风格", await fs.readFile(path.join(firstRow.work_path, "style.md"), "utf8") === firstStyle);
    const review = await api("POST", "/api/conversations", { spaceId: 1, agentsMdId: reviewTemplate.id, reviewTopicId: null });
    check("全部 Topic 复习创建成功", review.status === 201 && review.json.conversation.reviewTopicId === null);
    const firstEssencePath = path.join(firstRow.work_path, "essence");
    const secondEssencePath = path.join(secondRow.work_path, "essence");
    check("学习会话制卡开 / 关都默认创建空 essence/", (await fs.stat(firstEssencePath)).isDirectory()
      && (await fs.readdir(firstEssencePath)).length === 0 && (await fs.stat(secondEssencePath)).isDirectory()
      && (await fs.readdir(secondEssencePath)).length === 0);
    check("复习不默认创建 essence/", !existsSync(path.join(getPiSession(db, review.json.conversation.id).work_path, "essence")));
    const initialTaRow = db.prepare("SELECT work_path FROM pi_session WHERE space_id = 0").get() as { work_path: string };
    check("助教不默认创建 essence/", !existsSync(path.join(initialTaRow.work_path, "essence")));

    console.log("\n[2b] 旧学习会话打开时补建精华目录与文件冲突保护");
    await api("POST", `/api/conversations/${secondRow.id}/close`);
    await fs.rmdir(secondEssencePath);
    initializeSchema(db, homeDir);
    check("重入初始化不全盘创建旧学习会话的精华目录", !existsSync(secondEssencePath));
    const originalSecondJsonl = await fs.readFile(secondRow.path);
    const heldSecondJsonlPath = `${secondRow.path}.held`;
    await fs.rename(secondRow.path, heldSecondJsonlPath);
    result = await api("POST", `/api/conversations/${secondRow.id}/open`);
    check("历史文件缺失先报 409，不补精华目录或伪造会话", result.status === 409 && result.json.error.includes("历史文件缺失")
      && !existsSync(secondEssencePath) && !existsSync(secondRow.path));
    await fs.rename(heldSecondJsonlPath, secondRow.path);
    await fs.writeFile(secondEssencePath, "保留同名用户文件\n", { flag: "wx" });
    result = await api("POST", `/api/conversations/${secondRow.id}/open`);
    check("essence 被普通文件占用时明确返回 409", result.status === 409 && result.json.error.includes("essence 路径被非目录占用"));
    check("冲突不覆盖文件、不改历史、不启动 wrapper", (await fs.readFile(secondEssencePath, "utf8")) === "保留同名用户文件\n"
      && (await fs.readFile(secondRow.path)).equals(originalSecondJsonl) && !getSessionWrapper(sessionKeyFor(secondRow.id))?.isAlive());
    await fs.unlink(secondEssencePath);
    result = await api("POST", `/api/conversations/${secondRow.id}/open`);
    check("旧学习会话正常打开补建空精华目录，身份与历史路径不变", result.status === 200 && result.json.conversation.id === secondRow.id
      && getPiSession(db, secondRow.id).path === secondRow.path && (await fs.readdir(secondEssencePath)).length === 0);
    const preservedEssencePath = path.join(secondEssencePath, "已有精华.md");
    const preservedEssence = Buffer.from("# 已有精华\r\n\r\n已有学习结论。  \r\n", "utf8");
    await fs.writeFile(preservedEssencePath, preservedEssence, { flag: "wx", mode: 0o640 });
    await api("POST", `/api/conversations/${secondRow.id}/close`);
    await api("POST", `/api/conversations/${secondRow.id}/open`);
    await api("POST", `/api/conversations/${secondRow.id}/open`);
    check("重复打开学习会话不改已有精华文件与权限", (await fs.readFile(preservedEssencePath)).equals(preservedEssence)
      && ((await fs.stat(preservedEssencePath)).mode & 0o777) === 0o640);

    console.log("\n[3] 模型与真实附件");
    const models = (await api("GET", "/api/models")).json;
    check("真实模型目录含验收模型", models.models.some((model: any) => model.provider === process.env.PI_TEACHER_PROVIDER && model.id === process.env.PI_TEACHER_MODEL));
    check("模型目录仅公开白名单字段", models.models.every((model: any) => Object.keys(model).every((key) => ["provider", "id", "name"].includes(key))));
    check("默认模型与部署一致", models.defaultModel.provider === process.env.PI_TEACHER_PROVIDER && models.defaultModel.id === process.env.PI_TEACHER_MODEL);
    const fileBytes = Buffer.from("# 验收资料\n\n附件是真实文件。\n", "utf8");
    const upload = () => fetch(`${baseUrl}/api/conversations/${id}/attachments`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent("资料.md") }, body: fileBytes });
    const uploaded = await upload();
    const attachment = (await uploaded.json() as any).attachment;
    check("上传附件成功且相对路径在 files/ 下（ADR-0038）", uploaded.status === 201 && attachment.relativePath === "files/资料.md");
    check("附件真实落盘", (await fs.readFile(path.join(firstRow.work_path, attachment.relativePath))).equals(fileBytes));
    check("上传不覆盖同名文件", (await upload()).status === 409);
    const traversal = await fetch(`${baseUrl}/api/conversations/${id}/attachments`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/octet-stream", "X-File-Name": "..%2Fevil.txt" }, body: fileBytes });
    check("上传拒绝路径穿越", traversal.status === 400);
    const download = await fetch(`${baseUrl}/api/conversations/${id}/attachments/${attachment.id}`, { headers: { Cookie: cookie } });
    check("下载真实文件字节一致", Buffer.from(await download.arrayBuffer()).equals(fileBytes));
    check("附件不出现在另一 Pi", (await api("GET", `/api/conversations/${secondRow.id}/attachments`)).json.attachments.length === 0);
    check("@ 文件索引找到真实附件", (await api("GET", `/api/conversations/${id}/file-index?q=${encodeURIComponent("资料")}`)).json.files.includes("files/资料.md"));

    console.log("\n[4] SSE 与真实模型制卡");
    const events = openEvents(id);
    await waitFor(() => events.some((event) => event.type === "connected"), "SSE connected", 20_000);
    check("connected 使用业务 ID", events.find((event) => event.type === "connected")?.sessionId === String(id));
    const tools = (await api("POST", `/api/conversations/${id}/command`, { type: "get_tools" })).json.data;
    check("15 个业务工具真实注册", ["card_propose", "card_list", "card_get", "card_delete", "card_merge", "topic_create", "topic_list", "glossary_propose", "glossary_list", "glossary_get", "review_get_due_cards", "review_submit_ratings", "md_get_outline", "md_get_section", "file_get_size_and_length"].every((name) => tools.some((tool: any) => tool.name === name && tool.active)));
    check("set_model 使用已有命令", (await api("POST", `/api/conversations/${id}/command`, { type: "set_model", provider: process.env.PI_TEACHER_PROVIDER, modelId: process.env.PI_TEACHER_MODEL })).status === 200);
    // ADR-0038：非图片附件只在用户消息末尾以一行自然语言告知路径与大小；图片作为图片块发送，不列路径。
    const firstAgent = getSessionWrapper(sessionKeyFor(id))!.inner.agent as unknown as Agent;
    const firstPayloads: string[] = [];
    const firstOriginalOnPayload = firstAgent.onPayload;
    firstAgent.onPayload = async (payload, model) => { firstPayloads.push(JSON.stringify(payload)); return firstOriginalOnPayload?.(payload, model); };
    await prompt(id, "请实际调用工具完成：创建名为 HTTP验收主题 的主题；在该主题提议一张卡片，正面 SSE的握手事件是什么，背面 connected，备注 验收用。不要仅用文字描述操作。附件仅用于检查上传路径，本轮不要读取、移动或整理它。", { attachmentIds: [attachment.id] });
    await waitFor(() => events.some((event) => event.type === "prompt_done"), "SSE prompt_done");
    const publishedCardTools = firstPayloads.flatMap((payload) => JSON.parse(payload).tools ?? [])
      .filter((tool: any) => (tool.function?.name ?? tool.name) === "card_propose");
    check("真正发给模型的 card_propose schema 不再包含精华来源参数", publishedCardTools.length > 0 && publishedCardTools.every((tool: any) => {
      const schema = tool.function?.parameters ?? tool.input_schema ?? tool.parameters;
      return schema?.properties && JSON.stringify(Object.keys(schema.properties).sort()) === JSON.stringify(["back", "front", "reason_and_remark", "topic_name"]);
    }));
    const firstUserTexts = firstPayloads.map((payload) => (JSON.parse(payload).messages as Array<{ role: string; content: unknown }>)
      .filter((message) => message.role === "user").map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)));
    check("非图片附件以「用户上传了文件」一行注入并带 files/ 路径与大小", firstUserTexts.some((texts) => texts.some((text) => text.includes(`用户上传了文件「资料.md」，路径 files/资料.md（${fileBytes.length} B）。`))));
    check("注入文案不再是旧的「本轮附件」列表", !firstPayloads.some((payload) => payload.includes("本轮附件")));
    // 只发图片不写字：文本块用「用户发送了 N 张图片。」兜底，图片作为图片块进入 payload。
    const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const pngUpload = await fetch(`${baseUrl}/api/conversations/${id}/attachments`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent("像素.png") }, body: pngBytes });
    const pngAttachment = (await pngUpload.json() as any).attachment;
    check("上传 PNG 成功且判定为图片", pngUpload.status === 201 && pngAttachment.mimeType === "image/png" && pngAttachment.relativePath === "files/像素.png");
    firstPayloads.length = 0;
    await prompt(id, "", { attachmentIds: [pngAttachment.id] });
    const imageOnlyPayload = JSON.parse(firstPayloads[0]!) as { messages: Array<{ role: string; content: unknown }> };
    const imageOnlyUser = [...imageOnlyPayload.messages].reverse().find((message) => message.role === "user");
    check("只发图片时文本块兜底为「用户发送了 1 张图片。」且不列图片路径", JSON.stringify(imageOnlyUser?.content).includes("用户发送了 1 张图片。")
      && !JSON.stringify(imageOnlyUser?.content).includes("files/像素.png"));
    // 我们总是把图片作为图片块交给 SDK；模型未声明 input 含 image 时 pi-ai 会把图片块换成占位文本，
    // 所以按真实模型能力二选一断言：视觉模型见到 image_url，非视觉模型见到占位符。
    const modelSupportsImages = ((getSessionWrapper(sessionKeyFor(id))!.inner.model as { input?: string[] } | undefined)?.input ?? []).includes("image");
    const imageOnlyParts = Array.isArray(imageOnlyUser?.content) ? imageOnlyUser!.content as Array<{ type: string; text?: string }> : [];
    check(modelSupportsImages ? "图片作为图片块进入 payload" : "非视觉模型：图片块被 SDK 换成占位文本（说明我们确实发了图片块）",
      modelSupportsImages
        ? imageOnlyParts.some((part) => part.type === "image_url" || part.type === "image")
        : imageOnlyParts.some((part) => part.type === "text" && part.text?.includes("image omitted")));
    check("图片消息落 JSONL 时仍是图片块（与模型能力无关）", (await fs.readFile(firstRow.path, "utf8")).split("\n").filter((line) => line.trim())
      .map((line) => JSON.parse(line) as { type: string; message?: { role?: string; content?: Array<{ type: string; mimeType?: string }> } })
      .some((entry) => entry.type === "message" && entry.message?.role === "user" && (entry.message.content ?? []).some((part) => part.type === "image" && part.mimeType === "image/png")));
    firstAgent.onPayload = firstOriginalOnPayload;
    for (const type of ["agent_start", "message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_end", "agent_settled", "prompt_done"]) check(`SSE 收到 ${type}`, events.some((event) => event.type === type));
    const topic = db.prepare("SELECT id FROM topic WHERE name='HTTP验收主题'").get() as { id: number } | undefined;
    check("模型实际创建 Topic", topic);
    const card = db.prepare("SELECT id,status FROM card WHERE topic_id=? ORDER BY id DESC LIMIT 1").get(topic.id) as { id: number; status: string } | undefined;
    check("模型实际提议 Card", card?.status === "proposed");
    const context = (await api("GET", `/api/conversations/${id}/context`)).json;
    check("无 leaf 参数能读到权威历史", context.messages.some((message: any) => message.role === "assistant") && context.entryIds.length === context.messages.length);
    const page = (await api("GET", `/api/conversations/${id}/context?tail=2`)).json;
    check("历史分页给出游标", page.hasMore && page.oldestEntryId);
    const older = (await api("GET", `/api/conversations/${id}/context?tail=2&before=${page.oldestEntryId}`)).json;
    check("旧页不重复游标消息", !older.entryIds.includes(page.oldestEntryId));
    check("临时 context 注入不写入 JSONL", !(await fs.readFile(firstRow.path, "utf8")).includes("<pi-teacher-context>"));

    console.log("\n[5] 真实 CRUD 与调度保留");
    check("确认提议卡", (await api("POST", `/api/cards/${card!.id}/confirm`)).status === 200);
    check("确认建立真实调度", db.prepare("SELECT card_id FROM card_schedule WHERE card_id=?").get(card!.id));
    db.prepare("UPDATE card_schedule SET reps=5 WHERE card_id=?").run(card!.id);
    check("编辑卡片", (await api("PATCH", `/api/cards/${card!.id}`, { front: "已编辑的卡面", reasonAndRemark: "真实编辑" })).status === 200);
    await api("POST", `/api/cards/${card!.id}/delete`);
    result = await api("POST", `/api/cards/${card!.id}/restore`);
    check("正常卡恢复原进度", result.json.restoredStatus === "normal" && (db.prepare("SELECT reps FROM card_schedule WHERE card_id=?").get(card!.id) as { reps: number }).reps === 5);
    result = await api("POST", "/api/cards", { topicId: topic.id, front: "手动卡", back: "手动答案" });
    check("手动新建直接正常卡", result.json.card.status === "normal");
    check("HTTP 卡片详情不再提供精华来源字段", !Object.hasOwn(result.json.card, "source_essence_path")
      && !Object.hasOwn(result.json.card, "has_source_essence"));
    const listedCards = (await api("GET", "/api/cards?status=normal")).json.cards as Array<Record<string, unknown>>;
    check("HTTP 卡片列表移除精华来源字段，正常字段保留", listedCards.length > 0 && listedCards.every((view) => typeof view.id === "number"
      && typeof view.front === "string" && typeof view.back === "string" && !Object.hasOwn(view, "source_essence_path") && !Object.hasOwn(view, "has_source_essence")));
    result = await api("POST", "/api/glossary", { term: "验收术语", definition: "用真实 API 管理" });
    const termId = result.json.term.id;
    check("术语手动创建真实可读", result.json.term.status === "normal");
    await api("PATCH", `/api/glossary/${termId}`, { definition: "已修改" });
    await api("POST", `/api/glossary/${termId}/delete`);
    check("术语回收站真实显示", (await api("GET", "/api/glossary?status=deleted")).json.terms.some((term: any) => term.id === termId));
    check("术语可恢复", (await api("POST", `/api/glossary/${termId}/restore`)).json.term.definition === "已修改");
    check("FSRS 参数可编辑", (await api("PATCH", `/api/topics/${topic.id}`, { requestRetention: 0.92, maximumInterval: 180 })).status === 200);
    check("非法 FSRS 参数被拒", (await api("PATCH", `/api/topics/${topic.id}`, { requestRetention: 0.3 })).status === 400);
    check("被使用模板不可删除", (await api("DELETE", `/api/prompts/agents-md/${learnTemplate.id}`)).status === 409);
    check("被使用风格不可删除", (await api("DELETE", `/api/prompts/teach-style/${promptLibrary.teachStyles[0].id}`)).status === 409);
    check("模板编辑成功", (await api("PATCH", `/api/prompts/agents-md/${learnTemplate.id}`, { prompt: `${learnTemplate.prompt}\n新增约定。` })).status === 200);
    check("编辑模板不覆盖已建 Pi 投影", await fs.readFile(path.join(firstRow.work_path, "AGENTS.md"), "utf8") === firstAgents);

    console.log("\n[6] 运行期制卡开关与教学风格切换");
    const secondId = secondRow.id;
    check("创建时关闭制卡真实落库", second.json.conversation.enableMakeCard === false && getPiSession(db, secondId).enable_make_card === 0);
    result = await api("PATCH", `/api/conversations/${secondId}/options`, { enableMakeCard: true });
    check("运行期开启制卡返回新状态", result.status === 200 && result.json.conversation.enableMakeCard === true);
    check("制卡开关真实落库", getPiSession(db, secondId).enable_make_card === 1);
    check("制卡开关非布尔被拒", (await api("PATCH", `/api/conversations/${secondId}/options`, { enableMakeCard: "yes" })).status === 400);
    check("options 拒绝额外字段", (await api("PATCH", `/api/conversations/${secondId}/options`, { enableMakeCard: true, spaceId: 1 })).status === 400);
    const taSessionId = (await api("GET", "/api/workspaces")).json.taSessionId as number;
    check("助教会话拒绝改制卡", (await api("PATCH", `/api/conversations/${taSessionId}/options`, { enableMakeCard: true })).status === 403);
    check("助教制卡仍为关闭", getPiSession(db, taSessionId).enable_make_card === 0);

    // 教学风格切换要经过「落库 → 重投影 style.md → 按稳定 ID 重开」，
    // 这里断言重开没有换文件、没有丢历史、没有换模型（ADR-0031 的核心风险）。
    await prompt(secondId, "只回复“记住了”，不调用工具。");
    const secondPathBefore = getPiSession(db, secondId).path;
    const secondMessages = (await api("GET", `/api/conversations/${secondId}/context`)).json.messages.length;
    const secondModelBefore = (await api("GET", `/api/conversations/${secondId}/status`)).json.model;
    const styleForSwitch = promptLibrary.teachStyles[promptLibrary.teachStyles.length - 1];
    check("切换到不存在的教学风格被拒", (await api("PATCH", `/api/conversations/${secondId}/teach-style`, { teachStyleId: 999999 })).status === 400);
    check("teach-style 拒绝额外字段", (await api("PATCH", `/api/conversations/${secondId}/teach-style`, { teachStyleId: styleForSwitch.id, enableMakeCard: true })).status === 400);
    check("助教会话拒绝改教学风格", (await api("PATCH", `/api/conversations/${taSessionId}/teach-style`, { teachStyleId: styleForSwitch.id })).status === 403);
    result = await api("PATCH", `/api/conversations/${secondId}/teach-style`, { teachStyleId: styleForSwitch.id });
    check("运行期切换教学风格成功并重载会话", result.status === 200 && result.json.reloaded === true && result.json.conversation.teachStyleId === styleForSwitch.id);
    check("style.md 已重投影为新风格", await fs.readFile(path.join(secondRow.work_path, "style.md"), "utf8") === styleForSwitch.prompt);
    check("重载没有换 JSONL 文件", getPiSession(db, secondId).path === secondPathBefore);
    check("重载保留历史条数", (await api("GET", `/api/conversations/${secondId}/context`)).json.messages.length === secondMessages);
    const secondModelAfter = (await api("GET", `/api/conversations/${secondId}/status`)).json.model;
    check("重载保留已选模型", secondModelAfter.provider === secondModelBefore.provider && secondModelAfter.id === secondModelBefore.id);
    // 风格是通过 appendSystemPrompt 进入会话的，只有重建后的 agent 系统提示里
    // 真的出现新风格文本，才说明切换不是「只改了库和文件」。
    const reloadedSystemPrompt = getSessionWrapper(sessionKeyFor(secondId))!.inner.agent.state?.systemPrompt ?? "";
    check("新风格真实进入重建后的系统提示", reloadedSystemPrompt.includes(styleForSwitch.prompt.trim()));
    // 全局 AGENTS.md 靠 Pi 祖先遍历自动进入，不是我们拼的：断言 system prompt 里有模板首行。
    check("全局 AGENTS.md 被 Pi 自动发现进入系统提示", reloadedSystemPrompt.includes(globalAgentsMd.trim().split("\n")[0]));
    check("仅占位注释的 USER.md 不进系统提示", !reloadedSystemPrompt.includes("<全局用户偏好>"));
    check("有风格时附带会话级偏好引导", reloadedSystemPrompt.includes("<会话级用户偏好>") && reloadedSystemPrompt.includes("pi-session-user.md"));

    console.log("\n[6b] 全局用户偏好 API 与注入四态");
    result = await api("GET", "/api/config/user-preferences");
    check("读取用户偏好返回相对文件名与占位内容", result.status === 200 && result.json.path === "USER.md" && result.json.content === globalUserMdBefore);
    check("用户偏好拒绝多余键", (await api("PUT", "/api/config/user-preferences", { content: "x", extra: 1 })).status === 400);
    check("用户偏好拒绝非文本", (await api("PUT", "/api/config/user-preferences", { content: 42 })).status === 400);
    const overLimit = await api("PUT", "/api/config/user-preferences", { content: "偏".repeat(8001) });
    check("用户偏好超过 8000 字符被拒且说明上限", overLimit.status === 400 && String(overLimit.json.error).includes("8000"));
    check("被拒后 USER.md 字节不变", (await fs.readFile(path.join(homeDir, "USER.md"), "utf8")) === globalUserMdBefore);
    check("被拒后无临时残留", !(await fs.readdir(homeDir)).some((name) => name.includes("USER.md") && name.endsWith(".tmp")));
    result = await api("GET", "/api/config/global-agents-md");
    check("读取全局 AGENTS.md 返回相对文件名与 seed 内容", result.status === 200 && result.json.path === "AGENTS.md" && result.json.content === globalAgentsMd);
    check("全局 AGENTS.md 拒绝多余键", (await api("PUT", "/api/config/global-agents-md", { content: "x", other: 1 })).status === 400);
    const globalAgentsMdEdited = `${globalAgentsMd}\n## 验收追加\n\n全局规则标记-HTTP：先给结论。\n`;
    result = await api("PUT", "/api/config/global-agents-md", { content: globalAgentsMdEdited });
    check("保存全局 AGENTS.md 成功且真实落盘", result.status === 200 && (await fs.readFile(path.join(homeDir, "AGENTS.md"), "utf8")) === globalAgentsMdEdited);
    const preferenceMarker = "全局偏好标记-HTTP：讲解时多给代码示例";
    result = await api("PUT", "/api/config/user-preferences", { content: `# 我的偏好\n\n- ${preferenceMarker}\n` });
    check("保存用户偏好成功", result.status === 200 && result.json.success === true);
    check("保存后 USER.md 真实落盘且权限 0644", (await fs.readFile(path.join(homeDir, "USER.md"), "utf8")).includes(preferenceMarker)
      && ((await fs.stat(path.join(homeDir, "USER.md"))).mode & 0o777) === 0o644);
    const styleBeforePreferences = await fs.readFile(path.join(secondRow.work_path, "style.md"), "utf8");
    const agentsMdBeforePreferences = await fs.readFile(path.join(secondRow.work_path, "AGENTS.md"), "utf8");
    // 生效时机与 ADR-0031 一致：已开会话不变，切换风格触发的 reload 读到新 USER.md。
    check("保存偏好不影响已打开会话", (getSessionWrapper(sessionKeyFor(secondId))!.inner.agent.state?.systemPrompt ?? "").includes(preferenceMarker) === false);
    result = await api("PATCH", `/api/conversations/${secondId}/teach-style`, { teachStyleId: null });
    check("可清空教学风格", result.status === 200 && result.json.conversation.teachStyleId === null
      && (await fs.readFile(path.join(secondRow.work_path, "style.md"), "utf8")) === "");
    const promptWithPreferencesOnly = getSessionWrapper(sessionKeyFor(secondId))!.inner.agent.state?.systemPrompt ?? "";
    check("重载后全局偏好进入系统提示", promptWithPreferencesOnly.includes("<全局用户偏好>") && promptWithPreferencesOnly.includes(preferenceMarker));
    check("重载后编辑过的全局 AGENTS.md 经祖先遍历进入系统提示", promptWithPreferencesOnly.includes("全局规则标记-HTTP：先给结论。"));
    check("无风格时不出现教学风格块", !promptWithPreferencesOnly.includes("<教学风格>"));
    check("无风格时仍附带会话级偏好引导", promptWithPreferencesOnly.includes("<会话级用户偏好>"));
    check("保存偏好未改动会话的 AGENTS.md", (await fs.readFile(path.join(secondRow.work_path, "AGENTS.md"), "utf8")) === agentsMdBeforePreferences && styleBeforePreferences === styleForSwitch.prompt);
    result = await api("PATCH", `/api/conversations/${secondId}/teach-style`, { teachStyleId: styleForSwitch.id });
    const promptWithBoth = getSessionWrapper(sessionKeyFor(secondId))!.inner.agent.state?.systemPrompt ?? "";
    check("偏好与风格并存时两块都在且顺序为全局在前", promptWithBoth.indexOf("<全局用户偏好>") > -1
      && promptWithBoth.indexOf("<全局用户偏好>") < promptWithBoth.indexOf("<教学风格>") && promptWithBoth.indexOf("<教学风格>") < promptWithBoth.indexOf("<会话级用户偏好>"));
    await api("PUT", "/api/config/user-preferences", { content: "" });
    await api("PATCH", `/api/conversations/${secondId}/teach-style`, { teachStyleId: null });
    const promptWithNeither = getSessionWrapper(sessionKeyFor(secondId))!.inner.agent.state?.systemPrompt ?? "";
    check("偏好与风格都空时仍有会话级引导块（ADR-0036 提醒依赖它）", promptWithNeither.includes("<会话级用户偏好>"));
    check("偏好与风格都空时不再有全局偏好 / 教学风格块", !promptWithNeither.includes("<全局用户偏好>") && !promptWithNeither.includes("<教学风格>"));

    console.log("\n[7] 固定助教与一次性简介（真实 payload）");
    const taId = taSessionId;
    await api("POST", `/api/conversations/${id}/command`, { type: "set_session_name", name: "主会话专属简介标记-HTTP" });
    await api("POST", `/api/conversations/${taId}/open`);
    // ADR-0035：助教以常驻打开，/close 对它没有意义；学习会话不常驻（[9] 仍靠 /close 验证回收）。
    check("助教 wrapper 以常驻打开", getSessionWrapper(sessionKeyFor(taId))!.isResident() === true);
    check("学习会话 wrapper 不常驻", getSessionWrapper(sessionKeyFor(id))!.isResident() === false);
    const closeTa = await api("POST", `/api/conversations/${taId}/close`);
    check("助教 /close 返回 400 且仍活着", closeTa.status === 400 && getSessionWrapper(sessionKeyFor(taId))!.isAlive());
    const taAgent = getSessionWrapper(sessionKeyFor(taId))!.inner.agent as unknown as Agent;
    const payloads: string[] = [];
    const originalOnPayload = taAgent.onPayload;
    taAgent.onPayload = async (payload, model) => { payloads.push(JSON.stringify(payload)); return originalOnPayload?.(payload, model); };
    await prompt(taId, "只回复“准备好了”，不调用工具。");
    // 断言注入信封本身而不是简介里的字样，且只看非 assistant 消息：真模型可能在回答里
    // 复述主会话名甚至照抄 <pi-teacher-context> 标签，这段文字会随历史进入后续每轮 payload，
    // 属于模型输出而不是我们的注入；我们的信封总以 custom→user 侧消息出现。
    const injectedPayloads = () => payloads.filter((payload) => payloadHasNonAssistantEnvelope(payload, "<pi-teacher-context>"));
    check("助教默认没有注入主会话上下文", injectedPayloads().length === 0);
    payloads.length = 0;
    await prompt(taId, "若当前输入有授权简介，只回复“已读取”，不复述简介，不调用工具。", { injectMainSessionId: id });
    check("显式点击的该轮携带主会话简介", injectedPayloads().length > 0 && payloads.some((payload) => payload.includes("主会话专属简介标记-HTTP")));
    payloads.length = 0;
    await prompt(taId, "这轮只回复“完成”，不调用工具。");
    const leakedPayloads = injectedPayloads();
    check(
      `下一轮不再注入主会话简介${leakedPayloads.length ? `（意外命中片段：${excerptAround(leakedPayloads[0], "<pi-teacher-context>")}）` : ""}`,
      leakedPayloads.length === 0,
    );
    // 注入是 context 钩子里临时拼进请求 payload 的，不该写进 JSONL。逐条解析而不是整文件
    // 搜字符串：失败时要能立刻区分「我们真的持久化了注入」和「真模型在回答里复述了标签名」。
    // 覆盖两条真实泄漏路径：落成 custom 条目，或把信封拼进非 assistant 消息；assistant
    // 文本属于模型输出，复述标签名不构成持久化缺陷。
    const taHistoryLines = (await fs.readFile(getPiSession(db, taId).path, "utf8")).split("\n").filter((line) => line.trim());
    const persistedContextEntries = taHistoryLines
      .map((line) => { try { return JSON.parse(line) as Record<string, any>; } catch { return null; } })
      .filter((entry): entry is Record<string, any> => entry !== null)
      .filter((entry) => entry.type === "custom" || entry.customType === "pi-teacher-context"
        || entry.message?.customType === "pi-teacher-context"
        || (entry.message?.role !== "assistant" && JSON.stringify(entry).includes("<pi-teacher-context>")));
    check(
      `助教简介不落历史${persistedContextEntries.length ? `（命中条目：${JSON.stringify(persistedContextEntries[0]).slice(0, 300)}）` : ""}`,
      persistedContextEntries.length === 0,
    );

    console.log("\n[7b] 维护提醒：共用轮次、基础文案与学习精华（真实 payload）");
    // 只断言 provider payload 的最后一条 user 消息，不断言模型是否真的写文件；
    // 真模型复述提醒、历史里已有的提醒，都不代表本轮又被注入一次。
    const reminderTemplates = {
      制卡开: REMINDER_TEXT_DEFAULTS.makeCardOn, 制卡关: REMINDER_TEXT_DEFAULTS.makeCardOff,
      助教: REMINDER_TEXT_DEFAULTS.ta, 学习精华: REMINDER_TEXT_DEFAULTS.learningEssence,
    };
    check("四份出厂文案都是完整 <system-reminder> 段", Object.values(reminderTemplates)
      .every((text) => text.startsWith("<system-reminder>") && text.endsWith("</system-reminder>")));
    check("助教文案不提全局偏好", !reminderTemplates.助教.includes("用户偏好") && reminderTemplates.制卡开.includes("制卡") && !reminderTemplates.制卡关.includes("制卡"));
    check("精华段与三种基础文案独立", reminderTemplates.学习精华.includes("essence/")
      && [reminderTemplates.制卡开, reminderTemplates.制卡关, reminderTemplates.助教].every((text) => !text.includes("essence/")));
    result = await api("GET", "/api/config/settings");
    check("运行设置带业务字段 app.reminderIntervalTurns 且默认 30", result.status === 200 && result.json.app?.reminderIntervalTurns === 30);
    check("未改过时四条提醒都使用出厂文案", Object.entries(REMINDER_TEXT_DEFAULTS)
      .every(([kind, text]) => result.json.app.reminderTexts[kind] === text));
    check("精华文案缺行即可生效，无需 seed", !db.prepare("SELECT value FROM setting WHERE key = 'reminder_text_learning_essence'").get());
    for (const bad of [
      { reminderTexts: "x" }, { reminderTexts: {} }, { reminderTexts: { unknownKind: "x" } },
      { reminderTexts: { constructor: "x" } }, { reminderTexts: { toString: "x" } },
      { reminderTexts: { ta: 1 } }, { reminderTexts: { ta: "x".repeat(4001) } },
      { reminderTexts: { learningEssence: 1 } }, { reminderTexts: { learningEssence: "x".repeat(4001) } },
    ]) {
      check(`${JSON.stringify(bad).slice(0, 60)} 被 400 拒绝`, (await api("PATCH", "/api/config/settings", bad)).status === 400);
    }
    const customTaText = "<system-reminder>HTTP 验收自定义助教提醒：请回顾用户对你的要求并更新 pi-session-user.md。</system-reminder>";
    const customEssenceText = "<system-reminder>HTTP 精华验收标记：按需维护当前学习会话的 essence/，无需为本轮强行生成文件。</system-reminder>";
    const customBaseTexts = {
      makeCardOn: "<system-reminder>既有制卡开文案：按需维护偏好与制卡。</system-reminder>",
      makeCardOff: "<system-reminder>既有制卡关文案：按需维护偏好。</system-reminder>",
      ta: customTaText,
    };
    result = await api("PATCH", "/api/config/settings", { reminderTexts: customBaseTexts });
    check("三条基础文案可分别自定义", result.status === 200 && Object.entries(customBaseTexts)
      .every(([kind, text]) => result.json.app.reminderTexts[kind] === text));
    const baseRows = () => db.prepare("SELECT key, value FROM setting WHERE key IN ('reminder_text_make_card_on', 'reminder_text_make_card_off', 'reminder_text_ta') ORDER BY key").all();
    const originalBaseRows = JSON.stringify(baseRows());
    result = await api("PATCH", "/api/config/settings", { reminderTexts: { learningEssence: customEssenceText } });
    check("新增精华文案不修改已有三条基础文案", result.status === 200 && result.json.app.reminderTexts.learningEssence === customEssenceText
      && Object.entries(customBaseTexts).every(([kind, text]) => result.json.app.reminderTexts[kind] === text)
      && JSON.stringify(baseRows()) === originalBaseRows);
    check("精华文案写入 setting 表", (db.prepare("SELECT value FROM setting WHERE key = 'reminder_text_learning_essence'").get() as { value: string }).value === customEssenceText);
    initializeSchema(db, homeDir);
    initializeSchema(db, homeDir);
    check("初始化重入不覆盖任何已保存的提醒文案", JSON.stringify(baseRows()) === originalBaseRows
      && (await api("GET", "/api/config/settings")).json.app.reminderTexts.learningEssence === customEssenceText);
    result = await api("PATCH", "/api/config/settings", { reminderTexts: { learningEssence: "   " } });
    check("精华文案恢复默认只删该行，三条基础自定义文案原样保留", result.status === 200 && result.json.app.reminderTexts.learningEssence === reminderTemplates.学习精华
      && !db.prepare("SELECT value FROM setting WHERE key = 'reminder_text_learning_essence'").get() && JSON.stringify(baseRows()) === originalBaseRows);
    result = await api("PATCH", "/api/config/settings", { reminderTexts: { makeCardOn: "", makeCardOff: "", ta: "   " } });
    check("基础文案空白恢复出厂且删行", result.status === 200 && Object.entries(REMINDER_TEXT_DEFAULTS)
      .every(([kind, text]) => result.json.app.reminderTexts[kind] === text) && baseRows().length === 0);
    // 助教保留自定义文案用于命中轮验证，学习先用出厂精华，再在运行期改为自定义文案。
    await api("PATCH", "/api/config/settings", { reminderTexts: { ta: customTaText } });
    for (const bad of [-1, 1.5, "30", 10_001, null]) {
      check(`reminderIntervalTurns=${JSON.stringify(bad)} 被 400 拒绝`, (await api("PATCH", "/api/config/settings", { reminderIntervalTurns: bad })).status === 400);
    }
    check("被拒后间隔仍是 30", (await api("GET", "/api/config/settings")).json.app.reminderIntervalTurns === 30);
    const retryBeforeMixed = (await api("GET", "/api/config/settings")).json.settings.retryEnabled as boolean;
    result = await api("PATCH", "/api/config/settings", { reminderIntervalTurns: 2, retryEnabled: !retryBeforeMixed });
    check("同一 PATCH 混传 Pi 字段与业务字段都生效", result.status === 200 && result.json.app.reminderIntervalTurns === 2 && result.json.settings.retryEnabled === !retryBeforeMixed);
    await api("PATCH", "/api/config/settings", { retryEnabled: retryBeforeMixed });
    check("间隔写入 setting 表", (db.prepare("SELECT value FROM setting WHERE key = 'reminder_interval_turns'").get() as { value: string }).value === "2");
    check("GET 读回间隔 2", (await api("GET", "/api/config/settings")).json.app.reminderIntervalTurns === 2);

    const reminderSession = await api("POST", "/api/conversations", { spaceId, agentsMdId: learnTemplate.id });
    check("提醒验证用的学习 Pi Session 制卡默认开启", reminderSession.status === 201 && reminderSession.json.conversation.enableMakeCard === true);
    const reminderId = reminderSession.json.conversation.id as number;
    const reminderAgent = getSessionWrapper(sessionKeyFor(reminderId))!.inner.agent as unknown as Agent;
    const reminderPayloads: string[] = [];
    const reminderOriginalOnPayload = reminderAgent.onPayload;
    reminderAgent.onPayload = async (payload, model) => { reminderPayloads.push(JSON.stringify(payload)); return reminderOriginalOnPayload?.(payload, model); };
    const userTextOf = (captured: string[], submittedMessage: string) => lastUserTextInPayload(payloadForPrompt(captured, submittedMessage));
    await prompt(reminderId, "只回复“一”，不调用工具。");
    check("第 1 轮不追加基础或精华提醒", userTextOf(reminderPayloads, "只回复“一”，不调用工具。") === "只回复“一”，不调用工具。");
    reminderPayloads.length = 0;
    await prompt(reminderId, "只回复“二”，不调用工具。");
    const secondTurnPayload = payloadForPrompt(reminderPayloads, "只回复“二”，不调用工具。");
    const secondTurnText = lastUserTextInPayload(secondTurnPayload);
    check("第 2 轮制卡开：基础提醒后同轮追加出厂精华段", secondTurnText === `只回复“二”，不调用工具。\n\n${reminderTemplates.制卡开}\n\n${reminderTemplates.学习精华}`);
    check("提醒只在本轮消息里，历史第 1 轮不被改写", !JSON.parse(secondTurnPayload).messages
      .filter((message: any) => message.role === "user").slice(0, -1).some((message: any) => JSON.stringify(message.content).includes("<system-reminder>")));
    check("运行期关闭制卡", (await api("PATCH", `/api/conversations/${reminderId}/options`, { enableMakeCard: false })).status === 200);
    result = await api("PATCH", "/api/config/settings", { reminderTexts: { learningEssence: customEssenceText } });
    check("已开会话运行期更新精华文案，不影响基础文案", result.status === 200 && result.json.app.reminderTexts.learningEssence === customEssenceText
      && result.json.app.reminderTexts.makeCardOn === reminderTemplates.制卡开 && result.json.app.reminderTexts.makeCardOff === reminderTemplates.制卡关
      && result.json.app.reminderTexts.ta === customTaText);
    reminderPayloads.length = 0;
    await prompt(reminderId, "只回复“三”，不调用工具。", { type: "steer" });
    check("第 3 轮 steer 非命中，不追加基础或精华提醒", userTextOf(reminderPayloads, "只回复“三”，不调用工具。") === "只回复“三”，不调用工具。");
    reminderPayloads.length = 0;
    await prompt(reminderId, "只回复“四”，不调用工具。", { type: "follow_up" });
    const fourthTurnText = userTextOf(reminderPayloads, "只回复“四”，不调用工具。");
    check("第 4 轮 follow_up 制卡关：基础提醒后同轮追加刚保存的精华段", fourthTurnText === `只回复“四”，不调用工具。\n\n${reminderTemplates.制卡关}\n\n${customEssenceText}`);
    const reminderContext = (await api("GET", `/api/conversations/${reminderId}/context`)).json;
    const remindedUserMessages = reminderContext.messages.filter((message: any) => message.role === "user" && JSON.stringify(message.content).includes("<system-reminder>"));
    check("历史接口保留两个命中轮的基础与精华文案", remindedUserMessages.length === 2
      && JSON.stringify(remindedUserMessages[0].content).includes(reminderTemplates.学习精华)
      && JSON.stringify(remindedUserMessages[1].content).includes(customEssenceText));
    const remindedJsonlUserEntries = (await fs.readFile(getPiSession(db, reminderId).path, "utf8")).split("\n")
      .map((line) => { try { return JSON.parse(line) as Record<string, any>; } catch { return null; } })
      .filter((entry): entry is Record<string, any> => entry?.type === "message" && entry.message?.role === "user" && JSON.stringify(entry.message.content).includes("<system-reminder>"));
    check("组合提醒随用户消息落 JSONL（两条 user 条目）", remindedJsonlUserEntries.length === 2
      && JSON.stringify(remindedJsonlUserEntries[0].message.content).includes(reminderTemplates.学习精华)
      && JSON.stringify(remindedJsonlUserEntries[1].message.content).includes(customEssenceText));

    // 助教已发 3 轮（[7]），第 4 轮命中，但不追加学习精华。
    payloads.length = 0;
    await prompt(taId, "只回复“四”，不调用工具。");
    check("助教命中轮只追加自定义助教文案，不追加精华", userTextOf(payloads, "只回复“四”，不调用工具。") === `只回复“四”，不调用工具。\n\n${customTaText}`);
    check("助教文案恢复出厂", (await api("PATCH", "/api/config/settings", { reminderTexts: { ta: "" } })).json.app.reminderTexts.ta === reminderTemplates.助教);

    // 复用 [2] 创建且尚未发言的真实复习会话；调到每轮提醒，分别验证制卡开 / 关都不带精华。
    check("间隔改为 1", (await api("PATCH", "/api/config/settings", { reminderIntervalTurns: 1 })).json.app.reminderIntervalTurns === 1);
    const reviewReminderId = review.json.conversation.id as number;
    check("复习提醒验证以制卡开启状态开始", getPiSession(db, reviewReminderId).enable_make_card === 1);
    const reviewReminderAgent = getSessionWrapper(sessionKeyFor(reviewReminderId))!.inner.agent as unknown as Agent;
    const reviewPayloads: string[] = [];
    const reviewOriginalOnPayload = reviewReminderAgent.onPayload;
    reviewReminderAgent.onPayload = async (payload, model) => { reviewPayloads.push(JSON.stringify(payload)); return reviewOriginalOnPayload?.(payload, model); };
    await prompt(reviewReminderId, "只回复“复习一”，不调用工具。");
    check("复习制卡开命中时只用共用基础文案，不追加精华", userTextOf(reviewPayloads, "只回复“复习一”，不调用工具。") === `只回复“复习一”，不调用工具。\n\n${reminderTemplates.制卡开}`);
    await api("PATCH", `/api/conversations/${reviewReminderId}/options`, { enableMakeCard: false });
    reviewPayloads.length = 0;
    await prompt(reviewReminderId, "只回复“复习二”，不调用工具。");
    check("复习制卡关命中时也不追加精华", userTextOf(reviewPayloads, "只回复“复习二”，不调用工具。") === `只回复“复习二”，不调用工具。\n\n${reminderTemplates.制卡关}`);
    reviewReminderAgent.onPayload = reviewOriginalOnPayload;

    // 恢复精华出厂文案与改间隔均在下一命中轮生效，无需重开会话。
    result = await api("PATCH", "/api/config/settings", { reminderIntervalTurns: 5, reminderTexts: { learningEssence: "" } });
    check("间隔改为 5，同时恢复精华默认", result.json.app.reminderIntervalTurns === 5
      && result.json.app.reminderTexts.learningEssence === reminderTemplates.学习精华 && !db.prepare("SELECT value FROM setting WHERE key = 'reminder_text_learning_essence'").get());
    reminderPayloads.length = 0;
    await prompt(reminderId, "只回复“五”，不调用工具。");
    check("新间隔与默认恢复即时生效：第 5 轮基础加出厂精华", userTextOf(reminderPayloads, "只回复“五”，不调用工具。") === `只回复“五”，不调用工具。\n\n${reminderTemplates.制卡关}\n\n${reminderTemplates.学习精华}`);
    check("间隔改为 0", (await api("PATCH", "/api/config/settings", { reminderIntervalTurns: 0 })).json.app.reminderIntervalTurns === 0);
    reminderPayloads.length = 0;
    await prompt(reminderId, "只回复“六”，不调用工具。");
    check("间隔为 0 时学习会话的基础与精华提醒一起关闭", userTextOf(reminderPayloads, "只回复“六”，不调用工具。") === "只回复“六”，不调用工具。");
    payloads.length = 0;
    await prompt(taId, "只回复“五”，不调用工具。");
    check("间隔为 0 时助教本该命中的第 5 轮不追加", userTextOf(payloads, "只回复“五”，不调用工具。") === "只回复“五”，不调用工具。");
    check("间隔恢复默认 30", (await api("PATCH", "/api/config/settings", { reminderIntervalTurns: 30 })).json.app.reminderIntervalTurns === 30);
    reminderAgent.onPayload = reminderOriginalOnPayload;
    check("提醒 Pi Session 可关闭以释放模型", (await api("POST", `/api/conversations/${reminderId}/close`)).status === 200);

    console.log("\n[7c] 助教清除对话（ADR-0035）");
    check("学习会话不能清除（403）", (await api("POST", `/api/conversations/${id}/clear`)).status === 403);
    const taRowBeforeClear = getPiSession(db, taId);
    const taUserPreferencesPath = path.join(taRowBeforeClear.work_path, "pi-session-user.md");
    await fs.writeFile(taUserPreferencesPath, "# 用户对助教的要求\n\n- 回答尽量短。\n");
    check("清除前助教有历史", (await api("GET", `/api/conversations/${taId}/context`)).json.messages.length > 0 && existsSync(taRowBeforeClear.path));
    check("助教目录没有 style.md", !existsSync(path.join(taRowBeforeClear.work_path, "style.md")));
    const taEvents = openEvents(taId);
    await waitFor(() => taEvents.some((event) => event.type === "connected"), "助教 SSE connected", 20_000);
    result = await api("POST", `/api/conversations/${taId}/clear`);
    check("清除返回同一稳定 ID 且会话已重开", result.status === 200 && result.json.conversation.id === taId && result.json.runtime.alive === true);
    await waitFor(() => taEvents.some((event) => event.type === "session_recycled"), "清除时旧 SSE 收到 session_recycled", 5000);
    const taRowAfterClear = getPiSession(db, taId);
    check("清除换了 JSONL 文件但工作目录不变", taRowAfterClear.path !== taRowBeforeClear.path && taRowAfterClear.work_path === taRowBeforeClear.work_path);
    // 重开时 SDK 会立刻追加 model_change / thinking_level_change 条目（默认模型落盘），所以只断言没有 message 条目。
    const clearedJsonlEntries = (await fs.readFile(taRowAfterClear.path, "utf8")).split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as { type: string; id?: string });
    check("旧 JSONL 已删除、新 JSONL 是同一稳定 ID 的空历史", !existsSync(taRowBeforeClear.path)
      && clearedJsonlEntries[0]?.type === "session" && clearedJsonlEntries[0].id === sessionKeyFor(taId)
      && !clearedJsonlEntries.some((entry) => entry.type === "message"));
    check("新 JSONL 权限 0600", ((await fs.stat(taRowAfterClear.path)).mode & 0o777) === 0o600);
    check("清除后 pi-session-user.md 与 files/ 保留", (await fs.readFile(taUserPreferencesPath, "utf8")).includes("回答尽量短")
      && existsSync(path.join(taRowAfterClear.work_path, "files")));
    check("清除后助教仍常驻且活着", getSessionWrapper(sessionKeyFor(taId))!.isAlive() && getSessionWrapper(sessionKeyFor(taId))!.isResident());
    check("清除后历史为空", (await api("GET", `/api/conversations/${taId}/context`)).json.messages.length === 0);
    // 轮次从会话历史现数：清除后计数归零——间隔 2 时第 1 轮不命中、第 2 轮命中。
    check("间隔改为 2", (await api("PATCH", "/api/config/settings", { reminderIntervalTurns: 2 })).json.app.reminderIntervalTurns === 2);
    const taAgentAfterClear = getSessionWrapper(sessionKeyFor(taId))!.inner.agent as unknown as Agent;
    const clearedPayloads: string[] = [];
    const clearedOriginalOnPayload = taAgentAfterClear.onPayload;
    taAgentAfterClear.onPayload = async (payload, model) => { clearedPayloads.push(JSON.stringify(payload)); return clearedOriginalOnPayload?.(payload, model); };
    await prompt(taId, "只回复“清除后第一轮”，不调用工具。");
    const firstClearedPayload = payloadForPrompt(clearedPayloads, "只回复“清除后第一轮”，不调用工具。");
    check("清除后轮次归零：第 1 轮不追加提醒", lastUserTextInPayload(firstClearedPayload) === "只回复“清除后第一轮”，不调用工具。");
    check("清除后的 payload 不含清除前的对话", !firstClearedPayload.includes("准备好了"));
    clearedPayloads.length = 0;
    await prompt(taId, "只回复“清除后第二轮”，不调用工具。");
    check("清除后第 2 轮命中助教文案", userTextOf(clearedPayloads, "只回复“清除后第二轮”，不调用工具。") === `只回复“清除后第二轮”，不调用工具。\n\n${reminderTemplates.助教}`);
    check("间隔恢复默认 30", (await api("PATCH", "/api/config/settings", { reminderIntervalTurns: 30 })).json.app.reminderIntervalTurns === 30);
    check("清除后新历史真实落新 JSONL", (await fs.readFile(taRowAfterClear.path, "utf8")).includes("清除后第一轮"));

    console.log("\n[8] 账号、模型配置与学习日历 HTTP 契约");
    result = await api("GET", "/api/review-schedule?upcomingDays=14&historyDays=14");
    check("学习日历声明 UTC 与真实查询范围", result.status === 200 && result.json.timezone === "UTC"
      && result.json.range.upcomingDays === 14 && result.json.range.historyDays === 14);
    check("学习日历只返回可复算聚合", ["normalCards", "proposedCards", "dueNow", "overdue", "withoutSchedule"]
      .every((key) => Number.isInteger(result.json.totals[key])) && Array.isArray(result.json.upcoming) && Array.isArray(result.json.history));
    check("学习日历拒绝不存在 Topic", (await api("GET", "/api/review-schedule?topicId=999999")).status === 404);
    check("学习日历拒绝超大范围", (await api("GET", "/api/review-schedule?upcomingDays=366")).status === 400);

    result = await api("GET", "/api/config/models");
    check("模型配置公开 Known API 与默认来源", Array.isArray(result.json.knownApis) && result.json.knownApis.includes("anthropic-messages")
      && result.json.defaultModel.source === "env" && result.json.defaultModel.editable === false);
    const configText = JSON.stringify(result.json);
    check("模型配置出口只有凭据布尔与固定掩码", result.json.providers.every((provider: any) => typeof provider.apiKeyConfigured === "boolean"
      && Array.isArray(provider.headerNames) && !Object.prototype.hasOwnProperty.call(provider, "apiKey") && !Object.prototype.hasOwnProperty.call(provider, "headers")));
    check("模型配置不泄漏环境引用或命令引用", !configText.includes("$VAR") && !configText.includes("${VAR}") && !configText.includes("!command"));
    check("环境变量固定时默认模型写入被拒", (await api("PATCH", "/api/config/default-model", {
      provider: process.env.PI_TEACHER_PROVIDER, modelId: process.env.PI_TEACHER_MODEL,
    })).status === 409);
    result = await api("GET", "/api/config/settings");
    check("运行设置只公开受控字段", result.status === 200
      && ["defaultProvider", "defaultModel", "retryEnabled", "retry"].every((key) => Object.prototype.hasOwnProperty.call(result.json.settings, key)));
    const toggledRetry = !result.json.settings.retryEnabled;
    result = await api("PATCH", "/api/config/settings", { retryEnabled: toggledRetry });
    check("重试开关可真实写入并读回", result.status === 200 && result.json.settings.retryEnabled === toggledRetry
      && (await api("GET", "/api/config/settings")).json.settings.retryEnabled === toggledRetry);
    check("运行设置拒绝白名单外字段", (await api("PATCH", "/api/config/settings", { theme: "dark" })).status === 400);

    check("改用户名要求当前密码", (await api("PATCH", "/api/auth/username", { username: "HTTP新用户名", currentPassword: "wrong" })).status === 401);
    result = await api("PATCH", "/api/auth/username", { username: "HTTP新用户名", currentPassword: "acceptance-password-123" });
    check("改用户名同步当前登录态", result.status === 200 && (await api("GET", "/api/auth/me")).json.username === "HTTP新用户名");
    check("改密码要求当前密码", (await api("PATCH", "/api/auth/password", { currentPassword: "wrong", newPassword: "changed-password-456" })).status === 401);
    result = await api("PATCH", "/api/auth/password", { currentPassword: "acceptance-password-123", newPassword: "changed-password-456" });
    cookie = (result.headers.get("set-cookie") ?? "").split(";")[0];
    check("改密码为当前浏览器换发新 cookie", result.status === 200 && cookie.length > 20
      && (await api("GET", "/api/auth/me")).json.username === "HTTP新用户名");
    check("旧密码已失效", (await api("POST", "/api/auth/login", { username: "HTTP新用户名", password: "acceptance-password-123" })).status === 401);
    check("新密码可以登录", (await api("POST", "/api/auth/login", { username: "HTTP新用户名", password: "changed-password-456" })).status === 200);

    console.log("\n[8b] 用户环境变量 HTTP 契约与 process.env 即时生效");
    // 值随机生成，只存在于本进程与临时库；明文存储、明文回显（ADR-0034）。
    const envKeyValue = `http-smoke-key-${randomBytes(12).toString("hex")}`;
    const envPlainValue = `plain-${randomBytes(6).toString("hex")}`;
    const envTimeout = `${randomInt(101, 899)}s`;
    result = await api("GET", "/api/config/user-env");
    check("用户环境变量列表带内置项", result.status === 200 && Array.isArray(result.json.items)
      && ["TAVILY_API_KEY", "TAVILY_BASE_URL", "TAVILY_TIMEOUT",
        "EXA_API_KEY", "EXA_BASE_URL", "EXA_TIMEOUT",
        "FIRECRAWL_API_KEY", "FIRECRAWL_BASE_URL", "JINA_API_KEY", "JINA_BASE_URL",
        "DAYTONA_API_KEY", "E2B_API_KEY", "CODESANDBOX_API_KEY",
      ].every((key) => result.json.items.some((item: any) => item.key === key && item.builtin === true)));
    check("未设置的内置项 configured=false 且无 value", result.json.items.filter((item: any) => item.builtin && !item.configured)
      .every((item: any) => !Object.prototype.hasOwnProperty.call(item, "value")));
    check("PATCH 拒绝空对象", (await api("PATCH", "/api/config/user-env", {})).status === 400);
    check("PATCH 拒绝受保护变量名", (await api("PATCH", "/api/config/user-env", { PATH: "/tmp" })).status === 400
      && (await api("PATCH", "/api/config/user-env", { PI_TEACHER_HOME: "/tmp" })).status === 400);
    check("PATCH 拒绝非法变量名", (await api("PATCH", "/api/config/user-env", { "lower-case": "x" })).status === 400);
    check("PATCH 拒绝非文本值", (await api("PATCH", "/api/config/user-env", { TAVILY_TIMEOUT: { value: "1s" } })).status === 400);
    check("PATCH 拒绝空串值", (await api("PATCH", "/api/config/user-env", { TAVILY_TIMEOUT: "" })).status === 400);
    result = await api("PATCH", "/api/config/user-env", { TAVILY_API_KEY: envKeyValue, HTTP_SMOKE_PLAIN: envPlainValue });
    check("保存内置项与新增用户项成功", result.status === 200 && result.json.success === true);
    check("保存响应明文回显内置项的值", result.json.items.some((item: any) => item.key === "TAVILY_API_KEY" && item.builtin === true && item.configured === true && item.value === envKeyValue));
    check("新增的用户项回显值且标记为用户项", result.json.items.some((item: any) => item.key === "HTTP_SMOKE_PLAIN" && item.builtin === false && item.configured === true && item.value === envPlainValue));
    check("保存后 process.env 立即生效", process.env.TAVILY_API_KEY === envKeyValue && process.env.HTTP_SMOKE_PLAIN === envPlainValue);
    check("表里是明文值", (db.prepare("SELECT value FROM user_env WHERE key=?").get("HTTP_SMOKE_PLAIN") as { value: string }).value === envPlainValue);
    check("GET 列表回显已保存的值", (await api("GET", "/api/config/user-env")).json.items.some((item: any) => item.key === "TAVILY_API_KEY" && item.value === envKeyValue));
    check("DELETE 拒绝受保护变量名", (await api("DELETE", "/api/config/user-env/PATH")).status === 400);
    check("DELETE 不存在的用户项返回 404", (await api("DELETE", "/api/config/user-env/HTTP_SMOKE_MISSING")).status === 404);
    result = await api("DELETE", "/api/config/user-env/HTTP_SMOKE_PLAIN");
    check("删除用户项后不再列出且离开 process.env", result.status === 200 && !result.json.items.some((item: any) => item.key === "HTTP_SMOKE_PLAIN") && process.env.HTTP_SMOKE_PLAIN === undefined);
    result = await api("DELETE", "/api/config/user-env/TAVILY_API_KEY");
    check("清空内置项后仍列出但 configured=false", result.status === 200
      && result.json.items.some((item: any) => item.key === "TAVILY_API_KEY" && item.builtin === true && item.configured === false && !Object.prototype.hasOwnProperty.call(item, "value"))
      && process.env.TAVILY_API_KEY === undefined);
    // 真模型：保存的值经 process.env 继承进 bash 子进程，不需要重开会话；不依赖 Tavily 网络。
    result = await api("PATCH", "/api/config/user-env", { TAVILY_TIMEOUT: envTimeout });
    check("保存 TAVILY_TIMEOUT 成功且回显", result.status === 200 && result.json.items.some((item: any) => item.key === "TAVILY_TIMEOUT" && item.value === envTimeout));
    const toolsForEnv = (await api("POST", `/api/conversations/${id}/command`, { type: "get_tools" })).json.data;
    check("会话带 Pi 默认 bash 工具", toolsForEnv.some((tool: any) => tool.name === "bash" && tool.active));
    await prompt(id, "请实际调用 bash 工具执行命令 echo $TAVILY_TIMEOUT，然后把命令输出原样回复给我，不要解释，不要调用其他工具。");
    const envHistory = getSessionWrapper(sessionKeyFor(id))!.inner.sessionManager.getEntries();
    const bashResultsWithTimeout = envHistory.filter((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "bash"
      && JSON.stringify(entry.message.content).includes(envTimeout));
    check("bash 子进程实际读到刚保存的 TAVILY_TIMEOUT", bashResultsWithTimeout.length > 0);
    const lastEnvAssistant = [...envHistory].reverse().find((entry) => entry.type === "message" && entry.message.role === "assistant");
    const lastEnvAssistantText = lastEnvAssistant?.type === "message" && lastEnvAssistant.message.role === "assistant"
      ? lastEnvAssistant.message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
      : "";
    check("模型回答包含新值", lastEnvAssistantText.includes(envTimeout));

    console.log("\n[9] 回收、稳定身份恢复、SPA 与登出");
    const previousPath = getPiSession(db, id).path;
    const messageCount = (await api("GET", `/api/conversations/${id}/context`)).json.messages.length;
    await api("POST", `/api/conversations/${id}/close`);
    await waitFor(() => events.some((event) => event.type === "session_recycled"), "回收事件", 5000);
    result = await api("POST", `/api/conversations/${id}/command`, { type: "get_state" });
    check("回收后 command 404 且不自动创建", result.status === 404 && result.json.error === "Pi Session 已回收，请重新打开");
    check("回收后 events 404", (await api("GET", `/api/conversations/${id}/events`)).status === 404);
    const reopened = await api("POST", `/api/conversations/${id}/open`);
    check("稳定 ID 恢复原会话", reopened.json.conversation.id === id && getPiSession(db, id).path === previousPath);
    check("恢复保留历史", (await api("GET", `/api/conversations/${id}/context`)).json.messages.length === messageCount);
    check("恢复保留所选模型", reopened.json.runtime.model.provider === process.env.PI_TEACHER_PROVIDER && reopened.json.runtime.model.id === process.env.PI_TEACHER_MODEL);
    const reconnected = openEvents(id);
    await waitFor(() => reconnected.some((event) => event.type === "connected"), "恢复后的 SSE", 10_000);
    check("重新连接收到握手", reconnected[0].type === "connected");
    if (existsSync(path.resolve(import.meta.dirname, "../../../web/dist/index.html"))) {
      // 设置改为 /app 之上的覆盖层路径后，这些新路径必须能被直接访问和刷新。
      for (const spaPath of ["/settings", "/app/settings?tab=models", `/app/c/${id}/settings?tab=account`, "/app/calendar", `/app/c/${id}/help`]) {
        const page = await fetch(`${baseUrl}${spaPath}`);
        check(`SPA fallback 支持直接访问 ${spaPath}`, page.status === 200 && (await page.text()).includes('id="root"'));
      }
    } else { skipped += 1; console.log("  - 跳过 SPA 检查：web/dist 尚未构建，前端构建后必须重跑"); }
    console.log("\n[10] 真删除：对话与 Space（ADR-0037）");
    check("助教不可删除（403）", (await api("DELETE", `/api/conversations/${taId}`)).status === 403 && getSessionWrapper(sessionKeyFor(taId))!.isAlive());
    check("删除不存在的对话 404", (await api("DELETE", "/api/conversations/999999")).status === 404);
    // 复习会话：完成提醒验证后处于空闲，删除要连同 wrapper 一起关掉。
    const reviewId = review.json.conversation.id as number;
    check("复习会话此时有活着的 wrapper", getSessionWrapper(sessionKeyFor(reviewId))?.isAlive() === true);
    const reviewRow = getPiSession(db, reviewId);
    result = await api("DELETE", `/api/conversations/${reviewId}`);
    check("删除已打开但空闲的复习会话成功且声明文件保留", result.status === 200 && result.json.success === true && result.json.filesRetained === true);
    check("删除后行不存在、JSONL 已删、工作目录保留、wrapper 已关", !db.prepare("SELECT id FROM pi_session WHERE id = ?").get(reviewId)
      && !existsSync(reviewRow.path) && existsSync(path.join(reviewRow.work_path, "AGENTS.md")) && getSessionWrapper(sessionKeyFor(reviewId)) === undefined);
    check("删除后再访问 404 且不是回收码", (await api("GET", `/api/conversations/${reviewId}/context`)).status === 404
      && (await api("POST", `/api/conversations/${reviewId}/command`, { type: "get_state" })).json.code !== "session_recycled");
    check("删除后列表不再包含它", !(await api("GET", "/api/conversations?spaceId=1")).json.conversations.some((conversation: any) => conversation.id === reviewId));
    // 运行中的学习会话：删除要先 abort 再 shutdown，不能 409，SSE 收到 session_recycled。
    const runningEvents = openEvents(id);
    await waitFor(() => runningEvents.some((event) => event.type === "connected"), "删除前 SSE connected", 10_000);
    const runningPrompt = await api("POST", `/api/conversations/${id}/command`, { type: "prompt", message: "请从 1 数到 200，每个数字单独一行，不要调用工具。" });
    check("删除前的 prompt 已被接受", runningPrompt.status === 200);
    await waitFor(() => getSessionWrapper(sessionKeyFor(id))?.isRunning() === true, "模型开始运行", 30_000);
    const runningRow = getPiSession(db, id);
    const deletedWhileRunning = await api("DELETE", `/api/conversations/${id}`);
    check("运行中的对话可直接删除（先 abort 再 shutdown）", deletedWhileRunning.status === 200 && deletedWhileRunning.json.filesRetained === true);
    await waitFor(() => runningEvents.some((event) => event.type === "session_recycled"), "删除时 SSE 收到 session_recycled", 5000);
    // 同一会话上还挂着 [9] 的另一条 SSE：emit 遍历快照后两条都必须收到回收事件（曾因 splice 跳过第二条）。
    await waitFor(() => reconnected.some((event) => event.type === "session_recycled"), "同会话的另一条 SSE 也收到 session_recycled", 5000);
    check("删除后 wrapper 不在注册表", getSessionWrapper(sessionKeyFor(id)) === undefined);
    check("删除后行与 JSONL 都没了、附件仍在磁盘", !db.prepare("SELECT id FROM pi_session WHERE id = ?").get(id) && !existsSync(runningRow.path)
      && existsSync(path.join(runningRow.work_path, attachment.relativePath)));
    check("删除后 open 404", (await api("POST", `/api/conversations/${id}/open`)).status === 404);
    // Space 删除：其余会话（secondId 仍打开着）逐条 shutdown + 真删除，再删 space 行；不再因运行中而 409。
    const secondRowBeforeDelete = getPiSession(db, secondId);
    const essenceBeforeSpaceDelete = await fs.readFile(preservedEssencePath);
    check("Space 里还有已打开的会话", getSessionWrapper(sessionKeyFor(secondId))?.isAlive() === true);
    result = await api("DELETE", `/api/workspaces/${spaceId}`);
    check("删除学习 Space 成功", result.status === 200 && result.json.filesRetained === true);
    check("Space 行与其对话行都删除，JSONL 删除、目录保留", !db.prepare("SELECT id FROM space WHERE id = ?").get(spaceId)
      && !db.prepare("SELECT id FROM pi_session WHERE space_id = ?").get(spaceId)
      && !existsSync(secondRowBeforeDelete.path) && existsSync(path.join(secondRowBeforeDelete.work_path, "AGENTS.md")));
    check("删除 Space 后仍保留已有学习精华", (await fs.readFile(preservedEssencePath)).equals(essenceBeforeSpaceDelete));
    check("Space 内会话的 wrapper 已关闭", getSessionWrapper(sessionKeyFor(secondId)) === undefined);
    check("删除后的 Space 404", (await api("DELETE", `/api/workspaces/${spaceId}`)).status === 404);

    check("未知 API 仍返回 JSON 404", (await api("GET", "/api/nonexistent")).status === 404);
    check("登出成功", (await api("POST", "/api/auth/logout")).status === 200);
    check("登出后的旧 cookie 已失效", (await api("GET", "/api/workspaces")).status === 401);
    console.log(`\nHTTP 验收：${passed} 通过，0 失败，${skipped} 跳过`);
  } finally {
    for (const controller of streamControllers) controller.abort();
    await Promise.allSettled(streamTasks);
    await shutdownAllSessions();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase();
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error("HTTP 验收失败：", error instanceof Error ? error.message : "未知错误"); process.exitCode = 1; });
