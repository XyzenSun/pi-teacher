import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ApiError, conversationsApi, type SessionCommand } from "../api/client.ts";
import type { AgentMessage, Conversation, Runtime, SessionContext, ToolResultMessage } from "../api/types.ts";
import { INITIAL_STREAMING_STATE, normalizeMessage, streamReducer } from "./stream-reducer.ts";

export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "recycled" | "closed";

export const RECYCLED_MESSAGE = "Pi Session 已回收，请重新打开";

export interface ToolExecution {
  toolCallId: string;
  toolName: string;
  partialResult?: unknown;
  running: boolean;
}

interface HistoryState {
  messages: AgentMessage[];
  oldestEntryId: string | null;
  hasMore: boolean;
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
}

const EMPTY_HISTORY: HistoryState = { messages: [], oldestEntryId: null, hasMore: false, thinkingLevel: "off", model: null };

/**
 * 一条 Pi Session 的运行时状态：历史（GET context）+ 实时流（SSE）+ 命令。
 * SSE 用原生 EventSource：断线由浏览器被动重连，`connected` 握手视作快照重置点，
 * 此时清空流式状态并重新拉 context，从而不依赖 Last-Event-ID 做补偿。
 */
export function useConversation(conversationId: number | null) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [history, setHistory] = useState<HistoryState>(EMPTY_HISTORY);
  const [streaming, dispatch] = useReducer(streamReducer, INITIAL_STREAMING_STATE);
  const [toolExecutions, setToolExecutions] = useState<Map<string, ToolExecution>>(new Map());
  const [status, setStatus] = useState<ConnectionStatus>("closed");
  const [error, setError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [sessionVersion, setSessionVersion] = useState(0);
  const sourceRef = useRef<EventSource | null>(null);
  const idRef = useRef(conversationId);
  idRef.current = conversationId;
  /** 每次 connect 递增；onerror 里的异步探针只在自己那一代连接仍是当前连接时才改状态。 */
  const generationRef = useRef(0);

  const applyContext = useCallback((context: SessionContext) => {
    setConversation(context.conversation);
    setRuntime(context.runtime);
    setHistory({
      messages: context.messages.map(normalizeMessage),
      oldestEntryId: context.oldestEntryId,
      hasMore: context.hasMore,
      thinkingLevel: context.thinkingLevel,
      model: context.model,
    });
  }, []);

  const refreshContext = useCallback(async (id: number) => {
    try {
      const context = await conversationsApi.context(id);
      if (idRef.current === id) applyContext(context);
    } catch (cause) {
      if (idRef.current === id) setError(cause instanceof Error ? cause.message : "加载对话失败");
    }
  }, [applyContext]);

  const handleRecycled = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
    setStatus("recycled");
    dispatch({ type: "end" });
    setError(RECYCLED_MESSAGE);
  }, []);

  const connect = useCallback((id: number) => {
    sourceRef.current?.close();
    setStatus("connecting");
    const generation = ++generationRef.current;
    const source = new EventSource(conversationsApi.eventsUrl(id));
    sourceRef.current = source;
    source.onmessage = (raw) => {
      if (idRef.current !== id) return;
      let event: Record<string, unknown>;
      try { event = JSON.parse(raw.data); } catch { return; }
      switch (event.type) {
        case "connected":
          setStatus("connected");
          setError(null);
          dispatch({ type: "end" });
          setToolExecutions(new Map());
          void refreshContext(id);
          if (event.isStreaming) dispatch({ type: "start" });
          break;
        case "agent_start":
          dispatch({ type: "start" });
          setRuntime((current) => current ? { ...current, isRunning: true } : current);
          break;
        case "message_start":
          if (event.message) dispatch({ type: "snapshot", message: event.message as AgentMessage });
          break;
        case "message_update":
          if (event.assistantMessageEvent) dispatch({ type: "delta", event: event.assistantMessageEvent as Record<string, unknown> });
          break;
        case "message_end":
          if (event.message) {
            const message = normalizeMessage(event.message as AgentMessage);
            setHistory((current) => ({ ...current, messages: [...current.messages, message] }));
          }
          dispatch({ type: "end" });
          break;
        case "tool_execution_start":
        case "tool_execution_update":
        case "tool_execution_end": {
          const toolCallId = String(event.toolCallId ?? "");
          if (!toolCallId) break;
          setToolExecutions((current) => {
            const next = new Map(current);
            if (event.type === "tool_execution_end") next.delete(toolCallId);
            else next.set(toolCallId, { toolCallId, toolName: String(event.toolName ?? ""), partialResult: event.partialResult, running: true });
            return next;
          });
          break;
        }
        case "prompt_done":
        case "agent_settled":
        case "agent_end":
          dispatch({ type: "end" });
          setRuntime((current) => current ? { ...current, isRunning: false, isStreaming: false } : current);
          void refreshContext(id);
          break;
        case "prompt_error":
          setError(typeof event.errorMessage === "string" ? event.errorMessage : "模型运行出错");
          break;
        case "session_updated":
        case "model_changed":
          setSessionVersion((version) => version + 1);
          void refreshContext(id);
          break;
        case "startup_error":
          setError(typeof event.errorMessage === "string" ? event.errorMessage : "会话启动失败");
          break;
        case "session_recycled":
          handleRecycled();
          break;
        default:
          break;
      }
    };
    source.onerror = () => {
      if (idRef.current !== id || sourceRef.current !== source) return;
      // EventSource 在 404（会话已回收）时会先报 error 再尝试重连；用 status 探针区分两种情况。
      void conversationsApi.status(id).then(() => {
        if (generationRef.current === generation) setStatus("reconnecting");
      }).catch((cause) => {
        if (generationRef.current !== generation) return;
        if (cause instanceof ApiError && cause.status === 404) handleRecycled();
        else setStatus("reconnecting");
      });
    };
  }, [handleRecycled, refreshContext]);

  useEffect(() => {
    if (conversationId === null) {
      sourceRef.current?.close();
      sourceRef.current = null;
      setConversation(null);
      setRuntime(null);
      setHistory(EMPTY_HISTORY);
      setStatus("closed");
      setError(null);
      dispatch({ type: "end" });
      return;
    }
    let cancelled = false;
    setHistory(EMPTY_HISTORY);
    setError(null);
    setToolExecutions(new Map());
    dispatch({ type: "end" });
    void (async () => {
      try {
        const context = await conversationsApi.context(conversationId);
        if (cancelled) return;
        applyContext(context);
        if (!context.runtime.alive) {
          // 打开只按稳定 ID 恢复原 JSONL，不会新建会话。
          const opened = await conversationsApi.open(conversationId);
          if (cancelled) return;
          setRuntime(opened.runtime);
          setConversation(opened.conversation);
        }
        if (!cancelled) connect(conversationId);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "打开对话失败");
      }
    })();
    return () => {
      cancelled = true;
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [conversationId, applyContext, connect]);

  const loadOlder = useCallback(async () => {
    if (conversationId === null || !history.hasMore || !history.oldestEntryId || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const older = await conversationsApi.context(conversationId, { before: history.oldestEntryId, tail: 60 });
      setHistory((current) => ({
        ...current,
        messages: [...older.messages.map(normalizeMessage), ...current.messages],
        oldestEntryId: older.oldestEntryId ?? current.oldestEntryId,
        hasMore: older.hasMore,
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载更早历史失败");
    } finally {
      setLoadingOlder(false);
    }
  }, [conversationId, history.hasMore, history.oldestEntryId, loadingOlder]);

  const sendCommand = useCallback(async <T = unknown>(command: SessionCommand): Promise<T> => {
    if (conversationId === null) throw new Error("尚未选择对话");
    const run = () => conversationsApi.command<T>(conversationId, command);
    try {
      let result: { data: T };
      try {
        result = await run();
      } catch (cause) {
        // 空闲回收后的首条命令：按稳定 ID 重开同一 JSONL（不会新建会话）再重试一次，
        // 用户无需手动点「重新打开」；重开失败才把回收状态暴露出来。
        if (!(cause instanceof ApiError && cause.status === 404 && cause.code === "session_recycled")) throw cause;
        const opened = await conversationsApi.open(conversationId);
        setRuntime(opened.runtime);
        setConversation(opened.conversation);
        setError(null);
        connect(conversationId);
        result = await run();
      }
      if (command.type === "set_model" || command.type === "set_session_name" || command.type === "set_thinking_level") void refreshContext(conversationId);
      return result.data;
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 404) handleRecycled();
      throw cause;
    }
  }, [conversationId, connect, handleRecycled, refreshContext]);

  const reopen = useCallback(async () => {
    if (conversationId === null) return;
    setError(null);
    const opened = await conversationsApi.open(conversationId);
    setRuntime(opened.runtime);
    setConversation(opened.conversation);
    connect(conversationId);
  }, [conversationId, connect]);

  /** 会话设定（制卡开关、教学风格）经 REST 修改后，由调用方触发一次上下文刷新，
   *  让界面反映后端真实状态而不是乐观假设。 */
  const refreshConversation = useCallback(async () => {
    if (conversationId === null) return;
    await refreshContext(conversationId);
  }, [conversationId, refreshContext]);

  return {
    conversation, runtime, status, error, sessionVersion,
    messages: history.messages, hasMore: history.hasMore, loadingOlder, loadOlder,
    thinkingLevel: history.thinkingLevel, model: history.model,
    streaming, toolExecutions,
    sendCommand, reopen, refreshConversation, clearError: () => setError(null),
  };
}

/** 把 toolResult 消息按 toolCallId 建索引，assistant 中的 toolCall 块渲染时配对。 */
export function indexToolResults(messages: AgentMessage[]): Map<string, ToolResultMessage> {
  const map = new Map<string, ToolResultMessage>();
  for (const message of messages) if (message.role === "toolResult") map.set(message.toolCallId, message);
  return map;
}
