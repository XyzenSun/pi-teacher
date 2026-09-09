/** 管理面板各子页共用的小部件：状态筛选条、状态徽标、日期格式化。 */

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

/** 新代码请从 ../ui/form.tsx 与 ../ui/Overlays.tsx 引入，旧 settings tab 仍保留此兼容出口。 */
export { ErrorLine, Field, useSubmit } from "../ui/form.tsx";
export { Modal } from "../ui/Overlays.tsx";
export type { ModalSize } from "../ui/Overlays.tsx";

/**
 * Modal、Field 等实现统一在 ui 目录，避免 settings 与工作区出现两套视觉语义。
 * 本文件只保留状态类组件、日期格式化和旧 import 的 re-export。
 */

