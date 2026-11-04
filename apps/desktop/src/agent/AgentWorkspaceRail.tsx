import { useEffect, useState } from "react";
import type { MemoryWorkbenchRepository } from "@wb/db/memory";
import {
  DEFAULT_AGENT_WORKSPACE_TITLE,
  WEB_AGENT_THREAD_TITLE,
  filterAgentThreads,
  formatAgentRelativeShort,
  groupAgentThreadsByWorkspace,
  normalizeAgentWebUrl,
  orderAgentWorkspaceThreads,
  type AgentThread,
} from "@wb/domain";
import { useDialog } from "../shell/Dialogs";
import {
  IconFilter,
  IconFolder,
  IconFolderOpen,
  IconGlobe,
  IconMore,
  IconPencil,
  IconPlus,
  IconSearch,
} from "../shell/icons";
import { readProviderStore } from "./providers";

type Props = {
  store: MemoryWorkbenchRepository;
  threadId: string | null;
  onSelectThread: (id: string | null) => void;
  onCreateThread: (workspaceId: string) => void;
  onCreateFromFolder: () => void;
  /** Drop queued prompts kept only in the open chat. */
  onForgetThread?: (id: string) => void;
  onRefresh: () => void;
};

export function AgentWorkspaceRail({
  store,
  threadId,
  onSelectThread,
  onCreateThread,
  onCreateFromFolder,
  onForgetThread,
  onRefresh,
}: Props) {
  const dialog = useDialog();
  const workspaces = store.listAgentWorkspaces();
  const [showArchived, setShowArchived] = useState(false);
  const threads = store.listAgentThreads({ includeArchived: showArchived });
  const activeThreads = store.listAgentThreads();
  const thread = threadId
    ? (threads.find((item) => item.id === threadId) ??
      activeThreads.find((item) => item.id === threadId) ??
      null)
    : (activeThreads[0] ?? null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [threadQuery, setThreadQuery] = useState("");
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Record<string, boolean>>(
    {},
  );
  const [renamingWorkspaceId, setRenamingWorkspaceId] = useState<string | null>(null);
  const [workspaceTitleDraft, setWorkspaceTitleDraft] = useState("");
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  const [threadTitleDraft, setThreadTitleDraft] = useState("");
  const [workspaceMenuId, setWorkspaceMenuId] = useState<string | null>(null);
  const [threadMenuId, setThreadMenuId] = useState<string | null>(null);
  const nowMs = Date.now();

  useEffect(() => {
    if (!threadMenuId && !workspaceMenuId && !viewMenuOpen) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".agent__thread-actions")) return;
      if (target?.closest(".agent__workspace-actions")) return;
      if (target?.closest(".agent__threads-tool")) return;
      setThreadMenuId(null);
      setWorkspaceMenuId(null);
      setViewMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setThreadMenuId(null);
      setWorkspaceMenuId(null);
      setViewMenuOpen(false);
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [threadMenuId, workspaceMenuId, viewMenuOpen]);

  const beginRenameThread = (item: AgentThread) => {
    setThreadMenuId(null);
    setWorkspaceMenuId(null);
    setRenamingThreadId(item.id);
    setThreadTitleDraft(item.title);
  };

  const beginRenameWorkspace = (id: string, title: string) => {
    setWorkspaceMenuId(null);
    setThreadMenuId(null);
    setRenamingWorkspaceId(id);
    setWorkspaceTitleDraft(title);
  };

  const commitThreadTitle = (id: string, raw: string) => {
    const next = raw.trim();
    const current = store.getAgentThread(id);
    setRenamingThreadId(null);
    if (!current || !next || next === current.title) return;
    store.updateAgentThread(id, { title: next });
    onRefresh();
  };

  const commitWorkspaceTitle = (id: string, raw: string) => {
    const next = raw.trim();
    const current = store.getAgentWorkspace(id);
    setRenamingWorkspaceId(null);
    if (!current || !next || next === current.title) return;
    store.updateAgentWorkspace(id, { title: next });
    onRefresh();
  };

  const removeThread = async (id: string, title: string) => {
    const ok = await dialog.confirm({
      title: "删除会话",
      message: `删除会话「${title}」？对话会从本机移除。`,
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    store.deleteAgentThread(id);
    onForgetThread?.(id);
    setThreadMenuId(null);
    if (thread?.id === id) onSelectThread(store.listAgentThreads()[0]?.id ?? null);
    onRefresh();
  };

  const archiveThread = (item: AgentThread) => {
    store.archiveAgentThread(item.id);
    onForgetThread?.(item.id);
    setThreadMenuId(null);
    if (thread?.id === item.id && !showArchived) {
      onSelectThread(store.listAgentThreads()[0]?.id ?? null);
    }
    onRefresh();
  };

  const unarchiveThread = (item: AgentThread) => {
    store.unarchiveAgentThread(item.id);
    setThreadMenuId(null);
    onRefresh();
  };

  const removeWorkspace = async (id: string, title: string, count: number) => {
    const hint =
      count > 0
        ? `删除工作区「${title}」？其中的 ${count} 个会话也会从本机移除。`
        : `删除工作区「${title}」？`;
    const ok = await dialog.confirm({
      title: "删除工作区",
      message: hint,
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    const selected = thread?.workspaceId === id ? thread.id : null;
    store.deleteAgentWorkspace(id);
    setWorkspaceMenuId(null);
    setCollapsedWorkspaces((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    if (selected) onSelectThread(store.listAgentThreads()[0]?.id ?? null);
    onRefresh();
  };

  const openWebSession = async () => {
    const raw = await dialog.prompt({
      title: "打开网页",
      label: "网址",
      confirmLabel: "打开",
    });
    if (!raw) return;
    const webUrl = normalizeAgentWebUrl(raw);
    if (!webUrl) {
      await dialog.alert({ title: "无法打开", message: "请输入 http 或 https 网址。" });
      return;
    }
    const existing = store
      .listAgentWorkspaces()
      .find((item) => item.title === DEFAULT_AGENT_WORKSPACE_TITLE);
    const workspace =
      existing ?? store.createAgentWorkspace({ title: DEFAULT_AGENT_WORKSPACE_TITLE });
    const created = store.createAgentThread({
      workspaceId: workspace.id,
      title: WEB_AGENT_THREAD_TITLE,
      webUrl,
      modelRef: readProviderStore().defaultModelRef,
    });
    setCollapsedWorkspaces((current) => ({ ...current, [workspace.id]: false }));
    onSelectThread(created.id);
    onRefresh();
  };

  const needle = threadQuery.trim().toLowerCase();
  const visibleThreads = filterAgentThreads(threads, threadQuery);
  const workspaceGroups = groupAgentThreadsByWorkspace(workspaces, visibleThreads)
    .map((group) => ({
      ...group,
      titleHit: needle ? group.workspace.title.toLowerCase().includes(needle) : false,
    }))
    .filter((group) => !needle || group.titleHit || group.threads.length > 0);

  return (
    <aside className="agent__threads" aria-label="工作区">
      <header className="agent__threads-head">
        <h2>工作区</h2>
        <div className="agent__threads-tools">
          <button
            type="button"
            className={
              filterOpen || threadQuery.trim()
                ? "agent__threads-tool is-on"
                : "agent__threads-tool"
            }
            title="筛选"
            aria-label="筛选会话或工作区"
            aria-pressed={filterOpen}
            onClick={() => {
              setFilterOpen((value) => !value);
              setViewMenuOpen(false);
            }}
          >
            <IconSearch size={14} />
          </button>
          <div className="agent__threads-tool-wrap">
            <button
              type="button"
              className={
                showArchived || viewMenuOpen
                  ? "agent__threads-tool is-on"
                  : "agent__threads-tool"
              }
              title="视图"
              aria-label="视图选项"
              aria-haspopup="menu"
              aria-expanded={viewMenuOpen}
              onClick={() => {
                setViewMenuOpen((value) => !value);
                setWorkspaceMenuId(null);
                setThreadMenuId(null);
              }}
            >
              <IconFilter size={14} />
            </button>
            {viewMenuOpen ? (
              <div className="agent__thread-menu" role="menu" aria-label="视图选项">
                <button
                  type="button"
                  role="menuitem"
                  aria-checked={showArchived}
                  onClick={() => {
                    setShowArchived((value) => !value);
                    setViewMenuOpen(false);
                  }}
                >
                  {showArchived ? "隐藏已归档" : "显示已归档"}
                </button>
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="agent__threads-tool agent__threads-tool--text"
            title="打开网页"
            aria-label="网页"
            onClick={() => void openWebSession()}
          >
            <IconGlobe size={14} />
            <span>网页</span>
          </button>
          <button
            type="button"
            className="agent__threads-tool"
            title="选择文件夹并新建会话"
            aria-label="新建会话"
            onClick={onCreateFromFolder}
          >
            <IconPlus size={14} />
          </button>
        </div>
      </header>
      {filterOpen || threadQuery.trim() ? (
        <label className="agent__thread-filter">
          <input
            aria-label="筛选会话"
            placeholder="筛选会话或工作区"
            value={threadQuery}
            autoFocus={filterOpen}
            onChange={(event) => setThreadQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setThreadQuery("");
                setFilterOpen(false);
              }
            }}
          />
        </label>
      ) : null}
      {workspaces.length === 0 ? (
        <p className="agent__hint">还没有工作区。点「+」选择一个文件夹。</p>
      ) : workspaceGroups.length === 0 ? (
        <p className="agent__hint">没有匹配的会话。</p>
      ) : (
        <div className="agent__thread-list">
          {workspaceGroups.map(({ workspace, threads: items, titleHit }) => {
            const collapsed =
              !needle &&
              !titleHit &&
              collapsedWorkspaces[workspace.id] === true &&
              thread?.workspaceId !== workspace.id;
            const totalCount = store.listAgentThreads({
              workspaceId: workspace.id,
              includeArchived: true,
            }).length;
            const workspaceMenuOpen = workspaceMenuId === workspace.id;
            return (
              <section
                key={workspace.id}
                className="agent__workspace"
                aria-label={workspace.title}
              >
                <div
                  className={
                    workspaceMenuOpen
                      ? "agent__workspace-head is-open"
                      : "agent__workspace-head"
                  }
                >
                  {renamingWorkspaceId === workspace.id ? (
                    <input
                      className="agent__workspace-title-input"
                      aria-label="工作区名称"
                      value={workspaceTitleDraft}
                      autoFocus
                      maxLength={40}
                      onChange={(event) => setWorkspaceTitleDraft(event.target.value)}
                      onBlur={(event) =>
                        commitWorkspaceTitle(workspace.id, event.currentTarget.value)
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          commitWorkspaceTitle(workspace.id, event.currentTarget.value);
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          setRenamingWorkspaceId(null);
                        }
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="agent__workspace-title"
                      title={workspace.rootPath || workspace.title}
                      aria-expanded={!collapsed}
                      onClick={() =>
                        setCollapsedWorkspaces((current) => ({
                          ...current,
                          [workspace.id]: !collapsed,
                        }))
                      }
                    >
                      <span className="agent__workspace-icon" aria-hidden="true">
                        {collapsed ? (
                          <IconFolder size={14} />
                        ) : (
                          <IconFolderOpen size={14} />
                        )}
                      </span>
                      <span className="agent__workspace-name">{workspace.title}</span>
                    </button>
                  )}
                  <div className="agent__workspace-actions">
                    <button
                      type="button"
                      className="agent__workspace-action"
                      title="更多"
                      aria-label={`工作区操作 ${workspace.title}`}
                      aria-haspopup="menu"
                      aria-expanded={workspaceMenuOpen}
                      onClick={() => {
                        setWorkspaceMenuId(workspaceMenuOpen ? null : workspace.id);
                        setThreadMenuId(null);
                        setViewMenuOpen(false);
                      }}
                    >
                      <IconMore size={14} />
                    </button>
                    <button
                      type="button"
                      className="agent__workspace-action"
                      title="在此工作区新建会话"
                      aria-label={`在 ${workspace.title} 新建会话`}
                      onClick={() => onCreateThread(workspace.id)}
                    >
                      <IconPlus size={14} />
                    </button>
                    {workspaceMenuOpen ? (
                      <div
                        className="agent__thread-menu"
                        role="menu"
                        aria-label={`工作区「${workspace.title}」`}
                      >
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() =>
                            beginRenameWorkspace(workspace.id, workspace.title)
                          }
                        >
                          重命名
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="is-danger"
                          onClick={() =>
                            void removeWorkspace(
                              workspace.id,
                              workspace.title,
                              totalCount,
                            )
                          }
                        >
                          删除
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
                {collapsed ? null : items.length === 0 ? (
                  <p className="agent__workspace-empty">还没有会话</p>
                ) : (
                  <ul className="agent__workspace-threads">
                    {orderAgentWorkspaceThreads(
                      items,
                      workspace.title === DEFAULT_AGENT_WORKSPACE_TITLE,
                    ).map((item) => {
                      const archived = item.archivedAt != null;
                      const menuOpen = threadMenuId === item.id;
                      const age = formatAgentRelativeShort(item.updatedAt, nowMs);
                      return (
                        <li
                          key={item.id}
                          className={
                            menuOpen ? "agent__thread-row is-open" : "agent__thread-row"
                          }
                        >
                          {renamingThreadId === item.id ? (
                            <input
                              className="agent__thread-title-input"
                              aria-label="会话标题"
                              value={threadTitleDraft}
                              autoFocus
                              maxLength={40}
                              onChange={(event) =>
                                setThreadTitleDraft(event.target.value)
                              }
                              onBlur={(event) =>
                                commitThreadTitle(item.id, event.currentTarget.value)
                              }
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  commitThreadTitle(item.id, event.currentTarget.value);
                                } else if (event.key === "Escape") {
                                  event.preventDefault();
                                  setRenamingThreadId(null);
                                }
                              }}
                            />
                          ) : (
                            <button
                              type="button"
                              className={
                                thread?.id === item.id
                                  ? "agent__thread is-active"
                                  : "agent__thread"
                              }
                              title={item.webUrl || undefined}
                              onClick={() => onSelectThread(item.id)}
                            >
                              <span className="agent__thread-title">
                                {archived ? "〔归档〕 " : ""}
                                {item.title}
                              </span>
                              <span className="agent__thread-age">{age}</span>
                            </button>
                          )}
                          <div className="agent__thread-actions">
                            {renamingThreadId === item.id ? null : (
                              <button
                                type="button"
                                className="agent__thread-rename"
                                aria-label={`重命名会话 ${item.title}`}
                                title="重命名"
                                onClick={() => beginRenameThread(item)}
                              >
                                <IconPencil size={14} />
                              </button>
                            )}
                            <button
                              type="button"
                              className="agent__thread-menu-btn"
                              aria-label={`会话操作 ${item.title}`}
                              aria-haspopup="menu"
                              aria-expanded={menuOpen}
                              title="更多"
                              onClick={() => {
                                setThreadMenuId(menuOpen ? null : item.id);
                                setWorkspaceMenuId(null);
                                setViewMenuOpen(false);
                              }}
                            >
                              <IconMore size={14} />
                            </button>
                            {menuOpen ? (
                              <div
                                className="agent__thread-menu"
                                role="menu"
                                aria-label={`会话「${item.title}」`}
                              >
                                {archived ? (
                                  <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => unarchiveThread(item)}
                                  >
                                    取消归档
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => archiveThread(item)}
                                  >
                                    归档
                                  </button>
                                )}
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="is-danger"
                                  onClick={() => void removeThread(item.id, item.title)}
                                >
                                  删除
                                </button>
                              </div>
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}
    </aside>
  );
}
