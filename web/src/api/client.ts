import type {
  AgentsMd,
  AppSettingsPatch,
  Attachment,
  Card,
  Conversation,
  DefaultModelConfig,
  GlossaryTerm,
  HomeMarkdownKind,
  HomeMarkdownResponse,
  ModelsConfigResponse,
  ModelsResponse,
  PiSettingsResponse,
  PromptsResponse,
  ProviderConfigView,
  ProviderPatch,
  ReviewScheduleResponse,
  Runtime,
  SessionContext,
  Space,
  TeachStyle,
  Topic,
  TriState,
  UserEnvItem,
  UserEnvPatch,
  UserEnvResponse,
  WorkspacesResponse,
} from "./types.ts";

/** 后端错误统一带 status 与可选 code；`session_recycled` 由对话页专门处理。 */
export class ApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly code?: string) {
    super(message);
  }
}

/** 401 时由全局监听者跳转登录页，避免每个页面各自处理。 */
const unauthorizedListeners = new Set<() => void>();
export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  if (response.status === 401 && !path.startsWith("/api/auth/")) unauthorizedListeners.forEach((listener) => listener());
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(response.status, typeof payload.error === "string" ? payload.error : `请求失败（HTTP ${response.status}）`, payload.code);
  }
  return payload as T;
}

function json(method: string, body?: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) };
}

const query = (params: Record<string, string | number | undefined | null>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  const text = search.toString();
  return text ? `?${text}` : "";
};

export const authApi = {
  status: () => request<{ needsSetup: boolean }>("/api/auth/status"),
  me: () => request<{ username: string | null }>("/api/auth/me"),
  setup: (username: string, password: string) => request<{ success: true; username: string }>("/api/auth/setup", json("POST", { username, password })),
  login: (username: string, password: string) => request<{ success: true; username: string }>("/api/auth/login", json("POST", { username, password })),
  logout: () => request<{ success: true }>("/api/auth/logout", json("POST")),
  changeUsername: (username: string, currentPassword: string) =>
    request<{ success: true; username: string }>("/api/auth/username", json("PATCH", { username, currentPassword })),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ success: true }>("/api/auth/password", json("PATCH", { currentPassword, newPassword })),
};

export const workspacesApi = {
  list: () => request<WorkspacesResponse>("/api/workspaces"),
  create: (name: string) => request<{ success: true; space: Space }>("/api/workspaces", json("POST", { name })),
  rename: (id: number, name: string) => request<{ success: true }>(`/api/workspaces/${id}`, json("PATCH", { name })),
  remove: (id: number) => request<{ success: true }>(`/api/workspaces/${id}`, { method: "DELETE" }),
};

export interface CreateConversationInput {
  spaceId: number;
  agentsMdId: number;
  teachStyleId?: number | null;
  reviewTopicId?: number | null;
  enableMakeCard?: boolean;
}

export type SessionCommand =
  | { type: "prompt" | "steer" | "follow_up"; message: string; attachmentIds?: string[]; injectMainSessionId?: number }
  | { type: "set_model"; provider: string; modelId: string }
  | { type: "set_thinking_level"; level: string }
  | { type: "compact"; customInstructions?: string }
  | { type: "set_session_name"; name: string }
  | { type: "abort" | "get_state" | "get_tools" | "get_commands" | "get_session_stats" | "get_last_assistant_text" | "clear_queue" | "abort_compaction" };

export const conversationsApi = {
  create: (input: CreateConversationInput) => request<{ success: true; conversation: Conversation; runtime: Runtime }>("/api/conversations", json("POST", input)),
  setOptions: (id: number, input: { enableMakeCard: boolean }) =>
    request<{ success: true; conversation: Conversation }>(`/api/conversations/${id}/options`, json("PATCH", input)),
  setTeachStyle: (id: number, teachStyleId: number | null) =>
    request<{ success: true; reloaded: boolean; conversation: Conversation; runtime: Runtime }>(
      `/api/conversations/${id}/teach-style`, json("PATCH", { teachStyleId }),
    ),
  open: (id: number) => request<{ success: true; conversation: Conversation; runtime: Runtime }>(`/api/conversations/${id}/open`, json("POST")),
  status: (id: number) => request<Runtime>(`/api/conversations/${id}/status`),
  context: (id: number, options: { tail?: number; before?: string } = {}) => request<SessionContext>(`/api/conversations/${id}/context${query(options)}`),
  command: <T = unknown>(id: number, command: SessionCommand) => request<{ success: true; data: T }>(`/api/conversations/${id}/command`, json("POST", command)),
  close: (id: number) => request<{ success: true }>(`/api/conversations/${id}/close`, json("POST")),
  /** 只对助教有效：换新 JSONL 并常驻重开；工作目录与 pi-session-user.md 不动。 */
  clear: (id: number) => request<{ success: true; conversation: Conversation; runtime: Runtime }>(`/api/conversations/${id}/clear`, json("POST")),
  /** 真删除：行与 JSONL 一起删，工作目录保留；助教 403。 */
  remove: (id: number) => request<{ success: true; filesRetained: true }>(`/api/conversations/${id}`, { method: "DELETE" }),
  eventsUrl: (id: number) => `/api/conversations/${id}/events`,
  fileIndex: (id: number, q: string) => request<{ files: string[]; truncated: boolean }>(`/api/conversations/${id}/file-index${query({ q })}`),
  upload: async (id: number, file: File) => {
    const response = await fetch(`/api/conversations/${id}/attachments`, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-File-Name": encodeURIComponent(file.name),
        ...(file.type ? { "X-File-Type": file.type } : {}),
      },
      body: file,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(response.status, typeof payload.error === "string" ? payload.error : "上传失败", payload.code);
    return payload as { success: true; attachment: Attachment };
  },
};

export const modelsApi = { list: () => request<ModelsResponse>("/api/models") };

export const topicsApi = {
  list: () => request<{ topics: Topic[] }>("/api/topics"),
  create: (input: { name: string; description?: string | null; requestRetention?: number | null; maximumInterval?: number | null }) =>
    request<{ success: true; topic: Topic }>("/api/topics", json("POST", input)),
  update: (id: number, input: { name?: string; description?: string | null; requestRetention?: number | null; maximumInterval?: number | null }) =>
    request<{ success: true; topic: Topic }>(`/api/topics/${id}`, json("PATCH", input)),
};

export const cardsApi = {
  list: (options: { status?: TriState | "all"; topicId?: number | null } = {}) => request<{ cards: Card[] }>(`/api/cards${query(options)}`),
  create: (input: { topicId: number; front: string; back: string; reasonAndRemark?: string | null }) => request<{ success: true; card: Card }>("/api/cards", json("POST", input)),
  update: (id: number, input: { topicId?: number; front?: string; back?: string; reasonAndRemark?: string | null }) => request<{ success: true; card: Card }>(`/api/cards/${id}`, json("PATCH", input)),
  confirm: (id: number) => request<{ success: true; card: Card }>(`/api/cards/${id}/confirm`, json("POST")),
  reject: (id: number) => request<{ success: true; card: Card }>(`/api/cards/${id}/reject`, json("POST")),
  remove: (id: number) => request<{ success: true; card: Card }>(`/api/cards/${id}/delete`, json("POST")),
  restore: (id: number) => request<{ success: true; card: Card }>(`/api/cards/${id}/restore`, json("POST")),
};

export const glossaryApi = {
  list: (status?: TriState | "all") => request<{ terms: GlossaryTerm[] }>(`/api/glossary${query({ status })}`),
  create: (input: { term: string; definition: string }) => request<{ success: true; term: GlossaryTerm }>("/api/glossary", json("POST", input)),
  update: (id: number, input: { term?: string; definition?: string }) => request<{ success: true; term: GlossaryTerm }>(`/api/glossary/${id}`, json("PATCH", input)),
  confirm: (id: number) => request<{ success: true }>(`/api/glossary/${id}/confirm`, json("POST")),
  reject: (id: number) => request<{ success: true }>(`/api/glossary/${id}/reject`, json("POST")),
  remove: (id: number) => request<{ success: true }>(`/api/glossary/${id}/delete`, json("POST")),
  restore: (id: number) => request<{ success: true }>(`/api/glossary/${id}/restore`, json("POST")),
};

export const promptsApi = {  list: (type?: string) => request<PromptsResponse>(`/api/prompts${query({ type })}`),
  createAgentsMd: (input: { type: string; name: string; description?: string | null; prompt: string }) => request<{ success: true; agentsMd: AgentsMd }>("/api/prompts/agents-md", json("POST", input)),
  updateAgentsMd: (id: number, input: { name?: string; description?: string | null; prompt?: string }) => request<{ success: true; notice: string; agentsMd: AgentsMd }>(`/api/prompts/agents-md/${id}`, json("PATCH", input)),
  removeAgentsMd: (id: number) => request<{ success: true }>(`/api/prompts/agents-md/${id}`, { method: "DELETE" }),
  createTeachStyle: (input: { name: string; description?: string | null; prompt: string }) => request<{ success: true; teachStyle: TeachStyle }>("/api/prompts/teach-style", json("POST", input)),
  updateTeachStyle: (id: number, input: { name?: string; description?: string | null; prompt?: string }) => request<{ success: true; notice: string; teachStyle: TeachStyle }>(`/api/prompts/teach-style/${id}`, json("PATCH", input)),
  removeTeachStyle: (id: number) => request<{ success: true }>(`/api/prompts/teach-style/${id}`, { method: "DELETE" }),
};

export const reviewScheduleApi = {
  get: (options: { upcomingDays?: number; historyDays?: number; topicId?: number | null } = {}) =>
    request<ReviewScheduleResponse>(`/api/review-schedule${query(options)}`),
};

/** Pi 配置：出口已脱敏，apiKey 只有布尔与固定掩码，提交遵循三态语义。 */
export const configApi = {
  models: () => request<ModelsConfigResponse>("/api/config/models"),
  providerJson: (providerId: string) =>
    request<{ provider: Record<string, unknown>; secretMask: string }>(`/api/config/models/${encodeURIComponent(providerId)}/json`),
  saveProvider: (providerId: string, patch: ProviderPatch) =>
    request<{ success: true; provider: ProviderConfigView; warnings: string[] }>(
      `/api/config/models/${encodeURIComponent(providerId)}`, json("PATCH", patch),
    ),
  saveProviderJson: (providerId: string, value: unknown) =>
    request<{ success: true; provider: ProviderConfigView; warnings: string[] }>(
      `/api/config/models/${encodeURIComponent(providerId)}`, json("PATCH", { json: value }),
    ),
  removeProvider: (providerId: string) =>
    request<{ success: true }>(`/api/config/models/${encodeURIComponent(providerId)}`, { method: "DELETE" }),
  setDefaultModel: (provider: string, modelId: string) =>
    request<{ success: true; defaultModel: DefaultModelConfig }>("/api/config/default-model", json("PATCH", { provider, modelId })),
  settings: () => request<PiSettingsResponse>("/api/config/settings"),
  saveSettings: (patch: { defaultProvider?: string | null; defaultModel?: string | null; retryEnabled?: boolean } & AppSettingsPatch) =>
    request<{ success: true } & PiSettingsResponse>("/api/config/settings", json("PATCH", patch)),
  // homeDir 下用户直接编辑的两份 Markdown：全局 USER.md 与全局 AGENTS.md，契约相同。
  homeMarkdown: (kind: HomeMarkdownKind) => request<HomeMarkdownResponse>(`/api/config/${kind}`),
  saveHomeMarkdown: (kind: HomeMarkdownKind, content: string) => request<{ success: true }>(`/api/config/${kind}`, json("PUT", { content })),
  userEnv: () => request<UserEnvResponse>("/api/config/user-env"),
  saveUserEnv: (patch: UserEnvPatch) => request<{ success: true; items: UserEnvItem[] }>("/api/config/user-env", json("PATCH", patch)),
  removeUserEnv: (key: string) => request<{ success: true; items: UserEnvItem[] }>(`/api/config/user-env/${encodeURIComponent(key)}`, { method: "DELETE" }),
};
