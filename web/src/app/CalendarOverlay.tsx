import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { reviewScheduleApi } from "../api/client.ts";
import type { ReviewScheduleResponse } from "../api/types.ts";
import { useWorkspace } from "./WorkspaceContext.tsx";
import { useWorkspaceRoute } from "./overlay-routes.ts";
import { ErrorLine } from "../ui/form.tsx";
import { Modal } from "../ui/Overlays.tsx";

/**
 * 学习日历：只呈现 card_schedule / review_log 能确定性算出的数据。
 *
 * 刻意不做「连续打卡」「平均留存率」「预计用时」——它们没有真实数据支撑。
 * 后端按 UTC 日期分组，这里也按 UTC 渲染日期并明确标注，避免跨时区错位。
 */

const UPCOMING_DAYS = 28;
const HISTORY_DAYS = 28;

/** 把稀疏的日期聚合补齐成连续序列，让柱状图的空白天真实呈现为 0 而不是被压缩掉。 */
function buildDenseSeries(startDate: string, days: number, counts: Map<string, number>): Array<{ date: string; count: number }> {
  const start = new Date(`${startDate}T00:00:00Z`);
  const series: Array<{ date: string; count: number }> = [];
  for (let offset = 0; offset < days; offset += 1) {
    const day = new Date(start.getTime() + offset * 86_400_000);
    const key = day.toISOString().slice(0, 10);
    series.push({ date: key, count: counts.get(key) ?? 0 });
  }
  return series;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function shiftUtcDate(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

function weekdayLabel(date: string): string {
  return ["日", "一", "二", "三", "四", "五", "六"][new Date(`${date}T00:00:00Z`).getUTCDay()];
}

function BarRow({ series, max, tone, emptyText, formatTitle }: {
  series: Array<{ date: string; count: number }>;
  max: number;
  tone: string;
  emptyText: string;
  formatTitle: (item: { date: string; count: number }) => string;
}) {
  if (max === 0) return <div className="text-[13px] text-muted py-6 text-center">{emptyText}</div>;
  return (
    <div className="flex items-end gap-[3px] h-28">
      {series.map((item) => (
        <div key={item.date} className="flex-1 flex flex-col items-center gap-1 min-w-0" title={formatTitle(item)}>
          <div className="w-full flex-1 flex items-end">
            {/* 高度按最大值归一；0 也保留 2px 让「有这一天但没有量」可见 */}
            <div className={`w-full rounded-t ${item.count ? tone : "bg-surface-container"}`} style={{ height: item.count ? `${Math.max(6, (item.count / max) * 100)}%` : "2px" }} />
          </div>
          <span className="text-[9px] text-muted font-mono truncate">{item.date.slice(8)}</span>
        </div>
      ))}
    </div>
  );
}

export function CalendarOverlay() {
  const navigate = useNavigate();
  const { basePath } = useWorkspaceRoute();
  const { topics } = useWorkspace();
  const [topicId, setTopicId] = useState<number | null>(null);
  const [data, setData] = useState<ReviewScheduleResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await reviewScheduleApi.get({ upcomingDays: UPCOMING_DAYS, historyDays: HISTORY_DAYS, topicId }));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载失败");
    }
  }, [topicId]);
  useEffect(() => { void load(); }, [load]);

  const upcomingSeries = useMemo(() => {
    if (!data) return [];
    return buildDenseSeries(todayUtc(), data.range.upcomingDays, new Map(data.upcoming.map((item) => [item.date, item.dueCount])));
  }, [data]);

  const historySeries = useMemo(() => {
    if (!data) return [];
    // 后端条件为 date(reviewed_at) > date('now', '-N days')，即最近 N 天（含今天）。
    return buildDenseSeries(shiftUtcDate(todayUtc(), -(data.range.historyDays - 1)), data.range.historyDays, new Map(data.history.map((item) => [item.date, item.reviewCount])));
  }, [data]);

  const historyByDate = useMemo(() => new Map((data?.history ?? []).map((item) => [item.date, item])), [data]);
  const upcomingMax = upcomingSeries.reduce((max, item) => Math.max(max, item.count), 0);
  const historyMax = historySeries.reduce((max, item) => Math.max(max, item.count), 0);
  const reviewTotal = (data?.history ?? []).reduce((sum, item) => sum + item.reviewCount, 0);

  return (
    <Modal
      title="学习日历"
      subtitle="日期按 UTC 分组，与调度时间一致；只展示可由复习记录复算的数据"
      size="lg"
      onClose={() => navigate(basePath)}
      headerExtra={
        <select className="input w-auto py-1 text-[12px]" value={topicId ?? ""} onChange={(event) => setTopicId(event.target.value ? Number(event.target.value) : null)}>
          <option value="">全部 Topic</option>
          {topics.map((topic) => <option key={topic.id} value={topic.id}>{topic.name}</option>)}
        </select>
      }
    >
      <ErrorLine error={error} />
      {!data && !error && <div className="text-[13px] text-muted">正在读取排期…</div>}
      {data && (
        <div className="space-y-6">
          <div className="grid grid-cols-5 gap-2">
            {[
              { label: "正常卡片", value: data.totals.normalCards, tone: "text-primary" },
              { label: "待审批", value: data.totals.proposedCards, tone: "text-tertiary" },
              { label: "现在到期", value: data.totals.dueNow, tone: "text-secondary" },
              { label: "已逾期", value: data.totals.overdue, tone: "text-error" },
              { label: "未排期", value: data.totals.withoutSchedule, tone: "text-muted" },
            ].map((item) => (
              <div key={item.label} className="card p-3 text-center">
                <div className={`font-mono text-[22px] ${item.tone}`}>{item.value}</div>
                <div className="text-[11px] text-on-surface-variant mt-0.5">{item.label}</div>
              </div>
            ))}
          </div>

          <section className="space-y-2">
            <div className="flex items-baseline justify-between">
              <h3 className="font-reading text-[17px] text-primary">未来 {data.range.upcomingDays} 天到期分布</h3>
              <span className="text-[11px] text-muted">逾期卡片不计入某一天，单独统计在上方「已逾期」</span>
            </div>
            <BarRow
              series={upcomingSeries}
              max={upcomingMax}
              tone="bg-secondary"
              emptyText="未来这段时间没有到期卡片。"
              formatTitle={(item) => `${item.date}（周${weekdayLabel(item.date)}）到期 ${item.count} 张`}
            />
          </section>

          <section className="space-y-2">
            <div className="flex items-baseline justify-between">
              <h3 className="font-reading text-[17px] text-primary">最近 {data.range.historyDays} 天复习记录</h3>
              <span className="text-[11px] text-muted font-mono">合计 {reviewTotal} 次</span>
            </div>
            <BarRow
              series={historySeries}
              max={historyMax}
              tone="bg-tertiary"
              emptyText="这段时间还没有复习记录。"
              formatTitle={(item) => {
                const detail = historyByDate.get(item.date);
                if (!detail) return `${item.date}（周${weekdayLabel(item.date)}）没有复习`;
                return `${item.date}（周${weekdayLabel(item.date)}）复习 ${detail.reviewCount} 次：Again ${detail.again} / Hard ${detail.hard} / Good ${detail.good} / Easy ${detail.easy}`;
              }}
            />
            {historyMax > 0 && (
              <div className="card divide-y divide-line max-h-[200px] overflow-y-auto">
                {[...data.history].reverse().map((item) => (
                  <div key={item.date} className="px-3 py-1.5 flex items-center justify-between text-[12px]">
                    <span className="font-mono text-on-surface-variant">{item.date} 周{weekdayLabel(item.date)}</span>
                    <span className="flex items-center gap-2 font-mono">
                      <span className="text-primary">{item.reviewCount} 次</span>
                      <span className="chip bg-error-container text-on-error-container">Again {item.again}</span>
                      <span className="chip bg-tertiary-container text-on-tertiary-container">Hard {item.hard}</span>
                      <span className="chip bg-secondary-container text-on-secondary-container">Good {item.good}</span>
                      <span className="chip bg-surface-container text-on-surface-variant">Easy {item.easy}</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}
