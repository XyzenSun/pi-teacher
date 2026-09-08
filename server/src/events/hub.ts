/**
 * 会话事件 hub：wrapper 的 onAgentRunComplete → 消费者（标题生成、日志）。
 *
 * 为什么要有这层：标题生成是「轮次空闲」时机触发的独立 LLM 调用（PRD 实现要点
 * 10），不能直接写在 wrapper 里——那样 bridge 层就依赖 db 层了。hub 用进程内
 * 回调解耦：routes 层订阅并做数据库写回。
 */
type RunCompleteListener = (sessionId: string) => void;

const listeners = new Set<RunCompleteListener>();

export function onAgentRunComplete(listener: RunCompleteListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitAgentRunComplete(sessionId: string): void {
  for (const listener of listeners) {
    try {
      listener(sessionId);
    } catch (error) {
      console.error("[hub] run-complete listener failed:", error instanceof Error ? error.message : error);
    }
  }
}
