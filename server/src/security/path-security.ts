// 移植自 pi-web v0.9.0 lib/path-security.ts（MIT License），去掉 Windows
// 分支（pi-teacher 只部署在 Linux）。语义：路径穿越双段校验——先词法包含
// 判定，再 realpath 判定（符号链接把目标带出根的情况只有后者能挡住）。
import { realpathSync } from "node:fs";
import path from "node:path";

/**
 * Lexical containment check: target 必须落在某个 root 之内（或等于 root 本身）。
 */
export function isPathWithinRoots(target: string, roots: Set<string>): boolean {
  for (const root of roots) {
    const normalized = path.resolve(target);
    const normalizedRoot = path.resolve(root);
    const rootWithSep = normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep;
    if (normalized === normalizedRoot || normalized.startsWith(rootWithSep)) return true;
  }
  return false;
}

/** Realpath containment: 符号链接解析后再判一次，防链接逃逸。 */
export function isExistingPathWithinRoots(target: string, roots: Set<string>): boolean {
  let realTarget: string;
  try {
    realTarget = realpathSync(target);
  } catch {
    return false;
  }

  const realRoots = new Set<string>();
  for (const root of roots) {
    try {
      realRoots.add(realpathSync(root));
    } catch {
      // root 可能已不存在（会话被清理），跳过
    }
  }
  return isPathWithinRoots(realTarget, realRoots);
}
