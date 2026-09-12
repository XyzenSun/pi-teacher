import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { cardsApi } from "../api/client.ts";
import type { Card } from "../api/types.ts";
import { Markdown } from "../chat/Markdown.tsx";
import { useWorkspace } from "../app/WorkspaceContext.tsx";
import { overlayPath, useWorkspaceRoute } from "../app/overlay-routes.ts";

/**
 * 提议池是全局状态：展示所有 proposed 卡片并可按 Topic 过滤，
 * 不声称卡片来自当前对话（后端不记录来源会话）。
 *
 * 单卡浏览而非纵向列表：一次只看一张能让人真正读完正反面再判断。
 * 索引与翻面的重置规则集中在下面几处 setState，避免出现「看到上一张的背面」。
 */
export function CardProposals({ refreshToken }: { refreshToken: number }) {
  const { topics, refresh } = useWorkspace();
  const { basePath } = useWorkspaceRoute();
  const [cards, setCards] = useState<Card[]>([]);
  const [topicId, setTopicId] = useState<number | null>(null);
  const [index, setIndex] = useState(0);
  const [showBack, setShowBack] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await cardsApi.list({ status: "proposed", topicId });
      setCards(result.cards);
      // 池子变化后索引可能越界（例如别处确认了卡片），夹到合法范围。
      setIndex((current) => Math.min(current, Math.max(0, result.cards.length - 1)));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [topicId]);

  useEffect(() => { void load(); }, [load, refreshToken]);
  // 切 Topic 等于换了一叠卡：回到第一张的正面。
  useEffect(() => { setIndex(0); setShowBack(false); }, [topicId]);
  // 换卡一律回到正面。
  useEffect(() => { setShowBack(false); }, [index]);

  const current = cards[index] ?? null;

  const act = async (card: Card, action: "confirm" | "reject") => {
    try {
      await (action === "confirm" ? cardsApi.confirm(card.id) : cardsApi.reject(card.id));
      setCards((remaining) => {
        const next = remaining.filter((item) => item.id !== card.id);
        // 索引停在原位以自然显示下一张；处理的是最后一张时回退到新的末位。
        setIndex((currentIndex) => Math.min(currentIndex, Math.max(0, next.length - 1)));
        return next;
      });
      setShowBack(false);
      void refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败");
    }
  };

  return (
    <div className="h-[38%] shrink-0 flex flex-col border-b border-line bg-surface-container-lowest/80">
      <div className="h-11 shrink-0 px-3 border-b border-line flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="icon text-[16px] text-secondary">approval_delegation</span>
          <span className="label truncate">待审批卡片</span>
          {cards.length > 0 && (
            <span className="chip bg-secondary-container text-on-secondary-container font-mono">{index + 1} / {cards.length}</span>
          )}
        </span>
        <div className="flex items-center gap-1 shrink-0">
          <select className="input w-auto py-0.5 text-[11px]" value={topicId ?? ""} title="按 Topic 过滤" onChange={(event) => setTopicId(event.target.value ? Number(event.target.value) : null)}>
            <option value="">全部 Topic</option>
            {topics.map((topic) => <option key={topic.id} value={topic.id}>{topic.name}</option>)}
          </select>
          <Link to={overlayPath(basePath, "settings", "?tab=cards")} className="icon text-[16px] text-muted hover:text-secondary" title="到管理面板查看全部卡片">open_in_full</Link>
        </div>
      </div>

      <div className="flex-1 min-h-0 p-3 flex flex-col gap-2">
        {error && <div className="text-[12px] text-error shrink-0">{error}</div>}

        {loading && cards.length === 0 && <div className="flex-1 flex items-center justify-center text-[12px] text-muted">正在加载提议卡片…</div>}

        {!loading && !current && !error && (
          <div className="flex-1 flex flex-col items-center justify-center gap-1 text-center">
            <span className="icon text-[28px] text-outline-variant">inbox</span>
            <div className="text-[12px] text-muted">没有待审批的卡片</div>
            <div className="text-[11px] text-muted">开启制卡后，老师会在学习中提议卡片，出现在这里等你确认。</div>
          </div>
        )}

        {current && (
          <>
            <button
              type="button"
              className="card flex-1 min-h-0 p-3 text-left flex flex-col gap-2 hover:border-outline-variant transition-colors"
              title={showBack ? "点击看正面" : "点击看背面"}
              onClick={() => setShowBack((value) => !value)}
            >
              <span className="flex items-center justify-between gap-2 shrink-0">
                <span className="chip bg-secondary-container text-on-secondary-container truncate">{current.topic_name}</span>
                <span className="text-[10px] font-mono uppercase tracking-wider text-muted">{showBack ? "背面" : "正面"}</span>
              </span>
              <span className="flex-1 min-h-0 overflow-y-auto text-[13px]">
                <Markdown text={showBack ? current.back : current.front} />
                {showBack && current.reason_and_remark && (
                  <span className="block mt-2 text-[11px] text-muted border-l-2 border-line pl-2">{current.reason_and_remark}</span>
                )}
              </span>
            </button>

            <div className="shrink-0 flex items-center justify-between gap-2">
              <div className="flex items-center gap-1">
                <button type="button" className="icon text-[18px] text-muted hover:text-secondary disabled:opacity-30 disabled:hover:text-muted" title="上一张" disabled={index === 0} onClick={() => setIndex((value) => Math.max(0, value - 1))}>chevron_left</button>
                <button type="button" className="icon text-[18px] text-muted hover:text-secondary disabled:opacity-30 disabled:hover:text-muted" title="下一张" disabled={index >= cards.length - 1} onClick={() => setIndex((value) => Math.min(cards.length - 1, value + 1))}>chevron_right</button>
                <button type="button" className="text-[11px] text-secondary hover:underline ml-1" onClick={() => setShowBack((value) => !value)}>{showBack ? "看正面" : "看背面"}</button>
              </div>
              <div className="flex items-center gap-1">
                <button type="button" className="btn-danger py-1 text-[12px]" onClick={() => void act(current, "reject")}>拒绝</button>
                <button type="button" className="btn-secondary py-1 text-[12px]" onClick={() => void act(current, "confirm")}>确认</button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
