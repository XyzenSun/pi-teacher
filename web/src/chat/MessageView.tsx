import { Component, memo, useState, type ReactNode } from "react";
import type { AgentMessage, AssistantMessage, ToolCallContent, ToolResultMessage, UserMessage } from "../api/types.ts";
import { Markdown } from "./Markdown.tsx";
import type { ToolExecution } from "./useConversation.ts";

const TOOL_LABELS: Record<string, string> = {
  card_propose: "提议卡片", card_list: "查看卡片", topic_create: "创建 Topic", topic_list: "查看 Topic",
  glossary_propose: "提议术语", glossary_list: "查看术语", read_file: "读取文件", write_file: "写入文件",
  edit_file: "编辑文件", list_dir: "浏览目录", web_search: "网络搜索", web_fetch: "抓取网页",
  review_queue: "获取复习队列", review_submit_ratings: "提交复习评分", bash: "执行命令",
};

function previewValue(value: unknown, max = 80): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function stringifyPretty(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function resultText(result: ToolResultMessage | undefined): string {
  if (!result) return "";
  return result.content.map((block) => (block.type === "text" ? block.text : "[图片]")).join("\n");
}

function Collapsible({ summary, tone = "default", defaultOpen = false, children }: { summary: React.ReactNode; tone?: "default" | "thinking" | "error"; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  const border = tone === "error" ? "border-error/40" : tone === "thinking" ? "border-tertiary/30" : "border-line";
  return (
    <div className={`rounded-md border ${border} bg-surface-container-lowest text-[13px] my-1.5`}>
      <button type="button" className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-container-low rounded-md" onClick={() => setOpen((value) => !value)}>
        <span className="icon text-[16px] text-muted">{open ? "expand_more" : "chevron_right"}</span>
        <span className="flex-1 min-w-0 truncate">{summary}</span>
      </button>
      {open && <div className="px-3 pb-3 pt-1 border-t border-line">{children}</div>}
    </div>
  );
}

function ToolCallView({ block, result, execution }: { block: ToolCallContent; result?: ToolResultMessage; execution?: ToolExecution }) {
  const label = TOOL_LABELS[block.toolName] ?? block.toolName;
  const firstParam = Object.entries(block.input)[0];
  const paramsPreview = block.rawInput !== undefined && !Object.keys(block.input).length ? previewValue(block.rawInput) : firstParam ? `${firstParam[0]}: ${previewValue(firstParam[1])}` : "";
  const running = !result && (execution?.running ?? false);
  const tone = result?.isError ? "error" : "default";
  return (
    <Collapsible tone={tone} summary={(
      <span className="flex items-center gap-2">
        <span className={`icon text-[16px] ${result?.isError ? "text-error" : "text-secondary"}`}>{running ? "progress_activity" : result?.isError ? "error" : "build"}</span>
        <span className="font-medium text-primary">{label}</span>
        {paramsPreview && <span className="font-mono text-[12px] text-muted truncate">{paramsPreview}</span>}
        {running && <span className="chip bg-secondary-container text-on-secondary-container">执行中</span>}
        {result?.isError && <span className="chip bg-error-container text-on-error-container">失败</span>}
      </span>
    )}>
      <div className="space-y-2">
        <div>
          <div className="label mb-1">参数</div>
          <pre className="font-mono text-[12px] bg-surface-container-low rounded p-2 overflow-auto max-h-60 whitespace-pre-wrap break-all">{Object.keys(block.input).length ? stringifyPretty(block.input) : block.rawInput ?? ""}</pre>
        </div>
        {(result || execution?.partialResult !== undefined) && (
          <div>
            <div className="label mb-1">{result ? (result.isError ? "错误" : "结果") : "实时输出"}</div>
            <pre className={`font-mono text-[12px] rounded p-2 overflow-auto max-h-80 whitespace-pre-wrap break-words ${result?.isError ? "bg-error-container/60 text-on-error-container" : "bg-surface-container-low"}`}>
              {result ? resultText(result) : stringifyPretty(execution?.partialResult)}
            </pre>
          </div>
        )}
      </div>
    </Collapsible>
  );
}

function UserBubble({ message, conversationId }: { message: UserMessage; conversationId: number }) {
  const blocks = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-xl rounded-tr-sm bg-primary text-on-primary px-4 py-2.5 text-[14px] leading-[1.6] whitespace-pre-wrap break-words">
        {blocks.map((block, index) => block.type === "text"
          ? <span key={index}>{block.text}</span>
          : <img key={index} alt="附件图片" className="max-w-[240px] rounded-md my-1" src={`data:${block.mimeType};base64,${block.data}`} data-conversation={conversationId} />)}
      </div>
    </div>
  );
}

function AssistantView({ message, toolResults, executions, streaming }: { message: AssistantMessage; toolResults: Map<string, ToolResultMessage>; executions: Map<string, ToolExecution>; streaming: boolean }) {
  return (
    <div className="max-w-full">
      {message.content.map((block, index) => {
        if (block.type === "text") return block.text ? <Markdown key={index} text={block.text} /> : null;
        if (block.type === "thinking") {
          return block.thinking ? (
            <Collapsible key={index} tone="thinking" summary={<span className="flex items-center gap-2 text-tertiary"><span className="icon text-[16px]">psychology</span>思考过程{streaming && index === message.content.length - 1 ? "（进行中）" : ""}</span>}>
              <div className="text-[13px] text-on-surface-variant whitespace-pre-wrap break-words font-reading">{block.thinking}</div>
            </Collapsible>
          ) : null;
        }
        if (block.type === "toolCall") return <ToolCallView key={index} block={block} result={toolResults.get(block.toolCallId)} execution={executions.get(block.toolCallId)} />;
        return null;
      })}
      {message.stopReason === "error" && message.errorMessage && (
        <div className="mt-2 rounded-md bg-error-container text-on-error-container px-3 py-2 text-[13px]">{message.errorMessage}</div>
      )}
      {streaming && <span className="inline-block w-1.5 h-4 bg-secondary/70 animate-pulse align-text-bottom ml-0.5" />}
    </div>
  );
}

interface MessageViewProps {
  message: AgentMessage;
  conversationId: number;
  toolResults: Map<string, ToolResultMessage>;
  executions: Map<string, ToolExecution>;
  streaming?: boolean;
}

function toolCallIds(message: AgentMessage): string[] {
  return message.role === "assistant" ? message.content.flatMap((block) => (block.type === "toolCall" ? [block.toolCallId] : [])) : [];
}

/** 只有与本消息 toolCall 相关的 result/execution 变化才重渲染，避免流式期间整条历史刷新。 */
function haveSameRelevantToolState(prev: MessageViewProps, next: MessageViewProps): boolean {
  const ids = toolCallIds(next.message);
  return ids.every((id) => prev.toolResults.get(id) === next.toolResults.get(id) && prev.executions.get(id) === next.executions.get(id));
}

/** 单条消息渲染失败只降级该条，不能让整个对话页白屏。 */
class MessageErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed
      ? <div className="rounded-md bg-error-container text-on-error-container px-3 py-2 text-[12px]">这条消息无法渲染（内容格式不受支持）。</div>
      : this.props.children;
  }
}

const MessageBody = memo(function MessageBody({ message, conversationId, toolResults, executions, streaming = false }: MessageViewProps) {
  switch (message.role) {
    case "user":
      return <UserBubble message={message} conversationId={conversationId} />;
    case "assistant":
      return <AssistantView message={message} toolResults={toolResults} executions={executions} streaming={streaming} />;
    case "custom":
      if (!message.display) return null;
      return (
        <Collapsible summary={<span className="text-muted">{message.customType === "compactionSummary" ? "上下文压缩摘要" : message.customType}</span>}>
          <div className="text-[13px] text-on-surface-variant whitespace-pre-wrap">{typeof message.content === "string" ? message.content : message.content.map((block) => (block.type === "text" ? block.text : "")).join("")}</div>
        </Collapsible>
      );
    case "bashExecution":
      return (
        <Collapsible summary={<span className="font-mono text-[12px]">$ {message.command}</span>}>
          <pre className="font-mono text-[12px] whitespace-pre-wrap">{message.output}</pre>
        </Collapsible>
      );
    default:
      return null; // toolResult 由对应 toolCall 块显示
  }
}, (prev, next) => prev.message === next.message && prev.streaming === next.streaming && prev.conversationId === next.conversationId && haveSameRelevantToolState(prev, next));

export function MessageView(props: MessageViewProps) {
  return <MessageErrorBoundary><MessageBody {...props} /></MessageErrorBoundary>;
}
