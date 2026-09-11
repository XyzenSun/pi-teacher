/**
 * homeDir 下两份由用户直接编辑的 Markdown：全局 AGENTS.md 与全局 USER.md。
 *
 * 两者都是进入模型上下文的自由文本，不做语义校验；只限制长度并保证写入原子性。
 * 出口只回相对文件名，绝对路径属于部署机信息，不给浏览器。
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { HttpError } from "../routes/http.ts";

export const HOME_MARKDOWN_FILES = {
  "user-preferences": { file: "USER.md", maxLength: 8000 },
  // 全局规则进每个会话的 system prompt，上限比偏好宽但仍要压住上下文预算。
  "global-agents-md": { file: "AGENTS.md", maxLength: 20000 },
} as const;
export type HomeMarkdownKind = keyof typeof HOME_MARKDOWN_FILES;
const HOME_MARKDOWN_FILE_MODE = 0o644;

export interface HomeMarkdownView {
  content: string;
  path: string;
}

export function readHomeMarkdown(homeDir: string, kind: HomeMarkdownKind): HomeMarkdownView {
  const { file } = HOME_MARKDOWN_FILES[kind];
  const filePath = path.join(homeDir, file);
  return { content: existsSync(filePath) ? readFileSync(filePath, "utf8") : "", path: file };
}

/** body 只允许 `content` 一个键；超长直接拒绝而不截断，用户改了什么自己清楚。 */
export function readHomeMarkdownContent(body: Record<string, unknown>, kind: HomeMarkdownKind): string {
  const { maxLength } = HOME_MARKDOWN_FILES[kind];
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "content") throw new HttpError(400, `${kind} 只接收 content`);
  const content = body.content;
  if (typeof content !== "string") throw new HttpError(400, "content 必须是文本");
  if (content.length > maxLength) throw new HttpError(400, `内容超过 ${maxLength} 字符上限（当前 ${content.length}）`);
  return content;
}

/** 同目录临时文件 + rename：失败路径下原文件字节与权限不变。 */
export function writeHomeMarkdown(homeDir: string, kind: HomeMarkdownKind, content: string): void {
  const { file } = HOME_MARKDOWN_FILES[kind];
  const filePath = path.join(homeDir, file);
  const mode = existsSync(filePath) ? statSync(filePath).mode & 0o777 : HOME_MARKDOWN_FILE_MODE;
  const candidatePath = path.join(homeDir, `.${file}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(candidatePath, content, { encoding: "utf8", mode });
    renameSync(candidatePath, filePath);
  } catch (error) {
    try { unlinkSync(candidatePath); } catch { /* 临时文件可能未创建或已被 rename 走 */ }
    throw error;
  }
}
