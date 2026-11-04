import { useMemo, useState, type ReactNode } from "react";
import { INBOX_PROJECT_ID, type Note } from "@wb/domain";
import {
  IconChat,
  IconDone,
  IconFolder,
  IconInbox,
  IconKnowledge,
  IconPlus,
  IconPlanner,
  IconSearch,
  IconSettings,
  IconSidebar,
  IconTasks,
  IconTimed,
  IconToday,
} from "./icons";

export type AppNavId =
  "today" | "inbox" | "done" | "planner" | "projects" | "knowledge" | "timed" | "agent";

type TaskNavItem = {
  id: "today" | "inbox" | "done" | "planner" | "timed";
  label: string;
  icon: ReactNode;
};

/** 任务分组下的全局视图：覆盖全部项目的任务。 */
const TASK_NAV: TaskNavItem[] = [
  { id: "today", label: "今日", icon: <IconToday size={15} /> },
  { id: "inbox", label: "收件箱", icon: <IconInbox size={15} /> },
  { id: "done", label: "已完成", icon: <IconDone size={15} /> },
  { id: "planner", label: "计划", icon: <IconPlanner size={15} /> },
  { id: "timed", label: "定时任务", icon: <IconTimed size={15} /> },
];

type TaskNavCounts = Partial<Record<TaskNavItem["id"], number>>;

type Props = {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  nav: AppNavId;
  onNav: (id: AppNavId) => void;
  settingsOpen: boolean;
  onOpenSettings: () => void;
  projects: Array<{ id: string; title: string }>;
  activeProjectId?: string | null;
  /** 固定任务分类数量，与对应视图列表口径一致。 */
  taskNavCounts?: TaskNavCounts;
  /** 项目内未完成根任务数量。 */
  projectTaskCounts?: Record<string, number>;
  notes: Note[];
  onCreateProject: () => void;
  onSelectProject: (projectId: string) => void;
  onSelectNote: (id: string) => void;
  onOpenAgent: () => void;
  /** Agent 分组是否展开。展开时在该项下方显示工作区。 */
  agentOpen: boolean;
  onToggleAgent: () => void;
  agentRail: ReactNode;
  displayName: string;
};

function NavCount({ value }: { value: number | undefined }) {
  if (value == null) return null;
  // 视觉计数；隐藏于无障碍名称，避免侧栏按钮 name 变成「今日 3」。
  return (
    <span className="sidebar__count" aria-hidden="true">
      {value}
    </span>
  );
}

export function Sidebar({
  collapsed,
  onToggleCollapsed,
  nav,
  onNav,
  settingsOpen,
  onOpenSettings,
  projects,
  activeProjectId = null,
  taskNavCounts,
  projectTaskCounts,
  notes,
  onCreateProject,
  onSelectProject,
  onSelectNote,
  onOpenAgent,
  agentOpen,
  onToggleAgent,
  agentRail,
  displayName,
}: Props) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(true);

  const q = query.trim().toLowerCase();

  const filteredTaskNav = useMemo(() => {
    if (!q) return TASK_NAV;
    return TASK_NAV.filter((item) => item.label.toLowerCase().includes(q));
  }, [q]);

  const filteredProjects = useMemo(() => {
    // 收件箱已固定在「今日」下方，项目列表里不再重复出现。
    const list = projects
      .filter((p) => p.id !== INBOX_PROJECT_ID)
      .sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
    if (!q) return list;
    return list.filter((p) => p.title.toLowerCase().includes(q));
  }, [projects, q]);

  const showKnowledge = !q || "知识库".includes(q) || "knowledge".includes(q);
  const showAgent = !q || "agent".includes(q) || "会话".includes(q);
  const showTaskGroup =
    !q ||
    "任务".includes(q) ||
    "收件箱".includes(q) ||
    "已完成".includes(q) ||
    filteredTaskNav.length > 0 ||
    filteredProjects.length > 0;

  const taskGroupActive =
    !settingsOpen &&
    (nav === "today" ||
      nav === "inbox" ||
      nav === "done" ||
      nav === "planner" ||
      nav === "timed" ||
      nav === "projects");

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
        <div className="sidebar__rail" role="group" aria-label="任务">
          {TASK_NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              className={
                nav === item.id && !settingsOpen ? "icon-btn is-active" : "icon-btn"
              }
              aria-label={item.label}
              aria-pressed={nav === item.id && !settingsOpen}
              title={item.label}
              onClick={() => onNav(item.id)}
            >
              {item.icon}
            </button>
          ))}
          <button
            type="button"
            className="icon-btn"
            aria-label="添加项目"
            title="添加项目"
            onClick={onCreateProject}
          >
            <IconPlus size={15} />
          </button>
          <button
            type="button"
            className={
              nav === "knowledge" && !settingsOpen ? "icon-btn is-active" : "icon-btn"
            }
            aria-label="知识库"
            aria-pressed={nav === "knowledge" && !settingsOpen}
            title="知识库"
            onClick={() => onNav("knowledge")}
          >
            <IconKnowledge size={15} />
          </button>
          <button
            type="button"
            className={
              nav === "agent" && !settingsOpen ? "icon-btn is-active" : "icon-btn"
            }
            aria-label="Agent"
            aria-pressed={nav === "agent" && !settingsOpen}
            title="Agent"
            onClick={onOpenAgent}
          >
            <IconChat size={15} />
          </button>
        </div>
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
            placeholder="搜索任务视图或项目…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        ) : null}
      </div>

      <div className="sidebar__scroll">
        {showTaskGroup ? (
          <section className="sidebar__section" aria-label="任务分组">
            <div
              className={
                taskGroupActive ? "sidebar__group-head is-active" : "sidebar__group-head"
              }
            >
              <button
                type="button"
                className="sidebar__group-toggle"
                aria-expanded={tasksOpen}
                onClick={() => setTasksOpen((v) => !v)}
              >
                <span className="sidebar__row-icon" aria-hidden>
                  <IconTasks size={15} />
                </span>
                <span className="sidebar__row-text">任务</span>
                <span className="sidebar__chevron" aria-hidden>
                  {tasksOpen ? "▾" : "▸"}
                </span>
              </button>
              <button
                type="button"
                className="sidebar__group-add"
                aria-label="添加项目"
                title="添加项目"
                onClick={(e) => {
                  e.stopPropagation();
                  onCreateProject();
                  setTasksOpen(true);
                }}
              >
                <IconPlus size={14} />
              </button>
            </div>

            {tasksOpen ? (
              <div className="sidebar__group-body">
                {filteredTaskNav.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={
                      nav === item.id && !settingsOpen
                        ? "sidebar__row sidebar__row--nested is-active"
                        : "sidebar__row sidebar__row--nested"
                    }
                    onClick={() => onNav(item.id)}
                  >
                    <span className="sidebar__row-icon" aria-hidden>
                      {item.icon}
                    </span>
                    <span className="sidebar__row-text">{item.label}</span>
                    <NavCount value={taskNavCounts?.[item.id]} />
                  </button>
                ))}

                {filteredProjects.length > 0 ? (
                  <div className="sidebar__divider" role="separator" />
                ) : null}

                {filteredProjects.map((p) => {
                  const active =
                    nav === "projects" && !settingsOpen && activeProjectId === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className={
                        active
                          ? "sidebar__row sidebar__row--nested is-active"
                          : "sidebar__row sidebar__row--nested"
                      }
                      onClick={() => onSelectProject(p.id)}
                    >
                      <span className="sidebar__row-icon" aria-hidden>
                        <IconFolder size={15} />
                      </span>
                      <span className="sidebar__row-text">{p.title}</span>
                      <NavCount value={projectTaskCounts?.[p.id]} />
                    </button>
                  );
                })}
              </div>
            ) : null}
          </section>
        ) : null}

        {showKnowledge ? (
          <section className="sidebar__section">
            <button
              type="button"
              className={
                nav === "knowledge" && !settingsOpen
                  ? "sidebar__row is-active"
                  : "sidebar__row"
              }
              onClick={() => onNav("knowledge")}
            >
              <span className="sidebar__row-icon" aria-hidden>
                <IconKnowledge size={15} />
              </span>
              <span className="sidebar__row-text">知识库</span>
            </button>
          </section>
        ) : null}

        {showAgent ? (
          <section className="sidebar__section" aria-label="Agent">
            <div
              className={
                nav === "agent" && !settingsOpen
                  ? "sidebar__group-head is-active"
                  : "sidebar__group-head"
              }
            >
              <button
                type="button"
                className="sidebar__group-toggle"
                aria-expanded={agentOpen}
                onClick={onToggleAgent}
              >
                <span className="sidebar__row-icon" aria-hidden>
                  <IconChat size={15} />
                </span>
                <span className="sidebar__row-text">Agent</span>
                <span className="sidebar__chevron" aria-hidden>
                  {agentOpen ? "▾" : "▸"}
                </span>
              </button>
            </div>
            {agentOpen ? (
              <div className="sidebar__group-body sidebar__agent-rail">{agentRail}</div>
            ) : null}
          </section>
        ) : null}

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
                <span className="sidebar__row-icon" aria-hidden>
                  <IconKnowledge size={15} />
                </span>
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
            className={settingsOpen ? "sidebar__settings is-active" : "sidebar__settings"}
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
