import { useCallback, useEffect, useState } from "react";
import { cardsApi } from "../api/client.ts";
import type { Card, Topic } from "../api/types.ts";
import { Markdown } from "../chat/Markdown.tsx";
import { ErrorLine, Field, formatDate, Modal, StatusChip, StatusFilterBar, useSubmit, type StatusFilter } from "./shared.tsx";

interface CardFormState { topicId: number | null; front: string; back: string; reasonAndRemark: string }

function CardForm({ topics, initial, title, onSubmit, onClose }: { topics: Topic[]; initial: CardFormState; title: string; onSubmit: (state: CardFormState) => Promise<void>; onClose: () => void }) {
  const [state, setState] = useState(initial);
  const { busy, error, run } = useSubmit();
  return (
    <Modal title={title} onClose={onClose}>
      <Field label="Topic">
        <select className="input" value={state.topicId ?? ""} onChange={(event) => setState({ ...state, topicId: event.target.value ? Number(event.target.value) : null })}>
          <option value="">选择 Topic…</option>
          {topics.map((topic) => <option key={topic.id} value={topic.id}>{topic.name}</option>)}
        </select>
      </Field>
      <Field label="正面（问题）"><textarea className="input font-mono" rows={4} value={state.front} onChange={(event) => setState({ ...state, front: event.target.value })} /></Field>
      <Field label="背面（答案）"><textarea className="input font-mono" rows={6} value={state.back} onChange={(event) => setState({ ...state, back: event.target.value })} /></Field>
      <Field label="备注（可选）"><textarea className="input" rows={2} value={state.reasonAndRemark} onChange={(event) => setState({ ...state, reasonAndRemark: event.target.value })} /></Field>
      <ErrorLine error={error} />
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onClose}>取消</button>
        <button type="button" className="btn-primary" disabled={busy || state.topicId === null || !state.front.trim() || !state.back.trim()} onClick={() => void run(() => onSubmit(state)).then(onClose).catch(() => {})}>保存</button>
      </div>
    </Modal>
  );
}

export function CardsTab({ topics }: { topics: Topic[] }) {
  const [status, setStatus] = useState<StatusFilter>("all");
  const [topicId, setTopicId] = useState<number | null>(null);
  const [cards, setCards] = useState<Card[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Card | null>(null);
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const load = useCallback(async () => {
    try { setCards((await cardsApi.list({ status, topicId })).cards); setError(null); } catch (cause) { setError(cause instanceof Error ? cause.message : "加载失败"); }
  }, [status, topicId]);
  useEffect(() => { void load(); }, [load]);

  const act = async (operation: () => Promise<unknown>) => {
    try { await operation(); await load(); } catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败"); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <StatusFilterBar value={status} onChange={setStatus} />
          <select className="input w-auto" value={topicId ?? ""} onChange={(event) => setTopicId(event.target.value ? Number(event.target.value) : null)}>
            <option value="">全部 Topic</option>
            {topics.map((topic) => <option key={topic.id} value={topic.id}>{topic.name}</option>)}
          </select>
        </div>
        <button type="button" className="btn-primary" onClick={() => setCreating(true)}><span className="icon text-[16px]">add</span>新建卡片</button>
      </div>
      <ErrorLine error={error} />
      <div className="card divide-y divide-line">
        {cards.length === 0 && <div className="p-8 text-center text-[13px] text-muted">没有符合条件的卡片</div>}
        {cards.map((card) => {
          const open = expanded.has(card.id);
          return (
            <div key={card.id} className="p-4 space-y-2">
              <div className="flex items-start gap-3">
                <button type="button" className="icon text-[18px] text-muted mt-0.5" onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(card.id)) next.delete(card.id); else next.add(card.id); return next; })}>{open ? "expand_more" : "chevron_right"}</button>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <StatusChip status={card.status} />
                    <span className="chip bg-surface-container">{card.topic_name}</span>
                    <span className="text-[11px] text-muted font-mono">#{card.id} · {formatDate(card.created_at)}</span>
                    {card.schedule_state && <span className="text-[11px] text-muted">复习：{card.schedule_state}，到期 {formatDate(card.schedule_due)}，reps {card.schedule_reps}，lapses {card.schedule_lapses}</span>}
                  </div>
                  <div className="text-[14px]"><Markdown text={card.front} /></div>
                  {open && (
                    <div className="mt-2 rounded-md bg-surface-container-low p-3 text-[14px] space-y-2">
                      <Markdown text={card.back} />
                      {card.reason_and_remark && <div className="text-[12px] text-muted border-t border-line pt-2">{card.reason_and_remark}</div>}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {card.status === "proposed" && <>
                    <button type="button" className="btn-secondary py-1" onClick={() => void act(() => cardsApi.confirm(card.id))}>确认</button>
                    <button type="button" className="btn-danger py-1" onClick={() => void act(() => cardsApi.reject(card.id))}>拒绝</button>
                  </>}
                  {card.status !== "deleted" && <button type="button" className="btn-ghost py-1" onClick={() => setEditing(card)}>编辑</button>}
                  {card.status === "normal" && <button type="button" className="btn-danger py-1" onClick={() => { if (confirm("移入回收站？复习进度会保留。")) void act(() => cardsApi.remove(card.id)); }}>删除</button>}
                  {card.status === "deleted" && <button type="button" className="btn-outline py-1" onClick={() => void act(() => cardsApi.restore(card.id))}>恢复</button>}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {creating && (
        <CardForm topics={topics} title="新建卡片（直接生效）" initial={{ topicId: topicId ?? topics[0]?.id ?? null, front: "", back: "", reasonAndRemark: "" }} onClose={() => setCreating(false)}
          onSubmit={async (state) => { await cardsApi.create({ topicId: state.topicId!, front: state.front, back: state.back, reasonAndRemark: state.reasonAndRemark || null }); await load(); }} />
      )}
      {editing && (
        <CardForm topics={topics} title={`编辑卡片 #${editing.id}`} initial={{ topicId: editing.topic_id, front: editing.front, back: editing.back, reasonAndRemark: editing.reason_and_remark ?? "" }} onClose={() => setEditing(null)}
          onSubmit={async (state) => { await cardsApi.update(editing.id, { topicId: state.topicId!, front: state.front, back: state.back, reasonAndRemark: state.reasonAndRemark || null }); await load(); }} />
      )}
    </div>
  );
}
