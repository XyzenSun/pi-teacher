/**
 * 附件与工作目录文件索引的领域实现：文件名校验、路径边界、MIME 判定、磁盘元信息
 * 全部收在这里，HTTP 层（routes/attachments.ts）只做协议转换。prompt 命令要把
 * attachmentIds / name 还原成真实图片内容也复用本模块——「能下载的」与「能喂给
 * 模型的」永远走同一套校验，不可能出现两套口径。
 *
 * 存放位置：当前 Pi Session 的 `work_path/files/`（Session Files，ADR-0038；HTTP 路由与
 * 本模块名保留 attachments——那是「上传」这个动作的名字）。这里不建任何数据库表——附件的
 * 唯一事实来源是磁盘：模型自己在 files/ 下写出的图片也必须能被列出、下载、引用，所以
 * 列表一律 readdir 现算，绝不返回数据库里登记过、磁盘上已不存在的「假文件」。
 *
 * 安全边界（移植 pi-web v0.8.11 lib/file-upload.ts + path-security.ts 的思路，
 * 见 docs/pi-web-研究/04-API与基础设施.md §2.4）：
 *   1. 文件名必须是纯 basename：拒 `.`/`..`/`/`/`\`/控制字符/隐藏名/超长名；
 *   2. 目录侧双段校验：lstat 拒绝 files 目录自身是符号链接（否则一个链接就能把
 *      上传写到工作目录外），再对 realpath 做词法包含判定；
 *   3. 文件侧读用 O_NOFOLLOW、写用 `wx`（O_CREAT|O_EXCL）：符号链接既读不出去，
 *      也不会被顺着覆盖；同名冲突一律 409，不静默覆盖用户已有附件；
 *   4. 对外只出现相对路径（`files/<name>`）：绝对路径与工作目录既不进成功
 *      响应，也不进错误消息（db/types.ts 对 work_path 的约定）。
 *
 * 刻意**不**做 AI 文件沙箱——沙箱是部署层的事（ADR-0015 Docker）。本模块防的是
 * HTTP 侧的路径穿越与浏览器侧的内容执行，不是模型的文件权限。
 */
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { PiSessionRow } from "../db/types.ts";
import { HttpError } from "../routes/http.ts";
import { isPathWithinRoots } from "../security/path-security.ts";
import { getPiSession, SESSION_FILES_DIR_NAME } from "./repository.ts";

/** 改名前的目录名（ADR-0038），只在启动迁移里出现；之后程序不再认识它。 */
const LEGACY_ATTACHMENTS_DIR_NAME = "attachments";

/** 单个附件上限。必须与 ATTACHMENT_BODY_LIMIT 同源，否则会出现「过了 body 解析
 *  却被业务拒绝」或反之的错位。 */
export const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024;

/** express.raw 的 limit 写法（字符串形式的同一个数）。 */
export const ATTACHMENT_BODY_LIMIT = "16mb";

/** 文件名字节上限：ext4 的单文件名上限就是 255 字节。 */
export const MAX_ATTACHMENT_NAME_BYTES = 255;

/** file-index 单次最多返回多少条相对路径，超出则 truncated = true。 */
export const FILE_INDEX_LIMIT = 200;

/** file-index 遍历护栏：工作目录不该很大，超限即停并置 truncated。 */
const FILE_INDEX_MAX_DIRECTORIES = 2000;
const FILE_INDEX_MAX_DEPTH = 10;
const FILE_INDEX_MAX_CANDIDATES = 5000;

/** 依赖目录没有引用价值，且能一个人撑爆整个索引。 */
const SKIPPED_DIRECTORY_NAMES = new Set(["node_modules"]);

/** 会话历史（jsonl）不是用户文件，不进 @ 补全。 */
const SKIPPED_FILE_EXTENSIONS = new Set([".jsonl"]);

/**
 * 只有这四种位图允许 `?inline=1` 由浏览器直接呈现，且必须 magic 确认。
 * HTML/SVG 能在同源里执行脚本并回调 /api（04-API与基础设施.md §2.4 的原话），
 * 所以它们永远只能作为附件下载。
 */
const INLINE_SAFE_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** 扩展名 → MIME。只作为「magic 认不出来」时的兜底，且不足以让内容 inline。 */
const MIME_TYPES_BY_EXTENSION = new Map<string, string>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".bmp", "image/bmp"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
  [".pdf", "application/pdf"],
  [".zip", "application/zip"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".txt", "text/plain"],
  [".md", "text/markdown"],
  [".markdown", "text/markdown"],
  [".csv", "text/csv"],
  [".json", "application/json"],
  [".xml", "application/xml"],
  [".yaml", "application/yaml"],
  [".yml", "application/yaml"],
  [".html", "text/html"],
  [".htm", "text/html"],
  [".mp3", "audio/mpeg"],
  [".wav", "audio/wav"],
  [".mp4", "video/mp4"],
]);

/** 浏览器会把这些内容当文档解释执行，不管谁说它是什么，一律只准下载。 */
const NEVER_INLINE_MIME_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "application/xml",
  "text/xml",
  "image/svg+xml",
]);

export interface AttachmentMeta {
  /** 稳定编码后的文件名（base64url）：前端可当不透明 id 用，也可反解回 name。 */
  id: string;
  name: string;
  /** 相对 Pi Session 工作目录的路径，永远是 `files/<name>`。 */
  relativePath: string;
  mimeType: string;
  size: number;
  /** 磁盘 mtime（ISO）：附件可能由模型直接写出，列表要如实反映磁盘。 */
  modifiedAt: string;
}

/** 供 prompt 命令使用：base64 图片内容（不含 data: 前缀）+ 服务端判定的 MIME。 */
export interface AttachmentImage {
  data: string;
  mimeType: string;
}

export interface FileIndexResult {
  files: string[];
  truncated: boolean;
}

/** 内部读取结果：元信息 + 该内容是否允许浏览器 inline 呈现。 */
interface AttachmentFileInfo {
  meta: AttachmentMeta;
  inlineSafe: boolean;
  data?: Buffer;
}

// ============================================================================
// id 编码：稳定、可反解、URL 安全
// ============================================================================

export function encodeAttachmentId(name: string): string {
  return Buffer.from(name, "utf8").toString("base64url");
}

/**
 * 反解 id。要求 round-trip 完全一致，所以「看起来像 base64url 的普通文件名」
 * （例如 `photo`）解不出有效值，会被上层按原始 name 处理。
 */
function decodeAttachmentId(candidate: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(candidate)) return null;
  const decoded = Buffer.from(candidate, "base64url").toString("utf8");
  if (!decoded || encodeAttachmentId(decoded) !== candidate) return null;
  return decoded;
}

// ============================================================================
// 文件名校验
// ============================================================================

/** ASCII 控制字符 + DEL：文件系统允许，但会污染日志与 HTTP 头。 */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * 校验附件名，通过则原样返回。刻意不做任何静默改写：改写过的名字会让「上传返回的
 * name」与「磁盘上的 name」不一致，之后的引用与下载就会失配。
 */
export function assertSafeAttachmentName(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) throw new HttpError(400, "附件名不能为空");
  if (raw !== raw.trim()) throw new HttpError(400, "附件名首尾不能有空白字符");
  if (CONTROL_CHARACTERS.test(raw)) throw new HttpError(400, "附件名不能包含控制字符");
  if (raw.includes("/") || raw.includes("\\")) throw new HttpError(400, "附件名不能包含路径分隔符");
  if (raw === "." || raw === "..") throw new HttpError(400, "附件名不能是 . 或 ..");
  if (raw.startsWith(".")) throw new HttpError(400, "附件名不能以 . 开头");
  if (path.basename(raw) !== raw) throw new HttpError(400, "附件名必须是单个文件名");
  if (Buffer.byteLength(raw, "utf8") > MAX_ATTACHMENT_NAME_BYTES) {
    throw new HttpError(400, `附件名不能超过 ${MAX_ATTACHMENT_NAME_BYTES} 字节`);
  }
  return raw;
}

function isSafeAttachmentName(candidate: string): boolean {
  try {
    assertSafeAttachmentName(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * 解析上传协议里的 `X-File-Name`：值是 encodeURIComponent(原始文件名)。
 * 为兼容「本来就是纯 ASCII、客户端没编码」的情况，解码失败时退回原值再校验。
 */
export function readAttachmentNameHeader(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new HttpError(400, "缺少 X-File-Name 请求头（值为 encodeURIComponent(文件名)）");
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  return assertSafeAttachmentName(decoded);
}

/**
 * `X-File-Type` 是可选的「客户端声称的原始 MIME」，只校验格式，绝不参与响应的
 * Content-Type：浏览器实际拿到的 MIME 一律由服务端从扩展名 + magic 推出，否则
 * 客户端就能把任意文件声明成 text/html，在同源里执行。
 */
export function assertDeclaredMimeTypeShape(raw: unknown): void {
  if (raw === undefined) return;
  if (typeof raw !== "string" || raw.length > 100 || !/^[\w.+-]+\/[\w.+-]+$/.test(raw)) {
    throw new HttpError(400, "X-File-Type 不是合法的 MIME 类型");
  }
}

// ============================================================================
// 目录解析（拒绝符号链接目录 + realpath 包含校验）
// ============================================================================

function realWorkPath(row: PiSessionRow): string {
  try {
    return realpathSync(row.work_path);
  } catch {
    throw new HttpError(404, "对话的工作目录不存在");
  }
}

/** 目录必须是「真目录」而非符号链接，且 realpath 仍落在工作目录内。 */
function assertUsableAttachmentsDir(directory: string, workPath: string): string {
  let stats;
  try {
    // lstat 而非 stat：files 目录若是符号链接，写入就会被引到工作目录外
    stats = lstatSync(directory);
  } catch {
    throw new HttpError(403, "附件目录不可用");
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new HttpError(403, "附件目录不可用");

  const realDirectory = realpathSync(directory);
  // 第二段：上层目录里的链接也不能把我们带出工作目录
  if (!isPathWithinRoots(realDirectory, new Set([workPath]))) throw new HttpError(403, "附件目录不可用");
  return realDirectory;
}

/** 上传用：目录不存在就建（历史会话或模型清理过目录时仍要能上传）。 */
function resolveAttachmentsDirForWrite(row: PiSessionRow): string {
  const workPath = realWorkPath(row);
  const directory = path.join(workPath, SESSION_FILES_DIR_NAME);
  try {
    mkdirSync(directory, { recursive: true });
  } catch {
    // EEXIST 以外的失败（含目录位置是个链接/普通文件）都在下面统一判定为不可用
  }
  return assertUsableAttachmentsDir(directory, workPath);
}

/**
 * 读取用：目录不存在返回 null，让列表返回空数组而不是 404——
 * 「还没上传过」不是错误。目录存在但形态可疑（链接）仍然 403。
 */
function resolveAttachmentsDirForRead(row: PiSessionRow): string | null {
  const workPath = realWorkPath(row);
  const directory = path.join(workPath, SESSION_FILES_DIR_NAME);
  try {
    lstatSync(directory);
  } catch {
    return null;
  }
  return assertUsableAttachmentsDir(directory, workPath);
}

/**
 * 一次性迁移（ADR-0038）：旧部署的 `attachments/` 改名为 `files/`。只在启动时跑一遍：
 * `attachments/` 是真目录且 `files/` 不存在才 rename；两者并存不动、只记日志（相对信息，
 * 不打绝对路径）。行不存在于磁盘的会话直接跳过。之后程序不再认识 `attachments/`。
 */
export function renameLegacyAttachmentDirs(db: Database.Database): { renamed: number; skipped: number } {
  let renamed = 0;
  let skipped = 0;
  const rows = db.prepare("SELECT id, work_path FROM pi_session").all() as Array<{ id: number; work_path: string }>;
  for (const row of rows) {
    const legacy = path.join(row.work_path, LEGACY_ATTACHMENTS_DIR_NAME);
    const target = path.join(row.work_path, SESSION_FILES_DIR_NAME);
    let legacyStats;
    try {
      legacyStats = lstatSync(legacy);
    } catch {
      continue;
    }
    if (!legacyStats.isDirectory()) continue;
    let targetExists = true;
    try {
      lstatSync(target);
    } catch {
      targetExists = false;
    }
    if (targetExists) {
      skipped += 1;
      console.warn(`[attachments] Pi Session ${row.id} 同时存在 attachments/ 与 files/，未迁移，请手动合并`);
      continue;
    }
    renameSync(legacy, target);
    renamed += 1;
  }
  return { renamed, skipped };
}

// ============================================================================
// MIME 判定：magic 优先，扩展名兜底，可执行内容永不 inline
// ============================================================================

function startsWithBytes(head: Buffer, bytes: readonly number[]): boolean {
  if (head.length < bytes.length) return false;
  return bytes.every((byte, index) => head[index] === byte);
}

/** 只识别少量「结构明确、误判概率极低」的头部，不做通用类型嗅探。 */
function sniffMimeType(head: Buffer): string | null {
  if (startsWithBytes(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWithBytes(head, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (head.length >= 6) {
    const gifSignature = head.subarray(0, 6).toString("latin1");
    if (gifSignature === "GIF87a" || gifSignature === "GIF89a") return "image/gif";
  }
  if (
    head.length >= 12 &&
    head.subarray(0, 4).toString("latin1") === "RIFF" &&
    head.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  if (startsWithBytes(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  if (startsWithBytes(head, [0x50, 0x4b, 0x03, 0x04])) return "application/zip";
  return null;
}

function extensionMimeType(name: string): string | null {
  return MIME_TYPES_BY_EXTENSION.get(path.extname(name).toLowerCase()) ?? null;
}

/**
 * 判定对外 MIME 与 inline 资格。设计意图：
 * - magic 认出位图 → 用 magic 结果并允许 inline（浏览器要真拿到图才能显示）；
 * - 扩展名说是图片但 magic 不认 → 降级 application/octet-stream：伪装成 .png 的
 *   HTML 既拿不到 image/*，也拿不到 inline；
 * - zip 家族靠扩展名细化（docx/xlsx/pptx 本质都是 zip），但一律不 inline；
 * - HTML/SVG/XML 无论怎么来都在 NEVER_INLINE 名单里。
 */
export function resolveContentType(name: string, head: Buffer): { mimeType: string; inlineSafe: boolean } {
  const sniffed = sniffMimeType(head);
  const byExtension = extensionMimeType(name);

  if (sniffed !== null && INLINE_SAFE_IMAGE_MIME_TYPES.has(sniffed)) {
    return { mimeType: sniffed, inlineSafe: true };
  }
  if (sniffed === "application/zip" && byExtension !== null && byExtension.includes("openxmlformats")) {
    return { mimeType: byExtension, inlineSafe: false };
  }
  if (sniffed !== null) return { mimeType: sniffed, inlineSafe: false };

  if (byExtension !== null) {
    if (byExtension.startsWith("image/") && byExtension !== "image/svg+xml") {
      // 扩展名声称是位图却没过 magic：不给 image/*，避免「看着是图其实是脚本」
      return { mimeType: "application/octet-stream", inlineSafe: false };
    }
    return { mimeType: byExtension, inlineSafe: false };
  }
  return { mimeType: "application/octet-stream", inlineSafe: false };
}

/** 文本类型要带 charset，否则浏览器按本地编码解析中文会乱码。 */
export function contentTypeHeaderValue(mimeType: string): string {
  const needsCharset =
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/xml" ||
    mimeType === "application/yaml";
  return needsCharset ? `${mimeType}; charset=utf-8` : mimeType;
}

export function isNeverInlineMimeType(mimeType: string): boolean {
  return NEVER_INLINE_MIME_TYPES.has(mimeType);
}

// ============================================================================
// 文件读取原语（O_NOFOLLOW + 显式 position，不依赖文件游标）
// ============================================================================

function openAttachmentForRead(directory: string, name: string): number {
  const filePath = path.join(directory, name);
  // name 已过 basename 校验，这里是纵深防御：拼出来的路径必须仍在目录内
  if (!isPathWithinRoots(filePath, new Set([directory]))) throw new HttpError(400, "附件名不合法");
  try {
    // O_NOFOLLOW：末段是符号链接时直接 ELOOP，HTTP 自己绝不顺着链接读到目录外
    return openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EACCES" || code === "EPERM" || code === "EISDIR") {
      throw new HttpError(403, "附件不可读取");
    }
    throw new HttpError(404, "附件不存在");
  }
}

function readAt(fd: number, size: number, from = 0): Buffer {
  if (size <= 0) return Buffer.alloc(0);
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const bytesRead = readSync(fd, buffer, offset, size - offset, from + offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return offset === size ? buffer : buffer.subarray(0, offset);
}

/** 打开 → fstat → 读头部 → 组装元信息；wantData 时连内容一起读出来。 */
function inspectAttachment(directory: string, name: string, wantData: boolean): AttachmentFileInfo {
  const fd = openAttachmentForRead(directory, name);
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new HttpError(404, "附件不存在");
    if (stats.size > MAX_ATTACHMENT_BYTES) throw new HttpError(413, "附件超过大小限制，无法读取");

    const head = readAt(fd, Math.min(32, stats.size));
    const { mimeType, inlineSafe } = resolveContentType(name, head);
    const meta: AttachmentMeta = {
      id: encodeAttachmentId(name),
      name,
      relativePath: `${SESSION_FILES_DIR_NAME}/${name}`,
      mimeType,
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    };
    return wantData ? { meta, inlineSafe, data: readAt(fd, stats.size) } : { meta, inlineSafe };
  } finally {
    closeSync(fd);
  }
}

/** lstat 判「是普通文件」：符号链接在这里等于不存在，列表与下载都看不见它。 */
function isRegularFile(directory: string, name: string): boolean {
  try {
    return lstatSync(path.join(directory, name)).isFile();
  } catch {
    return false;
  }
}

/**
 * 把「id 或 name」解析成磁盘上真实存在的文件名：两个候选都试（id 反解值优先），
 * 谁在磁盘上就用谁。这样 prompt 命令传 id、前端手拼 name 都能工作，调用方不必
 * 记住该用哪种形态。
 */
function resolveAttachmentName(directory: string, idOrName: unknown): string {
  if (typeof idOrName !== "string" || idOrName.length === 0) throw new HttpError(400, "附件名不能为空");
  const candidates: string[] = [];
  const decoded = decodeAttachmentId(idOrName);
  if (decoded !== null) candidates.push(decoded);
  candidates.push(idOrName);

  for (const candidate of candidates) {
    if (isSafeAttachmentName(candidate) && isRegularFile(directory, candidate)) return candidate;
  }
  // 没命中：非法名如实报 400（带具体原因），合法但不存在报 404
  if (!candidates.some(isSafeAttachmentName)) assertSafeAttachmentName(idOrName);
  throw new HttpError(404, "附件不存在");
}

// ============================================================================
// 对外能力
// ============================================================================

/** 保存上传内容。同名冲突 409，绝不覆盖。 */
export function saveAttachment(
  db: Database.Database,
  piSessionId: number,
  headerName: unknown,
  content: Buffer,
): AttachmentMeta {
  const row = getPiSession(db, piSessionId);
  const name = readAttachmentNameHeader(headerName);
  if (content.length === 0) throw new HttpError(400, "附件内容为空");
  if (content.length > MAX_ATTACHMENT_BYTES) throw new HttpError(413, "附件超过大小限制");

  const directory = resolveAttachmentsDirForWrite(row);
  const target = path.join(directory, name);
  if (!isPathWithinRoots(target, new Set([directory]))) throw new HttpError(400, "附件名不合法");

  try {
    // wx = O_CREAT|O_EXCL|O_WRONLY：目标已存在（包括「已存在的符号链接」）直接失败
    writeFileSync(target, content, { flag: "wx", mode: 0o600 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new HttpError(409, "同名附件已存在，请改名后再上传");
    throw new HttpError(403, "附件写入失败");
  }
  return inspectAttachment(directory, name, false).meta;
}

/** 列出附件：元信息全部从磁盘现算，符号链接与非普通文件不出现在结果里。 */
export function listAttachments(db: Database.Database, piSessionId: number): AttachmentMeta[] {
  const row = getPiSession(db, piSessionId);
  const directory = resolveAttachmentsDirForRead(row);
  if (directory === null) return [];

  const metas: AttachmentMeta[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    // 只认普通文件：符号链接的 isFile() 为 false，天然被排除
    if (!entry.isFile()) continue;
    // 模型可能写出任何名字；无法被下载接口寻址的名字就不要列出来骗人
    if (!isSafeAttachmentName(entry.name)) continue;
    try {
      metas.push(inspectAttachment(directory, entry.name, false).meta);
    } catch {
      // 列举期间被删或被换成链接：跳过，列表只反映当下真实可读的文件
    }
  }
  return metas.sort((left, right) => left.name.localeCompare(right.name));
}

/** 只读元信息（不读内容），供 prompt 命令校验 attachmentIds 是否可用。 */
export function getAttachment(db: Database.Database, piSessionId: number, idOrName: unknown): AttachmentMeta {
  const row = getPiSession(db, piSessionId);
  const directory = resolveAttachmentsDirForRead(row);
  if (directory === null) throw new HttpError(404, "附件不存在");
  return inspectAttachment(directory, resolveAttachmentName(directory, idOrName), false).meta;
}

/** 读出内容 + 元信息 + inline 资格，供下载路由使用。 */
export function readAttachment(
  db: Database.Database,
  piSessionId: number,
  idOrName: unknown,
): { meta: AttachmentMeta; inlineSafe: boolean; data: Buffer } {
  const row = getPiSession(db, piSessionId);
  const directory = resolveAttachmentsDirForRead(row);
  if (directory === null) throw new HttpError(404, "附件不存在");
  const result = inspectAttachment(directory, resolveAttachmentName(directory, idOrName), true);
  return { meta: result.meta, inlineSafe: result.inlineSafe, data: result.data ?? Buffer.alloc(0) };
}

/** 能作为图片块直接进对话的附件（ADR-0038）：其余文件只把路径告诉模型。 */
export function isImageAttachment(meta: Pick<AttachmentMeta, "mimeType">): boolean {
  return INLINE_SAFE_IMAGE_MIME_TYPES.has(meta.mimeType);
}

/** 给模型看的人类可读大小：`12 KB`、`1.5 MB`；小于 1 KB 直接给字节数。 */
export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
}

/**
 * 非图片附件的注入文案（ADR-0038）：一行自然语言告诉模型有文件、在哪、多大，由它自己决定
 * 用什么工具读；后端不做内容转换。图片已随消息作为图片块发送，不再列出。
 */
export function describeNonImageAttachments(attachments: readonly AttachmentMeta[]): string {
  return attachments.filter((file) => !isImageAttachment(file))
    .map((file) => `用户上传了文件「${file.name}」，路径 ${file.relativePath}（${formatAttachmentSize(file.size)}）。`)
    .join("\n");
}

/**
 * 把已上传的附件读成模型可用的图片块。用户不发 base64：前端只传 attachmentId /
 * name，真实字节由服务端从磁盘加载——同一张图不会在请求体里被搬第二遍，也不可能
 * 绕过上面这套文件校验。
 */
export function readAttachmentImage(
  db: Database.Database,
  piSessionId: number,
  idOrName: unknown,
): AttachmentImage {
  const { meta, inlineSafe, data } = readAttachment(db, piSessionId, idOrName);
  // inlineSafe 等价于「magic 确认过的位图」，与浏览器 inline 白名单同源
  if (!inlineSafe || !INLINE_SAFE_IMAGE_MIME_TYPES.has(meta.mimeType)) {
    throw new HttpError(400, "该附件不是受支持的图片格式（PNG / JPEG / GIF / WEBP）");
  }
  return { data: data.toString("base64"), mimeType: meta.mimeType };
}

/** 批量版本：prompt 命令拿到的是 attachmentIds 数组，顺序与入参一致。 */
export function readAttachmentImages(
  db: Database.Database,
  piSessionId: number,
  idsOrNames: readonly unknown[],
): AttachmentImage[] {
  return idsOrNames.map((idOrName) => readAttachmentImage(db, piSessionId, idOrName));
}

// ============================================================================
// file-index：@ 补全用的工作目录文件索引
// ============================================================================

function shouldSkipDirectory(name: string): boolean {
  return name.startsWith(".") || SKIPPED_DIRECTORY_NAMES.has(name);
}

function shouldSkipFile(name: string): boolean {
  if (name.startsWith(".")) return true; // .env / .git 残留等隐藏文件
  if (name.toLowerCase().endsWith(".env")) return true; // prod.env 这类不以点开头的凭据文件
  return SKIPPED_FILE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

/**
 * 搜索当前 Pi Session 工作目录下真实存在的文件相对路径（供输入框 @ 补全）。
 *
 * 只在这一个目录里 BFS：没有 cwd 参数、不接受调用方给的根，所以它不可能变成全盘
 * 浏览器（pi-web 的立场：文件接口不是通用文件浏览器）。跳过符号链接（既不跟出去
 * 也避免目录环）、隐藏目录、node_modules、jsonl 与 .env。q 为空时即列全部（前端
 * 打开 @ 菜单时先整取一次，再本地过滤，见 03c-输入框交互.md）。
 */
export function searchFileIndex(db: Database.Database, piSessionId: number, query: string): FileIndexResult {
  const row = getPiSession(db, piSessionId);
  const workPath = realWorkPath(row);

  const normalizedQuery = query.trim().toLowerCase();
  const candidates: string[] = [];
  let truncated = false;
  let visitedDirectories = 0;

  const queue: Array<{ absolute: string; relative: string; depth: number }> = [
    { absolute: workPath, relative: "", depth: 0 },
  ];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visitedDirectories >= FILE_INDEX_MAX_DIRECTORIES) {
      truncated = true;
      break;
    }
    visitedDirectories += 1;

    let entries;
    try {
      entries = readdirSync(current.absolute, { withFileTypes: true });
    } catch {
      continue; // 无权读或已被删：跳过这棵子树，不让整次搜索失败
    }

    for (const entry of entries) {
      // 符号链接一律跳过：既防指向工作目录外，也防目录环
      if (entry.isSymbolicLink()) continue;
      const relative = current.relative === "" ? entry.name : `${current.relative}/${entry.name}`;

      if (entry.isDirectory()) {
        if (shouldSkipDirectory(entry.name)) continue;
        if (current.depth + 1 > FILE_INDEX_MAX_DEPTH) {
          truncated = true;
          continue;
        }
        queue.push({ absolute: path.join(current.absolute, entry.name), relative, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      if (shouldSkipFile(entry.name)) continue;
      if (normalizedQuery !== "" && !relative.toLowerCase().includes(normalizedQuery)) continue;

      if (candidates.length >= FILE_INDEX_MAX_CANDIDATES) {
        truncated = true;
        break;
      }
      candidates.push(relative);
    }
  }

  // 排序意图：命中文件名的排在只命中路径的前面，其余按路径短→长 + 字典序稳定
  const rank = (relative: string): number => {
    if (normalizedQuery === "") return 0;
    const base = path.basename(relative).toLowerCase();
    if (base.startsWith(normalizedQuery)) return 0;
    if (base.includes(normalizedQuery)) return 1;
    return 2;
  };
  candidates.sort((left, right) => {
    const byRank = rank(left) - rank(right);
    if (byRank !== 0) return byRank;
    if (left.length !== right.length) return left.length - right.length;
    return left.localeCompare(right);
  });

  if (candidates.length > FILE_INDEX_LIMIT) truncated = true;
  return { files: candidates.slice(0, FILE_INDEX_LIMIT), truncated };
}
