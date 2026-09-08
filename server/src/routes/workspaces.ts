/**
 * 工作区路由：列表（名称、到期卡数、最近活动）与新建。
 * 「工作区」= session 表行（学习区）+ 复习/助教两个固定区。
 */
import { Router } from "express";
import type { Request, Response } from "express";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AppState } from "./app-state.ts";
import { workspaceDirFor } from "./app-state.ts";

export function createWorkspacesRouter(state: AppState): Router {
  const router = Router();

  // GET /api/workspaces —— 工作区列表（学习区来自 session 表，助教/复习固定）
  router.get("/", (_req: Request, res: Response) => {
    const learnSessions = state.db
      .prepare("SELECT id, name, work_path FROM session WHERE id != 0 ORDER BY id")
      .all() as Array<{ id: number; name: string; work_path: string }>;

    // 到期卡数按「全部到期卡」计（不分 topic——工作区概览只做提醒）
    const dueCount = (state.db
      .prepare("SELECT COUNT(*) AS n FROM card_schedule WHERE due <= datetime('now')")
      .get() as { n: number }).n;

    const workspaces = [
      {
        id: 0,
        kind: "ta" as const,
        name: "助教",
        dir: workspaceDirFor(state, 0, null),
      },
      {
        id: null,
        kind: "review" as const,
        name: "复习",
        dir: workspaceDirFor(state, 2, null),
      },
      ...learnSessions.map((row) => ({
        id: row.id,
        kind: "learn" as const,
        name: row.name,
        dir: path.join(state.homeDir, "learn", String(row.id)),
      })),
    ];

    res.json({
      workspaces: workspaces.map((w) => ({ ...w, dueCards: dueCount })),
    });
  });

  // POST /api/workspaces —— 新建学习工作区：session 行 + 目录
  router.post("/", async (req: Request, res: Response) => {
    const { name } = req.body as { name?: string };
    if (typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "工作区名不能为空" });
      return;
    }
    const trimmed = name.trim();
    const exists = state.db
      .prepare("SELECT COUNT(*) AS n FROM session WHERE name = ?")
      .get(trimmed) as { n: number };
    if (exists.n > 0) {
      res.status(409).json({ error: `工作区「${trimmed}」已存在` });
      return;
    }

    const info = state.db
      .prepare("INSERT INTO session (name, work_path) VALUES (?, ?)")
      .run(trimmed, `~/pi-teacher/learn/<pending>`);
    const sessionId = Number(info.lastInsertRowid);
    const dir = path.join(state.homeDir, "learn", String(sessionId));
    // work_path 记真实路径（自部署绝对路径；dev/测试目录同样成立）
    state.db
      .prepare("UPDATE session SET work_path = ? WHERE id = ?")
      .run(dir, sessionId);
    await fs.mkdir(dir, { recursive: true });

    res.json({ success: true, workspace: { id: sessionId, kind: "learn", name: trimmed, dir } });
  });

  return router;
}
