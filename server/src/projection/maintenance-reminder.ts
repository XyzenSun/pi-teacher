/**
 * 维护提醒（ADR-0036 / ADR-0039）：每隔 N 轮把 <system-reminder> 直接拼在用户消息末尾，
 * 基础文案提醒偏好 / 用户信息 / 卡片 / 会话级要求，只有学习会话同轮追加精华维护提醒。
 * 判断轮次与类型在程序，是否维护及维护内容由模型决定。
 *
 * 不走 context / before_agent_start 钩子、不做自定义消息：提醒随用户消息落 JSONL，
 * 历史里保持可见（用户定稿）。轮次从会话历史现数，不另存计数器——助教清除上下文后
 * 自然归零，compact 不减少 JSONL 条目也就不影响计数。
 *
 * 文案存 `setting` 表（config/app-settings.ts），设置页可改；没改过就是 prompts/defaults.ts
 * 的出厂文案。每次发送现读，改完下一轮即生效。
 */
import type { SessionEntry } from "../bridge/types.ts";
import type { SpaceType } from "../db/types.ts";
import type { ReminderKind } from "../prompts/defaults.ts";

export type { ReminderKind };
export { readReminderText } from "../config/app-settings.ts";

/** 助教不维护全局偏好与用户信息（ADR-0035），只提醒它维护「用户对你的要求」；学习 / 复习按制卡开关。 */
export function pickReminderKind(spaceType: SpaceType, makeCardEnabled: boolean): Exclude<ReminderKind, "learningEssence"> {
  if (spaceType === "ta") return "ta";
  return makeCardEnabled ? "makeCardOn" : "makeCardOff";
}

/** 精华独立于制卡开关，不能写进学习 / 复习共用的基础文案，否则会提醒复习会话维护精华。 */
export function buildMaintenanceReminder(
  spaceType: SpaceType,
  makeCardEnabled: boolean,
  reminderTexts: Readonly<Record<ReminderKind, string>>,
): string {
  const baseReminder = reminderTexts[pickReminderKind(spaceType, makeCardEnabled)];
  return spaceType === "learn" ? `${baseReminder}\n\n${reminderTexts.learningEssence}` : baseReminder;
}

/** 活动分支上已有的 user 消息条数；即将发送的这条是第 count + 1 轮。 */
export function countUserTurns(entries: readonly SessionEntry[]): number {
  let count = 0;
  for (const entry of entries) {
    if (entry.type === "message" && (entry as { message?: { role?: string } }).message?.role === "user") count += 1;
  }
  return count;
}

/** interval 为 0 表示关闭；命中条件是轮次恰为 interval 的整数倍。 */
export function shouldRemind(turn: number, interval: number): boolean {
  return interval > 0 && turn > 0 && turn % interval === 0;
}
