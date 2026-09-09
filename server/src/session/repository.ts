import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { PiSessionRow, SpaceRow, SpaceType } from "../db/types.ts";
import { projectAgentsMd, projectTeachStyle } from "../projection/agents-md.ts";
import { HttpError } from "../routes/http.ts";

export function sessionKeyFor(id: number): string {
  return `pi-teacher-pi-session-id-${id}`;
}

export function sessionWorkPath(homeDir: string, space: Pick<SpaceRow, "id" | "type">, id: number): string {
  return space.type === "learn"
    ? path.join(homeDir, "learn", String(space.id), "pi", String(id))
    : path.join(homeDir, space.type, "pi", String(id));
}

export function getSpace(db: Database.Database, id: number): SpaceRow {
  const row = db.prepare("SELECT id, type, name, created_at FROM space WHERE id = ?").get(id) as SpaceRow | undefined;
  if (!row) throw new HttpError(404, "Space 不存在");
  return row;
}

export function getPiSession(db: Database.Database, id: number): PiSessionRow {
  const row = db.prepare(`SELECT p.*, s.type AS space_type FROM pi_session p
    JOIN space s ON s.id = p.space_id WHERE p.id = ?`).get(id) as PiSessionRow | undefined;
  if (!row) throw new HttpError(404, "Pi Session 不存在");
  return row;
}

export function listPiSessionRows(db: Database.Database, spaceId?: number): PiSessionRow[] {
  return db.prepare(`SELECT p.*, s.type AS space_type FROM pi_session p JOIN space s ON s.id = p.space_id
    ${spaceId === undefined ? "" : "WHERE p.space_id = ?"} ORDER BY p.id DESC`)
    .all(...(spaceId === undefined ? [] : [spaceId])) as PiSessionRow[];
}

export interface CreatePiSessionInput {
  spaceId: number;
  agentsMdId: number;
  teachStyleId?: number | null;
  enableMakeCard?: boolean;
  reviewTopicId?: number | null;
}

/**
 * IMMEDIATE 事务内先预留 AUTOINCREMENT 高水位 ID，再构造真实路径并一次插入完整行。
 * 这样数据库永远不会提交 pending 路径，也不会因并发初始化产生两条固定助教。
 * 文件系统不能参与 SQLite 回滚，失败时只清理本次亲自创建的新目录。
 */
export function createPiSession(
  db: Database.Database,
  homeDir: string,
  input: CreatePiSessionInput,
  allowFixedTa = false,
): PiSessionRow {
  let createdDirectory: string | undefined;
  try {
    return db.transaction(() => {
      const space = getSpace(db, input.spaceId);
      if (space.type === "ta" && !allowFixedTa) throw new HttpError(403, "助教 Pi Session 全局唯一，不能创建");
      if (space.type === "ta") {
        const existing = db.prepare("SELECT id FROM pi_session WHERE space_id = ?").get(space.id) as { id: number } | undefined;
        if (existing) return getPiSession(db, existing.id);
      }
      const template = db.prepare("SELECT type FROM agents_md WHERE id = ?").get(input.agentsMdId) as { type: SpaceType } | undefined;
      if (!template || template.type !== space.type) throw new HttpError(400, "Agents Md 不存在或与 Space 类型不匹配");
      if (input.teachStyleId != null && !db.prepare("SELECT id FROM teach_style WHERE id = ?").get(input.teachStyleId)) {
        throw new HttpError(400, "Teach Style 不存在");
      }
      if (input.reviewTopicId != null) {
        if (space.type !== "review") throw new HttpError(400, "只有复习 Pi Session 可以选择 Topic");
        if (!db.prepare("SELECT id FROM topic WHERE id = ?").get(input.reviewTopicId)) throw new HttpError(400, "复习 Topic 不存在");
      }
      const { next_id: id } = db.prepare(`SELECT MAX(
        COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'pi_session'), 0),
        COALESCE((SELECT MAX(id) FROM pi_session), 0)
      ) + 1 AS next_id`).get() as { next_id: number };
      const workPath = sessionWorkPath(path.resolve(homeDir), space, id);
      mkdirSync(path.dirname(workPath), { recursive: true });
      // 已有目录可能是外部文件或上次异常的产物，不能为了重试覆盖它。
      if (existsSync(workPath)) throw new HttpError(409, "Pi Session 目标目录已存在，请先检查数据目录");
      mkdirSync(workPath);
      createdDirectory = workPath;
      const manager = SessionManager.create(workPath, workPath, { id: sessionKeyFor(id) });
      const sessionFile = manager.getSessionFile();
      const header = manager.getHeader();
      if (!sessionFile || !header) throw new Error("Pi 未生成持久化会话路径");
      db.prepare(`INSERT INTO pi_session
        (id, space_id, name, work_path, path, agents_md_id, teach_style_id, enable_make_card, review_topic_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, space.id, space.type === "ta" ? "助教" : null, workPath, sessionFile,
        input.agentsMdId, input.teachStyleId ?? null,
        space.type === "ta" ? 0 : input.enableMakeCard === false ? 0 : 1, input.reviewTopicId ?? null,
      );
      projectAgentsMd(db, workPath, input.agentsMdId);
      projectTeachStyle(db, workPath, input.teachStyleId ?? null);
      mkdirSync(path.join(workPath, "attachments"));
      // SDK 默认首条 assistant 才刷盘。先持久化 SDK 自己生成的 header，随后统一
      // SessionManager.open，使空对话重启仍有稳定身份，同时不伪造任何历史消息。
      writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, { flag: "wx", mode: 0o600 });
      return getPiSession(db, id);
    }).immediate();
  } catch (error) {
    if (createdDirectory) rmSync(createdDirectory, { recursive: true, force: true });
    throw error;
  }
}
