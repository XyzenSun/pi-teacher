/**
 * 应用级共享状态：Express 各路由都要摸的东西集中在这一层，
 * 路由文件保持纯函数（挂到 express.Router 上），便于 http-smoke 构造。
 */
import path from "node:path";
import type Database from "better-sqlite3";

export interface AppState {
  /** 主数据库（~/.pi/teacher.db 或测试临时路径） */
  db: Database.Database;
  /** 部署根目录：~/pi-teacher（dev 模式下为测试目录） */
  homeDir: string;
  /** 数据目录：数据库、cookie key 等 server 自有数据 */
  dataDir: string;
}

/** 工作区目录约定（数据库设计.md「目录布局」）：learn/<id>/、review/、ta/。 */
export function workspaceDirFor(state: AppState, spaceId: number, sessionId: number | null): string {
  if (spaceId === 0) return path.join(state.homeDir, "ta");
  if (spaceId === 2) return path.join(state.homeDir, "review");
  if (sessionId === null) {
    throw new Error("学习对话必须有 session_id（工作区目录）");
  }
  return path.join(state.homeDir, "learn", String(sessionId));
}

/** md/file 工具的沙箱根：学习对话是工作区目录，助教/复习是各自根目录。 */
export function sandboxRootFor(state: AppState, spaceId: number, sessionId: number | null): string {
  return workspaceDirFor(state, spaceId, sessionId);
}
