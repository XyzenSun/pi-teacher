import { useMemo, useRef, useState } from "react";
import { conversationsApi } from "../api/client.ts";
import { indexToolResults, useConversation } from "../chat/useConversation.ts";
import { MessageView } from "../chat/MessageView.tsx";
import { ConfirmDialog } from "../ui/Overlays.tsx";

interface AssistantPanelProps {
  taSessionId: number;
  mainConversationId: number | null;
}

/**
 * 固定助教：独立 Pi Session，默认没有任何主会话上下文。
 * 只有用户明确点击「发送并注入」时，才在这一轮携带主会话简介（后端一次性、不落历史）。
 */
export function AssistantPanel({ taSessionId, mainConversationId }: AssistantPanelProps) {
  const session = useConversation(taSessionId);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const composingRef = useRef(false);
  const toolResults = useMemo(() => indexToolResults(session.messages), [session.messages]);
  const recent = session.messages.slice(-30);
  const isRunning = Boolean(session.runtime?.isRunning) || session.streaming.isStreaming;

  const send = async (inject: boolean) => {
    const message = value.trim();
    if (!message || busy) return;
    setBusy(true);
    setError(null);
    try {
      await session.sendCommand({ type: "prompt", message, ...(inject && mainConversationId !== null ? { injectMainSessionId: mainConversationId } : {}) });
      setValue("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "发送失败");
    } finally {
      setBusy(false);
    }
  };

  // 清除：后端换新 JSONL 并已常驻重开，前端只需重连 SSE；connected 事件会重新拉取（空）历史。
  const clearConversation = async () => {
    setClearing(true);
    setClearError(null);
    try {
      await conversationsApi.clear(taSessionId);
      setConfirmingClear(false);
      await session.reopen();
    } catch (cause) {
      setClearError(cause instanceof Error ? cause.message : "清除失败");
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div className="h-11 shrink-0 px-3 border-b border-line flex items-center justify-between">
        <span className="label flex items-center gap-1"><span className="icon text-[16px] text-secondary">support_agent</span>助教</span>
        <span className="flex items-center gap-2">
          <span className="text-[11px] text-muted">{session.status === "connected" ? "已连接" : session.status === "recycled" ? "已回收" : session.status === "reconnecting" ? "重连中" : "连接中"}</span>
          <button
            type="button"
            className="icon text-[16px] text-on-surface-variant hover:text-error disabled:opacity-50"
            title="清除对话"
            aria-label="清除对话"
            disabled={busy || isRunning || clearing}
            onClick={() => { setClearError(null); setConfirmingClear(true); }}
          >
            delete_sweep
          </button>
        </span>
      </div>
      {confirmingClear && (
        <ConfirmDialog
          title="清除助教对话"
          danger
          busy={clearing}
          error={clearError}
          message="清空助教的全部对话记录？助教对你的要求（pi-session-user.md）与上传的文件会保留。"
          confirmLabel="清除"
          onCancel={() => { if (!clearing) setConfirmingClear(false); }}
          onConfirm={() => void clearConversation()}
        />
      )}
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3 text-[13px]">
        {session.error && (
          <div className="rounded-md bg-error-container text-on-error-container px-2 py-1 text-[12px] flex items-center justify-between gap-2">
            <span className="truncate">{session.error}</span>
            {session.status === "recycled" && <button type="button" className="underline shrink-0" onClick={() => void session.reopen()}>重新打开</button>}
          </div>
        )}
        {recent.length === 0 && !session.streaming.streamingMessage && <div className="text-[12px] text-muted text-center py-4">助教可以解答概念、工具与流程问题，默认不知道你在主对话聊什么。</div>}
        {recent.map((message, index) => <MessageView key={index} message={message} conversationId={taSessionId} toolResults={toolResults} executions={session.toolExecutions} />)}
        {session.streaming.streamingMessage && <MessageView message={session.streaming.streamingMessage} conversationId={taSessionId} toolResults={toolResults} executions={session.toolExecutions} streaming />}
      </div>
      <div className="shrink-0 p-3 border-t border-line space-y-2 bg-surface-container-lowest/60">
        {error && <div className="text-[12px] text-error">{error}</div>}
        <textarea
          className="input resize-none text-[13px]"
          rows={2}
          placeholder="问助教…（Enter 发送）"
          value={value}
          disabled={session.status === "recycled"}
          onChange={(event) => setValue(event.target.value)}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !composingRef.current && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(false); }
          }}
        />
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            className="btn-outline text-[12px] py-1"
            disabled={mainConversationId === null || !value.trim() || busy || isRunning}
            title={mainConversationId === null ? "先打开一个主对话" : "仅本轮携带当前主对话的简介，不会持久化"}
            onClick={() => void send(true)}
          >
            <span className="icon text-[14px]">link</span>一次性发送并注入当前主会话简介
          </button>
          <button type="button" className="btn-secondary text-[12px] py-1" disabled={!value.trim() || busy} onClick={() => void send(false)}>发送</button>
        </div>
      </div>
    </div>
  );
}
