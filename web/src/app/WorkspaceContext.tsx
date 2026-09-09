import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { modelsApi, promptsApi, topicsApi, workspacesApi } from "../api/client.ts";
import type { ModelInfo, PromptsResponse, Topic, WorkspacesResponse } from "../api/types.ts";

interface WorkspaceContextValue {
  data: WorkspacesResponse | null;
  topics: Topic[];
  prompts: PromptsResponse;
  models: ModelInfo[];
  error: string | null;
  refresh: () => Promise<void>;
  refreshTopics: () => Promise<void>;
  refreshPrompts: () => Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);
const EMPTY_PROMPTS: PromptsResponse = { agentsMd: [], teachStyles: [] };

/** 左树、新建面板、右侧栏共享的只读目录数据；写操作各自调用 API 后 refresh。 */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<WorkspacesResponse | null>(null);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [prompts, setPrompts] = useState<PromptsResponse>(EMPTY_PROMPTS);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setData(await workspacesApi.list()); setError(null); } catch (cause) { setError(cause instanceof Error ? cause.message : "加载失败"); }
  }, []);
  const refreshTopics = useCallback(async () => { try { setTopics((await topicsApi.list()).topics); } catch { /* 在面板内显示错误 */ } }, []);
  const refreshPrompts = useCallback(async () => { try { setPrompts(await promptsApi.list()); } catch { /* 同上 */ } }, []);

  useEffect(() => {
    void refresh();
    void refreshTopics();
    void refreshPrompts();
    void modelsApi.list().then((result) => setModels(result.models)).catch(() => setModels([]));
  }, [refresh, refreshTopics, refreshPrompts]);

  const value = useMemo(() => ({ data, topics, prompts, models, error, refresh, refreshTopics, refreshPrompts }), [data, topics, prompts, models, error, refresh, refreshTopics, refreshPrompts]);
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace 必须在 WorkspaceProvider 内使用");
  return value;
}
