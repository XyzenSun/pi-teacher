import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { CardsTab } from "./CardsTab.tsx";
import { GlossaryTab } from "./GlossaryTab.tsx";
import { TopicsTab } from "./TopicsTab.tsx";
import { AgentsMdTab, TeachStyleTab } from "./PromptsTab.tsx";
import { AccountTab } from "./AccountTab.tsx";
import { ModelProvidersTab } from "./ModelProvidersTab.tsx";
import { AdvancedTab } from "./AdvancedTab.tsx";
import { UserPreferencesTab } from "./UserPreferencesTab.tsx";
import { topicsApi } from "../api/client.ts";
import type { Topic } from "../api/types.ts";
import { Modal } from "../ui/Overlays.tsx";
import { useWorkspaceRoute } from "../app/overlay-routes.ts";

const TABS = [
  { key: "cards", label: "Card", icon: "style" },
  { key: "glossary", label: "Glossary", icon: "spellcheck" },
  { key: "topics", label: "Topic", icon: "label" },
  { key: "agents-md", label: "Agents Md", icon: "description" },
  { key: "teach-style", label: "Teach Style", icon: "palette" },
  { key: "preferences", label: "用户偏好", icon: "manage_accounts" },
  { key: "account", label: "账号", icon: "person" },
  { key: "models", label: "模型与 Provider", icon: "hub" },
  { key: "advanced", label: "高级配置", icon: "tune" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

/**
 * 设置覆盖层：工作台之上的 modal，背景仍渲染左树、对话与第三栏。
 *
 * 状态仍由 URL 表达（路径决定开关、`?tab=` 决定子页），因此刷新、直接访问与
 * 浏览器前进/后退都成立。关闭等价于 push 回背景路由——与「tab 之间可前进后退」
 * 保持同一套历史语义，不用 navigate(-1)（那会退回上一个 tab 而不是关闭）。
 */
export function SettingsOverlay() {
  const [search, setSearch] = useSearchParams();
  const navigate = useNavigate();
  const { basePath, conversationId } = useWorkspaceRoute();
  const active = (TABS.some((tab) => tab.key === search.get("tab")) ? search.get("tab") : "cards") as TabKey;
  const [topics, setTopics] = useState<Topic[]>([]);
  const [topicsVersion, setTopicsVersion] = useState(0);

  useEffect(() => { void topicsApi.list().then((result) => setTopics(result.topics)).catch(() => setTopics([])); }, [topicsVersion]);

  const content = useMemo(() => {
    switch (active) {
      case "cards": return <CardsTab topics={topics} />;
      case "glossary": return <GlossaryTab />;
      case "topics": return <TopicsTab topics={topics} onChanged={() => setTopicsVersion((version) => version + 1)} />;
      case "agents-md": return <AgentsMdTab />;
      case "teach-style": return <TeachStyleTab />;
      case "preferences": return <UserPreferencesTab />;
      case "account": return <AccountTab />;
      case "models": return <ModelProvidersTab />;
      case "advanced": return <AdvancedTab />;
    }
  }, [active, topics]);

  return (
    <Modal
      title="管理面板"
      subtitle={conversationId !== null ? "背景对话保持打开，关闭后回到原对话" : undefined}
      size="xl"
      onClose={() => navigate(basePath)}
      toolbar={
        <div className="flex">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={`tab flex items-center gap-1.5 whitespace-nowrap ${active === tab.key ? "tab-active" : ""}`}
              onClick={() => setSearch({ tab: tab.key })}
            >
              <span className="icon text-[16px]">{tab.icon}</span>{tab.label}
            </button>
          ))}
        </div>
      }
      bodyClassName="min-h-[420px]"
    >
      {content}
    </Modal>
  );
}
