import { useEffect, useState } from "react";
import type { MemoryWorkbenchRepository } from "@wb/db/memory";
import {
  DEFAULT_AGENT_WORKSPACE_TITLE,
  filterAgentThreads,
  formatAgentRelativeShort,
  groupAgentThreadsByWorkspace,
  orderAgentWorkspaceThreads,
  type AgentThread,
} from "@wb/domain";
import { useDialog } from "../shell/Dialogs";
import {
  IconFolder,
  IconFolderOpen,
  IconMore,
  IconPencil,
  IconPin,
  IconPlus,
} from "../shell/icons";

type Props = {
  store: MemoryWorkbenchRepository;
  threadId: string | null;
  /** Session currently answering, for a side-rail status dot. */
  busyThreadId?: string | null;
  onSelectThread: (id: string | null) => void;
  onCreateThread: (workspaceId: string) => void;
  /** Drop queued prompts kept only in the open chat. */
  onForgetThread?: (id: string) => void;
  onRefresh: () => void;
};

export function AgentWorkspaceRail({
  store,
  threadId,
  busyThreadId = null,
  onSelectThread,
  onCreateThread,
  onForgetThread,
  onRefresh,
}: Props) {
  const dialog = useDialog();
  const workspaces = store.listAgentWorkspaces();
  const [threadQuery, setThreadQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const threads = store.listAgentThreads({ includeArchived: showArchived });
  const visibleThreads = filterAgentThreads(threads, threadQuery);
  const thread = threadId
    ? (store.getAgentThread(threadId) ?? null)
    : (threads[0] ?? null);
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
    if (!threadMenuId && !workspaceMenuId) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".agent__thread-actions")) return;
      if (target?.closest(".agent__workspace-actions")) return;
      setThreadMenuId(null);
      setWorkspaceMenuId(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setThreadMenuId(null);
      setWorkspaceMenuId(null);
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [threadMenuId, workspaceMenuId]);

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
    if (thread?.id === item.id) {
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

  const workspaceGroups = groupAgentThreadsByWorkspace(workspaces, visibleThreads);
  const filtering = Boolean(threadQuery.trim()) || showArchived;
  const filterMiss = filtering && visibleThreads.length === 0;

  return (
    <aside className="agent__threads" aria-label="工作区">
      {workspaces.length === 0 ? (
        <p className="agent__hint">还没有工作区。点「+」选择一个文件夹。</p>
      ) : (
        <>
          <div className="agent__thread-filter">
            <input
              type="search"
              value={threadQuery}
              placeholder="筛选会话"
              aria-label="筛选会话"
              onChange={(event) => setThreadQuery(event.target.value)}
            />
            <label className="agent__thread-filter-archived">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(event) => setShowArchived(event.target.checked)}
              />
              显示归档
            </label>
          </div>
          {filterMiss ? (
            <p className="agent__hint">没有匹配的会话</p>
          ) : (
            <div className="agent__thread-list">
              {workspaceGroups.map(({ workspace, threads: items }) => {
                if (filtering && items.length === 0) return null;
                const collapsed =
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
                              commitWorkspaceTitle(
                                workspace.id,
                                event.currentTarget.value,
                              );
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
                                menuOpen
                                  ? "agent__thread-row is-open"
                                  : "agent__thread-row"
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
                                      commitThreadTitle(
                                        item.id,
                                        event.currentTarget.value,
                                      );
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
                                  {item.pinnedAt != null ? (
                                    <IconPin size={12} className="agent__thread-pin" />
                                  ) : null}
                                  {busyThreadId === item.id ? (
                                    <span
                                      className="agent__thread-busy"
                                      title="正在回答"
                                      aria-label="正在回答"
                                    />
                                  ) : null}
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
                                      onClick={() =>
                                        void removeThread(item.id, item.title)
                                      }
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
        </>
      )}
    </aside>
  );
}
