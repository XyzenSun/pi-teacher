/** 管理面板各子页共用的小部件：状态筛选条、状态徽标、日期格式化。Modal / Field 等统一在 ../ui/，避免两套视觉语义。 */

export type StatusFilter = "all" | "proposed" | "normal" | "deleted";

export const STATUS_LABEL: Record<StatusFilter, string> = { all: "全部", proposed: "待审批", normal: "正常", deleted: "回收站" };

export function StatusFilterBar({ value, onChange, counts }: { value: StatusFilter; onChange: (next: StatusFilter) => void; counts?: Partial<Record<StatusFilter, number>> }) {
  return (
    <div className="flex gap-1 p-1 rounded-lg bg-surface-container w-fit">
      {(Object.keys(STATUS_LABEL) as StatusFilter[]).map((key) => (
        <button key={key} type="button" className={`px-3 py-1 rounded-md text-[13px] ${value === key ? "bg-surface-container-lowest shadow-sm text-primary font-medium" : "text-on-surface-variant"}`} onClick={() => onChange(key)}>
          {STATUS_LABEL[key]}{counts?.[key] !== undefined && <span className="ml-1 font-mono text-[11px] text-muted">{counts[key]}</span>}
        </button>
      ))}
    </div>
  );
}

export function StatusChip({ status }: { status: string }) {
  const tone = status === "normal" ? "bg-secondary-container text-on-secondary-container" : status === "proposed" ? "bg-tertiary-container text-on-tertiary-container" : "bg-surface-container-high text-on-surface-variant";
  return <span className={`chip ${tone}`}>{STATUS_LABEL[status as StatusFilter] ?? status}</span>;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("zh-CN", { hour12: false });
}
