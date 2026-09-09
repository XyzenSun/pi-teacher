import { useCallback, useEffect, useState } from "react";
import { glossaryApi } from "../api/client.ts";
import type { GlossaryTerm } from "../api/types.ts";
import { ErrorLine, Field, formatDate, Modal, StatusChip, StatusFilterBar, useSubmit, type StatusFilter } from "./shared.tsx";

function TermForm({ initial, title, onSubmit, onClose }: { initial: { term: string; definition: string }; title: string; onSubmit: (state: { term: string; definition: string }) => Promise<void>; onClose: () => void }) {
  const [state, setState] = useState(initial);
  const { busy, error, run } = useSubmit();
  return (
    <Modal title={title} onClose={onClose}>
      <Field label="术语"><input className="input" value={state.term} onChange={(event) => setState({ ...state, term: event.target.value })} /></Field>
      <Field label="定义"><textarea className="input" rows={5} value={state.definition} onChange={(event) => setState({ ...state, definition: event.target.value })} /></Field>
      <ErrorLine error={error} />
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onClose}>取消</button>
        <button type="button" className="btn-primary" disabled={busy || !state.term.trim() || !state.definition.trim()} onClick={() => void run(() => onSubmit(state)).then(onClose).catch(() => {})}>保存</button>
      </div>
    </Modal>
  );
}

export function GlossaryTab() {
  const [status, setStatus] = useState<StatusFilter>("all");
  const [terms, setTerms] = useState<GlossaryTerm[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<GlossaryTerm | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try { setTerms((await glossaryApi.list(status)).terms); setError(null); } catch (cause) { setError(cause instanceof Error ? cause.message : "加载失败"); }
  }, [status]);
  useEffect(() => { void load(); }, [load]);

  const act = async (operation: () => Promise<unknown>) => {
    try { await operation(); await load(); } catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败"); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <StatusFilterBar value={status} onChange={setStatus} />
        <button type="button" className="btn-primary" onClick={() => setCreating(true)}><span className="icon text-[16px]">add</span>新建术语</button>
      </div>
      <ErrorLine error={error} />
      <div className="card divide-y divide-line">
        {terms.length === 0 && <div className="p-8 text-center text-[13px] text-muted">没有符合条件的术语</div>}
        {terms.map((term) => (
          <div key={term.id} className="p-4 flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="font-semibold text-primary">{term.term}</span>
                <StatusChip status={term.status} />
                <span className="text-[11px] text-muted font-mono">#{term.id} · {formatDate(term.created_at)}</span>
              </div>
              <div className="text-[13px] text-on-surface-variant whitespace-pre-wrap">{term.definition}</div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {term.status === "proposed" && <>
                <button type="button" className="btn-secondary py-1" onClick={() => void act(() => glossaryApi.confirm(term.id))}>确认</button>
                <button type="button" className="btn-danger py-1" onClick={() => void act(() => glossaryApi.reject(term.id))}>拒绝</button>
              </>}
              {term.status !== "deleted" && <button type="button" className="btn-ghost py-1" onClick={() => setEditing(term)}>编辑</button>}
              {term.status === "normal" && <button type="button" className="btn-danger py-1" onClick={() => void act(() => glossaryApi.remove(term.id))}>删除</button>}
              {term.status === "deleted" && <button type="button" className="btn-outline py-1" onClick={() => void act(() => glossaryApi.restore(term.id))}>恢复</button>}
            </div>
          </div>
        ))}
      </div>
      {creating && <TermForm title="新建术语" initial={{ term: "", definition: "" }} onClose={() => setCreating(false)} onSubmit={async (state) => { await glossaryApi.create(state); await load(); }} />}
      {editing && <TermForm title={`编辑「${editing.term}」`} initial={{ term: editing.term, definition: editing.definition }} onClose={() => setEditing(null)} onSubmit={async (state) => { await glossaryApi.update(editing.id, state); await load(); }} />}
    </div>
  );
}
