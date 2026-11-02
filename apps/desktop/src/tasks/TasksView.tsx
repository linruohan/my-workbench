import { useEffect, useMemo, useState } from "react";
import {
  computeTaskStats,
  filterTasks,
  formatLocalDay,
  listChildTasks,
  sortTasks,
  type ProjectBucket,
  type ReminderOptionId,
  type Tag,
  type Task,
  type TaskBoardColumnId,
  type TaskSortKey,
  type TaskStatusFilter,
} from "@wb/domain";
import { useDialog } from "../shell/Dialogs";
import { TaskBoard } from "./TaskBoard";
import { TaskEditor, type TaskEditorSave } from "./TaskEditor";
import { TaskRow } from "./TaskRow";
import { TaskStatsPanel } from "./TaskStatsPanel";

export type TasksViewMode = "list" | "board" | "stats";

const FILTER_KEY = "wb.tasks.filterPrefs";

type FilterPrefs = {
  status: TaskStatusFilter;
  sortKey: TaskSortKey;
};

function readFilterPrefs(): FilterPrefs {
  try {
    const raw = localStorage.getItem(FILTER_KEY);
    if (!raw) {
      return { status: "all", sortKey: "updated" };
    }
    const parsed = JSON.parse(raw) as Partial<FilterPrefs>;
    return {
      status: parsed.status ?? "all",
      sortKey: parsed.sortKey ?? "updated",
    };
  } catch {
    return { status: "all", sortKey: "updated" };
  }
}

type Props = {
  tasks: Task[];
  projects: Array<{ id: string; title: string }>;
  tags: Tag[];
  taskTagMap: Record<string, Tag[]>;
  buckets: Record<string, ProjectBucket>;
  /** 项目视图下必填：每个项目只看自己的任务。 */
  filterProjectId: string;
  viewMode: TasksViewMode;
  showCompleted: boolean;
  denseMeta?: boolean;
  defaultRemind: ReminderOptionId;
  confirmBeforeDelete: boolean;
  activeTimerTaskId: string | null;
  timerElapsedMs: number;
  nowMs: number;
  onViewModeChange: (mode: TasksViewMode) => void;
  onShowCompletedChange: (show: boolean) => void;
  onToggleDone: (task: Task) => void;
  onPlanToday: (task: Task) => void;
  onPlanTime: (task: Task) => void;
  onClearPlan: (task: Task) => void;
  onToggleTimer: (task: Task) => void;
  onMoveColumn: (taskId: string, column: TaskBoardColumnId) => void;
  onSaveTask: (taskId: string, draft: TaskEditorSave) => void;
  onDeleteTask: (taskId: string) => void;
  onDuplicateTask: (taskId: string) => void;
  onClearCompleted: (taskIds: string[]) => void;
  onCreateTag: (title: string) => Tag | null;
  onAddSubtask: (parentId: string, title: string) => void;
};

const VIEW_MODES: Array<{ id: TasksViewMode; label: string }> = [
  { id: "list", label: "列表" },
  { id: "board", label: "看板" },
  { id: "stats", label: "统计" },
];

export function TasksView({
  tasks,
  projects,
  tags,
  taskTagMap,
  buckets,
  filterProjectId,
  viewMode,
  showCompleted,
  denseMeta,
  defaultRemind,
  confirmBeforeDelete,
  activeTimerTaskId,
  timerElapsedMs,
  nowMs,
  onViewModeChange,
  onShowCompletedChange,
  onToggleDone,
  onPlanToday,
  onPlanTime,
  onClearPlan,
  onToggleTimer,
  onMoveColumn,
  onSaveTask,
  onDeleteTask,
  onDuplicateTask,
  onClearCompleted,
  onCreateTag,
  onAddSubtask,
}: Props) {
  const dialog = useDialog();
  const initialPrefs = useMemo(() => readFilterPrefs(), []);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<TaskStatusFilter>(initialPrefs.status);
  const [sortKey, setSortKey] = useState<TaskSortKey>(initialPrefs.sortKey);
  const [filterTagId, setFilterTagId] = useState<string | null>(null);
  const today = formatLocalDay(nowMs);
  const isStats = viewMode === "stats";

  useEffect(() => {
    localStorage.setItem(
      FILTER_KEY,
      JSON.stringify({ status, sortKey } satisfies FilterPrefs),
    );
  }, [status, sortKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && editingId) {
        setEditingId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editingId]);

  const projectTitles = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of projects) map[p.id] = p.title;
    return map;
  }, [projects]);

  const scopedTasks = useMemo(
    () => tasks.filter((t) => t.projectId === filterProjectId),
    [tasks, filterProjectId],
  );

  const stats = useMemo(
    () => computeTaskStats(scopedTasks, { today }),
    [scopedTasks, today],
  );

  const visible = useMemo(() => {
    const filtered = filterTasks(scopedTasks, {
      query,
      status,
      showCompleted: status === "all" ? showCompleted : true,
      today,
      rootsOnly: true,
    }).filter((task) => {
      if (!filterTagId) return true;
      return (taskTagMap[task.id] ?? []).some((t) => t.id === filterTagId);
    });
    return sortTasks(filtered, sortKey);
  }, [
    scopedTasks,
    query,
    status,
    showCompleted,
    today,
    sortKey,
    filterTagId,
    taskTagMap,
  ]);

  const editing = editingId ? (tasks.find((t) => t.id === editingId) ?? null) : null;
  const editingSubtasks = editing ? listChildTasks(tasks, editing.id) : [];

  const title = projectTitles[filterProjectId] ?? "项目";

  const confirmDelete = async (taskId: string) => {
    if (confirmBeforeDelete) {
      const ok = await dialog.confirm({
        title: "删除任务",
        message: "确定删除该任务？此操作不可撤销。",
        confirmLabel: "删除",
        danger: true,
      });
      if (!ok) return;
    }
    onDeleteTask(taskId);
    setEditingId((prev) => (prev === taskId ? null : prev));
  };

  const drillFromStats = (next: Exclude<TaskStatusFilter, "all">) => {
    setStatus(next);
    onViewModeChange("list");
  };

  const doneInScope = scopedTasks.filter((t) => t.isDone && !t.parentId);
  const openVisible = visible.filter((t) => !t.isDone);

  return (
    <section className="tasks panel">
      <header className="tasks__header">
        <div className="tasks__title-row">
          <h1>{title}</h1>
          <span className="panel__count">{isStats ? stats.total : visible.length}</span>
        </div>
        <div className="tasks__toolbar">
          {!isStats ? (
            <label className="tasks__check">
              <input
                type="checkbox"
                checked={showCompleted}
                onChange={(e) => onShowCompletedChange(e.target.checked)}
                disabled={status !== "all"}
              />
              显示已完成
            </label>
          ) : null}

          <div className="tasks__view-toggle" role="group" aria-label="视图切换">
            {VIEW_MODES.map((mode) => (
              <button
                key={mode.id}
                type="button"
                className={
                  viewMode === mode.id ? "tasks__view-btn is-active" : "tasks__view-btn"
                }
                aria-pressed={viewMode === mode.id}
                onClick={() => onViewModeChange(mode.id)}
              >
                {mode.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {isStats ? (
        <div className="tasks__content">
          <div className="tasks__main">
            <TaskStatsPanel
              stats={stats}
              projectTitles={projectTitles}
              onDrill={drillFromStats}
            />
          </div>
        </div>
      ) : (
        <>
          <div className="tasks__filters">
            <input
              className="tasks__search"
              aria-label="搜索任务"
              placeholder="搜索标题或备注…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select
              aria-label="状态筛选"
              value={status}
              onChange={(e) => setStatus(e.target.value as TaskStatusFilter)}
            >
              <option value="all">全部状态</option>
              <option value="open">未完成</option>
              <option value="today">今日到期</option>
              <option value="overdue">已逾期</option>
              <option value="unplanned">未排期</option>
              <option value="done">已完成</option>
            </select>
            <select
              aria-label="标签筛选"
              value={filterTagId ?? ""}
              onChange={(e) => setFilterTagId(e.target.value ? e.target.value : null)}
            >
              <option value="">全部标签</option>
              {tags.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.title}
                </option>
              ))}
            </select>
            <select
              aria-label="排序"
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as TaskSortKey)}
            >
              <option value="updated">最近更新</option>
              <option value="created">最近创建</option>
              <option value="due">计划日期</option>
              <option value="title">标题</option>
            </select>
          </div>

          <div className="tasks__bulk" role="toolbar" aria-label="批量操作">
            <button
              type="button"
              className="btn btn--ghost"
              disabled={openVisible.length === 0}
              onClick={() => openVisible.forEach(onPlanToday)}
            >
              可见项排到今天 ({openVisible.length})
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={doneInScope.length === 0}
              onClick={() => {
                void (async () => {
                  if (confirmBeforeDelete) {
                    const ok = await dialog.confirm({
                      title: "清理已完成",
                      message: `确定清理 ${doneInScope.length} 个已完成任务？此操作不可撤销。`,
                      confirmLabel: "清理",
                      danger: true,
                    });
                    if (!ok) return;
                  }
                  onClearCompleted(doneInScope.map((t) => t.id));
                })();
              }}
            >
              清理已完成 ({doneInScope.length})
            </button>
            {(query || filterTagId || status !== "all") && (
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => {
                  setQuery("");
                  setFilterTagId(null);
                  setStatus("all");
                }}
              >
                清空筛选
              </button>
            )}
            <span className="tasks__bulk-hint">Esc 关闭编辑 · Ctrl+N 底部输入</span>
          </div>

          <div className="tasks__content">
            <div className="tasks__main">
              {viewMode === "list" ? (
                visible.length === 0 ? (
                  <p className="empty">没有匹配的任务。调整筛选，或用底部输入添加。</p>
                ) : (
                  <ul className="list" aria-label="任务列表">
                    {visible.map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        tags={taskTagMap[task.id] ?? []}
                        childCount={listChildTasks(tasks, task.id).length}
                        denseMeta={denseMeta}
                        showDoneStyle
                        nowMs={nowMs}
                        timerRunning={activeTimerTaskId === task.id}
                        timerElapsedMs={
                          activeTimerTaskId === task.id ? timerElapsedMs : 0
                        }
                        onToggleDone={onToggleDone}
                        onOpen={(t) => setEditingId(t.id)}
                      />
                    ))}
                  </ul>
                )
              ) : (
                <TaskBoard
                  tasks={visible}
                  buckets={buckets}
                  projectTitles={projectTitles}
                  nowMs={nowMs}
                  onOpen={(t) => setEditingId(t.id)}
                  onToggleDone={onToggleDone}
                  onMoveColumn={onMoveColumn}
                />
              )}
            </div>
          </div>

          {editing ? (
            <TaskEditor
              key={editing.id}
              task={editing}
              bucket={buckets[editing.id] ?? "active"}
              projects={projects}
              tags={tags}
              selectedTagIds={(taskTagMap[editing.id] ?? []).map((t) => t.id)}
              subtasks={editingSubtasks}
              defaultRemind={defaultRemind}
              nowMs={nowMs}
              onClose={() => setEditingId(null)}
              onDelete={() => void confirmDelete(editing.id)}
              onDuplicate={() => {
                onDuplicateTask(editing.id);
                setEditingId(null);
              }}
              onCreateTag={onCreateTag}
              onAddSubtask={(subTitle) => onAddSubtask(editing.id, subTitle)}
              onToggleSubtask={onToggleDone}
              onDeleteSubtask={(id) => void confirmDelete(id)}
              onSave={(draft) => {
                onSaveTask(editing.id, draft);
                setEditingId(null);
              }}
            />
          ) : null}
        </>
      )}
    </section>
  );
}
