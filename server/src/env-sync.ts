/**
 * env-sync：按 ADR-0029 / .scratch/env-key-sync-and-resource-locations/spec.md。
 * 五条语义（启动时执行一次）：
 *   1. 白名单外的 key 一律不碰
 *   2. env 持有的 key 覆盖写 .env 对应行（防旧 key 复活，非追加）
 *   3. env 为空的 key 跳过（不写空值）
 *   4. .env 不存在时创建
 *   5. 格式损坏的行原样保留（只按 KEY= 前缀识别归属）
 */
import { promises as fs } from "node:fs";

/** 白名单：目前只有 tavily-search 的三键（spec 起步集）。 */
const SYNC_KEYS = ["TAVILY_API_KEY", "TAVILY_BASE_URL", "TAVILY_TIMEOUT_MS"] as const;

export function getSyncKeys(): readonly string[] {
  return SYNC_KEYS;
}

/** 单 key 的覆盖写规则（纯函数，便于 verify 直调断言）。 */
export function applyEnvSyncToContent(content: string, env: NodeJS.ProcessEnv): { content: string; written: string[] } {
  const lines = content.split("\n");
  const written: string[] = [];

  for (const key of SYNC_KEYS) {
    const value = env[key];
    if (!value) continue; // 语义 3：env 为空跳过

    let replaced = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // 只认「行首 KEY=」的行；export KEY= 与注释行（# KEY=）不动
      if (line.startsWith(`${key}=`)) {
        lines[i] = `${key}=${value}`;
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      lines.push(`${key}=${value}`); // 不存在则追加（后续统一处理换行）
    }
    written.push(key);
  }

  return { content: lines.join("\n"), written };
}

/** 启动钩子：同步白名单 env → .env。env 全空时直接返回（不建文件不写）。 */
export async function syncEnvToFile(envFilePath: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const hasAny = SYNC_KEYS.some((key) => env[key]);
  if (!hasAny) return [];

  let content = "";
  try {
    content = await fs.readFile(envFilePath, "utf8");
  } catch {
    // 语义 4：文件不存在时创建（空内容起步）
  }

  const result = applyEnvSyncToContent(content, env);
  await fs.writeFile(envFilePath, result.content.endsWith("\n") ? result.content : result.content + "\n", "utf8");
  return result.written;
}
