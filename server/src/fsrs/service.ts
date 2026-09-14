import { fsrs, generatorParameters, createEmptyCard, State, type Card, type Grade } from "ts-fsrs";
import type Database from "better-sqlite3";

/**
 * FSRS 调度服务：行 ↔ Card 映射、判定落库（card_schedule 更新 + review_log 写入）。
 *
 * 关键约定（数据库与目录结构设计.md topic 表）：
 * - learning_steps / relearning_steps 固定为 []（关多步学习）——任何判定路径
 *   最短间隔 24h，一张卡一天最多出现一次
 * - ts-fsrs 的 Card.learning_steps 字段恒为 0，映射层直接丢弃（不建列）
 * - elapsed_days 在 ts-fsrs 5.x 已标 deprecated，但 v6 才移除，照常持久化
 *
 * 每个工具调 reviewSubmitRatings 时都新建一个 scheduler 实例——fsrs() 构造
 * 是纯对象组装，代价可忽略；换来的是按 topic 参数即时取用，不需要缓存失效逻辑。
 */

/** 数据库行 → ts-fsrs Card。learning_steps 恒 0，从行里取不到是设计使然。 */
/** DB 文字状态 → ts-fsrs 数字枚举 State。card_schedule 的 CHECK 保证取值合法。 */
const STATE_TEXT_TO_ENUM: Record<string, Card["state"]> = {
    new: State.New,
    learning: State.Learning,
    review: State.Review,
    relearning: State.Relearning,
};

function rowToCard(row: CardScheduleRow): Card {
    return {
        due: new Date(row.due),
        stability: row.stability,
        difficulty: row.difficulty,
        elapsed_days: row.elapsed_days,
        scheduled_days: row.scheduled_days,
        learning_steps: 0,
        reps: row.reps,
        lapses: row.lapses,
        state: STATE_TEXT_TO_ENUM[row.state],
        last_review: row.last_review ? new Date(row.last_review) : undefined,
    };
}

/** ts-fsrs 枚举 State → DB 文字。 */
const STATE_ENUM_TO_TEXT: Record<number, string> = {
    [State.New]: "new",
    [State.Learning]: "learning",
    [State.Review]: "review",
    [State.Relearning]: "relearning",
};

/**
 * Date → SQLite 文本格式（'YYYY-MM-DD HH:MM:SS'，UTC）。
 *
 * 统一用 SQLite 格式而非 ISO 8601：due 的查询条件是
 * `cs.due <= datetime('now')`，SQLite 的 datetime() 产出空格分隔格式；
 * 若存 ISO（'T' 分隔），TEXT 比较时 'T'(0x54) > ' '(0x20) 恒大，永远取不到卡。
 * review_log 的 reviewed_at 由 schema DEFAULT (datetime('now')) 同格式写入。
 */
function dateToSqliteText(date: Date): string {
    return date.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

/** ts-fsrs Card → 数据库行片段。due/last_review 统一 SQLite 文本格式（UTC）。 */
function cardToRowPatch(card: Card): Record<string, string | number | null> {
    return {
        state: STATE_ENUM_TO_TEXT[card.state],
        due: dateToSqliteText(card.due),
        stability: card.stability,
        difficulty: card.difficulty,
        elapsed_days: card.elapsed_days,
        scheduled_days: card.scheduled_days,
        reps: card.reps,
        lapses: card.lapses,
        last_review: card.last_review ? dateToSqliteText(card.last_review) : null,
    };
}

interface CardScheduleRow {
    card_id: number;
    state: string;
    due: string;
    stability: number;
    difficulty: number;
    elapsed_days: number;
    scheduled_days: number;
    reps: number;
    lapses: number;
    last_review: string | null;
}

/** 一次判定的落库结果，供工具返回给模型核对。 */
export interface RatingApplyResult {
    card_id: number;
    rating: string;
    next_due: string;
    scheduled_days: number;
}

/**
 * 卡片确认（proposed → normal）时创建初始调度行。
 *
 * 初始状态用 createEmptyCard：due = now（立刻到期，第一次复习马上见到），
 * state = new。enable_fuzz 用 ts-fsrs 默认值（开启，打散到期聚集）。
 */
export function createInitialSchedule(
    db: Database.Database,
    cardId: number,
    requestRetention: number,
    maximumInterval: number,
): void {
    const emptyCard = createEmptyCard(new Date());
    const patch = cardToRowPatch(emptyCard);
    db.prepare(`
        INSERT INTO card_schedule (card_id, state, due, stability, difficulty,
                                   elapsed_days, scheduled_days, reps, lapses, last_review)
        VALUES (@card_id, @state, @due, @stability, @difficulty,
                @elapsed_days, @scheduled_days, @reps, @lapses, @last_review)
    `).run({ card_id: cardId, ...patch });
}

/**
 * 批量提交判定：对每张卡跑 fsrs().next() 并落库。
 *
 * 单事务：要么全部判定落库，要么全部回滚——批量判定是一个原子业务动作
 * （复习是一场批量对话），半批落库会让 due 队列与 review_log 失配。
 *
 * rating 文字档（Again/Hard/Good/Easy）与 ts-fsrs 枚举值的映射直接查表，
 * 不做 parse——非法值在工具参数校验层就该被 TypeBox 拒掉。
 */
const RATING_TO_GRADE: Record<string, Grade> = {
    Again: 1,
    Hard: 2,
    Good: 3,
    Easy: 4,
};

export function applyRatings(
    db: Database.Database,
    ratings: Array<{ card_id: number; rating: string }>,
): RatingApplyResult[] {
    const readSchedule = db.prepare(`
        SELECT cs.*, t.request_retention, t.maximum_interval
        FROM card_schedule cs
        JOIN card c ON c.id = cs.card_id
        JOIN topic t ON t.id = c.topic_id
        WHERE cs.card_id = ?
    `);
    const writeSchedule = db.prepare(`
        UPDATE card_schedule
        SET state = @state, due = @due, stability = @stability, difficulty = @difficulty,
            elapsed_days = @elapsed_days, scheduled_days = @scheduled_days,
            reps = @reps, lapses = @lapses, last_review = @last_review
        WHERE card_id = @card_id
    `);
    const writeLog = db.prepare(`
        INSERT INTO review_log (card_id, rating, state, due, stability, difficulty,
                                elapsed_days, scheduled_days)
        VALUES (@card_id, @rating, @state, @due, @stability, @difficulty,
                @elapsed_days, @scheduled_days)
    `);

    const apply = db.transaction(() => {
        const results: RatingApplyResult[] = [];
        for (const { card_id, rating } of ratings) {
            const row = readSchedule.get(card_id) as (CardScheduleRow & {
                request_retention: number;
                maximum_interval: number;
            }) | undefined;
            if (!row) {
                throw new Error(`card ${card_id} has no schedule (not confirmed yet?)`);
            }

            const scheduler = fsrs(
                generatorParameters({
                    request_retention: row.request_retention,
                    maximum_interval: row.maximum_interval,
                    // 关多步学习：见文件头注释。learning_steps/relearning_steps 默认
                    // ['1m','10m']/['10m']，这里显式置空覆盖默认值。
                    learning_steps: [],
                    relearning_steps: [],
                }),
            );

            const now = new Date();
            const { card, log } = scheduler.next(
                rowToCard(row),
                now,
                RATING_TO_GRADE[rating],
            );

            writeSchedule.run({ card_id, ...cardToRowPatch(card) });
            writeLog.run({
                card_id,
                rating,
                // review_log 记的是判定前的状态快照（before），对齐 ts-fsrs ReviewLog
                // 语义：优化器重放需要「复习时的状态 + rating」
                state: row.state,
                due: row.due,
                stability: row.stability,
                difficulty: row.difficulty,
                elapsed_days: row.elapsed_days,
                scheduled_days: row.scheduled_days,
            });
            results.push({
                card_id,
                rating,
                next_due: dateToSqliteText(card.due),
                scheduled_days: card.scheduled_days,
            });
        }
        return results;
    });

    return apply();
}

/**
 * 合并卡推导初始调度：复制 stability 最低旧卡的调度状态（记忆估计宁低勿高）。
 *
 * 复制的是完整调度行（state/due/stability/...），不只是 stability——
 * due 也一起带过来，让新卡顺着旧卡的记忆节奏走。reps/lapses 保留旧卡
 * 计数，FSRS 参数优化时这些历史仍然有解释力。
 */
export function copyScheduleFromLowestStability(
    db: Database.Database,
    newCardId: number,
    sourceCardIds: number[],
): void {
    const pick = db.prepare(`
        SELECT * FROM card_schedule
        WHERE card_id = ?
        ORDER BY stability ASC
        LIMIT 1
    `);
    const insert = db.prepare(`
        INSERT INTO card_schedule (card_id, state, due, stability, difficulty,
                                   elapsed_days, scheduled_days, reps, lapses, last_review)
        SELECT ?, state, due, stability, difficulty,
               elapsed_days, scheduled_days, reps, lapses, last_review
        FROM card_schedule WHERE card_id = ?
    `);

    let source: CardScheduleRow | undefined;
    for (const id of sourceCardIds) {
        const candidate = pick.get(id) as CardScheduleRow | undefined;
        if (candidate && (!source || candidate.stability < source.stability)) {
            source = candidate;
        }
    }
    if (!source) {
        // 所有旧卡都没有调度行（都还是 proposed）：新卡用空卡初始状态，
        // due = now 立刻进入队列
        createInitialSchedule(db, newCardId, 0.9, 365);
        return;
    }
    insert.run(newCardId, source.card_id);
}

/** 查询到期卡（review_get_due_cards 的取卡逻辑），只取 status='normal'。 */
export function selectDueCards(
    db: Database.Database,
    nums: number,
    topicId: number | null,
): Array<{
    card_id: number;
    front: string;
    back: string;
    reason_and_remark: string | null;
    topic_name: string;
    last_review: string | null;
    reps: number;
    lapses: number;
}> {
    const sql = `
        SELECT c.id AS card_id, c.front, c.back, c.reason_and_remark,
               t.name AS topic_name,
               cs.last_review, cs.reps, cs.lapses
        FROM card c
        JOIN card_schedule cs ON cs.card_id = c.id
        JOIN topic t ON t.id = c.topic_id
        WHERE c.status = 'normal' AND cs.due <= datetime('now')
        ${topicId !== null ? "AND c.topic_id = ?" : ""}
        ORDER BY cs.due ASC
        LIMIT ?
    `;
    const params = topicId !== null ? [topicId, nums] : [nums];
    return db.prepare(sql).all(...params) as never;
}

/** 到期卡总数（超出 nums 上限截断时返回值注明还剩多少张要用）。 */
export function countDueCards(db: Database.Database, topicId: number | null): number {
    const sql = `
        SELECT COUNT(*) AS n
        FROM card c JOIN card_schedule cs ON cs.card_id = c.id
        WHERE c.status = 'normal' AND cs.due <= datetime('now')
        ${topicId !== null ? "AND c.topic_id = ?" : ""}
    `;
    const params = topicId !== null ? [topicId] : [];
    const row = db.prepare(sql).get(...params) as { n: number };
    return row.n;
}
