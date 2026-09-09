/**
 * 主题路由：管理面板 Topic 子页（列表、创建、编辑 + FSRS 参数）。
 *
 * FSRS 参数是主题级配置（数据库与目录结构设计.md topic 表）：核心算法可要 95% 保留率，
 * 边缘知识 80% 即可。另两个参数 learning_steps / relearning_steps 由代码固定
 * 为 []，不建列、也不开放给接口。
 *
 * 不提供删除：card.topic_id 是 NOT NULL 外键，删主题等于让卡片悬空；主题不再
 * 使用时留着不碍事（列表里卡片数为 0 一眼可辨）。
 */
import { Router } from "express";
import type { Request, Response } from "express";
import type Database from "better-sqlite3";
import type { AppState } from "./app-state.ts";
import { HttpError, readBody, readId, readNullableText, readText } from "./http.ts";

/** request_retention 合法区间：低于 0.5 复习没意义，高于 0.99 间隔坍缩成天天见。 */
const RETENTION_MIN = 0.5;
const RETENTION_MAX = 0.99;

interface TopicRow {
  id: number;
  name: string;
  description: string | null;
  request_retention: number;
  maximum_interval: number;
  created_at: string;
}

const TOPIC_COLUMNS = "id, name, description, request_retention, maximum_interval, created_at";

function readRequestRetention(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < RETENTION_MIN || value > RETENTION_MAX) {
    throw new HttpError(400, `requestRetention 必须是 [${RETENTION_MIN}, ${RETENTION_MAX}] 区间内的数字`);
  }
  return value;
}

function readMaximumInterval(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new HttpError(400, "maximumInterval 必须是 ≥1 的整数（天）");
  }
  return value;
}

function selectTopic(db: Database.Database, topicId: number): TopicRow {
  const row = db
    .prepare(`SELECT ${TOPIC_COLUMNS} FROM topic WHERE id = ?`)
    .get(topicId) as TopicRow | undefined;
  if (!row) throw new HttpError(404, "主题不存在");
  return row;
}

/**
 * 重名预检：唯一约束本身由数据库保证（并发下靠中央错误中间件翻 409），
 * 这里多查一次只为把冲突的主题 id 告诉用户，让界面能直接跳过去。
 */
function assertNameAvailable(db: Database.Database, name: string, excludeTopicId: number | null): void {
  const conflict = db
    .prepare("SELECT id FROM topic WHERE name = ? AND id != ?")
    .get(name, excludeTopicId ?? -1) as { id: number } | undefined;
  if (conflict) throw new HttpError(409, `主题「${name}」已存在（id=${conflict.id}），请直接复用`);
}

export function createTopicsRouter(state: AppState): Router {
  const router = Router();
  const db = state.db;

  // GET /api/topics —— 列表带卡片数与到期数，管理面板与复习入口都用这一份
  router.get("/", (_req: Request, res: Response) => {
    const topics = db
      .prepare(
        `SELECT ${TOPIC_COLUMNS.split(", ").map((column) => `t.${column}`).join(", ")},
                (SELECT COUNT(*) FROM card c
                 WHERE c.topic_id = t.id AND c.status = 'normal') AS card_count,
                (SELECT COUNT(*) FROM card c
                 WHERE c.topic_id = t.id AND c.status = 'proposed') AS proposed_count,
                (SELECT COUNT(*) FROM card c JOIN card_schedule cs ON cs.card_id = c.id
                 WHERE c.topic_id = t.id AND c.status = 'normal'
                       AND cs.due <= datetime('now')) AS due_count
         FROM topic t ORDER BY t.id`,
      )
      .all();
    res.json({ topics });
  });

  // POST /api/topics —— 新建主题。FSRS 参数不传则用 schema 默认（0.9 / 365）
  router.post("/", (req: Request, res: Response) => {
    const body = readBody(req.body);
    const name = readText(body.name, "name", 200);
    const description = readNullableText(body.description ?? null, "description");
    const requestRetention =
      body.requestRetention === undefined ? null : readRequestRetention(body.requestRetention);
    const maximumInterval =
      body.maximumInterval === undefined ? null : readMaximumInterval(body.maximumInterval);

    assertNameAvailable(db, name, null);
    const info = db
      .prepare(
        `INSERT INTO topic (name, description, request_retention, maximum_interval)
         VALUES (?, ?, COALESCE(?, 0.9), COALESCE(?, 365))`,
      )
      .run(name, description, requestRetention, maximumInterval);
    res.json({ success: true, topic: selectTopic(db, Number(info.lastInsertRowid)) });
  });

  // PATCH /api/topics/:id —— 名称、描述与 FSRS 参数（未传的字段保持原值）
  router.patch("/:id", (req: Request, res: Response) => {
    const topicId = readId(req.params.id, "id");
    const body = readBody(req.body);
    const current = selectTopic(db, topicId);

    const name = body.name === undefined ? null : readText(body.name, "name", 200);
    // description 允许显式置 null（清空），故用 undefined 区分「没传」
    const description =
      body.description === undefined ? undefined : readNullableText(body.description, "description");
    const requestRetention =
      body.requestRetention === undefined ? null : readRequestRetention(body.requestRetention);
    const maximumInterval =
      body.maximumInterval === undefined ? null : readMaximumInterval(body.maximumInterval);

    if (name === null && description === undefined && requestRetention === null && maximumInterval === null) {
      throw new HttpError(400, "至少要提供 name / description / requestRetention / maximumInterval 之一");
    }
    if (name !== null && name !== current.name) assertNameAvailable(db, name, topicId);

    // 改参数不动 card_schedule：新参数在下一次判定（fsrs/service.applyRatings
    // 按 topic 现值构造 scheduler）自然生效，已算好的 due 不追溯重排
    db.prepare(
      `UPDATE topic SET name = ?, description = ?, request_retention = ?, maximum_interval = ?
       WHERE id = ?`,
    ).run(
      name ?? current.name,
      description === undefined ? current.description : description,
      requestRetention ?? current.request_retention,
      maximumInterval ?? current.maximum_interval,
      topicId,
    );
    res.json({ success: true, topic: selectTopic(db, topicId) });
  });

  return router;
}
