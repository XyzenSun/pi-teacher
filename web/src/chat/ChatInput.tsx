import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { conversationsApi } from "../api/client.ts";
import type { Attachment, SlashCommand } from "../api/types.ts";
import { buildAtInsertText, buildEntriesFromFiles, extractAtQuery, filterFileEntries, type FileIndexEntry } from "../lib/file-fuzzy.ts";

/** 草稿按对话 ID 存内存：切换会话再切回来不丢输入，刷新页面则按后端历史重建。 */
const drafts = new Map<number, string>();

const MAX_IMAGES = 5;

interface ChatInputProps {
  conversationId: number;
  disabled: boolean;
  isRunning: boolean;
  commands: SlashCommand[];
  onSend: (message: string, attachmentIds: string[]) => Promise<void>;
  onSteer: (message: string) => Promise<void>;
  onAbort: () => void;
}

export function ChatInput({ conversationId, disabled, isRunning, commands, onSend, onSteer, onAbort }: ChatInputProps) {
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
    for (const file of files.slice(0, MAX_IMAGES - attachments.length)) {
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
      if (isRunning && !followUpMode) await onSteer(message);
      else await onSend(message, attachmentIds);
      setValue("");
      setAttachments([]);
      drafts.delete(conversationId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "发送失败");
    } finally {
      setBusy(false);
    }
  }, [attachments, conversationId, followUpMode, isRunning, onSend, onSteer, value]);

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
    <div className="border-t border-line bg-surface-container-lowest px-4 py-3">
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {attachments.map((attachment) => (
            <div key={attachment.id} className="flex items-center gap-1.5 rounded-md border border-line bg-surface-container-low px-2 py-1 text-[12px]">
              <span className="icon text-[14px] text-secondary">attach_file</span>
              <span className="max-w-[160px] truncate">{attachment.name}</span>
              <span className="text-muted">{Math.ceil(attachment.size / 1024)}KB</span>
              <button type="button" className="icon text-[14px] text-muted hover:text-error" onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}>close</button>
            </div>
          ))}
        </div>
      )}
      {menuOpen && (
        <div className="mb-2 card max-h-56 overflow-auto p-1">
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
      {error && <div className="mb-2 text-[12px] text-error">{error}</div>}
      <div className="flex items-end gap-2">
        <button type="button" className="btn-ghost h-9 px-2" title="添加图片附件" disabled={disabled} onClick={() => fileInputRef.current?.click()}>
          <span className="icon text-[18px]">image</span>
        </button>
        <input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={(event) => { void uploadFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
        <textarea
          ref={textareaRef}
          className="input flex-1 resize-none py-2 min-h-[38px] leading-[1.5]"
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
            const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
            if (images.length) { event.preventDefault(); void uploadFiles(images); }
          }}
        />
        {isRunning
          ? <button type="button" className="btn-outline h-9" onClick={onAbort} title="中止本轮">停止</button>
          : null}
        <button type="button" className="btn-secondary h-9" disabled={disabled || busy || (!value.trim() && attachments.length === 0)} onClick={() => void submit()}>
          {busy ? "发送中" : isRunning && !followUpMode ? "插话" : "发送"}
        </button>
      </div>
      {isRunning && (
        <label className="mt-2 flex items-center gap-1.5 text-[12px] text-on-surface-variant">
          <input type="checkbox" className="accent-secondary" checked={followUpMode} onChange={(event) => setFollowUpMode(event.target.checked)} />
          排队为下一轮追问（不打断当前回答）
        </label>
      )}
    </div>
  );
}
