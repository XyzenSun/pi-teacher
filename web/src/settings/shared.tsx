import { useState, type ReactNode } from "react";

/** 管理面板各子页共用的小部件：状态筛选条、错误提示、简单表单弹层。 */

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

export function ErrorLine({ error }: { error: string | null }) {
  return error ? <div className="text-[13px] text-error">{error}</div> : null;
}

export function Modal({ title, onClose, children, width = 560 }: { title: string; onClose: () => void; children: ReactNode; width?: number }) {
  return (
    <div className="fixed inset-0 z-40 bg-primary/30 backdrop-blur-[2px] flex items-center justify-center" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="card p-6 space-y-4 max-h-[90vh] overflow-y-auto" style={{ width }}>
        <div className="flex items-center justify-between">
          <h2 className="font-reading text-[20px] text-primary">{title}</h2>
          <button type="button" className="icon text-[20px] text-muted hover:text-on-surface" onClick={onClose}>close</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-muted block">{hint}</span>}
    </label>
  );
}

/** 表单通用提交状态：busy + error，避免每个表单各写一套。 */
export function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await operation(); } catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败"); throw cause; } finally { setBusy(false); }
  };
  return { busy, error, setError, run };
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("zh-CN", { hour12: false });
}
