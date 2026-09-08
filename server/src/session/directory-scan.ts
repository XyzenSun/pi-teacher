/**
 * 工作区目录扫描：枚举工作区下的 Pi 会话 jsonl 文件（平铺布局，
 * 数据库设计.md「目录布局」——jsonl 直接躺工作区目录，无 .pi/sessions）。
 *
 * 识别子代理会话：header 里 parentSession 指向父会话文件的行是资料抓取
 * 子代理（ADR-0016），pi_session 表不记录它们，列表也不展示——按
 * header.parentSession 过滤。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { readSessionHeader, type SessionHeader } from "./session-reader.ts";

export interface WorkspaceSessionFile {
  /** jsonl 绝对路径 */
  filePath: string;
  /** header 里的 Pi 会话 id */
  sessionId: string;
  header: SessionHeader;
  /** 文件 mtime，用于列表排序 */
  modifiedMs: number;
}

/** 解析一行 header（首行）判定 parentSession。坏行/坏文件返回 null。 */
export async function scanWorkspaceSessions(workspaceDir: string): Promise<WorkspaceSessionFile[]> {
  let dirents: string[];
  try {
    dirents = await fs.readdir(workspaceDir);
  } catch {
    // 工作区目录不存在（刚建的 session 或全新部署），视为无会话
    return [];
  }

  const results: WorkspaceSessionFile[] = [];
  for (const name of dirents) {
    if (!name.endsWith(".jsonl")) continue;
    const filePath = path.join(workspaceDir, name);
    const header = readSessionHeader(filePath);
    if (!header) continue;
    // 子代理会话不进列表（数据库设计.md「pi_session」节）
    if (header.parentSession) continue;

    try {
      const stat = await fs.stat(filePath);
      results.push({
        filePath,
        sessionId: header.id,
        header,
        modifiedMs: stat.mtimeMs,
      });
    } catch {
      // 竞态：扫描期间文件被删，跳过
    }
  }
  results.sort((a, b) => b.modifiedMs - a.modifiedMs);
  return results;
}
