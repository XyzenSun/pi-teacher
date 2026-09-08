/**
 * 投影：数据库是源，工作区文件是投影（ADR-0014）。
 * 开对话时整份覆盖写 AGENTS.md / style.md——并发对话覆盖冲突不处理
 * （数据库设计.md 已定：概率低、后果轻）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

/** 把 agents_md.prompt 整份覆盖写到工作区 AGENTS.md。 */
export async function projectAgentsMd(db: Database.Database, workspaceDir: string, agentsMdId: number): Promise<void> {
  const row = db
    .prepare("SELECT name, prompt FROM agents_md WHERE id = ?")
    .get(agentsMdId) as { name: string; prompt: string } | undefined;
  if (!row) {
    throw new Error(`agents_md ${agentsMdId} 不存在，投影失败`);
  }
  await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), row.prompt, "utf8");
}

/** 把 teach_style.prompt 整份覆盖写到工作区 style.md；无风格时删旧文件。 */
export async function projectTeachStyle(
  db: Database.Database,
  workspaceDir: string,
  teachStyleId: number | null,
): Promise<void> {
  const stylePath = path.join(workspaceDir, "style.md");
  if (teachStyleId === null) {
    // 不注入风格：清掉上一对话可能留下的投影，避免残留生效
    await fs.rm(stylePath, { force: true });
    return;
  }
  const row = db
    .prepare("SELECT prompt FROM teach_style WHERE id = ?")
    .get(teachStyleId) as { prompt: string } | undefined;
  if (!row) {
    throw new Error(`teach_style ${teachStyleId} 不存在，投影失败`);
  }
  await fs.writeFile(stylePath, row.prompt, "utf8");
}
