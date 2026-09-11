import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { assertToolAllowed, type SessionToolContext } from "./context.ts";

/**
 * card_* 与 topic_* 工具组：制卡相关（提议、增删查改、合并、Topic 管理）。
 *
 * 设计约束（docs/工具定义.md）：
 * - 模型无物理增删权，只有状态提案权（ADR-0005）：propose 固定写 'proposed'
 * - 时间戳由代码填（schema DEFAULT），工具参数里不出现时间字段
 * - 返回值给原料不给结论：拒绝时附 front 列表让模型自己判断下一步
 */

/** 归一化去重（ADR-0017）：精确匹配归代码，语义判断归模型。 */
function normalizeFront(front: string): string {
    return front
        .trim()
        // 删除全部空白：中文语境里「JVM 的」与「JVM的」是同一句话，
        // 英文语境里空格也不承载卡面区分度（front 是问题文本不是标识符）
        .replace(/\s+/g, "")
        // 中英文标点统一：成对标点各归一边，顿号句号等归英文对应
        .replace(/[，、]/g, ",")
        .replace(/。/g, ".")
        .replace(/[；;]/g, ";")
        .replace(/[：:]/g, ":")
        .replace(/[？?]/g, "?")
        .replace(/[！!]/g, "!")
        .replace(/[（(]/g, "(")
        .replace(/[）)]/g, ")")
        .replace(/[「『"']/g, "\"")
        .replace(/[」』"']/g, "\"")
        .toLowerCase();
}

function toolResult(text: string): { content: Array<{ type: "text"; text: string }>; details: null } {
    return { content: [{ type: "text", text }], details: null };
}

/** 组内共享：按 Topic 查现有卡 front 列表（去重判断、事后察觉语义相似的原料）。 */
function listTopicFronts(db: SessionToolContext["db"], topicId: number): string[] {
    const rows = db
        .prepare(
            `SELECT front FROM card WHERE topic_id = ? AND status IN ('proposed', 'normal')
             ORDER BY created_at DESC`,
        )
        .all(topicId) as Array<{ front: string }>;
    return rows.map((r) => r.front);
}

export function createCardTopicTools(ctx: SessionToolContext): ToolDefinition[] {
    const db = ctx.db;

    const cardPropose = defineTool({
        name: "card_propose",
        label: "提议制卡",
        description:
            "提议一张新的学习卡片。卡片以待审批状态入库，用户确认后才进入复习。topic_name 必须是已存在的主题名称——先 topic_list 核对，确为新主题先 topic_create。",
        parameters: Type.Object({
            topic_name: Type.String({ description: "主题名称，必须是 topic_list 中已存在的名称" }),
            front: Type.String({ description: "卡片正面（问题）" }),
            back: Type.String({ description: "卡片背面（参考答案或评价标准）" }),
            reason_and_remark: Type.String({ description: "为什么造这张卡、补充说明" }),
        }),
        async execute(_toolCallId, params) {
            const gate = assertToolAllowed(ctx, "card_propose");
            if (!gate.allowed) return toolResult(gate.reason);

            const topic = db
                .prepare("SELECT id, name FROM topic WHERE name = ?")
                .get(params.topic_name) as { id: number; name: string } | undefined;
            if (!topic) {
                return toolResult(
                    `拒绝：主题「${params.topic_name}」不存在。先 topic_list 核对现有主题；确为新主题时先 topic_create 再提议卡片。`,
                );
            }

            // 去重范围按 Topic（数据库与目录结构设计.md）：同 Topic 内 front 归一化后重复即拒绝
            const existing = listTopicFronts(db, topic.id);
            const normalizedNew = normalizeFront(params.front);
            const duplicate = existing.find((f) => normalizeFront(f) === normalizedNew);
            if (duplicate) {
                return toolResult(
                    `拒绝：该主题下已存在正面高度相似的卡。\n现有卡 front 列表（按创建时间倒序）：\n${existing
                        .map((f) => `- ${f}`)
                        .join("\n")}\n\n重复项：${duplicate}\n请自行判断：放弃、换个角度重出，或用 card_merge 合并现有卡。`,
                );
            }

            const result = db
                .prepare(
                    `INSERT INTO card (topic_id, front, back, status, reason_and_remark)
                     VALUES (?, ?, ?, 'proposed', ?)`,
                )
                .run(
                    topic.id,
                    params.front,
                    params.back,
                    params.reason_and_remark,
                );

            return toolResult(
                `已提议卡片 card_id=${result.lastInsertRowid}（待用户审批）。主题「${topic.name}」现有卡片 front：\n${existing
                    .map((f) => `- ${f}`)
                    .join("\n")}\n若发现语义相近的卡，考虑合并而非堆叠。`,
            );
        },
    });

    const cardList = defineTool({
        name: "card_list",
        label: "卡片列表",
        description: "列出卡片（仅已确认的正式卡），每条返回 id、topic_name、front。topic_id 可选，用于核对某主题下已有哪些卡。",
        parameters: Type.Object({
            topic_id: Type.Optional(Type.Number({ description: "按主题过滤，不传则列出全部" })),
        }),
        async execute(_toolCallId, params) {
            const gate = assertToolAllowed(ctx, "card_list");
            if (!gate.allowed) return toolResult(gate.reason);

            const rows = params.topic_id
                ? (db
                      .prepare(
                          `SELECT c.id, t.name AS topic_name, c.front
                           FROM card c JOIN topic t ON t.id = c.topic_id
                           WHERE c.status = 'normal' AND c.topic_id = ?
                           ORDER BY c.created_at DESC`,
                      )
                      .all(params.topic_id) as never)
                : (db
                      .prepare(
                          `SELECT c.id, t.name AS topic_name, c.front
                           FROM card c JOIN topic t ON t.id = c.topic_id
                           WHERE c.status = 'normal'
                           ORDER BY c.created_at DESC`,
                      )
                      .all() as never);

            return toolResult(JSON.stringify(rows, null, 2));
        },
    });

    const cardGet = defineTool({
        name: "card_get",
        label: "卡片详情",
        description: "返回一张卡片的全部字段：id、topic_id、topic_name、front、back、status、reason_and_remark、created_at。",
        parameters: Type.Object({
            card_id: Type.Number({ description: "卡片 id" }),
        }),
        async execute(_toolCallId, params) {
            const gate = assertToolAllowed(ctx, "card_get");
            if (!gate.allowed) return toolResult(gate.reason);

            const row = db
                .prepare(
                    `SELECT c.id, c.topic_id, t.name AS topic_name, c.front, c.back, c.status,
                            c.reason_and_remark, c.created_at
                     FROM card c JOIN topic t ON t.id = c.topic_id WHERE c.id = ?`,
                )
                .get(params.card_id);
            return toolResult(row ? JSON.stringify(row, null, 2) : `拒绝：card_id=${params.card_id} 不存在`);
        },
    });

    const cardDelete = defineTool({
        name: "card_delete",
        label: "软删卡片",
        description: "将一张卡片移入回收站（软删除，可恢复）。reason 会追加到 reason_and_remark 供用户在回收站查看。",
        parameters: Type.Object({
            card_id: Type.Number({ description: "卡片 id" }),
            reason: Type.Optional(Type.String({ description: "删除原因，显示给用户" })),
        }),
        async execute(_toolCallId, params) {
            const gate = assertToolAllowed(ctx, "card_delete");
            if (!gate.allowed) return toolResult(gate.reason);

            const row = db
                .prepare("SELECT status, reason_and_remark FROM card WHERE id = ?")
                .get(params.card_id) as { status: string; reason_and_remark: string | null } | undefined;
            if (!row) return toolResult(`拒绝：card_id=${params.card_id} 不存在`);
            if (row.status === "deleted") return toolResult(`card_id=${params.card_id} 已在回收站，无需重复删除`);

            const remarkSuffix = params.reason
                ? `${row.reason_and_remark ? `${row.reason_and_remark}\n` : ""}[删除原因] ${params.reason}`
                : row.reason_and_remark;
            db.prepare("UPDATE card SET status = 'deleted', reason_and_remark = ? WHERE id = ?").run(
                remarkSuffix,
                params.card_id,
            );
            return toolResult(`已软删除 card_id=${params.card_id}（进回收站，用户可在界面恢复）。`);
        },
    });

    const cardMerge = defineTool({
        name: "card_merge",
        label: "合并卡片",
        description:
            "将几张高度重复的卡合并为一张新卡。旧卡全部移入回收站；新卡直接成为正式卡（合并前用户已在对话中同意）。新卡复习状态取记忆估计最低（stability 最低）的旧卡。",
        parameters: Type.Object({
            target_front: Type.String({ description: "合并后新卡的正面（问题）" }),
            target_back: Type.String({ description: "合并后新卡的背面（参考答案或评价标准）" }),
            merged_card_ids: Type.Array(Type.Number(), { description: "被合并的旧卡 id 列表（至少两张）" }),
            reason_and_remark: Type.String({ description: "为什么合并、合并逻辑说明" }),
        }),
        async execute(_toolCallId, params) {
            const gate = assertToolAllowed(ctx, "card_merge");
            if (!gate.allowed) return toolResult(gate.reason);

            if (params.merged_card_ids.length < 2) {
                return toolResult("拒绝：合并至少需要两张卡（merged_card_ids 少于 2 张没有合并意义）。");
            }

            // 三件事一个事务：新卡入库 + 旧卡软删 + 新卡调度状态复制
            // （fsrs/service.ts 的 copyScheduleFromLowestStability）
            const oldCards = db
                .prepare(
                    `SELECT id, topic_id, status FROM card WHERE id IN (${params.merged_card_ids.map(() => "?").join(",")})`,
                )
                .all(...params.merged_card_ids) as Array<{ id: number; topic_id: number; status: string }>;
            if (oldCards.length !== params.merged_card_ids.length) {
                return toolResult(`拒绝：merged_card_ids 中有不存在的 card_id。实际找到 ${oldCards.length} 张。`);
            }
            if (new Set(oldCards.map((c) => c.topic_id)).size !== 1) {
                return toolResult("拒绝：被合并的卡必须属于同一个主题（topic 不同无法合并）。");
            }

            const merge = db.transaction(() => {
                const targetTopicId = oldCards[0].topic_id;
                const insertNew = db
                    .prepare(
                        `INSERT INTO card (topic_id, front, back, status, reason_and_remark)
                         VALUES (?, ?, ?, 'normal', ?)`,
                    )
                    .run(
                        targetTopicId,
                        params.target_front,
                        params.target_back,
                        params.reason_and_remark,
                    ) as { lastInsertRowid: number };

                const stampDeleted = db.prepare("UPDATE card SET status = 'deleted' WHERE id = ?");
                for (const old of oldCards) stampDeleted.run(old.id);

                return insertNew.lastInsertRowid;
            });
            const newCardId = merge();

            // 调度状态复制放事务外（insert-only，失败不会破坏一致性；且复用 fsrs 模块的函数）
            const { copyScheduleFromLowestStability } = await import("../fsrs/service.ts");
            copyScheduleFromLowestStability(db, newCardId, params.merged_card_ids);

            return toolResult(
                `已合并：新卡 card_id=${newCardId}（正式卡，直接进入复习队列），旧卡 ${params.merged_card_ids.join(", ")} 已移入回收站。`,
            );
        },
    });

    const topicCreate = defineTool({
        name: "topic_create",
        label: "创建主题",
        description:
            "创建一个新的学习主题（Topic）。名称全局唯一。建主题是显式动作：制卡前先 topic_list 优先复用现有主题，确为新主题才调用本工具。",
        parameters: Type.Object({
            name: Type.String({ description: "主题名称，全局唯一" }),
            description: Type.Optional(Type.String({ description: "主题说明，帮助后续归类判断" })),
        }),
        async execute(_toolCallId, params) {
            const gate = assertToolAllowed(ctx, "topic_create");
            if (!gate.allowed) return toolResult(gate.reason);

            try {
                const result = db
                    .prepare("INSERT INTO topic (name, description) VALUES (?, ?)")
                    .run(params.name, params.description ?? null);
                return toolResult(`已创建主题「${params.name}」topic_id=${result.lastInsertRowid}。`);
            } catch (error) {
                // UNIQUE 约束冲突 = 重名，转换成模型能理解的拒绝语义
                if ((error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
                    const existing = db
                        .prepare("SELECT id, description FROM topic WHERE name = ?")
                        .get(params.name) as { id: number; description: string | null };
                    return toolResult(
                        `拒绝：主题「${params.name}」已存在（topic_id=${existing.id}）。请直接复用；若现有描述不准，让用户在界面修改。`,
                    );
                }
                throw error;
            }
        },
    });

    const topicList = defineTool({
        name: "topic_list",
        label: "主题列表",
        description: "列出全部主题：id、name、description、卡片数、到期数。制卡前先看这个列表优先复用现有主题。",
        parameters: Type.Object({}),
        async execute(_toolCallId, _params) {
            const gate = assertToolAllowed(ctx, "topic_list");
            if (!gate.allowed) return toolResult(gate.reason);

            const rows = db
                .prepare(
                    `SELECT t.id, t.name, t.description,
                            (SELECT COUNT(*) FROM card c WHERE c.topic_id = t.id AND c.status = 'normal') AS card_count,
                            (SELECT COUNT(*) FROM card c JOIN card_schedule cs ON cs.card_id = c.id
                             WHERE c.topic_id = t.id AND c.status = 'normal' AND cs.due <= datetime('now')) AS due_count
                     FROM topic t ORDER BY t.name`,
                )
                .all();
            return toolResult(JSON.stringify(rows, null, 2));
        },
    });

    return [cardPropose, cardList, cardGet, cardDelete, cardMerge, topicCreate, topicList];
}
