import { useState } from "react";
import { conversationsApi } from "../api/client.ts";
import type { Conversation, ModelInfo } from "../api/types.ts";
import { useWorkspace } from "../app/WorkspaceContext.tsx";
import { ConfirmDialog } from "../ui/Overlays.tsx";

/**
 * 输入区控制条：会话类型、制卡开关、教学风格、模型。
 *
 * 三者都是真实写后端的开关，不做乐观更新——每次成功后都由 onChanged 重新拉取
 * 会话上下文，界面显示的永远是数据库里的值。
 */

const TYPE_LABEL = { learn: "学习", review: "复习", ta: "助教" } as const;
const TYPE_ICON = { learn: "school", review: "replay", ta: "support_agent" } as const;

interface SessionControlBarProps {
  conversation: Conversation | null;
  isRunning: boolean;
  onChanged: () => Promise<void>;
}

export function SessionControlBar({ conversation, isRunning, onChanged }: SessionControlBarProps) {
  const { topics, prompts } = useWorkspace();
  const [pendingStyleId, setPendingStyleId] = useState<number | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!conversation) return null;

  const isTa = conversation.spaceType === "ta";
  const reviewTopic = conversation.reviewTopicId === null ? null : topics.find((topic) => topic.id === conversation.reviewTopicId) ?? null;
  const currentStyle = prompts.teachStyles.find((style) => style.id === conversation.teachStyleId) ?? null;

  const toggleMakeCard = async () => {
    setBusy(true);
    setError(null);
    try {
      await conversationsApi.setOptions(conversation.id, { enableMakeCard: !conversation.enableMakeCard });
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "切换制卡开关失败");
    } finally {
      setBusy(false);
    }
  };

  const applyTeachStyle = async (teachStyleId: number | null) => {
    setBusy(true);
    setError(null);
    try {
      await conversationsApi.setTeachStyle(conversation.id, teachStyleId);
      setPendingStyleId(undefined);
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "切换教学风格失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-1.5 flex-wrap px-1 pb-1.5 text-[11px]">
      <span className="control-pill">
        <span className="icon text-[13px] text-secondary">{TYPE_ICON[conversation.spaceType]}</span>
        {TYPE_LABEL[conversation.spaceType]}
      </span>

      {conversation.spaceType === "review" && (
        <span className="control-pill">
          <span className="icon text-[13px] text-secondary">label</span>
          {reviewTopic ? reviewTopic.name : "全部 Topic"}
        </span>
      )}

      {!isTa && (
        <button
          type="button"
          className={conversation.enableMakeCard ? "control-pill-on" : "control-pill"}
          disabled={busy}
          title={conversation.enableMakeCard ? "老师可以提议记忆卡片，点击关闭" : "老师无法调用制卡工具，点击开启"}
          onClick={() => void toggleMakeCard()}
        >
          <span className="icon text-[13px] text-secondary">auto_fix_high</span>
          制卡：{conversation.enableMakeCard ? "开" : "关"}
        </button>
      )}

      {!isTa && (
        <label className="control-pill gap-1" title={isRunning ? "回复进行中不能切换教学风格" : "切换后会以新风格重新载入本对话"}>
          <span className="icon text-[13px]">psychology</span>
          教学风格
          <select
            className="bg-transparent border-none focus:outline-none text-[11px] max-w-[140px] disabled:cursor-not-allowed"
            value={conversation.teachStyleId ?? ""}
            disabled={busy || isRunning}
            onChange={(event) => setPendingStyleId(event.target.value ? Number(event.target.value) : null)}
          >
            <option value="">不使用</option>
            {prompts.teachStyles.map((style) => <option key={style.id} value={style.id}>{style.name}</option>)}
          </select>
        </label>
      )}

      {error && <span className="text-[11px] text-error">{error}</span>}

      {pendingStyleId !== undefined && (
        <ConfirmDialog
          title="切换教学风格"
          busy={busy}
          message={
            <>
              将把本对话的教学风格从「{currentStyle?.name ?? "未使用"}」切换为「
              {pendingStyleId === null ? "不使用" : prompts.teachStyles.find((style) => style.id === pendingStyleId)?.name ?? `#${pendingStyleId}`}」。
              <br />
              当前对话会以新风格重新载入：历史消息、已选模型都会保留，只是之后的回答按新风格进行。
            </>
          }
          confirmLabel="切换并重新载入"
          onCancel={() => setPendingStyleId(undefined)}
          onConfirm={() => void applyTeachStyle(pendingStyleId)}
        />
      )}
    </div>
  );
}

interface ModelSelectorProps {
  models: ModelInfo[];
  activeModel: { provider: string; modelId: string } | null;
  disabled: boolean;
  disabledReason: string;
  onSelect: (provider: string, modelId: string) => void;
}

export function ModelSelector({ models, activeModel, disabled, disabledReason, onSelect }: ModelSelectorProps) {
  return (
    <select
      className="rounded-xl bg-surface-container hover:bg-surface-container-high text-primary text-[12px] font-medium py-1.5 pl-2.5 pr-6 border-none focus:outline-none cursor-pointer transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
      value={activeModel ? `${activeModel.provider}/${activeModel.modelId}` : ""}
      disabled={disabled}
      title={disabled ? disabledReason : "切换本对话使用的模型"}
      onChange={(event) => {
        const [provider, ...rest] = event.target.value.split("/");
        onSelect(provider, rest.join("/"));
      }}
    >
      {!activeModel && <option value="">选择模型</option>}
      {models.length === 0 && <option value="">未配置模型</option>}
      {models.map((model) => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name}</option>)}
    </select>
  );
}
