import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { conversationsApi } from "../api/client.ts";
import type { Attachment, SlashCommand } from "../api/types.ts";
import { buildAtInsertText, buildEntriesFromFiles, extractAtQuery, filterFileEntries, type FileIndexEntry } from "../lib/file-fuzzy.ts";
import { parseNativeCommand } from "./native-commands.ts";

/** 草稿按对话 ID 存内存：切换会话再切回来不丢输入，刷新页面则按后端历史重建。 */
const drafts = new Map<number, string>();

/** 单次发送的附件数量上限，与后端 attachmentIds 的上限一致（附件不限类型）。 */
const MAX_ATTACHMENTS = 8;

interface ChatInputProps {
  conversationId: number;
  disabled: boolean;
  isRunning: boolean;
  commands: SlashCommand[];
  /** 输入卡片顶部的会话设定条（类型、制卡、教学风格）。 */
  controls?: ReactNode;
  /** 输入卡片底部工具行右侧的模型选择器。 */
  modelSelector?: ReactNode;
  onSend: (message: string, attachmentIds: string[]) => Promise<void>;
  onSteer: (message: string) => Promise<void>;
  /** 提交文本是原生命令（/compact 等）时走命令通道，不发 prompt 也不 steer。 */
  onNativeCommand: (name: string, args: string) => Promise<void>;
  onAbort: () => void;
}

export function ChatInput({ conversationId, disabled, isRunning, commands, controls, modelSelector, onSend, onSteer, onNativeCommand, onAbort }: ChatInputProps) {
  const [value, setValue] = useState(() => drafts.get(conversationId) ?? "");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<FileIndexEntry[]>([]);
  const [menuIndex, setMenuIndex] = useState(0);
  const [followUpMode, setFollowUpMode] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const compositionEndAtRef = useRef(0);
  const cursorRef = useRef(0);

  useEffect(() => {
    setValue(drafts.get(conversationId) ?? "");
    setAttachments([]);
    setError(null);
  }, [conversationId]);

  useEffect(() => {
    if (value) drafts.set(conversationId, value); else drafts.delete(conversationId);
  }, [conversationId, value]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 260)}px`;
  }, [value]);

  const textBeforeCursor = value.slice(0, cursorRef.current);
  const atQuery = useMemo(() => extractAtQuery(textBeforeCursor), [textBeforeCursor]);
  const slashQuery = useMemo(() => {
    const match = /^\/([^\s]*)$/.exec(value);
    return match ? match[1].toLowerCase() : null;
  }, [value]);

  useEffect(() => {
    if (!atQuery) return;
    let cancelled = false;
    void conversationsApi.fileIndex(conversationId, atQuery.query).then((result) => {
      if (!cancelled) setEntries(buildEntriesFromFiles(result.files));
    }).catch(() => { if (!cancelled) setEntries([]); });
    return () => { cancelled = true; };
  }, [atQuery?.query, atQuery, conversationId]);

  const fileSuggestions = useMemo(() => (atQuery ? filterFileEntries(entries, atQuery.query, 8) : []), [atQuery, entries]);
  const commandSuggestions = useMemo(() => (slashQuery === null ? [] : commands.filter((command) => command.name.toLowerCase().includes(slashQuery)).slice(0, 8)), [commands, slashQuery]);
  const menuOpen = fileSuggestions.length > 0 || commandSuggestions.length > 0;
  const menuLength = fileSuggestions.length || commandSuggestions.length;

  useEffect(() => { setMenuIndex(0); }, [atQuery?.query, slashQuery]);

  const applyFileSuggestion = useCallback((entry: FileIndexEntry) => {
    if (!atQuery) return;
    const insertion = buildAtInsertText(entry.path, entry.isDir, atQuery.quoted);
    const next = value.slice(0, atQuery.start) + insertion.text + value.slice(cursorRef.current);
    const caret = atQuery.start + insertion.cursorOffset;
    setValue(next);
    cursorRef.current = caret;
    requestAnimationFrame(() => { textareaRef.current?.focus(); textareaRef.current?.setSelectionRange(caret, caret); });
  }, [atQuery, value]);

  const applyCommand = useCallback((command: SlashCommand) => {
    const next = `/${command.name} `;
    setValue(next);
    cursorRef.current = next.length;
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  const uploadFiles = useCallback(async (files: File[]) => {
    setError(null);
    for (const file of files.slice(0, MAX_ATTACHMENTS - attachments.length)) {
      try {
        const result = await conversationsApi.upload(conversationId, file);
        setAttachments((current) => [...current, result.attachment]);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "上传失败");
      }
    }
  }, [attachments.length, conversationId]);

  const submit = useCallback(async () => {
    const message = value.trim();
    if (!message && attachments.length === 0) return;
    setBusy(true);
    setError(null);
    const attachmentIds = attachments.map((attachment) => attachment.id);
    try {
      // 原生命令优先于 prompt/steer 分流：否则运行中的 /compact 会被 steer 成字面文本发给模型
      const native = parseNativeCommand(message);
      if (native) {
        await onNativeCommand(native.name, native.args);
      } else if (isRunning && !followUpMode) {
        await onSteer(message);
      } else {
        await onSend(message, attachmentIds);
      }
      setValue("");
      setAttachments([]);
      drafts.delete(conversationId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "发送失败");
    } finally {
      setBusy(false);
    }
  }, [attachments, conversationId, followUpMode, isRunning, onSend, onSteer, onNativeCommand, value]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen && !composingRef.current) {
      if (event.key === "ArrowDown") { event.preventDefault(); setMenuIndex((index) => (index + 1) % menuLength); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); setMenuIndex((index) => (index - 1 + menuLength) % menuLength); return; }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
        event.preventDefault();
        if (fileSuggestions.length) applyFileSuggestion(fileSuggestions[menuIndex]);
        else if (commandSuggestions.length) applyCommand(commandSuggestions[menuIndex]);
        return;
      }
      if (event.key === "Escape") { event.preventDefault(); setEntries([]); return; }
    }
    if (event.key !== "Enter" || event.shiftKey) return;
    // 输入法保护：合成中、keyCode 229、以及刚结束合成的 100ms 内都不发送，
    // 否则中文候选词的回车会被当成提交（pi-web lib/ime 结论）。
    if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (Date.now() - compositionEndAtRef.current < 100) return;
    event.preventDefault();
    void submit();
  };

  const syncCursor = (event: React.SyntheticEvent<HTMLTextAreaElement>) => {
    cursorRef.current = event.currentTarget.selectionStart ?? 0;
  };

  return (
    <div className="px-5 pb-4 pt-2 bg-surface">
      <div className="mx-auto w-full max-w-reading input-floating p-2.5 space-y-1.5">
        {controls}

        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {attachments.map((attachment) => (
              <div key={attachment.id} className="flex items-center gap-1.5 rounded-md border border-line bg-surface-container-low px-2 py-1 text-[12px]">
                <span className="icon text-[14px] text-secondary">attach_file</span>
                <span className="max-w-[160px] truncate">{attachment.name}</span>
                <span className="text-muted">{Math.ceil(attachment.size / 1024)}KB</span>
                <button type="button" className="icon text-[14px] text-muted hover:text-error" title="移除附件" onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}>close</button>
              </div>
            ))}
          </div>
        )}

        {menuOpen && (
          <div className="card max-h-56 overflow-auto p-1">
            {fileSuggestions.map((entry, index) => (
              <button key={entry.path} type="button" className={`w-full text-left px-2 py-1 rounded text-[13px] font-mono flex items-center gap-2 ${index === menuIndex ? "bg-secondary-container text-on-secondary-container" : "hover:bg-surface-container"}`} onMouseDown={(event) => { event.preventDefault(); applyFileSuggestion(entry); }}>
                <span className="icon text-[14px]">{entry.isDir ? "folder" : "description"}</span>
                <span className="truncate">{entry.path}{entry.isDir ? "/" : ""}</span>
              </button>
            ))}
            {commandSuggestions.map((command, index) => (
              <button key={command.name} type="button" className={`w-full text-left px-2 py-1 rounded text-[13px] flex items-center gap-2 ${index === menuIndex ? "bg-secondary-container text-on-secondary-container" : "hover:bg-surface-container"}`} onMouseDown={(event) => { event.preventDefault(); applyCommand(command); }}>
                <span className="font-mono">/{command.name}</span>
                <span className="text-muted truncate">{command.description}</span>
              </button>
            ))}
          </div>
        )}

        {error && <div className="text-[12px] text-error px-1">{error}</div>}

        <textarea
          ref={textareaRef}
          className="w-full bg-transparent px-1 py-1 resize-none focus:outline-none text-[14px] leading-[1.5] min-h-[38px] placeholder:text-muted"
          rows={1}
          placeholder={disabled ? "会话不可用" : isRunning && !followUpMode ? "输入以插话（Steer）…" : "输入消息，@ 引用文件，/ 使用命令；Enter 发送，Shift+Enter 换行"}
          value={value}
          disabled={disabled}
          onChange={(event) => { cursorRef.current = event.target.selectionStart ?? 0; setValue(event.target.value); }}
          onKeyDown={handleKeyDown}
          onKeyUp={syncCursor}
          onClick={syncCursor}
          onSelect={syncCursor}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; compositionEndAtRef.current = Date.now(); }}
          onPaste={(event) => {
            // 粘贴的文件（截图、从文件管理器复制的文档）一律作为附件上传，不限类型。
            const files = Array.from(event.clipboardData.files);
            if (files.length) { event.preventDefault(); void uploadFiles(files); }
          }}
        />

        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1 min-w-0">
            <button type="button" className="p-1.5 rounded-lg text-on-surface-variant hover:bg-surface-container hover:text-on-surface transition-colors disabled:opacity-40" title="添加附件（图片直接进入对话，其他文件会告诉老师路径）" disabled={disabled} onClick={() => fileInputRef.current?.click()}>
              <span className="icon text-[18px]">attach_file</span>
            </button>
            <input ref={fileInputRef} type="file" multiple hidden onChange={(event) => { void uploadFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
            {isRunning && (
              <label className="flex items-center gap-1.5 text-[11px] text-on-surface-variant ml-1">
                <input type="checkbox" className="accent-secondary" checked={followUpMode} onChange={(event) => setFollowUpMode(event.target.checked)} />
                排队为下一轮追问
              </label>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {modelSelector}
            {isRunning && <button type="button" className="btn-outline h-8" onClick={onAbort} title="中止本轮">停止</button>}
            <button
              type="button"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-primary text-on-primary hover:bg-[#2b343c] transition-colors text-[13px] font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={disabled || busy || (!value.trim() && attachments.length === 0)}
              onClick={() => void submit()}
            >
              {busy ? "发送中" : isRunning && !followUpMode ? "插话" : "发送"}
              <span className="icon text-[16px]">arrow_upward</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
