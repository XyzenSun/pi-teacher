import type Database from "better-sqlite3";
import type { PiSessionRow, SpaceType } from "../db/types.ts";

/** 业务权限按数据库里的 Space 类型裁决，工作目录只用于解析相对文件路径。 */
export interface SessionToolContext {
  db: Database.Database;
  piSessionId: number;
  spaceType: SpaceType;
  reviewTopicId: number | null;
  workPath: string;
  /**
   * 制卡开关按需读库，而不是会话启动时的快照。
   * 上下文被 extension factory 闭包捕获并贯穿整条 Pi Session 的生命周期，
   * 若在这里固化布尔值，运行期改库就变成「界面开了、工具还拒」的假开关。
   */
  isMakeCardEnabled(): boolean;
}

export function toolContextFor(db: Database.Database, row: PiSessionRow): SessionToolContext {
  return {
    db,
    piSessionId: row.id,
    spaceType: row.space_type,
    reviewTopicId: row.review_topic_id,
    workPath: row.work_path,
    isMakeCardEnabled: () => isMakeCardEnabled(db, row.id),
  };
}

/** 助教恒关；其余会话读当前行。行被删则按关闭处理，避免残留上下文继续放行写入。 */
export function isMakeCardEnabled(db: Database.Database, piSessionId: number): boolean {
  const row = db.prepare("SELECT enable_make_card FROM pi_session WHERE id = ?")
    .get(piSessionId) as { enable_make_card: number } | undefined;
  return row?.enable_make_card === 1;
}

const TA_DENIED = new Set([
  "card_propose", "topic_create", "card_delete", "card_merge", "glossary_propose",
  "review_get_due_cards", "review_submit_ratings",
]);
const MAKE_CARD_TOOLS = new Set(["card_propose", "topic_create"]);

export function assertToolAllowed(
  ctx: SessionToolContext,
  toolName: string,
): { allowed: true } | { allowed: false; reason: string } {
  if (ctx.spaceType === "ta" && TA_DENIED.has(toolName)) {
    return { allowed: false, reason: `本会话是助教对话，无权执行 ${toolName}。助教只答疑，不推进课程、不制卡、不复习。` };
  }
  if (MAKE_CARD_TOOLS.has(toolName) && !ctx.isMakeCardEnabled()) {
    return { allowed: false, reason: "本次对话已关闭制卡（enable_make_card = 0），不能提议卡片或创建主题。" };
  }
  return { allowed: true };
}
