/**
 * 复习排期路由：学习日历的唯一数据源。
 *
 * 只做能从 card_schedule / review_log 确定性算出来的聚合——到期日分布与复习历史。
 * 前端模板里的「连续打卡天数」「平均留存率」「预计用时」没有真实数据支撑，
 * 一律不提供，界面上以空状态或不展示处理，避免把示意指标当成真实结论。
 *
 * 时间语义：card_schedule.due 与 review_log.reviewed_at 都是 UTC 的
 * `datetime('now')` 文本。按本地日历分组会引入时区漂移，因此这里统一按
 * UTC 日期（date(...)）分组，并在响应里显式声明 timezone: "UTC"。
 */
import { Router } from "express";
import type { Request, Response } from "express";
import type { AppState } from "./app-state.ts";
import { HttpError, readId } from "./http.ts";

const DEFAULT_UPCOMING_DAYS = 30;
const DEFAULT_HISTORY_DAYS = 30;
const MAX_DAYS = 365;

function readDays(value: unknown, label: string, fallback: number): number {
  if (value === undefined) return fallback;
  const days = readId(value, label);
  if (days > MAX_DAYS) throw new HttpError(400, `${label} 不能超过 ${MAX_DAYS} 天`);
  return days;
}

export function createReviewScheduleRouter(state: AppState): Router {
  const router = Router();
  const db = state.db;

  router.get("/", (req: Request, res: Response) => {
    const upcomingDays = readDays(req.query.upcomingDays, "upcomingDays", DEFAULT_UPCOMING_DAYS);
    const historyDays = readDays(req.query.historyDays, "historyDays", DEFAULT_HISTORY_DAYS);
    const topicId = req.query.topicId === undefined ? null : readId(req.query.topicId, "topicId");
    if (topicId !== null && !db.prepare("SELECT id FROM topic WHERE id = ?").get(topicId)) {
      throw new HttpError(404, "主题不存在");
    }

    const totals = db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM card c WHERE c.status = 'normal' AND (? IS NULL OR c.topic_id = ?)) AS normalCards,
         (SELECT COUNT(*) FROM card c WHERE c.status = 'proposed' AND (? IS NULL OR c.topic_id = ?)) AS proposedCards,
         (SELECT COUNT(*) FROM card c JOIN card_schedule s ON s.card_id = c.id
          WHERE c.status = 'normal' AND s.due <= datetime('now') AND (? IS NULL OR c.topic_id = ?)) AS dueNow,
         (SELECT COUNT(*) FROM card c JOIN card_schedule s ON s.card_id = c.id
          WHERE c.status = 'normal' AND s.due < date('now') AND (? IS NULL OR c.topic_id = ?)) AS overdue,
         (SELECT COUNT(*) FROM card c LEFT JOIN card_schedule s ON s.card_id = c.id
          WHERE c.status = 'normal' AND s.card_id IS NULL AND (? IS NULL OR c.topic_id = ?)) AS withoutSchedule`,
      // 五个子查询各有一对 (? IS NULL OR topic_id = ?) 占位符，全部绑定同一个 topicId
    ).get(...(Array<number | null>(10).fill(topicId))) as {
      normalCards: number; proposedCards: number; dueNow: number; overdue: number; withoutSchedule: number;
    };

    // 到期分布：只统计 [今天, 今天+upcomingDays) 区间内的到期日；
    // 早于今天的全部归入 overdue，不伪装成某一天的任务量。
    const upcoming = db.prepare(
      `SELECT date(s.due) AS date, COUNT(*) AS dueCount
       FROM card c JOIN card_schedule s ON s.card_id = c.id
       WHERE c.status = 'normal'
         AND date(s.due) >= date('now')
         AND date(s.due) < date('now', '+' || ? || ' days')
         AND (? IS NULL OR c.topic_id = ?)
       GROUP BY date(s.due) ORDER BY date(s.due)`,
    ).all(upcomingDays, topicId, topicId) as Array<{ date: string; dueCount: number }>;

    // 复习历史：按判定等级分列，全部来自 review_log 的真实写入。
    const history = db.prepare(
      `SELECT date(r.reviewed_at) AS date, COUNT(*) AS reviewCount,
              SUM(CASE WHEN r.rating = 'Again' THEN 1 ELSE 0 END) AS again,
              SUM(CASE WHEN r.rating = 'Hard' THEN 1 ELSE 0 END) AS hard,
              SUM(CASE WHEN r.rating = 'Good' THEN 1 ELSE 0 END) AS good,
              SUM(CASE WHEN r.rating = 'Easy' THEN 1 ELSE 0 END) AS easy
       FROM review_log r JOIN card c ON c.id = r.card_id
       WHERE date(r.reviewed_at) > date('now', '-' || ? || ' days')
         AND (? IS NULL OR c.topic_id = ?)
       GROUP BY date(r.reviewed_at) ORDER BY date(r.reviewed_at)`,
    ).all(historyDays, topicId, topicId) as Array<{
      date: string; reviewCount: number; again: number; hard: number; good: number; easy: number;
    }>;

    res.json({
      timezone: "UTC",
      range: { upcomingDays, historyDays },
      topicId,
      totals,
      upcoming,
      history,
    });
  });

  return router;
}
