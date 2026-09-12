import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * 全局通用组件：Modal / InlineEdit / ConfirmDialog。
 *
 * 从 settings/shared.tsx 提升到这里，是因为对话重命名、Space 重命名与删除确认
 * 都需要同一套页面内交互——原来这些位置用的是 window.prompt / confirm / alert，
 * 既不符合 Atelier Mind 视觉，也无法被浏览器验收脚本稳定驱动。
 */

export type ModalSize = "sm" | "md" | "lg" | "xl";

const MODAL_WIDTH: Record<ModalSize, string> = {
  sm: "w-[420px]",
  md: "w-[560px]",
  lg: "w-[760px]",
  xl: "w-[min(1040px,92vw)]",
};

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  size?: ModalSize;
  /** 页脚区域（按钮组）；不传则不渲染分隔线。 */
  footer?: ReactNode;
  subtitle?: string;
  /** 头部右侧附加内容，如状态标签。 */
  headerExtra?: ReactNode;
  /** 头部下方的固定条（如 tab 栏），不随内容滚动。 */
  toolbar?: ReactNode;
  bodyClassName?: string;
}

/**
 * Esc 关闭 + 点击遮罩关闭 + 关闭按钮，三种方式都可用。
 * 外层留 `p-6`，使覆盖层不铺满全屏，工作区背景保持可见。
 */
export function Modal({ title, subtitle, onClose, children, size = "md", footer, headerExtra, toolbar, bodyClassName }: ModalProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-primary/25 backdrop-blur-[2px] p-6"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className={`card flex flex-col max-h-[86vh] ${MODAL_WIDTH[size]}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="shrink-0 flex items-start justify-between gap-4 px-6 py-4 border-b border-line">
          <div className="min-w-0">
            <h2 className="font-reading text-[20px] text-primary truncate">{title}</h2>
            {subtitle && <p className="text-[12px] text-on-surface-variant mt-0.5">{subtitle}</p>}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {headerExtra}
            <button type="button" className="icon text-[20px] text-muted hover:text-on-surface" title="关闭" onClick={onClose}>close</button>
          </div>
        </header>
        {toolbar && <div className="shrink-0 border-b border-line px-4 overflow-x-auto">{toolbar}</div>}
        <div className={`flex-1 min-h-0 overflow-y-auto px-6 py-5 ${bodyClassName ?? ""}`}>{children}</div>
        {footer && <footer className="shrink-0 flex items-center justify-end gap-2 px-6 py-4 border-t border-line">{footer}</footer>}
      </div>
    </div>
  );
}

interface InlineEditProps {
  value: string;
  onSubmit: (next: string) => Promise<void> | void;
  /** 触发区渲染：未编辑时显示的内容。 */
  children: ReactNode;
  placeholder?: string;
  maxLength?: number;
  title?: string;
  inputClassName?: string;
  /** 编辑入口图标按钮的额外类名。 */
  buttonClassName?: string;
}

/**
 * 原地重命名：点击铅笔进入输入态，Enter 提交、Esc 取消、失焦提交。
 * 输入法合成期间的 Enter 不提交（与 ChatInput 同一套判据）。
 */
export function InlineEdit({ value, onSubmit, children, placeholder, maxLength = 100, title = "重命名", inputClassName, buttonClassName }: InlineEditProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const composingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  const commit = async () => {
    if (busy) return;
    const next = draft.trim();
    if (!next || next === value) { setEditing(false); setDraft(value); return; }
    setBusy(true);
    try {
      await onSubmit(next);
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <span className="min-w-0 flex items-center gap-1.5">
        {children}
        <button
          type="button"
          className={`icon text-[16px] text-muted hover:text-secondary shrink-0 ${buttonClassName ?? ""}`}
          title={title}
          onClick={(event) => { event.stopPropagation(); setEditing(true); }}
        >
          edit
        </button>
      </span>
    );
  }

  return (
    <input
      ref={inputRef}
      className={`input py-1 ${inputClassName ?? "max-w-[320px]"}`}
      value={draft}
      autoFocus
      disabled={busy}
      maxLength={maxLength}
      placeholder={placeholder}
      aria-label={title}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => setDraft(event.target.value)}
      onCompositionStart={() => { composingRef.current = true; }}
      onCompositionEnd={() => { composingRef.current = false; }}
      onBlur={() => void commit()}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); setDraft(value); setEditing(false); return; }
        if (event.key !== "Enter") return;
        if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        void commit();
      }}
    />
  );
}

interface ConfirmDialogProps {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/** 替代 window.confirm：删除类操作的破坏性后果必须写清楚。 */
export function ConfirmDialog({ title, message, confirmLabel = "确认", cancelLabel = "取消", danger, busy, error, onConfirm, onCancel }: ConfirmDialogProps) {
  return (
    <Modal
      title={title}
      size="sm"
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn-ghost" disabled={busy} onClick={onCancel}>{cancelLabel}</button>
          <button type="button" className={danger ? "btn-danger" : "btn-primary"} disabled={busy} onClick={onConfirm}>
            {busy ? "处理中…" : confirmLabel}
          </button>
        </>
      }
    >
      <div className="space-y-2 text-[13px] text-on-surface">
        {message}
        {error && <div className="text-[13px] text-error">{error}</div>}
      </div>
    </Modal>
  );
}
