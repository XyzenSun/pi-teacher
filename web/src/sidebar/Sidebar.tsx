import { useState } from "react";
import { Link } from "react-router-dom";
import { workspacesApi } from "../api/client.ts";
import type { Conversation, Space } from "../api/types.ts";
import { useAuth } from "../auth/AuthContext.tsx";
import { useWorkspace } from "../app/WorkspaceContext.tsx";
import type { CreateIntent } from "../app/CreatePanel.tsx";

interface SidebarProps {
  activeConversationId: number | null;
  onOpenConversation: (id: number) => void;
  onCreate: (intent: CreateIntent) => void;
}

function conversationTitle(conversation: Conversation): string {
  return conversation.name ?? `未命名对话 #${conversation.id}`;
}

function formatTime(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function Sidebar({ activeConversationId, onOpenConversation, onCreate }: SidebarProps) {
  const { data, topics, error, refresh } = useWorkspace();
  const auth = useAuth();
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [creatingSpace, setCreatingSpace] = useState(false);
  const [spaceName, setSpaceName] = useState("");
  const [spaceError, setSpaceError] = useState<string | null>(null);

  const toggle = (id: number) => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const submitSpace = async () => {
    if (!spaceName.trim()) return;
    try {
      await workspacesApi.create(spaceName.trim());
      setSpaceName("");
      setCreatingSpace(false);
      setSpaceError(null);
      await refresh();
    } catch (cause) {
      setSpaceError(cause instanceof Error ? cause.message : "创建失败");
    }
  };

  const renameSpace = async (space: Space) => {
    const next = prompt("重命名学习 Space", space.name);
    if (next === null || !next.trim() || next.trim() === space.name) return;
    try { await workspacesApi.rename(space.id, next.trim()); await refresh(); } catch (cause) { alert(cause instanceof Error ? cause.message : "重命名失败"); }
  };

  const deleteSpace = async (space: Space) => {
    if (!confirm(`删除学习 Space「${space.name}」及其 ${space.conversations.length} 条对话记录？文件会保留在磁盘上。`)) return;
    try { await workspacesApi.remove(space.id); await refresh(); } catch (cause) { alert(cause instanceof Error ? cause.message : "删除失败"); }
  };

  const visibleSpaces = (data?.spaces ?? []).filter((space) => space.type !== "ta");
  const reviewSpace = visibleSpaces.find((space) => space.type === "review");
  const learnSpaces = visibleSpaces.filter((space) => space.type === "learn");

  const renderConversation = (conversation: Conversation) => (
    <button
      key={conversation.id}
      type="button"
      onClick={() => onOpenConversation(conversation.id)}
      className={`w-full text-left pl-7 pr-2 py-1.5 rounded-md flex items-center gap-2 text-[13px] group ${conversation.id === activeConversationId ? "bg-secondary-container text-on-secondary-container" : "hover:bg-surface-container text-on-surface"}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${conversation.id === activeConversationId ? "bg-secondary" : "bg-outline-variant group-hover:bg-secondary"}`} />
      <span className="flex-1 min-w-0 truncate">{conversationTitle(conversation)}</span>
      <span className="text-[10px] text-muted font-mono shrink-0">{formatTime(conversation.modifiedAt ?? conversation.createdAt)}</span>
    </button>
  );

  const renderSpaceHeader = (space: Space, intent: CreateIntent, actions?: React.ReactNode) => (
    <div className="flex items-center gap-1 px-1 py-1 rounded-md hover:bg-surface-container group">
      <button type="button" className="flex-1 min-w-0 flex items-center gap-1.5 text-left" onClick={() => toggle(space.id)}>
        <span className="icon text-[16px] text-muted">{collapsed.has(space.id) ? "chevron_right" : "expand_more"}</span>
        <span className="icon text-[16px] text-secondary">{space.type === "review" ? "replay" : "menu_book"}</span>
        <span className="text-[13px] font-medium text-primary truncate">{space.name}</span>
        <span className="text-[10px] text-muted font-mono">{space.conversations.length}</span>
      </button>
      <span className="opacity-0 group-hover:opacity-100 flex items-center">
        {actions}
        <button type="button" className="icon text-[16px] text-muted hover:text-secondary p-0.5" title={space.type === "review" ? "新建复习对话" : "在此 Space 新建学习对话"} onClick={() => onCreate(intent)}>add</button>
      </span>
    </div>
  );

  return (
    <aside className="w-sidebar shrink-0 h-full flex flex-col border-r border-line bg-surface-container-low">
      <div className="h-14 px-4 flex items-center justify-between border-b border-line">
        <Link to="/app" className="font-reading text-[20px] text-primary">Pi Teacher</Link>
        <button type="button" className="icon text-[20px] text-secondary hover:text-primary" title="新建对话" onClick={() => onCreate({ kind: "generic" })}>add_circle</button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-3 space-y-4">
        {error && <div className="text-[12px] text-error px-2">{error}</div>}

        <div>
          <div className="flex items-center justify-between px-2 mb-1">
            <span className="label">学习</span>
            <button type="button" className="icon text-[16px] text-muted hover:text-secondary" title="新建学习 Space" onClick={() => setCreatingSpace((value) => !value)}>create_new_folder</button>
          </div>
          {creatingSpace && (
            <div className="px-2 pb-2 space-y-1">
              <input className="input py-1" placeholder="Space 名称，如：线性代数" value={spaceName} autoFocus onChange={(event) => setSpaceName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void submitSpace(); if (event.key === "Escape") setCreatingSpace(false); }} />
              {spaceError && <div className="text-[11px] text-error">{spaceError}</div>}
            </div>
          )}
          {learnSpaces.length === 0 && !creatingSpace && <div className="px-2 text-[12px] text-muted">还没有学习 Space，点右上角文件夹图标创建。</div>}
          {learnSpaces.map((space) => (
            <div key={space.id}>
              {renderSpaceHeader(space, { kind: "learn", spaceId: space.id }, (
                <>
                  <button type="button" className="icon text-[16px] text-muted hover:text-primary p-0.5" title="重命名" onClick={() => void renameSpace(space)}>edit</button>
                  <button type="button" className="icon text-[16px] text-muted hover:text-error p-0.5" title="删除" onClick={() => void deleteSpace(space)}>delete</button>
                </>
              ))}
              {!collapsed.has(space.id) && (
                <div className="space-y-0.5">
                  {space.conversations.length === 0 && <div className="pl-7 text-[12px] text-muted py-1">暂无对话</div>}
                  {space.conversations.map(renderConversation)}
                </div>
              )}
            </div>
          ))}
        </div>

        {reviewSpace && (
          <div>
            <div className="flex items-center justify-between px-2 mb-1">
              <span className="label">复习</span>
              {data && data.dueCards > 0 && <span className="chip bg-tertiary-container text-on-tertiary-container">{data.dueCards} 张到期</span>}
            </div>
            {renderSpaceHeader(reviewSpace, { kind: "review", topicId: null })}
            {!collapsed.has(reviewSpace.id) && (
              <div className="space-y-1">
                <div className="pl-7 pr-2 flex flex-wrap gap-1 py-1">
                  <button type="button" className="chip bg-surface-container-lowest border border-line hover:border-secondary" onClick={() => onCreate({ kind: "review", topicId: null })}>全部</button>
                  {topics.map((topic) => (
                    <button key={topic.id} type="button" className="chip bg-surface-container-lowest border border-line hover:border-secondary" title={`复习「${topic.name}」`} onClick={() => onCreate({ kind: "review", topicId: topic.id })}>
                      {topic.name}{topic.due_count ? <span className="ml-1 text-tertiary font-mono">{topic.due_count}</span> : null}
                    </button>
                  ))}
                </div>
                {reviewSpace.conversations.length === 0 && <div className="pl-7 text-[12px] text-muted py-1">暂无复习记录</div>}
                {reviewSpace.conversations.map(renderConversation)}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="border-t border-line px-3 py-2 flex items-center justify-between text-[12px]">
        <span className="text-on-surface-variant truncate">{auth.username}</span>
        <span className="flex items-center gap-1">
          <Link to="/settings" className="btn-ghost px-2 py-1" title="管理面板"><span className="icon text-[18px]">tune</span></Link>
          <button type="button" className="btn-ghost px-2 py-1" title="退出登录" onClick={() => void auth.logout()}><span className="icon text-[18px]">logout</span></button>
        </span>
      </div>
    </aside>
  );
}
