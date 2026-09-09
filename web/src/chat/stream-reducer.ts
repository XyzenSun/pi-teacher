// 参考 pi-web v0.9.0（MIT License）lib/streaming-message.ts 与 normalize.ts 重写，
// 见 THIRD-PARTY-NOTICES.md。流式 assistant 消息按 contentIndex 逐块拼接，
// *_end 事件用完整内容覆盖增量结果，避免丢包造成的文本错位。
import type { AgentMessage, AssistantContentBlock, AssistantMessage, ToolCallContent } from "../api/types.ts";

export interface StreamingState {
  isStreaming: boolean;
  streamingMessage: AssistantMessage | null;
}

export type StreamAction =
  | { type: "start" }
  | { type: "snapshot"; message: AgentMessage }
  | { type: "delta"; event: Record<string, unknown> }
  | { type: "end" };

export const INITIAL_STREAMING_STATE: StreamingState = { isStreaming: false, streamingMessage: null };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** SDK 在流式期间用 id/name/arguments，落盘后用 toolCallId/toolName/input；统一成后者。 */
export function normalizeToolCallBlock(block: unknown): ToolCallContent | null {
  if (!isObject(block) || block.type !== "toolCall") return null;
  const input = isObject(block.input) ? block.input : isObject(block.arguments) ? block.arguments : {};
  const rawInput = typeof block.rawInput === "string" ? block.rawInput : typeof block.partialJson === "string" ? block.partialJson : undefined;
  return {
    type: "toolCall",
    toolCallId: typeof block.toolCallId === "string" ? block.toolCallId : typeof block.id === "string" ? block.id : "",
    toolName: typeof block.toolName === "string" ? block.toolName : typeof block.name === "string" ? block.name : "",
    input: input as Record<string, unknown>,
    ...(rawInput === undefined ? {} : { rawInput }),
  };
}

export function normalizeMessage(message: AgentMessage): AgentMessage {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
  return { ...message, content: message.content.map((block) => normalizeToolCallBlock(block) ?? block) };
}

function updateBlock(state: StreamingState, contentIndex: unknown, update: (current: AssistantContentBlock | undefined) => AssistantContentBlock | null): StreamingState {
  const message = state.streamingMessage;
  if (!message || typeof contentIndex !== "number" || !Number.isInteger(contentIndex) || contentIndex < 0) return state;
  const content = [...message.content];
  const next = update(content[contentIndex]);
  if (!next) return state;
  content[contentIndex] = next;
  return { isStreaming: true, streamingMessage: { ...message, content } };
}

function applyDelta(state: StreamingState, event: Record<string, unknown>): StreamingState {
  // 首个 delta 可能早于 message_start 快照到达；此时先建空消息壳，避免整段丢失。
  const base: StreamingState = state.streamingMessage ? state : { isStreaming: true, streamingMessage: { role: "assistant", content: [] } };
  const index = event.contentIndex;
  switch (event.type) {
    case "text_start":
      return updateBlock(base, index, (current) => current?.type === "text" ? current : { type: "text", text: "" });
    case "text_delta":
      return updateBlock(base, index, (current) => ({ type: "text", text: (current?.type === "text" ? current.text : "") + String(event.delta ?? "") }));
    case "text_end":
      return updateBlock(base, index, () => ({ type: "text", text: String(event.content ?? "") }));
    case "thinking_start":
      return updateBlock(base, index, (current) => current?.type === "thinking" ? current : { type: "thinking", thinking: "" });
    case "thinking_delta":
      return updateBlock(base, index, (current) => ({ type: "thinking", thinking: (current?.type === "thinking" ? current.thinking : "") + String(event.delta ?? "") }));
    case "thinking_end":
      return updateBlock(base, index, () => ({ type: "thinking", thinking: String(event.content ?? "") }));
    case "toolcall_start":
      return updateBlock(base, index, (current) => current?.type === "toolCall"
        ? { ...current, toolCallId: typeof event.id === "string" ? event.id : current.toolCallId, toolName: typeof event.toolName === "string" ? event.toolName : current.toolName, rawInput: current.rawInput ?? "" }
        : { type: "toolCall", toolCallId: typeof event.id === "string" ? event.id : "", toolName: typeof event.toolName === "string" ? event.toolName : "", input: {}, rawInput: "" });
    case "toolcall_delta":
      return updateBlock(base, index, (current) => current?.type === "toolCall"
        ? { ...current, rawInput: (current.rawInput ?? "") + String(event.delta ?? "") }
        : null);
    case "toolcall_end": {
      const call = isObject(event.toolCall) ? event.toolCall : null;
      if (!call) return base;
      return updateBlock(base, index, () => ({
        type: "toolCall",
        toolCallId: typeof call.id === "string" ? call.id : "",
        toolName: typeof call.name === "string" ? call.name : "",
        input: isObject(call.arguments) ? call.arguments : {},
      }));
    }
    case "done":
    case "error":
      return base;
    default:
      return base;
  }
}

export function streamReducer(state: StreamingState, action: StreamAction): StreamingState {
  switch (action.type) {
    case "start": return { isStreaming: true, streamingMessage: null };
    case "snapshot": {
      const message = normalizeMessage(action.message);
      return message.role === "assistant" ? { isStreaming: true, streamingMessage: message } : state;
    }
    case "delta": return applyDelta(state, action.event);
    case "end": return INITIAL_STREAMING_STATE;
    default: return state;
  }
}
