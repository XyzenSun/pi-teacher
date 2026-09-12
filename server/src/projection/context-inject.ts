import { AsyncLocalStorage } from "node:async_hooks";
import type { SessionToolContext } from "../tools/context.ts";

interface PromptInjection {
  summary?: string;
  userSignature?: string;
}
const promptInjection = new AsyncLocalStorage<PromptInjection>();

/** 注入随一次 prompt 的异步调用链存活，不落 JSONL，也不挂全局主会话引用。 */
export function withPromptContext<T>(summary: string | undefined, operation: () => T): T {
  return promptInjection.run({ summary }, operation);
}

export function buildContextInjection(ctx: SessionToolContext, messages: readonly { role: string }[]): string | undefined {
  if (ctx.spaceType === "ta") {
    const scope = promptInjection.getStore();
    if (!scope?.summary) return undefined;
    const currentUser = [...messages].reverse().find((message) => message.role === "user");
    if (!currentUser) return undefined;
    const signature = JSON.stringify(currentUser);
    scope.userSignature ??= signature;
    // 同一轮工具续跑可继续使用简介；队列里的下一条用户消息不继承这一轮授权。
    return scope.userSignature === signature ? scope.summary : undefined;
  }
  const due = ctx.db.prepare(`SELECT COUNT(*) AS count FROM card c JOIN card_schedule s ON s.card_id = c.id
    WHERE c.status = 'normal' AND s.due <= datetime('now') AND (? IS NULL OR c.topic_id = ?)`)
    .get(ctx.reviewTopicId, ctx.reviewTopicId) as { count: number };
  return `当前活动：${ctx.spaceType === "review" ? "复习" : "学习"}。到期待复习卡片：${due.count}。制卡${ctx.isMakeCardEnabled() ? "已开启" : "已关闭"}。`;
}
