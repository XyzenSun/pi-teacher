import { useEffect, useState, type ReactNode } from "react";
import { configApi } from "../api/client.ts";
import type { HomeMarkdownKind } from "../api/types.ts";
import { ErrorLine, useSubmit } from "../ui/form.tsx";

/**
 * homeDir 下用户直接编辑的 Markdown 编辑器：全局 USER.md 与全局 AGENTS.md 共用。
 * 上限与后端 home-markdown.ts 一致；前端只做提示，拒绝仍由服务端判定。
 */
export function HomeMarkdownEditor({ kind, maxLength, title, description, rows = 18, monospace = false }: {
  kind: HomeMarkdownKind;
  maxLength: number;
  title: string;
  description: ReactNode;
  rows?: number;
  monospace?: boolean;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [savedContent, setSavedContent] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { busy, error, run } = useSubmit();

  useEffect(() => {
    let cancelled = false;
    void configApi.homeMarkdown(kind)
      .then((result) => { if (!cancelled) { setContent(result.content); setSavedContent(result.content); } })
      .catch((cause: unknown) => { if (!cancelled) setLoadError(cause instanceof Error ? cause.message : "读取失败"); });
    return () => { cancelled = true; };
  }, [kind]);

  if (loadError) return <ErrorLine error={loadError} />;
  if (content === null) return <div className="text-[13px] text-muted">正在读取…</div>;

  const overLimit = content.length > maxLength;
  const dirty = content !== savedContent;
  const save = () => void run(async () => {
    await configApi.saveHomeMarkdown(kind, content);
    setSavedContent(content);
    setNotice("已保存。下次打开或重载对话时生效。");
  }).catch(() => {});

  return (
    <div className="space-y-3">
      <div>
        <h3 className="font-reading text-[17px] text-primary">{title}</h3>
        <p className="text-[12px] text-on-surface-variant mt-0.5">{description}</p>
      </div>
      {notice && !dirty && <div className="text-[13px] text-secondary">{notice}</div>}
      <textarea
        className={`input text-[13px] leading-[1.6] ${monospace ? "font-mono text-[12px]" : ""}`}
        rows={rows}
        spellCheck={false}
        value={content}
        onChange={(event) => { setContent(event.target.value); setNotice(null); }}
      />
      <div className={`text-[11px] ${overLimit ? "text-error" : "text-muted"}`}>
        {content.length} / {maxLength} 字符{overLimit ? "，超出上限，请精简后再保存" : ""}
      </div>
      <ErrorLine error={error} />
      <div className="flex justify-end">
        <button type="button" className="btn-primary" disabled={busy || overLimit || !dirty} onClick={save}>
          {busy ? "保存中…" : "保存"}
        </button>
      </div>
    </div>
  );
}

/**
 * 全局用户偏好：编辑 ~/pi-teacher/USER.md。
 *
 * 会话级偏好（pi-session-user.md）故意不在这里出现：它由老师在对话里自行维护，
 * 程序不读不写，界面只负责告诉用户这条边界。
 */
export function UserPreferencesTab() {
  return (
    <HomeMarkdownEditor
      kind="user-preferences"
      maxLength={8000}
      title="全局用户偏好"
      description={<>
        写给老师的长期偏好：讲解方式、术语习惯、已掌握的基础等。下次打开或重载对话时生效；
        当前对话的教学风格与老师在会话中记录的 <span className="font-mono">pi-session-user.md</span> 优先于这里的设置。
        只针对某次对话的要求直接在对话里告诉老师即可，不要写在这里。本文件会进入模型上下文，请勿写入密码或 API key。
      </>}
    />
  );
}
