/**
 * 卡片路由：提议列表、确认（proposed→normal + 初始调度）、拒绝、编辑、
 * 软删、恢复。合并视图复用工具层语义（stability 取最低、due 复制）。
 */
import { Router } from "express";
import type { Request, Response } from "express";
import type { AppState } from "./app-state.ts";
import { createInitialSchedule } from "../fsrs/service.ts";

interface CardRow {
  id: number;
  topic_id: number;
  front: string;
  back: string;
  status: string;
  reason_and_remark: string | null;
  created_at: string;
}

export function createCardsRouter(state: AppState): Router {
  const router = Router();

  // GET /api/cards?status=proposed|normal|deleted（默认 proposed+normal）
  router.get("/", (req: Request, res: Response) => {
    const status = typeof req.query.status === "string" ? req.query.status : null;
    const rows = status
      ? (state.db.prepare("SELECT * FROM card WHERE status = ? ORDER BY id DESC").all(status) as CardRow[])
      : (state.db.prepare("SELECT * FROM card WHERE status != 'deleted' ORDER BY id DESC").all() as CardRow[]);
    res.json({ cards: rows });
  });

  // POST /api/cards/:id/confirm —— proposed → normal + card_schedule 初始行
  router.post("/:id/confirm", (req: Request, res: Response) => {
    const card = state.db
      .prepare("SELECT * FROM card WHERE id = ?")
      .get(req.params.id) as CardRow | undefined;
    if (!card) {
      res.status(404).json({ error: "卡片不存在" });
      return;
    }
    if (card.status === "deleted") {
      res.status(409).json({ error: "已删除的卡片不能确认" });
      return;
    }
    if (card.status === "normal") {
      res.json({ success: true, card }); // 幂等：已确认直接返回
      return;
    }
    state.db.prepare("UPDATE card SET status = 'normal' WHERE id = ?").run(card.id);
    // FSRS 初始调度（new → due=now），参数取卡片所属 topic 的配置
    const topic = state.db
      .prepare("SELECT request_retention, maximum_interval FROM topic WHERE id = ?")
      .get(card.topic_id) as { request_retention: number; maximum_interval: number };
    createInitialSchedule(state.db, card.id, topic.request_retention, topic.maximum_interval);
    res.json({ success: true });
  });

  // POST /api/cards/:id/reject —— proposed → deleted（没进过队列，软删即终态）
  router.post("/:id/reject", (req: Request, res: Response) => {
    const info = state.db
      .prepare("UPDATE card SET status = 'deleted' WHERE id = ? AND status = 'proposed'")
      .run(req.params.id);
    if (info.changes === 0) {
      const exists = state.db.prepare("SELECT id FROM card WHERE id = ?").get(req.params.id);
      res.status(exists ? 409 : 404).json({ error: exists ? "仅提议卡可拒绝" : "卡片不存在" });
      return;
    }
    res.json({ success: true });
  });

  // PATCH /api/cards/:id —— 编辑正反面与备注
  router.patch("/:id", (req: Request, res: Response) => {
    const card = state.db
      .prepare("SELECT * FROM card WHERE id = ?")
      .get(req.params.id) as CardRow | undefined;
    if (!card) {
      res.status(404).json({ error: "卡片不存在" });
      return;
    }
    const { front, back, reasonAndRemark } = req.body as { front?: string; back?: string; reasonAndRemark?: string | null };
    if (front !== undefined && (typeof front !== "string" || !front.trim())) {
      res.status(400).json({ error: "front 不能为空" });
      return;
    }
    if (back !== undefined && (typeof back !== "string" || !back.trim())) {
      res.status(400).json({ error: "back 不能为空" });
      return;
    }
    state.db
      .prepare("UPDATE card SET front = ?, back = ?, reason_and_remark = ? WHERE id = ?")
      .run(
        front?.trim() ?? card.front,
        back?.trim() ?? card.back,
        reasonAndRemark === undefined ? card.reason_and_remark : reasonAndRemark,
        card.id,
      );
    res.json({ success: true });
  });

  // POST /api/cards/:id/delete —— 软删（调度行保留，FSRS 语义，见数据库设计.md）
  router.post("/:id/delete", (req: Request, res: Response) => {
    const info = state.db
      .prepare("UPDATE card SET status = 'deleted' WHERE id = ? AND status != 'deleted'")
      .run(req.params.id);
    if (info.changes === 0) {
      const exists = state.db.prepare("SELECT id FROM card WHERE id = ?").get(req.params.id);
      res.status(exists ? 200 : 404).json({ error: exists ? "已经是删除态" : "卡片不存在" });
      return;
    }
    res.json({ success: true });
  });

  // POST /api/cards/:id/restore —— deleted → proposed（回到提议池，调度行还在）
  router.post("/:id/restore", (req: Request, res: Response) => {
    const info = state.db
      .prepare("UPDATE card SET status = 'proposed' WHERE id = ? AND status = 'deleted'")
      .run(req.params.id);
    if (info.changes === 0) {
      const exists = state.db.prepare("SELECT id FROM card WHERE id = ?").get(req.params.id);
      res.status(exists ? 409 : 404).json({ error: exists ? "仅删除态可恢复" : "卡片不存在" });
      return;
    }
    res.json({ success: true });
  });

  // POST /api/cards/merge —— 两张卡合并视图：给前端预览合并后的卡面
  router.post("/merge", (req: Request, res: Response) => {
    const { primaryId, secondaryId } = req.body as { primaryId?: number; secondaryId?: number };
    if (!primaryId || !secondaryId || primaryId === secondaryId) {
      res.status(400).json({ error: "primaryId/secondaryId 必填且不同" });
      return;
    }
    const primary = state.db.prepare("SELECT * FROM card WHERE id = ?").get(primaryId) as CardRow | undefined;
    const secondary = state.db.prepare("SELECT * FROM card WHERE id = ?").get(secondaryId) as CardRow | undefined;
    if (!primary || !secondary) {
      res.status(404).json({ error: "卡片不存在" });
      return;
    }
    // 合并视图与工具层 card_merge 语义一致：正面主卡，背面拼接
    res.json({
      primary,
      secondary,
      preview: {
        front: primary.front,
        back: `${primary.back}\n\n${secondary.back}`,
      },
    });
  });

  return router;
}
