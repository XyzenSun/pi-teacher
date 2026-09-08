/** 术语路由：提议列表、确认、拒绝。孤立表，无外键（数据库设计.md）。 */
import { Router } from "express";
import type { Request, Response } from "express";
import type { AppState } from "./app-state.ts";

interface GlossaryRow {
  id: number;
  term: string;
  definition: string;
  status: string;
}

export function createGlossaryRouter(state: AppState): Router {
  const router = Router();

  router.get("/", (req: Request, res: Response) => {
    const status = typeof req.query.status === "string" ? req.query.status : null;
    const rows = status
      ? (state.db.prepare("SELECT * FROM glossary WHERE status = ? ORDER BY id DESC").all(status) as GlossaryRow[])
      : (state.db.prepare("SELECT * FROM glossary WHERE status != 'deleted' ORDER BY id DESC").all() as GlossaryRow[]);
    res.json({ terms: rows });
  });

  // 确认：proposed → normal。幂等。
  router.post("/:id/confirm", (req: Request, res: Response) => {
    const info = state.db
      .prepare("UPDATE glossary SET status = 'normal' WHERE id = ? AND status = 'proposed'")
      .run(req.params.id);
    if (info.changes === 0) {
      const exists = state.db.prepare("SELECT id, status FROM glossary WHERE id = ?").get(req.params.id) as GlossaryRow | undefined;
      res.status(exists ? 200 : 404).json({ success: exists?.status === "normal", error: exists ? undefined : "术语不存在" });
      return;
    }
    res.json({ success: true });
  });

  // 拒绝：proposed → deleted
  router.post("/:id/reject", (req: Request, res: Response) => {
    const info = state.db
      .prepare("UPDATE glossary SET status = 'deleted' WHERE id = ? AND status = 'proposed'")
      .run(req.params.id);
    if (info.changes === 0) {
      const exists = state.db.prepare("SELECT id FROM glossary WHERE id = ?").get(req.params.id);
      res.status(exists ? 409 : 404).json({ error: exists ? "仅提议术语可拒绝" : "术语不存在" });
      return;
    }
    res.json({ success: true });
  });

  return router;
}
