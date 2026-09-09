/** 后端契约类型：字段名与 server/src/routes 输出保持一致，不在前端做二次映射。 */

export type SpaceType = "learn" | "review" | "ta";
export type TriState = "proposed" | "normal" | "deleted";

export interface Conversation {
  id: number;
  spaceId: number;
  spaceType: SpaceType;
  name: string | null;
  enableMakeCard: boolean;
  agentsMdId: number;
  teachStyleId: number | null;
  reviewTopicId: number | null;
  createdAt: string;
  modifiedAt: string | null;
}

export interface Space {
  id: number;
  type: SpaceType;
  name: string;
  createdAt?: string;
  conversations: Conversation[];
}

export interface WorkspacesResponse {
  spaces: Space[];
  taSessionId: number;
  dueCards: number;
}

export interface Runtime {
  alive: boolean;
  isRunning: boolean;
  isStreaming: boolean;
  isCompacting: boolean;
  model: { provider: string; id: string } | null;
  pendingMessageCount: number;
}

export interface TextContent { type: "text"; text: string }
/** Pi SDK 的图片块是扁平结构（data + mimeType），不是 Anthropic 风格的 source 包装。 */
export interface ImageContent { type: "image"; data: string; mimeType: string }
export interface ThinkingContent { type: "thinking"; thinking: string }
export interface ToolCallContent { type: "toolCall"; toolCallId: string; toolName: string; input: Record<string, unknown>; rawInput?: string }
export type AssistantContentBlock = TextContent | ImageContent | ThinkingContent | ToolCallContent;

export interface UserMessage { role: "user"; content: string | (TextContent | ImageContent)[]; timestamp?: number }
export interface AssistantMessage {
  role: "assistant";
  content: AssistantContentBlock[];
  model?: string;
  provider?: string;
  stopReason?: string;
  errorMessage?: string;
  timestamp?: number;
}
export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName?: string;
  content: (TextContent | ImageContent)[];
  isError?: boolean;
  details?: unknown;
  timestamp?: number;
}
export interface CustomMessage { role: "custom"; customType: string; content: string | (TextContent | ImageContent)[]; display: boolean; timestamp?: number }
export interface BashExecutionMessage { role: "bashExecution"; command: string; output: string; exitCode?: number; timestamp?: number }
export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage | CustomMessage | BashExecutionMessage;

export interface SessionContext {
  messages: AgentMessage[];
  entryIds: string[];
  oldestEntryId: string | null;
  hasMore: boolean;
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
  conversation: Conversation;
  runtime: Runtime;
}

export interface ModelInfo { provider: string; id: string; name: string }
export interface ModelsResponse { models: ModelInfo[]; defaultModel: { provider: string; id: string } | null }

export interface Attachment { id: string; relativePath: string; name: string; mimeType: string; size: number }
export interface FileIndexEntry { path: string; type?: string; size?: number }

export interface Topic {
  id: number;
  name: string;
  description: string | null;
  request_retention: number | null;
  maximum_interval: number | null;
  created_at: string;
  card_count?: number;
  proposed_count?: number;
  due_count?: number;
}

export interface Card {
  id: number;
  topic_id: number;
  topic_name: string;
  front: string;
  back: string;
  status: TriState;
  reason_and_remark: string | null;
  created_at: string;
  has_source_essence: number;
  schedule_state: string | null;
  schedule_due: string | null;
  schedule_reps: number | null;
  schedule_lapses: number | null;
}

export interface GlossaryTerm {
  id: number;
  term: string;
  definition: string;
  status: TriState;
  created_at: string;
}

export interface AgentsMd { id: number; type: SpaceType; name: string; description: string | null; prompt: string; usage_count: number }
export interface TeachStyle { id: number; name: string; description: string | null; prompt: string; usage_count: number }
export interface PromptsResponse { agentsMd: AgentsMd[]; teachStyles: TeachStyle[] }

export interface SlashCommand { name: string; description: string }
export interface SessionState {
  isStreaming: boolean;
  isRunning: boolean;
  isCompacting: boolean;
  model?: { id: string; provider: string };
  pendingMessageCount: number;
  contextUsage: { percent: number; contextWindow: number; tokens: number } | null;
  thinkingLevel: string;
}

/** 复习排期：全部字段都能由 card_schedule / review_log 复算，无估算指标。 */
export interface ReviewScheduleResponse {
  timezone: "UTC";
  range: { upcomingDays: number; historyDays: number };
  topicId: number | null;
  totals: { normalCards: number; proposedCards: number; dueNow: number; overdue: number; withoutSchedule: number };
  upcoming: Array<{ date: string; dueCount: number }>;
  history: Array<{ date: string; reviewCount: number; again: number; hard: number; good: number; easy: number }>;
}

/** provider 凭据只以布尔出现；headerNames 只有名字，值永远不出网。 */
export interface ProviderConfigView {
  id: string;
  name: string | null;
  api: string | null;
  apiUnknown: boolean;
  baseUrl: string | null;
  apiKeyConfigured: boolean;
  headerNames: string[];
  models: Array<{ id: string; name: string | null }>;
  advancedKeys: string[];
}

export interface DefaultModelConfig {
  provider: string | null;
  modelId: string | null;
  source: "env" | "settings" | "catalog";
  editable: boolean;
}

export interface ModelsConfigResponse {
  knownApis: string[];
  secretMask: string;
  providers: ProviderConfigView[];
  defaultModel: DefaultModelConfig;
}

export interface RetrySettingsView {
  enabled: boolean;
  maxRetries: number;
  baseDelayMs: number;
  provider: { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs: number };
}

/** settings.json 的受控子集；provider 级 retry 明细无公开 setter，只读展示。 */
export interface PiSettingsView {
  defaultProvider: string | null;
  defaultModel: string | null;
  retryEnabled: boolean;
  retry: RetrySettingsView;
}

export interface PiSettingsResponse { settings: PiSettingsView; defaultModel: DefaultModelConfig }

/** provider 补丁：apiKey / header 值遵循三态（缺省保持、字符串覆盖、null 清除）。 */
export interface ProviderPatch {
  name?: string | null;
  baseUrl?: string | null;
  api?: string;
  apiKey?: string | null;
  headers?: Record<string, string | null>;
  models?: Array<{ id: string; name?: string | null }>;
}
