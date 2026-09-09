import { useCallback, useEffect, useState } from "react";
import { promptsApi } from "../api/client.ts";
import type { AgentsMd, PromptsResponse, SpaceType, TeachStyle } from "../api/types.ts";
import { ErrorLine, Field, Modal, useSubmit } from "./shared.tsx";

const TYPE_LABEL: Record<SpaceType, string> = { learn: "学习", review: "复习", ta: "助教" };
const EMPTY: PromptsResponse = { agentsMd: [], teachStyles: [] };

function usePrompts() {
  const [data, setData] = useState<PromptsResponse>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setData(await promptsApi.list()); setError(null); } catch (cause) { setError(cause instanceof Error ? cause.message : "加载失败"); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  return { data, error, setError, load };
}

interface PromptFormState { type: SpaceType; name: string; description: string; prompt: string }

function PromptForm({ title, initial, lockType, onSubmit, onClose }: { title: string; initial: PromptFormState; lockType: boolean; onSubmit: (state: PromptFormState) => Promise<void>; onClose: () => void }) {
  const [state, setState] = useState(initial);
  const { busy, error, run } = useSubmit();
  return (
    <Modal title={title} width={720} onClose={onClose}>
      {!lockType && (
        <Field label="类型" hint="助教模板全局唯一，由系统维护，不能新建">
          <select className="input" value={state.type} onChange={(event) => setState({ ...state, type: event.target.value as SpaceType })}>
            <option value="learn">学习</option>
            <option value="review">复习</option>
          </select>
        </Field>
      )}
      <Field label="名称"><input className="input" value={state.name} onChange={(event) => setState({ ...state, name: event.target.value })} /></Field>
      <Field label="简介（可选）"><input className="input" value={state.description} onChange={(event) => setState({ ...state, description: event.target.value })} /></Field>
      <Field label="提示词正文" hint="修改只影响之后新建的对话；已存在对话的 AGENTS.md / style.md 已投影到各自工作目录，不会被改写">
        <textarea className="input font-mono text-[12px]" rows={18} value={state.prompt} onChange={(event) => setState({ ...state, prompt: event.target.value })} />
      </Field>
      <ErrorLine error={error} />
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onClose}>取消</button>
        <button type="button" className="btn-primary" disabled={busy || !state.name.trim() || !state.prompt.trim()} onClick={() => void run(() => onSubmit(state)).then(onClose).catch(() => {})}>保存</button>
      </div>
    </Modal>
  );
}

export function AgentsMdTab() {
  const { data, error, setError, load } = usePrompts();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AgentsMd | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const grouped: Array<[SpaceType, AgentsMd[]]> = (["learn", "review", "ta"] as SpaceType[]).map((type) => [type, data.agentsMd.filter((item) => item.type === type)]);

  const remove = async (item: AgentsMd) => {
    if (!confirm(`删除模板「${item.name}」？`)) return;
    try { await promptsApi.removeAgentsMd(item.id); await load(); } catch (cause) { setError(cause instanceof Error ? cause.message : "删除失败"); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-[13px] text-on-surface-variant">Agents Md 决定老师的职责与工作方式，按类型区分；对话创建时会投影为该对话工作目录下的 AGENTS.md。</p>
        <button type="button" className="btn-primary" onClick={() => setCreating(true)}><span className="icon text-[16px]">add</span>新建模板</button>
      </div>
      <ErrorLine error={error} />
      {notice && <div className="text-[12px] text-on-secondary-container bg-secondary-container rounded-md px-3 py-2">{notice}</div>}
      {grouped.map(([type, items]) => (
        <section key={type} className="space-y-2">
          <div className="label">{TYPE_LABEL[type]}模板</div>
          <div className="card divide-y divide-line">
            {items.length === 0 && <div className="p-6 text-center text-[13px] text-muted">暂无{TYPE_LABEL[type]}模板</div>}
            {items.map((item) => (
              <div key={item.id} className="p-4 flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-primary">{item.name}</span>
                    <span className="text-[11px] text-muted font-mono">#{item.id}</span>
                    <span className="chip bg-surface-container">被 {item.usage_count} 个对话使用</span>
                    {item.type === "ta" && <span className="chip bg-tertiary-container text-on-tertiary-container">系统固定</span>}
                  </div>
                  {item.description && <div className="text-[12px] text-on-surface-variant mt-0.5">{item.description}</div>}
                  <div className="text-[12px] text-muted font-mono mt-1 line-clamp-2">{item.prompt.slice(0, 200)}</div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button type="button" className="btn-ghost py-1" onClick={() => setEditing(item)}>编辑</button>
                  {item.type !== "ta" && item.usage_count === 0 && <button type="button" className="btn-danger py-1" onClick={() => void remove(item)}>删除</button>}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}

      {creating && (
        <PromptForm title="新建 Agents Md" lockType={false} initial={{ type: "learn", name: "", description: "", prompt: "" }} onClose={() => setCreating(false)}
          onSubmit={async (state) => { await promptsApi.createAgentsMd({ type: state.type, name: state.name.trim(), description: state.description.trim() || null, prompt: state.prompt }); await load(); }} />
      )}
      {editing && (
        <PromptForm title={`编辑「${editing.name}」`} lockType initial={{ type: editing.type, name: editing.name, description: editing.description ?? "", prompt: editing.prompt }} onClose={() => setEditing(null)}
          onSubmit={async (state) => {
            const result = await promptsApi.updateAgentsMd(editing.id, { name: state.name.trim(), description: state.description.trim() || null, prompt: state.prompt });
            setNotice(result.notice);
            await load();
          }} />
      )}
    </div>
  );
}

export function TeachStyleTab() {
  const { data, error, setError, load } = usePrompts();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<TeachStyle | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const remove = async (item: TeachStyle) => {
    if (!confirm(`删除教学风格「${item.name}」？`)) return;
    try { await promptsApi.removeTeachStyle(item.id); await load(); } catch (cause) { setError(cause instanceof Error ? cause.message : "删除失败"); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-[13px] text-on-surface-variant">教学风格是可选的语气与节奏偏好，创建对话时投影为 style.md，并作为系统提示词追加。</p>
        <button type="button" className="btn-primary" onClick={() => setCreating(true)}><span className="icon text-[16px]">add</span>新建风格</button>
      </div>
      <ErrorLine error={error} />
      {notice && <div className="text-[12px] text-on-secondary-container bg-secondary-container rounded-md px-3 py-2">{notice}</div>}
      <div className="card divide-y divide-line">
        {data.teachStyles.length === 0 && <div className="p-6 text-center text-[13px] text-muted">暂无教学风格</div>}
        {data.teachStyles.map((item) => (
          <div key={item.id} className="p-4 flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium text-primary">{item.name}</span>
                <span className="text-[11px] text-muted font-mono">#{item.id}</span>
                <span className="chip bg-surface-container">被 {item.usage_count} 个对话使用</span>
              </div>
              {item.description && <div className="text-[12px] text-on-surface-variant mt-0.5">{item.description}</div>}
              <div className="text-[12px] text-muted font-mono mt-1 line-clamp-2">{item.prompt.slice(0, 200)}</div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button type="button" className="btn-ghost py-1" onClick={() => setEditing(item)}>编辑</button>
              {item.usage_count === 0 && <button type="button" className="btn-danger py-1" onClick={() => void remove(item)}>删除</button>}
            </div>
          </div>
        ))}
      </div>

      {creating && (
        <PromptForm title="新建教学风格" lockType initial={{ type: "learn", name: "", description: "", prompt: "" }} onClose={() => setCreating(false)}
          onSubmit={async (state) => { await promptsApi.createTeachStyle({ name: state.name.trim(), description: state.description.trim() || null, prompt: state.prompt }); await load(); }} />
      )}
      {editing && (
        <PromptForm title={`编辑「${editing.name}」`} lockType initial={{ type: "learn", name: editing.name, description: editing.description ?? "", prompt: editing.prompt }} onClose={() => setEditing(null)}
          onSubmit={async (state) => {
            const result = await promptsApi.updateTeachStyle(editing.id, { name: state.name.trim(), description: state.description.trim() || null, prompt: state.prompt });
            setNotice(result.notice);
            await load();
          }} />
      )}
    </div>
  );
}
