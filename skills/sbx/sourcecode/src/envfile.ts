import { readFile } from 'node:fs/promises';
import { SbxError } from './types.js';

/**
 * 解析 .env 文件为键值对。
 *
 * 支持格式：
 * - `KEY=VALUE` / `export KEY=VALUE`
 * - 整行注释（# 开头）与空行
 * - 单引号/双引号包裹的值（去引号；行内注释仅在引号外生效按整行原样处理，不做展开）
 *
 * 设计意图：key 不落盘是默认原则，.env 文件是用户通过 --envfile 显式
 * 选择加入的例外（而非自动发现/自动加载）——注入逻辑在 CLI 层统一执行，
 * 且真实环境变量优先于文件值。
 */
export async function parseEnvFile(path: string): Promise<Record<string, string>> {
  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch {
    throw new SbxError('CLI_USAGE', `Env file not readable: ${path}`);
  }

  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eqIndex = withoutExport.indexOf('=');
    if (eqIndex <= 0) {
      continue; // 非法行静默跳过：envfile 里可能混有注释型杂项
    }
    const key = withoutExport.slice(0, eqIndex).trim();
    let value = withoutExport.slice(eqIndex + 1).trim();
    if (value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
         (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue; // 变量名不合法：跳过而非报错，保持宽容解析
    }
    result[key] = value;
  }
  return result;
}

/** 把 envfile 的键值注入 process.env：真实环境变量优先（文件只补缺） */
export function injectEnvEntries(entries: Record<string, string>): void {
  for (const [key, value] of Object.entries(entries)) {
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}
