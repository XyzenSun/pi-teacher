import { writeFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

/** 数据库单向投影到本条 Pi Session 的目录，绝不写入 Space 的共享目录。 */
export function projectAgentsMd(db: Database.Database, workPath: string, agentsMdId: number): void {
  const row = db.prepare("SELECT prompt FROM agents_md WHERE id = ?").get(agentsMdId) as { prompt: string } | undefined;
  if (!row) throw new Error(`agents_md ${agentsMdId} 不存在，无法投影`);
  writeFileSync(path.join(workPath, "AGENTS.md"), row.prompt, "utf8");
}

export function projectTeachStyle(db: Database.Database, workPath: string, teachStyleId: number | null): void {
  const row = teachStyleId === null ? null : db.prepare("SELECT prompt FROM teach_style WHERE id = ?").get(teachStyleId) as { prompt: string } | undefined;
  if (teachStyleId !== null && !row) throw new Error(`teach_style ${teachStyleId} 不存在，无法投影`);
  // 空风格仍有独立投影文件；SDK 仅追加非空内容，不继承其他对话的风格。
  writeFileSync(path.join(workPath, "style.md"), row?.prompt ?? "", "utf8");
}
