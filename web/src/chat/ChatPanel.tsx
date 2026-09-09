import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ModelInfo, SlashCommand } from "../api/types.ts";
import { captureScrollDistance, getLiveFollowAttached, getNextVisibleCount, getVisibleRenderWindow, restoreScrollTop, VISIBLE_PAGE_SIZE } from "../lib/chat-lazy-load.ts";
import { ChatInput } from "./ChatInput.tsx";
import { MessageView } from "./MessageView.tsx";
import { indexToolResults, RECYCLED_MESSAGE, type ConnectionStatus } from "./useConversation.ts";
import type { useConversation } from "./useConversation.ts";

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  connecting: "连接中", connected: "已连接", reconnecting: "重连中", recycled: "已回收", closed: "未连接",
};

const STATUS_TONE: Record<ConnectionStatus, string> = {
  connecting: "bg-tertiary-container text-on-tertiary-container",
  connected: "bg-secondary-container text-on-secondary-container",
  reconnecting: "bg-tertiary-container text-on-tertiary-container",
  recycled: "bg-error-container text-on-error-container",
  closed: "bg-surface-container text-on-surface-variant",
};

interface ChatPanelProps {
  conversationId: number;
  title: string;
  session: ReturnType<typeof useConversation>;
  models: ModelInfo[];
  onRenamed: () => void;
}

export function ChatPanel({ conversationId, title, session, models, onRenamed }: ChatPanelProps) {
  const { conversation, runtime, status, error, messages, hasMore, loadingOlder, loadOlder, streaming, toolExecutions, sendCommand, reopen, clearError } = session;
  const [visibleCount, setVisibleCount] = useState(VISIBLE_PAGE_SIZE);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const previousScrollTopRef = useRef(0);
  const pendingRestoreRef = useRef<number | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const toolResults = useMemo(() => indexToolResults(messages), [messages]);
  const window_ = getVisibleRenderWindow(messages.length, visibleCount);
  const visibleMessages = messages.slice(window_.startIndex);

  useEffect(() => { setVisibleCount(VISIBLE_PAGE_SIZE); followRef.current = true; }, [conversationId]);

  useEffect(() => {
    if (status !== "connected") return;
    void sendCommand<SlashCommand[]>({ type: "get_commands" }).then((result) => setCommands(Array.isArray(result) ? result : [])).catch(() => setCommands([]));
  }, [status, sendCommand]);

  /** 只有停在底部时才自动跟随；向上阅读历史时不强制拉回底部。 */
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (pendingRestoreRef.current !== null) {
      element.scrollTop = restoreScrollTop(element.scrollHeight, pendingRestoreRef.current);
      pendingRestoreRef.current = null;
      return;
    }
    if (followRef.current) element.scrollTop = element.scrollHeight;
  }, [visibleMessages.length, streaming.streamingMessage, conversationId]);

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    followRef.current = getLiveFollowAttached(followRef.current, previousScrollTopRef.current, element.scrollTop, element.clientHeight, element.scrollHeight);
    previousScrollTopRef.current = element.scrollTop;
  }, []);

  /** 顶部哨兵进入视口时先展开本地窗口，本地耗尽再向后端要更早的条目，并保持滚动位置。 */
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const element = scrollRef.current;
    if (!sentinel || !element) return;
    const observer = new IntersectionObserver((observations) => {
      if (!observations.some((observation) => observation.isIntersecting)) return;
      pendingRestoreRef.current = captureScrollDistance(element.scrollHeight, element.scrollTop);
      if (window_.hasMore) setVisibleCount((count) => getNextVisibleCount(count));
      else if (hasMore && !loadingOlder) void loadOlder();
      else pendingRestoreRef.current = null;
    }, { root: element, rootMargin: "120px 0px 0px 0px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [window_.hasMore, hasMore, loadingOlder, loadOlder]);

  const isRunning = Boolean(runtime?.isRunning) || streaming.isStreaming;
  const activeModel = session.model ?? (runtime?.model ? { provider: runtime.model.provider, modelId: runtime.model.id } : null);

  const rename = async () => {
    const next = prompt("重命名对话", conversation?.name ?? "");
    if (next === null || !next.trim()) return;
    await sendCommand({ type: "set_session_name", name: next.trim() });
    onRenamed();
  };

  return (
    <section className="flex-1 min-w-0 flex flex-col bg-surface">
      <header className="h-14 shrink-0 px-5 flex items-center justify-between border-b border-line bg-surface-container-lowest">
        <div className="min-w-0 flex items-center gap-2">
          <h1 className="font-reading text-[18px] text-primary truncate max-w-[420px]">{title}</h1>
          <button type="button" className="icon text-[16px] text-muted hover:text-on-surface" title="重命名" onClick={() => void rename()}>edit</button>
          {conversation?.spaceType === "review" && (
            <span className="chip bg-secondary-container text-on-secondary-container">{conversation.reviewTopicId === null ? "全部 Topic" : `Topic #${conversation.reviewTopicId}`}</span>
          )}
          {conversation?.enableMakeCard && <span className="chip bg-tertiary-container text-on-tertiary-container">制卡开启</span>}
        </div>
        <div className="flex items-center gap-2">
          <span className={`chip ${STATUS_TONE[status]}`}>{STATUS_TEXT[status]}</span>
          <select
            className="input w-auto py-1 text-[12px]"
            value={activeModel ? `${activeModel.provider}/${activeModel.modelId}` : ""}
            disabled={isRunning || status !== "connected"}
            title={isRunning ? "运行中不能切换模型" : "切换模型"}
            onChange={(event) => {
              const [provider, ...rest] = event.target.value.split("/");
              void sendCommand({ type: "set_model", provider, modelId: rest.join("/") });
            }}
          >
            {!activeModel && <option value="">选择模型</option>}
            {models.map((model) => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name}</option>)}
          </select>
        </div>
      </header>

      {error && (
        <div className="px-5 py-2 bg-error-container text-on-error-container text-[13px] flex items-center justify-between gap-3">
          <span className="min-w-0 truncate">{error}</span>
          <span className="flex items-center gap-2 shrink-0">
            {error === RECYCLED_MESSAGE && <button type="button" className="btn-outline" onClick={() => void reopen()}>重新打开</button>}
            <button type="button" className="icon text-[16px]" onClick={clearError}>close</button>
          </span>
        </div>
      )}

      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-5 py-6">
        <div className="mx-auto w-full max-w-reading space-y-4">
          <div ref={sentinelRef} className="h-px" />
          {(window_.hasMore || hasMore) && (
            <div className="text-center text-[12px] text-muted py-1">{loadingOlder ? "正在加载更早的消息…" : "向上滚动加载更早的消息"}</div>
          )}
          {visibleMessages.length === 0 && !streaming.streamingMessage && (
            <div className="text-center text-[13px] text-muted py-10">还没有消息，先说点什么吧。</div>
          )}
          {visibleMessages.map((message, index) => (
            <MessageView key={`${window_.startIndex + index}`} message={message} conversationId={conversationId} toolResults={toolResults} executions={toolExecutions} />
          ))}
          {streaming.streamingMessage && (
            <MessageView message={streaming.streamingMessage} conversationId={conversationId} toolResults={toolResults} executions={toolExecutions} streaming />
          )}
          {isRunning && !streaming.streamingMessage && <div className="text-[13px] text-muted">模型正在思考…</div>}
        </div>
      </div>

      <div className="mx-auto w-full">
        <ChatInput
          conversationId={conversationId}
          disabled={status === "recycled" || status === "closed"}
          isRunning={isRunning}
          commands={commands}
          onSend={async (message, attachmentIds) => { followRef.current = true; await sendCommand({ type: "prompt", message, attachmentIds }); }}
          onSteer={async (message) => { followRef.current = true; await sendCommand({ type: "steer", message }); }}
          onAbort={() => { void sendCommand({ type: "abort" }); }}
        />
      </div>
    </section>
  );
}
