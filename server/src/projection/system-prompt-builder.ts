import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { USER_PREFERENCES_PLACEHOLDER } from "../prompts/defaults.ts";

/** 会话级用户偏好文件名。程序只在引导句里提到它，从不读取、投影或校验其内容。 */
export const SESSION_USER_PREFERENCES_FILE = "pi-session-user.md";

const SESSION_PREFERENCES_GUIDANCE = `<会话级用户偏好>
如果当前工作目录下存在 ${SESSION_USER_PREFERENCES_FILE}，它记录的是用户在本次会话中对你的特殊要求，优先级高于上面的全局偏好与教学风格；回答前先读取它。
当你察觉到用户提出的要求只针对本次会话而不是全局性偏好时，创建或维护 ${SESSION_USER_PREFERENCES_FILE}；全局性偏好不要写进这个文件。
</会话级用户偏好>`;

/** 文件不存在、只有空白、或仍是 seed 写入的占位注释，都视为「用户没写偏好」，不进 system prompt。 */
function readMeaningfulText(filePath: string, placeholder?: string): string {
  if (!existsSync(filePath)) return "";
  const content = readFileSync(filePath, "utf8").trim();
  if (placeholder && content === placeholder.trim()) return "";
  return content;
}

/** 全局 USER.md 只在传入 homeDir 时参与；验证脚本里不传 homeDir 的旧调用退化为只读 style.md。 */
export function readGlobalUserPreferences(homeDir: string): string {
  return readMeaningfulText(path.join(homeDir, "USER.md"), USER_PREFERENCES_PLACEHOLDER);
}

/**
 * 拼出 appendSystemPrompt 的固定段落：全局 USER.md 与会话 style.md 缺失的层省略对应标签块；
 * 会话级引导块**无条件**附带（无论文件是否存在都输出）——维护提醒
 * 会让模型「更新到 pi-session-user.md」，模型必须事先知道这个文件是什么，
 * 而助教几乎总处于 USER.md 为空且无风格的状态。文件是否存在由模型自己用工具看。
 */
export function buildAppendedSystemPrompt(homeDir: string | undefined, workPath: string): string {
  const globalPreferences = homeDir ? readGlobalUserPreferences(homeDir) : "";
  const style = readMeaningfulText(path.join(workPath, "style.md"));
  const blocks: string[] = [];
  if (globalPreferences || style) blocks.push("以下为用户偏好与教学风格，会话级内容优先于全局内容。");
  if (globalPreferences) blocks.push(`<全局用户偏好>\n${globalPreferences}\n</全局用户偏好>`);
  if (style) blocks.push(`<教学风格>\n${style}\n</教学风格>`);
  blocks.push(SESSION_PREFERENCES_GUIDANCE);
  return blocks.join("\n\n");
}
