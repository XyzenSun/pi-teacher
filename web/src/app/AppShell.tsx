import { useEffect, useMemo, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { ChatPanel } from "../chat/ChatPanel.tsx";
import { useConversation } from "../chat/useConversation.ts";
import { Sidebar } from "../sidebar/Sidebar.tsx";
import { CardProposals } from "../aside/CardProposals.tsx";
import { AssistantPanel } from "../aside/AssistantPanel.tsx";
import { CreatePanel, type CreateIntent } from "./CreatePanel.tsx";
import { WorkspaceProvider, useWorkspace } from "./WorkspaceContext.tsx";
import { useWorkspaceRoute } from "./overlay-routes.ts";
import { SettingsOverlay } from "../settings/SettingsOverlay.tsx";
import { CalendarOverlay } from "./CalendarOverlay.tsx";
import { HelpOverlay } from "./HelpOverlay.tsx";

function AppLayout() {
  const navigate = useNavigate();
  const { conversationId, overlay, valid } = useWorkspaceRoute();
  const { data, models, refresh } = useWorkspace();
  const [intent, setIntent] = useState<CreateIntent | null>(null);
  const session = useConversation(conversationId);

  const title = useMemo(() => {
    if (conversationId === null) return "";
    if (session.conversation?.name) return session.conversation.name;
    for (const space of data?.spaces ?? []) {
      const match = space.conversations.find((conversation) => conversation.id === conversationId);
      if (match) return match.name ?? `未命名对话 #${conversationId}`;
    }
    return `对话 #${conversationId}`;
  }, [conversationId, data, session.conversation]);

  /** 模型每轮结束都可能改了标题或提议了卡片，刷新树与右侧栏；用 sessionVersion 触发。 */
  const [cardRefreshToken, setCardRefreshToken] = useState(0);
  useEffect(() => {
    if (session.status !== "connected") return;
    setCardRefreshToken((token) => token + 1);
  }, [session.status]);
  useEffect(() => {
    if (session.runtime && !session.runtime.isRunning) {
      void refresh();
      setCardRefreshToken((token) => token + 1);
    }
  }, [session.runtime?.isRunning, session.sessionVersion, refresh, session.runtime]);

  // `/app/xxx` 这类无法解析的路径回到工作台，避免出现空白页面。
  if (!valid) return <Navigate to="/app" replace />;

  return (
    <div className="h-full flex overflow-hidden">
      <Sidebar activeConversationId={conversationId} onOpenConversation={(id) => navigate(`/app/c/${id}`)} onCreate={setIntent} />

      {conversationId === null ? (
        <section className="flex-1 flex items-center justify-center bg-surface">
          <div className="text-center space-y-3 max-w-[360px]">
            <div className="font-reading text-[28px] text-primary">开始一段学习</div>
            <p className="text-[13px] text-on-surface-variant">在左侧选择一个 Space 里的对话，或点击 <span className="icon text-[14px] align-middle">add_circle</span> 新建学习 / 复习对话。</p>
            <button type="button" className="btn-primary" onClick={() => setIntent({ kind: "generic" })}>新建对话</button>
          </div>
        </section>
      ) : (
        <ChatPanel conversationId={conversationId} title={title} session={session} models={models} onRenamed={() => void refresh()} />
      )}

      <aside className="w-aside shrink-0 h-full flex flex-col border-l border-line bg-surface-container-low aside-compact">
        {/* 模板比例：卡片审批固定 38%，助教占剩余空间（约 2/3） */}
        <CardProposals refreshToken={cardRefreshToken} />
        {data && <AssistantPanel taSessionId={data.taSessionId} mainConversationId={conversationId} />}
      </aside>

      {intent && <CreatePanel intent={intent} onClose={() => setIntent(null)} onCreated={(id) => { setIntent(null); navigate(`/app/c/${id}`); }} />}

      {overlay === "settings" && <SettingsOverlay />}
      {overlay === "calendar" && <CalendarOverlay />}
      {overlay === "help" && <HelpOverlay />}
    </div>
  );
}

export function AppShell() {
  return <WorkspaceProvider><AppLayout /></WorkspaceProvider>;
}
