/** 提示词库路由：agents_md 与 teach_style 的增删改查（用户自维护的模板库）。 */
import { Router } from "express";
import type { Request, Response } from "express";
import type { AppState } from "./app-state.ts";

const AGENTS_MD_TYPES = new Set(["learn", "review", "ta"]);

export function createPromptsRouter(state: AppState): Router {
  const router = Router();

  // GET /api/prompts —— 两库并列返回，前端一屏管理
  router.get("/", (_req: Request, res: Response) => {
    res.json({
      agentsMd: state.db.prepare("SELECT * FROM agents_md ORDER BY id").all(),
      teachStyles: state.db.prepare("SELECT * FROM teach_style ORDER BY id").all(),
    });
  });

  // POST /api/prompts/agents-md
  router.post("/agents-md", (req: Request, res: Response) => {
    const { type, name, description, prompt } = req.body as {
      type?: string; name?: string; description?: string; prompt?: string;
    };
    if (!type || !AGENTS_MD_TYPES.has(type)) {
      res.status(400).json({ error: "type 必须是 learn/review/ta" });
      return;
    }
    if (typeof name !== "string" || !name.trim() || typeof prompt !== "string" || !prompt.trim()) {
      res.status(400).json({ error: "name 与 prompt 必填" });
      return;
    }
    const info = state.db
      .prepare("INSERT INTO agents_md (type, name, description, prompt) VALUES (?, ?, ?, ?)")
      .run(type, name.trim(), description ?? null, prompt);
    res.json({ success: true, id: Number(info.lastInsertRowid) });
  });

  // PATCH /api/prompts/agents-md/:id
  router.patch("/agents-md/:id", (req: Request, res: Response) => {
    const row = state.db.prepare("SELECT id, type, name, description, prompt FROM agents_md WHERE id = ?").get(req.params.id) as { id: number; type: string; name: string; description: string | null; prompt: string } | undefined;
    if (!row) {
      res.status(404).json({ error: "模板不存在" });
      return;
    }
    const { type, name, description, prompt } = req.body as {
      type?: string; name?: string; description?: string | null; prompt?: string;
    };
    if (type !== undefined && !AGENTS_MD_TYPES.has(type)) {
      res.status(400).json({ error: "type 必须是 learn/review/ta" });
      return;
    }
    state.db
      .prepare("UPDATE agents_md SET type = ?, name = ?, description = ?, prompt = ? WHERE id = ?")
      .run(
        type ?? row.type,
        name?.trim() ?? row.name,
        description === undefined ? row.description : description,
        prompt ?? row.prompt,
        row.id,
      );
    res.json({ success: true });
  });

  // DELETE /api/prompts/agents-md/:id —— 被 pi_session 引用时拒删（外键完整性）
  router.delete("/agents-md/:id", (req: Request, res: Response) => {
    const id = req.params.id;
    const referenced = state.db
      .prepare("SELECT COUNT(*) AS n FROM pi_session WHERE agents_md_id = ?")
      .get(id) as { n: number };
    if (referenced.n > 0) {
      res.status(409).json({ error: `该模板被 ${referenced.n} 个对话引用，不能删除（事后追溯凭据，见数据库设计.md）` });
      return;
    }
    const info = state.db.prepare("DELETE FROM agents_md WHERE id = ?").run(id);
    res.status(info.changes > 0 ? 200 : 404).json({ success: info.changes > 0 });
  });

  // —— teach_style 同构三路由 ——
  router.post("/teach-style", (req: Request, res: Response) => {
    const { name, description, prompt } = req.body as { name?: string; description?: string; prompt?: string };
    if (typeof name !== "string" || !name.trim() || typeof prompt !== "string" || !prompt.trim()) {
      res.status(400).json({ error: "name 与 prompt 必填" });
      return;
    }
    const info = state.db
      .prepare("INSERT INTO teach_style (name, description, prompt) VALUES (?, ?, ?)")
      .run(name.trim(), description ?? null, prompt);
    res.json({ success: true, id: Number(info.lastInsertRowid) });
  });

  router.patch("/teach-style/:id", (req: Request, res: Response) => {
    const row = state.db.prepare("SELECT * FROM teach_style WHERE id = ?").get(req.params.id) as { id: number; name: string; description: string | null; prompt: string } | undefined;
    if (!row) {
      res.status(404).json({ error: "风格不存在" });
      return;
    }
    const { name, description, prompt } = req.body as { name?: string; description?: string | null; prompt?: string };
    state.db
      .prepare("UPDATE teach_style SET name = ?, description = ?, prompt = ? WHERE id = ?")
      .run(
        name?.trim() ?? row.name,
        description === undefined ? row.description : description,
        prompt ?? row.prompt,
        row.id,
      );
    res.json({ success: true });
  });

  router.delete("/teach-style/:id", (req: Request, res: Response) => {
    const id = req.params.id;
    const referenced = state.db
      .prepare("SELECT COUNT(*) AS n FROM pi_session WHERE teach_style_id = ?")
      .get(id) as { n: number };
    if (referenced.n > 0) {
      res.status(409).json({ error: `该风格被 ${referenced.n} 个对话引用，不能删除` });
      return;
    }
    const info = state.db.prepare("DELETE FROM teach_style WHERE id = ?").run(id);
    res.status(info.changes > 0 ? 200 : 404).json({ success: info.changes > 0 });
  });

  return router;
}
