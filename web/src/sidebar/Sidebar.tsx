import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { workspacesApi } from "../api/client.ts";
import type { Conversation, Space } from "../api/types.ts";
import { useAuth } from "../auth/AuthContext.tsx";
import { useWorkspace } from "../app/WorkspaceContext.tsx";
import { overlayPath, useWorkspaceRoute, type OverlayKind } from "../app/overlay-routes.ts";
import type { CreateIntent } from "../app/CreatePanel.tsx";
import { ConfirmDialog, InlineEdit } from "../ui/Overlays.tsx";

interface SidebarProps {
  activeConversationId: number | null;
  onOpenConversation: (id: number) => void;
  onCreate: (intent: CreateIntent) => void;
}

/** 左下角 2×2 Dock：四个入口都指向真实页面，路径由当前工作台路由派生。 */
const DOCK_ENTRIES: Array<{ label: string; icon: string; overlay: OverlayKind; search?: string; title: string }> = [
  { label: "系统设置", icon: "tune", overlay: "settings", title: "管理面板：卡片、术语、模板、账号与模型配置" },
  { label: "学习日历", icon: "calendar_today", overlay: "calendar", title: "复习排期与复习记录" },
  { label: "知识卡库", icon: "style", overlay: "settings", search: "?tab=cards", title: "管理面板的卡片页" },
  { label: "帮助指南", icon: "help_center", overlay: "help", title: "本产品的概念与操作说明" },
];

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
  const navigate = useNavigate();
  const { basePath } = useWorkspaceRoute();
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [creatingSpace, setCreatingSpace] = useState(false);
  const [spaceName, setSpaceName] = useState("");
  const [spaceError, setSpaceError] = useState<string | null>(null);
  const [removingSpace, setRemovingSpace] = useState<Space | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

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

  const renameSpace = async (space: Space, next: string) => {
    try { await workspacesApi.rename(space.id, next); setSpaceError(null); await refresh(); } catch (cause) { setSpaceError(cause instanceof Error ? cause.message : "重命名失败"); }
  };

  const deleteSpace = async (space: Space) => {
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      await workspacesApi.remove(space.id);
      setRemovingSpace(null);
      await refresh();
    } catch (cause) {
      setRemoveError(cause instanceof Error ? cause.message : "删除失败");
    } finally {
      setRemoveBusy(false);
    }
  };

  const visibleSpaces = (data?.spaces ?? []).filter((space) => space.type !== "ta");
  const reviewSpace = visibleSpaces.find((space) => space.type === "review");
  const learnSpaces = visibleSpaces.filter((space) => space.type === "learn");

  const renderConversation = (conversation: Conversation) => {
    const active = conversation.id === activeConversationId;
    return (
      <button
        key={conversation.id}
        type="button"
        onClick={() => onOpenConversation(conversation.id)}
        className={`tree-row w-full pl-7 pr-2 group ${active ? "tree-row-active" : ""}`}
      >
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${active ? "bg-secondary" : "bg-outline-variant group-hover:bg-secondary"}`} />
        <span className={`flex-1 min-w-0 truncate ${active ? "font-medium" : ""}`}>{conversationTitle(conversation)}</span>
        <span className="text-[10px] text-muted font-mono shrink-0">{formatTime(conversation.modifiedAt ?? conversation.createdAt)}</span>
      </button>
    );
  };

  const renderSpaceHeader = (space: Space, intent: CreateIntent, renamable: boolean) => (
    <div className="tree-row px-1 group">
      <button type="button" className="icon text-[16px] text-muted shrink-0" title={collapsed.has(space.id) ? "展开" : "折叠"} onClick={() => toggle(space.id)}>
        {collapsed.has(space.id) ? "chevron_right" : "expand_more"}
      </button>
      <span className="icon text-[16px] text-secondary shrink-0">{space.type === "review" ? "replay" : "menu_book"}</span>
      {renamable ? (
        <InlineEdit
          value={space.name}
          title="重命名 Space"
          inputClassName="w-full text-[13px]"
          buttonClassName="opacity-0 group-hover:opacity-100"
          onSubmit={(next) => renameSpace(space, next)}
        >
          <span className="text-[13px] font-medium text-primary truncate">{space.name}</span>
        </InlineEdit>
      ) : (
        <span className="text-[13px] font-medium text-primary truncate">{space.name}</span>
      )}
      <span className="flex-1" />
      <span className="text-[10px] text-muted font-mono">{space.conversations.length}</span>
      <span className="opacity-0 group-hover:opacity-100 flex items-center shrink-0">
        {renamable && (
          <button type="button" className="icon text-[16px] text-muted hover:text-error p-0.5" title="删除 Space" onClick={() => { setRemoveError(null); setRemovingSpace(space); }}>delete</button>
        )}
        <button type="button" className="icon text-[16px] text-muted hover:text-secondary p-0.5" title={space.type === "review" ? "新建复习对话" : "在此 Space 新建学习对话"} onClick={() => onCreate(intent)}>add</button>
      </span>
    </div>
  );

  return (
    <aside className="w-sidebar shrink-0 h-full flex flex-col border-r border-line bg-surface-container-low">
      <div className="h-14 px-4 shrink-0 flex items-center justify-between border-b border-line">
        <Link to="/app" className="font-reading text-[20px] text-primary">Pi Teacher</Link>
        <button type="button" className="icon text-[20px] text-secondary hover:text-primary" title="新建对话" onClick={() => onCreate({ kind: "generic" })}>add_circle</button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-2 py-3 space-y-4">
        {error && <div className="text-[12px] text-error px-2">{error}</div>}
        {spaceError && <div className="text-[12px] text-error px-2">{spaceError}</div>}

        <div>
          <div className="flex items-center justify-between px-2 mb-1">
            <span className="label">学习</span>
            <button type="button" className="icon text-[16px] text-muted hover:text-secondary" title="新建学习 Space" onClick={() => setCreatingSpace((value) => !value)}>create_new_folder</button>
          </div>
          {creatingSpace && (
            <div className="px-2 pb-2 space-y-1">
              <input className="input py-1" placeholder="Space 名称，如：线性代数" value={spaceName} autoFocus onChange={(event) => setSpaceName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void submitSpace(); if (event.key === "Escape") setCreatingSpace(false); }} />
            </div>
          )}
          {learnSpaces.length === 0 && !creatingSpace && <div className="px-2 text-[12px] text-muted">还没有学习 Space，点右上角文件夹图标创建。</div>}
          {learnSpaces.map((space) => (
            <div key={space.id}>
              {renderSpaceHeader(space, { kind: "learn", spaceId: space.id }, true)}
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
            {renderSpaceHeader(reviewSpace, { kind: "review", topicId: null }, false)}
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

      <div className="shrink-0 border-t border-line bg-surface-container-lowest/90 p-2 space-y-2">
        <div className="grid grid-cols-2 gap-1.5">
          {DOCK_ENTRIES.map((entry) => (
            <button
              key={entry.label}
              type="button"
              className="dock-card"
              title={entry.title}
              onClick={() => navigate(overlayPath(basePath, entry.overlay, entry.search))}
            >
              <span className="icon text-[18px] text-secondary shrink-0">{entry.icon}</span>
              <span className="text-[12px] font-medium truncate">{entry.label}</span>
            </button>
          ))}
        </div>
        <div className="flex items-center justify-between px-1 text-[12px]">
          <span className="text-on-surface-variant truncate">{auth.username}</span>
          <button type="button" className="btn-ghost px-2 py-1" title="退出登录" onClick={() => void auth.logout()}><span className="icon text-[18px]">logout</span></button>
        </div>
      </div>

      {removingSpace && (
        <ConfirmDialog
          title="删除学习 Space"
          danger
          busy={removeBusy}
          error={removeError}
          message={<>删除「{removingSpace.name}」及其 {removingSpace.conversations.length} 条对话记录？对话的工作目录与消息文件会保留在磁盘上，但不再显示在这里。</>}
          confirmLabel="删除"
          onCancel={() => { setRemovingSpace(null); setRemoveError(null); }}
          onConfirm={() => void deleteSpace(removingSpace)}
        />
      )}
    </aside>
  );
}
