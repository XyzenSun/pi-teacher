import type Database from "better-sqlite3";

/**
 * 会话工具上下文：可见性裁决的全部输入。
 *
 * dev 阶段由验证脚本硬编码构造（PRD 对齐结论），将来由后端读 pi_session 行
 * 构造——接口形状不变，接真实查询时零改动。
 *
 * enableMakeCard 是 pi_session.enable_make_card 的快照；TA 会话恒 false
 * （工具层不看该字段直接拒绝制卡，见 visibility 模块）。
 */
export interface SessionToolContext {
    db: Database.Database;
    spaceId: 0 | 1 | 2; // 0=助教 1=学习 2=复习
    enableMakeCard: boolean;
    reviewTopicId: number | null;
    /** md/file 类工具的路径沙箱根，工具内一切 path 参数都被限制在该目录内 */
    workspaceRoot: string;
}

export const SPACE_NAMES: Record<0 | 1 | 2, string> = {
    0: "助教",
    1: "学习",
    2: "复习",
};

/** 可见性矩阵（docs/工具定义.md）：拒绝时给模型的中文原因。 */
export function assertToolAllowed(
    ctx: SessionToolContext,
    toolName: string,
): { allowed: true } | { allowed: false; reason: string } {
    const space = SPACE_NAMES[ctx.spaceId];

    // 助教不参与学习沉淀：写入类全部硬拒（ADR-0026 / 工具定义.md 可见性矩阵）
    const TA_DENIED = new Set([
        "card_propose",
        "topic_create",
        "card_delete",
        "card_merge",
        "glossary_propose",
        "review_get_due_cards",
        "review_submit_ratings",
    ]);
    if (ctx.spaceId === 0 && TA_DENIED.has(toolName)) {
        return {
            allowed: false,
            reason: `本会话是${space}对话，无权执行写入类操作（${toolName}）。助教只答疑，不推进课程、不制卡、不复习。`,
        };
    }

    // 制卡类受 enable_make_card 开关控制（学习/复习共用）
    const MAKE_CARD_TOOLS = new Set(["card_propose", "topic_create"]);
    if (MAKE_CARD_TOOLS.has(toolName) && !ctx.enableMakeCard) {
        return {
            allowed: false,
            reason: "本次对话已关闭制卡（enable_make_card = 0）。不要提议卡片或创建主题。",
        };
    }

    return { allowed: true };
}
