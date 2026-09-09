import type Database from "better-sqlite3";
import type { PiSessionRow, SpaceType } from "../db/types.ts";

/** 业务权限按数据库里的 Space 类型裁决，工作目录只用于解析相对文件路径。 */
export interface SessionToolContext {
  db: Database.Database;
  spaceType: SpaceType;
  enableMakeCard: boolean;
  reviewTopicId: number | null;
  workPath: string;
}

export function toolContextFor(db: Database.Database, row: PiSessionRow): SessionToolContext {
  return {
    db,
    spaceType: row.space_type,
    enableMakeCard: row.enable_make_card === 1,
    reviewTopicId: row.review_topic_id,
    workPath: row.work_path,
  };
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
  if (MAKE_CARD_TOOLS.has(toolName) && !ctx.enableMakeCard) {
    return { allowed: false, reason: "本次对话已关闭制卡（enable_make_card = 0），不能提议卡片或创建主题。" };
  }
  return { allowed: true };
}
