import { useState } from "react";
import { topicsApi } from "../api/client.ts";
import type { Topic } from "../api/types.ts";
import { formatDate } from "./shared.tsx";
import { ErrorLine, Field, useSubmit } from "../ui/form.tsx";
import { Modal } from "../ui/Overlays.tsx";

interface TopicFormState { name: string; description: string; requestRetention: string; maximumInterval: string }

/** FSRS 参数留空表示沿用全局默认，因此空串必须转成 null 而不是 0。 */
function toNumberOrNull(value: string): number | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : Number(trimmed);
}

function TopicForm({ initial, title, onSubmit, onClose }: { initial: TopicFormState; title: string; onSubmit: (state: TopicFormState) => Promise<void>; onClose: () => void }) {
  const [state, setState] = useState(initial);
  const { busy, error, run } = useSubmit();
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn-ghost" onClick={onClose}>取消</button>
          <button type="button" className="btn-primary" disabled={busy || !state.name.trim()} onClick={() => void run(() => onSubmit(state)).then(onClose).catch(() => {})}>保存</button>
        </>
      }
    >
      <div className="space-y-3">
      <Field label="名称"><input className="input" value={state.name} onChange={(event) => setState({ ...state, name: event.target.value })} /></Field>
      <Field label="简介（可选）"><textarea className="input" rows={3} value={state.description} onChange={(event) => setState({ ...state, description: event.target.value })} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="目标保留率" hint="0.5–0.99，留空用全局默认">
          <input className="input font-mono" inputMode="decimal" placeholder="0.9" value={state.requestRetention} onChange={(event) => setState({ ...state, requestRetention: event.target.value })} />
        </Field>
        <Field label="最大间隔（天）" hint="≥1 的整数，留空用全局默认">
          <input className="input font-mono" inputMode="numeric" placeholder="36500" value={state.maximumInterval} onChange={(event) => setState({ ...state, maximumInterval: event.target.value })} />
        </Field>
      </div>
      <ErrorLine error={error} />
      </div>
    </Modal>
  );
}

export function TopicsTab({ topics, onChanged }: { topics: Topic[]; onChanged: () => void }) {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Topic | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-[13px] text-on-surface-variant">Topic 是卡片的归属单位，也决定复习调度参数；Topic 不可删除，以保证历史卡片可追溯。</p>
        <button type="button" className="btn-primary" onClick={() => setCreating(true)}><span className="icon text-[16px]">add</span>新建 Topic</button>
      </div>
      <ErrorLine error={error} />
      <div className="card overflow-hidden">
        <table className="w-full text-[13px]">
          <thead className="bg-surface-container-low text-on-surface-variant">
            <tr>
              <th className="text-left px-4 py-2 font-medium">名称</th>
              <th className="text-left px-4 py-2 font-medium">简介</th>
              <th className="text-right px-4 py-2 font-medium">正常卡</th>
              <th className="text-right px-4 py-2 font-medium">待审批</th>
              <th className="text-right px-4 py-2 font-medium">到期</th>
              <th className="text-right px-4 py-2 font-medium">保留率</th>
              <th className="text-right px-4 py-2 font-medium">最大间隔</th>
              <th className="text-left px-4 py-2 font-medium">创建时间</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {topics.length === 0 && <tr><td colSpan={9} className="px-4 py-8 text-center text-muted">还没有 Topic，模型在学习中也可以自行创建。</td></tr>}
            {topics.map((topic) => (
              <tr key={topic.id}>
                <td className="px-4 py-2 font-medium text-primary">{topic.name}</td>
                <td className="px-4 py-2 text-on-surface-variant max-w-[280px] truncate">{topic.description ?? "—"}</td>
                <td className="px-4 py-2 text-right font-mono">{topic.card_count ?? 0}</td>
                <td className="px-4 py-2 text-right font-mono">{topic.proposed_count ?? 0}</td>
                <td className="px-4 py-2 text-right font-mono text-tertiary">{topic.due_count ?? 0}</td>
                <td className="px-4 py-2 text-right font-mono">{topic.request_retention ?? "默认"}</td>
                <td className="px-4 py-2 text-right font-mono">{topic.maximum_interval ?? "默认"}</td>
                <td className="px-4 py-2 text-muted">{formatDate(topic.created_at)}</td>
                <td className="px-4 py-2 text-right"><button type="button" className="btn-ghost py-1" onClick={() => setEditing(topic)}>编辑</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {creating && (
        <TopicForm title="新建 Topic" initial={{ name: "", description: "", requestRetention: "", maximumInterval: "" }} onClose={() => setCreating(false)}
          onSubmit={async (state) => {
            await topicsApi.create({ name: state.name.trim(), description: state.description.trim() || null, requestRetention: toNumberOrNull(state.requestRetention), maximumInterval: toNumberOrNull(state.maximumInterval) });
            onChanged();
            setError(null);
          }} />
      )}
      {editing && (
        <TopicForm title={`编辑「${editing.name}」`} initial={{ name: editing.name, description: editing.description ?? "", requestRetention: editing.request_retention === null ? "" : String(editing.request_retention), maximumInterval: editing.maximum_interval === null ? "" : String(editing.maximum_interval) }} onClose={() => setEditing(null)}
          onSubmit={async (state) => {
            await topicsApi.update(editing.id, { name: state.name.trim(), description: state.description.trim() || null, requestRetention: toNumberOrNull(state.requestRetention), maximumInterval: toNumberOrNull(state.maximumInterval) });
            onChanged();
            setError(null);
          }} />
      )}
    </div>
  );
}
