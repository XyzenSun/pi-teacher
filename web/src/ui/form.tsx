import { useState, type ReactNode } from "react";

/**
 * 表单通用部件：字段布局、错误行、busy+error 提交状态。
 * 从 settings/shared.tsx 提升为全局组件，settings 与新增的设置 tab 共用一套。
 */

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-muted block">{hint}</span>}
    </label>
  );
}

export function ErrorLine({ error }: { error: string | null }) {
  return error ? <div className="text-[13px] text-error">{error}</div> : null;
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
