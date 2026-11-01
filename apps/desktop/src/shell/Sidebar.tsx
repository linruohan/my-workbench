import { useMemo, useState } from "react";
import type { Note } from "@wb/domain";
import {
  IconBot,
  IconChat,
  IconFolder,
  IconPlus,
  IconSearch,
  IconSettings,
  IconSidebar,
} from "./icons";

export type AppNavId =
  | "today"
  | "planner"
  | "schedule"
  | "projects"
  | "knowledge"
  | "timed";

const NAV: Array<{ id: AppNavId; label: string }> = [
  { id: "today", label: "今日" },
  { id: "planner", label: "计划" },
  { id: "schedule", label: "时间表" },
  { id: "projects", label: "任务" },
  { id: "timed", label: "定时任务" },
  { id: "knowledge", label: "知识库" },
];

type Props = {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  nav: AppNavId;
  onNav: (id: AppNavId) => void;
  settingsOpen: boolean;
  onOpenSettings: () => void;
  projects: Array<{ id: string; title: string }>;
  activeProjectId?: string | null;
  notes: Note[];
  onCreateProject: () => void;
  onSelectProject?: (projectId: string | null) => void;
  onSelectNote: (id: string) => void;
  onNewChat: () => void;
  onAutomations: () => void;
  displayName: string;
};

export function Sidebar({
  collapsed,
  onToggleCollapsed,
  nav,
  onNav,
  settingsOpen,
  onOpenSettings,
  projects,
  activeProjectId = null,
  notes,
  onCreateProject,
  onSelectProject,
  onSelectNote,
  onNewChat,
  onAutomations,
  displayName,
}: Props) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);

  const filteredNav = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return NAV;
    return NAV.filter((item) => item.label.toLowerCase().includes(q));
  }, [query]);

  const recentNotes = notes.slice(0, 6);

  if (collapsed) {
    return (
      <aside className="sidebar sidebar--collapsed" aria-label="侧栏">
        <button
          type="button"
          className="icon-btn"
          aria-label="展开左视图"
          onClick={onToggleCollapsed}
        >
          <IconSidebar />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="打开设置"
          onClick={onOpenSettings}
        >
          <IconSettings />
        </button>
      </aside>
    );
  }

  return (
    <aside className="sidebar" aria-label="侧栏">
      <div className="sidebar__top">
        <div className="sidebar__tools">
          <button
            type="button"
            className="icon-btn"
            aria-label="收起左视图"
            onClick={onToggleCollapsed}
          >
            <IconSidebar />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="搜索"
            aria-pressed={searchOpen}
            onClick={() => setSearchOpen((v) => !v)}
          >
            <IconSearch />
          </button>
        </div>
        {searchOpen ? (
          <input
            className="sidebar__search"
            aria-label="搜索视图"
            placeholder="搜索视图…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        ) : null}
      </div>

      <div className="sidebar__actions">
        <button type="button" className="sidebar__action" onClick={onNewChat}>
          <IconChat />
          <span>新建会话</span>
        </button>
        <button type="button" className="sidebar__action" onClick={onAutomations}>
          <IconBot />
          <span>自动化</span>
        </button>
      </div>

      <div className="sidebar__scroll">
        <section className="sidebar__section">
          <div className="sidebar__section-label">项目</div>
          <button type="button" className="sidebar__row" onClick={onCreateProject}>
            <IconPlus size={15} />
            <span>新建项目</span>
          </button>
          {projects.map((p) => (
            <button
              key={p.id}
              type="button"
              className={
                nav === "projects" &&
                !settingsOpen &&
                activeProjectId === p.id
                  ? "sidebar__row is-active"
                  : "sidebar__row"
              }
              onClick={() => {
                onSelectProject?.(p.id);
                onNav("projects");
              }}
            >
              <IconFolder size={15} />
              <span className="sidebar__row-text">{p.title}</span>
            </button>
          ))}
        </section>

        <section className="sidebar__section">
          <div className="sidebar__section-label">视图</div>
          {filteredNav.map((item) => (
            <button
              key={item.id}
              type="button"
              className={
                nav === item.id &&
                !settingsOpen &&
                (item.id !== "projects" || activeProjectId == null)
                  ? "sidebar__row is-active"
                  : "sidebar__row"
              }
              onClick={() => {
                if (item.id === "projects") onSelectProject?.(null);
                onNav(item.id);
              }}
            >
              <span className="sidebar__dot" />
              <span className="sidebar__row-text">{item.label}</span>
            </button>
          ))}
        </section>

        {recentNotes.length > 0 ? (
          <section className="sidebar__section">
            <div className="sidebar__section-label">最近笔记</div>
            {recentNotes.map((n) => (
              <button
                key={n.id}
                type="button"
                className="sidebar__row"
                onClick={() => onSelectNote(n.id)}
              >
                <span className="sidebar__dot" />
                <span className="sidebar__row-text">{n.title}</span>
              </button>
            ))}
          </section>
        ) : null}
      </div>

      <div className="sidebar__footer">
        <div className="sidebar__account">
          <div className="sidebar__account-user">
            <div className="sidebar__avatar" aria-hidden>
              {displayName.slice(0, 1)}
            </div>
            <span className="sidebar__account-name">{displayName}</span>
          </div>
          <button
            type="button"
            className={
              settingsOpen
                ? "sidebar__settings is-active"
                : "sidebar__settings"
            }
            aria-label="打开设置"
            aria-pressed={settingsOpen}
            onClick={onOpenSettings}
          >
            <IconSettings size={16} />
          </button>
        </div>
      </div>
    </aside>
  );
}
