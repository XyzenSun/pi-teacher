/**
 * context 事件注入：每轮 LLM 调用前把动态状态（待复习卡数等）注入会话。
 *
 * 当前为哨兵占位（PRD 实现要点 11）：注入内容用固定文本占位，链路通即验收；
 * 真实内容由提示词设计任务填充。事件返回值只进 payload、不落盘、不进压缩。
 */
export const CONTEXT_INJECT_SENTINEL = "PI-TEACHER-CONTEXT-INJECT-MARKER";

/** 组装注入内容：哨兵占位，真实版本将来读库（到期卡数、glossary 概况等）。 */
export function buildContextInjection(): string {
  return CONTEXT_INJECT_SENTINEL;
}
