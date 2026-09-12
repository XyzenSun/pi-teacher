import type Database from "better-sqlite3";

/** 路由共享状态；Space 只负责收纳，工作路径统一由 session/repository 生成。 */
export interface AppState {
  db: Database.Database;
  homeDir: string;
  dataDir: string;
}
