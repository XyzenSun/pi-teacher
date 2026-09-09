import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CardsTab } from "./CardsTab.tsx";
import { GlossaryTab } from "./GlossaryTab.tsx";
import { TopicsTab } from "./TopicsTab.tsx";
import { AgentsMdTab, TeachStyleTab } from "./PromptsTab.tsx";
import { topicsApi } from "../api/client.ts";
import type { Topic } from "../api/types.ts";

const TABS = [
  { key: "cards", label: "Card", icon: "style" },
  { key: "glossary", label: "Glossary", icon: "spellcheck" },
  { key: "topics", label: "Topic", icon: "label" },
  { key: "agents-md", label: "Agents Md", icon: "description" },
  { key: "teach-style", label: "Teach Style", icon: "palette" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

/** 单页管理面板：tab 记在 URL query，刷新与前进后退都能回到同一子页。 */
export function SettingsPage() {
  const [search, setSearch] = useSearchParams();
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
    }
  }, [active, topics]);

  return (
    <div className="h-full flex flex-col bg-surface">
      <header className="h-14 shrink-0 px-6 flex items-center justify-between border-b border-line bg-surface-container-lowest">
        <div className="flex items-center gap-3">
          <Link to="/app" className="btn-ghost px-2"><span className="icon text-[20px]">arrow_back</span></Link>
          <h1 className="font-reading text-[20px] text-primary">管理面板</h1>
        </div>
      </header>
      <div className="px-6 border-b border-line bg-surface-container-lowest flex">
        {TABS.map((tab) => (
          <button key={tab.key} type="button" className={`tab flex items-center gap-1.5 ${active === tab.key ? "tab-active" : ""}`} onClick={() => setSearch({ tab: tab.key })}>
            <span className="icon text-[16px]">{tab.icon}</span>{tab.label}
          </button>
        ))}
      </div>
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-workstation px-6 py-6">{content}</div>
      </main>
    </div>
  );
}
