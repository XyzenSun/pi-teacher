/** 主题路由：列表与 FSRS 参数编辑（request_retention / maximum_interval）。 */
import { Router } from "express";
import type { Request, Response } from "express";
import type { AppState } from "./app-state.ts";

interface TopicRow {
  id: number;
  name: string;
  description: string | null;
  request_retention: number;
  maximum_interval: number;
}

export function createTopicsRouter(state: AppState): Router {
  const router = Router();

  router.get("/", (_req: Request, res: Response) => {
    res.json({ topics: state.db.prepare("SELECT * FROM topic ORDER BY id").all() as TopicRow[] });
  });

  // PATCH /api/topics/:id —— 名称/描述/FSRS 参数。参数范围校验防手滑
  router.patch("/:id", (req: Request, res: Response) => {
    const topic = state.db.prepare("SELECT * FROM topic WHERE id = ?").get(req.params.id) as TopicRow | undefined;
    if (!topic) {
      res.status(404).json({ error: "主题不存在" });
      return;
    }
    const { name, description, requestRetention, maximumInterval } = req.body as {
      name?: string; description?: string | null; requestRetention?: number; maximumInterval?: number;
    };
    if (requestRetention !== undefined && (typeof requestRetention !== "number" || requestRetention < 0.5 || requestRetention > 0.99)) {
      res.status(400).json({ error: "request_retention 合法区间 [0.5, 0.99]" });
      return;
    }
    if (maximumInterval !== undefined && (typeof maximumInterval !== "number" || !Number.isInteger(maximumInterval) || maximumInterval < 1)) {
      res.status(400).json({ error: "maximum_interval 必须是 ≥1 的整数" });
      return;
    }
    if (name !== undefined && (typeof name !== "string" || !name.trim())) {
      res.status(400).json({ error: "name 不能为空" });
      return;
    }
    state.db
      .prepare("UPDATE topic SET name = ?, description = ?, request_retention = ?, maximum_interval = ? WHERE id = ?")
      .run(
        name?.trim() ?? topic.name,
        description === undefined ? topic.description : description,
        requestRetention ?? topic.request_retention,
        maximumInterval ?? topic.maximum_interval,
        topic.id,
      );
    res.json({ success: true });
  });

  return router;
}
