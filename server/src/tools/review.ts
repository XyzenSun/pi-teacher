import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { assertToolAllowed, type SessionToolContext } from "./context.ts";
import { applyRatings, selectDueCards, countDueCards } from "../fsrs/service.ts";

/**
 * review_* 工具组：取卡与判定。
 *
 * 学习对话里这两个是反模式——工具不拦、提示词管；
 * 用户明确要求穿插复习时照做。nums 上限 100：一次取上千张会爆上下文，
 * 积压靠「取卡 → 复习 → 判定 → 再取」循环消化。
 */

const MAX_DUE_CARDS = 100;

function toolResult(text: string): { content: Array<{ type: "text"; text: string }>; details: null } {
    return { content: [{ type: "text", text }], details: null };
}

export function createReviewTools(ctx: SessionToolContext): ToolDefinition[] {
    const db = ctx.db;

    const reviewGetDueCards = defineTool({
        name: "review_get_due_cards",
        label: "取到期卡",
        description:
            "取出到期的复习卡片（仅正式卡，最逾期的在前）。每张返回 id、front、back、reason_and_remark、topic_name 及复习历史（reps、lapses、last_review）——失误多的卡可多追问一步。",
        parameters: Type.Object({
            nums: Type.Number({ description: "本次取多少张，结合用户状态自行决定" }),
            topic_id: Type.Optional(Type.Number({ description: "按主题过滤；不传取全部主题" })),
        }),
        async execute(_toolCallId, params) {
            const gate = assertToolAllowed(ctx, "review_get_due_cards");
            if (!gate.allowed) return toolResult(gate.reason);

            // topic_id 显式过滤优先于 pi_session.review_topic_id：
            // 模型主动指定的范围是更具体的意图
            const topicFilter =
                params.topic_id !== undefined ? params.topic_id : ctx.reviewTopicId;

            const requested = Math.min(Math.max(Math.floor(params.nums), 1), MAX_DUE_CARDS);
            const cards = selectDueCards(db, requested, topicFilter);
            const totalDue = countDueCards(db, topicFilter);

            let header = `本次取到 ${cards.length} 张（全部到期 ${totalDue} 张）`;
            if (totalDue > requested) {
                header += `，剩余 ${totalDue - requested} 张未取——判定落库后再取下一批`;
            }

            return toolResult(header + "\n" + JSON.stringify(cards, null, 2));
        },
    });

    const reviewSubmitRatings = defineTool({
        name: "review_submit_ratings",
        label: "提交判定",
        description:
            "批量提交本批卡片的判定结果。rating 四档：Again（答错/想不起）、Hard（明显吃力才答出）、Good（正常答出）、Easy（轻松秒答）。FSRS 调度由本工具完成，无需关心。",
        parameters: Type.Object({
            ratings: Type.Array(
                Type.Object({
                    card_id: Type.Number({ description: "卡片 id" }),
                    rating: Type.Union(
                        [Type.Literal("Again"), Type.Literal("Hard"), Type.Literal("Good"), Type.Literal("Easy")],
                        { description: "判定档位" },
                    ),
                }),
                { description: "判定列表，每项 { card_id, rating }" },
            ),
        }),
        async execute(_toolCallId, params) {
            const gate = assertToolAllowed(ctx, "review_submit_ratings");
            if (!gate.allowed) return toolResult(gate.reason);

            if (params.ratings.length === 0) {
                return toolResult("拒绝：ratings 为空列表。没有要判定的卡就不需要调用本工具。");
            }

            // 前置校验卡存在且有调度行（未确认的 proposed 卡没有调度行）
            const checkCard = db.prepare(
                `SELECT c.status FROM card c LEFT JOIN card_schedule cs ON cs.card_id = c.id
                 WHERE c.id = ?`,
            );
            const invalid: string[] = [];
            for (const { card_id } of params.ratings) {
                const row = checkCard.get(card_id) as { status: string } | undefined;
                if (!row) invalid.push(`card_id=${card_id} 不存在`);
                else if (row.status !== "normal") invalid.push(`card_id=${card_id} 状态为 ${row.status}（不是正式卡）`);
            }
            if (invalid.length > 0) {
                return toolResult(`拒绝：以下卡片无法判定（不存在或未确认进入复习队列）：\n${invalid.join("\n")}`);
            }

            const results = applyRatings(db, params.ratings);
            return toolResult(
                `已提交 ${results.length} 张判定。\n` +
                    results
                        .map((r) => `- card_id=${r.card_id} [${r.rating}] 下次到期 ${r.next_due}（${r.scheduled_days} 天后）`)
                        .join("\n"),
            );
        },
    });

    return [reviewGetDueCards, reviewSubmitRatings];
}
