import { Router } from "express";
import type { AppState } from "./app-state.ts";
import type { SpaceRow } from "../db/types.ts";
import { HttpError, readBody, readId, readText } from "./http.ts";
import { getSpace, listPiSessionRows, sessionKeyFor } from "../session/repository.ts";
import { conversationView } from "../session/session-reader.ts";
import { getSessionWrapper } from "../bridge/agent-session-wrapper.ts";

export function createWorkspacesRouter(state: AppState): Router {
  const router = Router();
  router.get("/", (_req, res) => {
    const spaces = state.db.prepare("SELECT id, type, name, created_at FROM space ORDER BY id").all() as SpaceRow[];
    const sessions = listPiSessionRows(state.db);
    const dueCards = (state.db.prepare(`SELECT COUNT(*) AS count FROM card c JOIN card_schedule s ON c.id = s.card_id
      WHERE c.status = 'normal' AND s.due <= datetime('now')`).get() as { count: number }).count;
    res.json({
      spaces: spaces.map((space) => ({
        id: space.id, type: space.type, name: space.name, createdAt: space.created_at,
        conversations: sessions.filter((session) => session.space_id === space.id).map(conversationView),
      })),
      taSessionId: sessions.find((session) => session.space_type === "ta")?.id ?? null,
      dueCards,
    });
  });

  router.post("/", (req, res) => {
    const body = readBody(req.body);
    if (body.type !== undefined && body.type !== "learn") throw new HttpError(403, "只能创建学习 Space");
    const name = readText(body.name, "Space 名称", 100);
    const result = state.db.prepare("INSERT INTO space (type, name) VALUES ('learn', ?)").run(name);
    const space = getSpace(state.db, Number(result.lastInsertRowid));
    res.status(201).json({ success: true, space: { id: space.id, type: space.type, name: space.name, conversations: [] } });
  });

  router.patch("/:id", (req, res) => {
    const space = getSpace(state.db, readId(req.params.id, "Space id", true));
    if (space.type !== "learn") throw new HttpError(403, "固定助教与复习 Space 不可编辑");
    const body = readBody(req.body);
    if (body.type !== undefined) throw new HttpError(400, "Space 的类型不可更改");
    const name = readText(body.name, "Space 名称", 100);
    state.db.prepare("UPDATE space SET name = ? WHERE id = ?").run(name, space.id);
    res.json({ success: true });
  });

  router.delete("/:id", async (req, res) => {
    const space = getSpace(state.db, readId(req.params.id, "Space id", true));
    if (space.type !== "learn") throw new HttpError(403, "固定助教与复习 Space 不可删除");
    const sessions = listPiSessionRows(state.db, space.id);
    if (sessions.some((row) => getSessionWrapper(sessionKeyFor(row.id))?.isRunning())) {
      throw new HttpError(409, "Space 中还有运行中的对话，请先停止再删除");
    }
    await Promise.all(sessions.map((row) => getSessionWrapper(sessionKeyFor(row.id))?.shutdown()));
    state.db.transaction(() => {
      state.db.prepare("DELETE FROM pi_session WHERE space_id = ?").run(space.id);
      state.db.prepare("DELETE FROM space WHERE id = ?").run(space.id);
    })();
    // 删除收纳关系不递归清除用户学习产出；界面确认时明确说明磁盘文件保留。
    res.json({ success: true, filesRetained: true });
  });
  return router;
}
