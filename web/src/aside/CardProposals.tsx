import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { cardsApi } from "../api/client.ts";
import type { Card } from "../api/types.ts";
import { Markdown } from "../chat/Markdown.tsx";
import { useWorkspace } from "../app/WorkspaceContext.tsx";

/**
 * 提议池是全局状态：展示所有 proposed 卡片并可按 Topic 过滤，
 * 不声称卡片来自当前对话（后端不记录来源会话）。
 */
export function CardProposals({ refreshToken }: { refreshToken: number }) {
  const { topics, refresh } = useWorkspace();
  const [cards, setCards] = useState<Card[]>([]);
  const [topicId, setTopicId] = useState<number | null>(null);
  const [flipped, setFlipped] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setCards((await cardsApi.list({ status: "proposed", topicId })).cards); setError(null); } catch (cause) { setError(cause instanceof Error ? cause.message : "加载失败"); }
  }, [topicId]);

  useEffect(() => { void load(); }, [load, refreshToken]);

  const act = async (card: Card, action: "confirm" | "reject") => {
    try {
      await (action === "confirm" ? cardsApi.confirm(card.id) : cardsApi.reject(card.id));
      setCards((current) => current.filter((item) => item.id !== card.id));
      void refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败");
    }
  };

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div className="px-4 py-2.5 border-b border-line flex items-center justify-between gap-2">
        <span className="label">待审批卡片 <span className="font-mono text-tertiary">{cards.length}</span></span>
        <div className="flex items-center gap-1">
          <select className="input w-auto py-0.5 text-[11px]" value={topicId ?? ""} onChange={(event) => setTopicId(event.target.value ? Number(event.target.value) : null)}>
            <option value="">全部 Topic</option>
            {topics.map((topic) => <option key={topic.id} value={topic.id}>{topic.name}</option>)}
          </select>
          <Link to="/settings?tab=cards" className="icon text-[16px] text-muted hover:text-secondary" title="到管理面板查看全部卡片">open_in_new</Link>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {error && <div className="text-[12px] text-error">{error}</div>}
        {cards.length === 0 && !error && <div className="text-[12px] text-muted text-center py-6">没有待审批的卡片</div>}
        {cards.map((card) => {
          const showBack = flipped.has(card.id);
          return (
            <div key={card.id} className="card p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="chip bg-secondary-container text-on-secondary-container">{card.topic_name}</span>
                <button type="button" className="text-[11px] text-secondary hover:underline" onClick={() => setFlipped((current) => { const next = new Set(current); if (next.has(card.id)) next.delete(card.id); else next.add(card.id); return next; })}>
                  {showBack ? "看正面" : "看背面"}
                </button>
              </div>
              <div className="text-[13px] min-h-[40px]">
                <Markdown text={showBack ? card.back : card.front} />
              </div>
              {card.reason_and_remark && <div className="text-[11px] text-muted border-l-2 border-line pl-2">{card.reason_and_remark}</div>}
              <div className="flex justify-end gap-1">
                <button type="button" className="btn-danger py-1 text-[12px]" onClick={() => void act(card, "reject")}>拒绝</button>
                <button type="button" className="btn-secondary py-1 text-[12px]" onClick={() => void act(card, "confirm")}>确认</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
