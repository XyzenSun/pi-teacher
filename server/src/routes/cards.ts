/**
 * 卡片路由：管理面板 Card 子页（全部 / 待审批 / 正常卡 / 回收站）与右侧提议池
 * 共用同一套接口（tools-dev/tasks/frontend-webui-mvp.md §2.7、§2.8）。
 *
 * 状态机（数据库与目录结构设计.md「status 三档」）：
 *   proposed --confirm--> normal --delete--> deleted --restore--> normal | proposed
 *   proposed --reject--> deleted
 *   手动新建 --> normal（用户意图本身即确认，见 ADR-0009）
 *
 * card_schedule 只在卡片首次成为 normal 时创建，软删**不删**调度行；因此
 * 恢复时有调度行的卡直接回 normal（复习进度原样回来），没有的回 proposed。
 * 「改状态」与「建/保留调度」是同一个业务动作，全部放进事务，避免出现
 * normal 却无调度行（复习队列取不到）这种半成品。
 */
import { Router } from "express";
import type { Request, Response } from "express";
import type Database from "better-sqlite3";
import type { AppState } from "./app-state.ts";
import { createInitialSchedule } from "../fsrs/service.ts";
import { HttpError, readBody, readId, readNullableText, readText } from "./http.ts";

/** card 与 glossary 共用的三档状态（数据库与目录结构设计.md：两张表的 status 完全同构）。 */
const TRI_STATE_VALUES = new Set(["proposed", "normal", "deleted"]);

export type TriStateFilter = "proposed" | "normal" | "deleted" | "all";

/**
 * 解析 status 查询参数。缺省（undefined）返回 null，语义是「工作视图」=
 * proposed + normal：回收站内容必须显式 status=deleted 或 all 才拿到，
 * 免得管理面板与提议池默认把已删卡混进列表。
 */
export function readTriStateFilter(value: unknown, label = "status"): TriStateFilter | null {
  if (value === undefined) return null;
  if (typeof value === "string" && (value === "all" || TRI_STATE_VALUES.has(value))) {
    return value as TriStateFilter;
  }
  throw new HttpError(400, `${label} 只能是 proposed / normal / deleted / all`);
}

/** 前端卡片契约显式列出字段；调度来自 LEFT JOIN，没有调度的 proposed 卡为 null。 */
const CARD_VIEW_SQL = `
  SELECT c.id, c.topic_id, t.name AS topic_name, c.front, c.back, c.status,
         c.reason_and_remark, c.created_at,
         cs.state AS schedule_state, cs.due AS schedule_due,
         cs.reps AS schedule_reps, cs.lapses AS schedule_lapses
  FROM card c
  JOIN topic t ON t.id = c.topic_id
  LEFT JOIN card_schedule cs ON cs.card_id = c.id
`;

interface CardView {
  id: number;
  topic_id: number;
  topic_name: string;
  front: string;
  back: string;
  status: string;
  reason_and_remark: string | null;
  created_at: string;
  schedule_state: string | null;
  schedule_due: string | null;
  schedule_reps: number | null;
  schedule_lapses: number | null;
}

/** 状态流转只需要这三列，比读整个投影便宜，也不牵扯 topic 表连接。 */
interface CardStateRow {
  id: number;
  topic_id: number;
  status: string;
}

interface TopicFsrsRow {
  request_retention: number;
  maximum_interval: number;
}

function selectCardView(db: Database.Database, cardId: number): CardView {
  const row = db.prepare(`${CARD_VIEW_SQL} WHERE c.id = ?`).get(cardId) as CardView | undefined;
  if (!row) throw new HttpError(404, "卡片不存在");
  return row;
}

function selectCardState(db: Database.Database, cardId: number): CardStateRow {
  const row = db
    .prepare("SELECT id, topic_id, status FROM card WHERE id = ?")
    .get(cardId) as CardStateRow | undefined;
  if (!row) throw new HttpError(404, "卡片不存在");
  return row;
}

/**
 * 保证 normal 卡有调度行，已有的原样保留。
 *
 * 确认动作绝不能重置既有进度：软删→恢复往返、card_merge 复制过来的调度行
 * 都可能先于确认存在，覆盖一次就等于把用户的复习历史清零。
 */
function ensureSchedule(db: Database.Database, cardId: number, topicId: number): void {
  const existing = db.prepare("SELECT card_id FROM card_schedule WHERE card_id = ?").get(cardId);
  if (existing) return;
  const topic = db
    .prepare("SELECT request_retention, maximum_interval FROM topic WHERE id = ?")
    .get(topicId) as TopicFsrsRow | undefined;
  if (!topic) throw new HttpError(409, "卡片所属主题已不存在，无法建立复习调度");
  createInitialSchedule(db, cardId, topic.request_retention, topic.maximum_interval);
}

function requireTopicExists(db: Database.Database, topicId: number): void {
  const topic = db.prepare("SELECT id FROM topic WHERE id = ?").get(topicId);
  if (!topic) throw new HttpError(400, `topicId ${topicId} 对应的主题不存在`);
}

export function createCardsRouter(state: AppState): Router {
  const router = Router();
  const db = state.db;

  // GET /api/cards?status=proposed|normal|deleted|all&topicId=<id>
  // 缺省 status = proposed + normal（工作视图）
  router.get("/", (req: Request, res: Response) => {
    const status = readTriStateFilter(req.query.status);
    const topicId = req.query.topicId === undefined ? null : readId(req.query.topicId, "topicId");

    const conditions: string[] = [];
    const params: unknown[] = [];
    if (status === null) {
      conditions.push("c.status != 'deleted'");
    } else if (status !== "all") {
      conditions.push("c.status = ?");
      params.push(status);
    }
    if (topicId !== null) {
      conditions.push("c.topic_id = ?");
      params.push(topicId);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const cards = db
      .prepare(`${CARD_VIEW_SQL} ${where} ORDER BY c.id DESC`)
      .all(...params) as CardView[];
    res.json({ cards });
  });

  // POST /api/cards —— 用户手动建卡：直接 normal + 真实 FSRS 初始调度
  router.post("/", (req: Request, res: Response) => {
    const body = readBody(req.body);
    const topicId = readId(body.topicId, "topicId");
    const front = readText(body.front, "front");
    const back = readText(body.back, "back");
    const reasonAndRemark = readNullableText(body.reasonAndRemark ?? null, "reasonAndRemark");

    // 一个事务：卡片入库 + 调度行创建。半成品（normal 无调度）会让复习队列漏卡。
    const createCard = db.transaction(() => {
      const topic = db
        .prepare("SELECT request_retention, maximum_interval FROM topic WHERE id = ?")
        .get(topicId) as TopicFsrsRow | undefined;
      if (!topic) throw new HttpError(400, `topicId ${topicId} 对应的主题不存在`);
      const info = db
        .prepare(
          `INSERT INTO card (topic_id, front, back, status, reason_and_remark)
           VALUES (?, ?, ?, 'normal', ?)`,
        )
        .run(topicId, front, back, reasonAndRemark);
      const cardId = Number(info.lastInsertRowid);
      createInitialSchedule(db, cardId, topic.request_retention, topic.maximum_interval);
      return cardId;
    });

    res.json({ success: true, card: selectCardView(db, createCard()) });
  });

  // PATCH /api/cards/:id —— 正反面、备注与所属主题（未传的字段保持原值）
  router.patch("/:id", (req: Request, res: Response) => {
    const cardId = readId(req.params.id, "id");
    const body = readBody(req.body);
    const current = selectCardView(db, cardId);

    const front = body.front === undefined ? null : readText(body.front, "front");
    const back = body.back === undefined ? null : readText(body.back, "back");
    // reasonAndRemark 允许显式置 null（清空备注），所以用 undefined 区分「没传」
    const reasonAndRemark =
      body.reasonAndRemark === undefined
        ? undefined
        : readNullableText(body.reasonAndRemark, "reasonAndRemark");
    const topicId = body.topicId === undefined ? null : readId(body.topicId, "topicId");

    if (front === null && back === null && reasonAndRemark === undefined && topicId === null) {
      throw new HttpError(400, "至少要提供 front / back / reasonAndRemark / topicId 之一");
    }
    if (topicId !== null && topicId !== current.topic_id) requireTopicExists(db, topicId);

    // 换主题不动调度行：FSRS 参数是主题级配置，下次判定时自然按新主题的参数走
    db.prepare("UPDATE card SET front = ?, back = ?, reason_and_remark = ?, topic_id = ? WHERE id = ?").run(
      front ?? current.front,
      back ?? current.back,
      reasonAndRemark === undefined ? current.reason_and_remark : reasonAndRemark,
      topicId ?? current.topic_id,
      cardId,
    );
    res.json({ success: true, card: selectCardView(db, cardId) });
  });

  // POST /api/cards/:id/confirm —— proposed → normal（+ 缺失时补调度行）
  router.post("/:id/confirm", (req: Request, res: Response) => {
    const cardId = readId(req.params.id, "id");
    const confirm = db.transaction(() => {
      const card = selectCardState(db, cardId);
      if (card.status === "deleted") throw new HttpError(409, "回收站里的卡片不能确认，请先恢复");
      if (card.status === "normal") return false; // 幂等：已是正式卡，且不碰既有调度
      db.prepare("UPDATE card SET status = 'normal' WHERE id = ?").run(cardId);
      ensureSchedule(db, cardId, card.topic_id);
      return true;
    });
    const changed = confirm();
    res.json({ success: true, changed, card: selectCardView(db, cardId) });
  });

  // POST /api/cards/:id/reject —— proposed → deleted（候选卡没进过队列，拒绝即入回收站）
  router.post("/:id/reject", (req: Request, res: Response) => {
    const cardId = readId(req.params.id, "id");
    const reject = db.transaction(() => {
      const card = selectCardState(db, cardId);
      if (card.status === "deleted") return false; // 幂等：已在回收站
      if (card.status !== "proposed") {
        throw new HttpError(409, "只有待审批的提议卡可以拒绝，正式卡请用删除");
      }
      db.prepare("UPDATE card SET status = 'deleted' WHERE id = ?").run(cardId);
      return true;
    });
    const changed = reject();
    res.json({ success: true, changed, card: selectCardView(db, cardId) });
  });

  // POST /api/cards/:id/delete —— 软删。调度行保留（数据库与目录结构设计.md：恢复后进度原样回来）
  router.post("/:id/delete", (req: Request, res: Response) => {
    const cardId = readId(req.params.id, "id");
    const softDelete = db.transaction(() => {
      const card = selectCardState(db, cardId);
      if (card.status === "deleted") return false; // 幂等：目标状态已达成
      db.prepare("UPDATE card SET status = 'deleted' WHERE id = ?").run(cardId);
      return true;
    });
    const changed = softDelete();
    res.json({ success: true, changed, card: selectCardView(db, cardId) });
  });

  // POST /api/cards/:id/restore —— 回收站恢复：有调度行回 normal，没有的回 proposed
  router.post("/:id/restore", (req: Request, res: Response) => {
    const cardId = readId(req.params.id, "id");
    const restore = db.transaction(() => {
      const card = selectCardState(db, cardId);
      if (card.status !== "deleted") throw new HttpError(409, "只有回收站里的卡片可以恢复");
      // 有调度行说明它曾是正式卡，直接回队列；没有说明当初是被拒的候选卡，回待审批
      const hasSchedule = !!db
        .prepare("SELECT card_id FROM card_schedule WHERE card_id = ?")
        .get(cardId);
      const restoredStatus = hasSchedule ? "normal" : "proposed";
      db.prepare("UPDATE card SET status = ? WHERE id = ?").run(restoredStatus, cardId);
      return restoredStatus;
    });
    const restoredStatus = restore();
    res.json({ success: true, restoredStatus, card: selectCardView(db, cardId) });
  });

  // POST /api/cards/merge —— 只读预览：给前端展示合并后的卡面，真正的合并由工具层做
  router.post("/merge", (req: Request, res: Response) => {
    const body = readBody(req.body);
    const primaryId = readId(body.primaryId, "primaryId");
    const secondaryId = readId(body.secondaryId, "secondaryId");
    if (primaryId === secondaryId) throw new HttpError(400, "primaryId 与 secondaryId 不能相同");

    const primary = selectCardView(db, primaryId);
    const secondary = selectCardView(db, secondaryId);
    if (primary.topic_id !== secondary.topic_id) {
      // 与工具层 card_merge 同一条约束：跨主题合并没有归类意义
      throw new HttpError(409, "两张卡不属于同一个主题，无法合并");
    }
    // 合并视图与工具层 card_merge 语义一致：正面取主卡，背面拼接
    res.json({
      primary,
      secondary,
      preview: { front: primary.front, back: `${primary.back}\n\n${secondary.back}` },
    });
  });

  return router;
}
