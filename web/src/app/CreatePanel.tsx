import { useEffect, useMemo, useState } from "react";
import { conversationsApi } from "../api/client.ts";
import { useWorkspace } from "./WorkspaceContext.tsx";

export type CreateIntent =
  | { kind: "generic" }
  | { kind: "learn"; spaceId: number | null }
  | { kind: "review"; topicId: number | null };

interface CreatePanelProps {
  intent: CreateIntent;
  onClose: () => void;
  onCreated: (conversationId: number) => void;
}

/**
 * 统一新建面板：学习需要选学习 Space + learn 模板 + 可选教学风格 + 制卡开关；
 * 复习固定落到 review Space，选 review 模板 + Topic（null = 全部）。
 * 创建成功后直接进入对话；模型不在此处选择（用 set_model 命令切换）。
 */
export function CreatePanel({ intent, onClose, onCreated }: CreatePanelProps) {
  const { data, topics, prompts, refresh } = useWorkspace();
  const learnSpaces = useMemo(() => (data?.spaces ?? []).filter((space) => space.type === "learn"), [data]);
  const reviewSpace = useMemo(() => (data?.spaces ?? []).find((space) => space.type === "review"), [data]);

  const [mode, setMode] = useState<"learn" | "review">(intent.kind === "review" ? "review" : "learn");
  const [spaceId, setSpaceId] = useState<number | null>(intent.kind === "learn" ? intent.spaceId : null);
  const [topicId, setTopicId] = useState<number | null>(intent.kind === "review" ? intent.topicId : null);
  const [agentsMdId, setAgentsMdId] = useState<number | null>(null);
  const [teachStyleId, setTeachStyleId] = useState<number | null>(null);
  const [enableMakeCard, setEnableMakeCard] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const templates = useMemo(() => prompts.agentsMd.filter((item) => item.type === mode), [prompts, mode]);

  useEffect(() => {
    setMode(intent.kind === "review" ? "review" : "learn");
    setSpaceId(intent.kind === "learn" ? intent.spaceId : null);
    setTopicId(intent.kind === "review" ? intent.topicId : null);
    setError(null);
  }, [intent]);

  useEffect(() => {
    if (agentsMdId === null || !templates.some((template) => template.id === agentsMdId)) setAgentsMdId(templates[0]?.id ?? null);
  }, [templates, agentsMdId]);

  useEffect(() => {
    if (mode === "learn" && spaceId === null && learnSpaces.length === 1) setSpaceId(learnSpaces[0].id);
  }, [mode, spaceId, learnSpaces]);

  const submit = async () => {
    setError(null);
    if (agentsMdId === null) { setError(`没有可用的${mode === "learn" ? "学习" : "复习"}模板，请先到管理面板创建`); return; }
    const targetSpaceId = mode === "learn" ? spaceId : reviewSpace?.id ?? null;
    if (targetSpaceId === null) { setError(mode === "learn" ? "请选择学习 Space" : "复习 Space 不可用"); return; }
    setBusy(true);
    try {
      const result = await conversationsApi.create({
        spaceId: targetSpaceId,
        agentsMdId,
        teachStyleId,
        reviewTopicId: mode === "review" ? topicId : null,
        enableMakeCard: mode === "learn" ? enableMakeCard : false,
      });
      await refresh();
      onCreated(result.conversation.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "创建失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 bg-primary/30 backdrop-blur-[2px] flex items-center justify-center" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="card w-[520px] p-6 space-y-5">
        <div className="flex items-center justify-between">
          <h2 className="font-reading text-[22px] text-primary">新建对话</h2>
          <button type="button" className="icon text-[20px] text-muted hover:text-on-surface" onClick={onClose}>close</button>
        </div>

        <div className="flex gap-1 p-1 rounded-lg bg-surface-container">
          {(["learn", "review"] as const).map((item) => (
            <button key={item} type="button" className={`flex-1 py-1.5 rounded-md text-[13px] font-medium ${mode === item ? "bg-surface-container-lowest shadow-sm text-primary" : "text-on-surface-variant"}`} onClick={() => setMode(item)}>
              {item === "learn" ? "学习" : "复习"}
            </button>
          ))}
        </div>

        {mode === "learn" ? (
          <label className="block space-y-1">
            <span className="label">学习 Space</span>
            <select className="input" value={spaceId ?? ""} onChange={(event) => setSpaceId(event.target.value ? Number(event.target.value) : null)}>
              <option value="">选择 Space…</option>
              {learnSpaces.map((space) => <option key={space.id} value={space.id}>{space.name}</option>)}
            </select>
            {learnSpaces.length === 0 && <span className="text-[12px] text-error">还没有学习 Space，请先在左侧创建。</span>}
          </label>
        ) : (
          <label className="block space-y-1">
            <span className="label">复习范围</span>
            <select className="input" value={topicId ?? ""} onChange={(event) => setTopicId(event.target.value ? Number(event.target.value) : null)}>
              <option value="">全部 Topic</option>
              {topics.map((topic) => <option key={topic.id} value={topic.id}>{topic.name}{topic.due_count ? `（${topic.due_count} 张到期）` : ""}</option>)}
            </select>
          </label>
        )}

        <label className="block space-y-1">
          <span className="label">{mode === "learn" ? "学习模板（Agents Md）" : "复习模板（Agents Md）"}</span>
          <select className="input" value={agentsMdId ?? ""} onChange={(event) => setAgentsMdId(Number(event.target.value))}>
            {templates.map((template) => <option key={template.id} value={template.id}>{template.name}{template.description ? ` — ${template.description}` : ""}</option>)}
          </select>
        </label>

        <label className="block space-y-1">
          <span className="label">教学风格（可选）</span>
          <select className="input" value={teachStyleId ?? ""} onChange={(event) => setTeachStyleId(event.target.value ? Number(event.target.value) : null)}>
            <option value="">不指定</option>
            {prompts.teachStyles.map((style) => <option key={style.id} value={style.id}>{style.name}{style.description ? ` — ${style.description}` : ""}</option>)}
          </select>
        </label>

        {mode === "learn" && (
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" className="accent-secondary w-4 h-4" checked={enableMakeCard} onChange={(event) => setEnableMakeCard(event.target.checked)} />
            允许老师在学习中提议记忆卡片
          </label>
        )}

        {error && <div className="text-[13px] text-error">{error}</div>}

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>取消</button>
          <button type="button" className="btn-primary" disabled={busy} onClick={() => void submit()}>{busy ? "创建中…" : "创建并进入"}</button>
        </div>
      </div>
    </div>
  );
}
