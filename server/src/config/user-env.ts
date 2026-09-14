/**
 * 用户环境变量：SQLite `user_env` 表是唯一源，后端把它们注入自己的
 * process.env，模型调用的 skill 子进程靠继承拿到。容器 env 与旧 .env 只在首次
 * 启动时导入一次，之后不再是源。
 *
 * 值明文存库、明文回显：单用户本机部署，数据库本身不加密，前端再遮一层没有意义。
 * 因此这里不属于 secret 边界（那条边界只管 models.json，见 pi-config.ts）。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import type Database from "better-sqlite3";
import { HttpError } from "../routes/http.ts";

/** 内置项：产品自带 skill 需要的变量，未设置也出现在列表里；不可删行只可清值。 */
export const BUILTIN_USER_ENV = [
  { key: "TAVILY_API_KEY", description: "Tavily 搜索 API Key" },
  { key: "TAVILY_BASE_URL", description: "Tavily API 地址，默认 https://api.tavily.com" },
  { key: "TAVILY_TIMEOUT", description: "Tavily 请求超时，如 60s" },
  { key: "EXA_API_KEY", description: "Exa 搜索 / 抓取 API Key" },
  { key: "EXA_BASE_URL", description: "Exa API 地址（可选），默认 https://api.exa.ai" },
  { key: "EXA_TIMEOUT", description: "Exa 请求超时，如 60s" },
  { key: "FIRECRAWL_API_KEY", description: "Firecrawl 抓取 API Key" },
  { key: "FIRECRAWL_BASE_URL", description: "Firecrawl API 地址（可选），默认 https://api.firecrawl.dev" },
  { key: "JINA_API_KEY", description: "Jina Reader API Key" },
  { key: "JINA_BASE_URL", description: "Jina Reader 地址（可选），默认 https://r.jina.ai" },
  { key: "DAYTONA_API_KEY", description: "sbx 云沙箱的 Daytona API Key" },
  { key: "E2B_API_KEY", description: "sbx 云沙箱的 E2B API Key" },
  { key: "CODESANDBOX_API_KEY", description: "sbx 云沙箱的 CodeSandbox API Key" },
] as const;

/** 会改变后端进程自身或动态链接器行为的变量：设错了服务本身就起不来，不允许从界面设置。 */
const PROTECTED_KEYS = new Set([
  "PATH", "HOME", "USER", "SHELL", "PWD", "TMPDIR", "NODE_OPTIONS", "NODE_ENV", "PORT",
  "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "NODE_EXTRA_CA_CERTS", "UV_THREADPOOL_SIZE",
]);
const PROTECTED_PREFIXES = ["PI_TEACHER_", "PI_CODING_AGENT_", "NODE_", "npm_"];
const KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const KEY_MAX_LENGTH = 64;
const VALUE_MAX_LENGTH = 4000;

export interface UserEnvItem {
  key: string;
  builtin: boolean;
  configured: boolean;
  /** 已设置的项带值；内置项未设置时没有。 */
  value?: string;
  description?: string;
}

/** `{ [key]: value }`：每个值都是非空字符串，直接覆盖。 */
export type UserEnvPatch = Record<string, string>;

interface UserEnvRow { key: string; value: string }

function isBuiltin(key: string): boolean {
  return BUILTIN_USER_ENV.some((item) => item.key === key);
}

/** 变量名合法且不受保护；错误信息只含名字。 */
export function assertUserEnvKey(key: string): string {
  if (!KEY_PATTERN.test(key) || key.length > KEY_MAX_LENGTH) {
    throw new HttpError(400, `变量名「${key.slice(0, 80)}」无效：只允许大写字母、数字与下划线，且不能以数字开头`);
  }
  if (PROTECTED_KEYS.has(key) || PROTECTED_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    throw new HttpError(400, `变量「${key}」由部署环境管理，不能在这里设置`);
  }
  return key;
}

function readRows(db: Database.Database): UserEnvRow[] {
  return db.prepare("SELECT key, value FROM user_env ORDER BY key").all() as UserEnvRow[];
}

/** 内置项永远在列（未设置 configured=false），用户项按表。 */
export function listUserEnv(db: Database.Database): UserEnvItem[] {
  const rows = new Map(readRows(db).map((row) => [row.key, row]));
  const items: UserEnvItem[] = BUILTIN_USER_ENV.map((builtin) => {
    const row = rows.get(builtin.key);
    rows.delete(builtin.key);
    return {
      key: builtin.key,
      builtin: true,
      configured: row !== undefined,
      description: builtin.description,
      ...(row ? { value: row.value } : {}),
    };
  });
  for (const row of rows.values()) items.push({ key: row.key, builtin: false, configured: true, value: row.value });
  return items;
}

/** 补丁 `{ [key]: value }`：值必须是非空字符串；名字非法或受保护 400。 */
export function readUserEnvPatch(body: Record<string, unknown>): UserEnvPatch {
  const keys = Object.keys(body);
  if (!keys.length) throw new HttpError(400, "至少要提供一个变量");
  const patch: UserEnvPatch = {};
  for (const rawKey of keys) {
    const key = assertUserEnvKey(rawKey);
    const value = body[rawKey];
    if (typeof value !== "string") throw new HttpError(400, `变量「${key}」的值必须是文本`);
    if (!value.trim()) throw new HttpError(400, `变量「${key}」的值不能为空；要移除请用删除或清除`);
    if (value.length > VALUE_MAX_LENGTH) throw new HttpError(400, `变量「${key}」的值超过 ${VALUE_MAX_LENGTH} 字符上限`);
    patch[key] = value;
  }
  return patch;
}

function syncProcessEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** 事务写表，成功后同步 process.env：下一次 skill 子进程即拿到新值。 */
export function applyUserEnvPatch(db: Database.Database, patch: UserEnvPatch): void {
  const upsert = db.prepare("INSERT INTO user_env (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  db.transaction(() => {
    for (const [key, value] of Object.entries(patch)) upsert.run(key, value);
  }).immediate();
  for (const [key, value] of Object.entries(patch)) syncProcessEnv(key, value);
}

/** 内置项：删行但仍在列表里（清值）；用户项：删行。两者都从 process.env 移除。 */
export function deleteUserEnv(db: Database.Database, rawKey: string): void {
  const key = assertUserEnvKey(rawKey);
  const removed = db.prepare("DELETE FROM user_env WHERE key = ?").run(key).changes;
  if (!removed && !isBuiltin(key)) throw new HttpError(404, `变量「${key}」不存在`);
  syncProcessEnv(key, undefined);
}

/**
 * 启动引导：内置项从容器 env 首次导入；旧 .env 里表中没有的合法 key 全部导入一次；
 * 最后把表里全部行写入 process.env。返回 key 名供日志使用。
 */
export function bootstrapUserEnv(db: Database.Database, homeDir: string): { fromEnv: string[]; fromDotenv: string[] } {
  const existing = new Set(readRows(db).map((row) => row.key));
  const insert = db.prepare("INSERT INTO user_env (key, value) VALUES (?, ?)");
  const fromEnv: string[] = [];
  const fromDotenv: string[] = [];
  db.transaction(() => {
    for (const builtin of BUILTIN_USER_ENV) {
      const value = process.env[builtin.key];
      if (existing.has(builtin.key) || !value) continue;
      insert.run(builtin.key, value);
      existing.add(builtin.key);
      fromEnv.push(builtin.key);
    }
    const dotenvPath = path.join(homeDir, ".env");
    if (!existsSync(dotenvPath)) return;
    for (const [key, value] of Object.entries(parseEnv(readFileSync(dotenvPath, "utf8")))) {
      if (existing.has(key) || !value) continue;
      try { assertUserEnvKey(key); } catch { continue; }
      insert.run(key, value);
      existing.add(key);
      fromDotenv.push(key);
    }
  }).immediate();
  for (const row of readRows(db)) syncProcessEnv(row.key, row.value);
  return { fromEnv, fromDotenv };
}
