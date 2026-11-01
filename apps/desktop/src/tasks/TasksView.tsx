import { useEffect, useMemo, useRef, useState } from "react";
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
import { TaskBoard } from "./TaskBoard";
import { TaskEditor, type TaskEditorSave } from "./TaskEditor";
import { TaskRow } from "./TaskRow";
import { TaskStatsPanel } from "./TaskStatsPanel";

export type TasksViewMode = "list" | "board";

const FILTER_KEY = "wb.tasks.filterPrefs";

type FilterPrefs = {
  status: TaskStatusFilter;
  sortKey: TaskSortKey;
  statsExpanded: boolean;
};

function readFilterPrefs(): FilterPrefs {
  try {
    const raw = localStorage.getItem(FILTER_KEY);
    if (!raw) {
      return { status: "all", sortKey: "updated", statsExpanded: false };
    }
    const parsed = JSON.parse(raw) as Partial<FilterPrefs>;
    return {
      status: parsed.status ?? "all",
      sortKey: parsed.sortKey ?? "updated",
      statsExpanded: Boolean(parsed.statsExpanded),
    };
  } catch {
    return { status: "all", sortKey: "updated", statsExpanded: false };
  }
}

type Props = {
  tasks: Task[];
  projects: Array<{ id: string; title: string }>;
  tags: Tag[];
  taskTagMap: Record<string, Tag[]>;
  buckets: Record<string, ProjectBucket>;
  filterProjectId: string | null;
  viewMode: TasksViewMode;
  showCompleted: boolean;
  denseMeta?: boolean;
  defaultRemind: ReminderOptionId;
  confirmBeforeDelete: boolean;
  activeTimerTaskId: string | null;
  timerElapsedMs: number;
  onViewModeChange: (mode: TasksViewMode) => void;
  onFilterProject: (projectId: string | null) => void;
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
  onCreate: (title: string) => void;
};

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
  onViewModeChange,
  onFilterProject,
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
  onCreate,
}: Props) {
  const initialPrefs = useMemo(() => readFilterPrefs(), []);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [createTitle, setCreateTitle] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<TaskStatusFilter>(initialPrefs.status);
  const [sortKey, setSortKey] = useState<TaskSortKey>(initialPrefs.sortKey);
  const [filterTagId, setFilterTagId] = useState<string | null>(null);
  const [statsExpanded, setStatsExpanded] = useState(
    initialPrefs.statsExpanded,
  );
  const [today] = useState(() => formatLocalDay(Date.now()));
  const createRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    localStorage.setItem(
      FILTER_KEY,
      JSON.stringify({ status, sortKey, statsExpanded } satisfies FilterPrefs),
    );
  }, [status, sortKey, statsExpanded]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && editingId) {
        setEditingId(null);
        return;
      }
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key.toLowerCase() === "n" &&
        !editingId
      ) {
        e.preventDefault();
        createRef.current?.focus();
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

  const scopedTasks = useMemo(() => {
    if (!filterProjectId) return tasks;
    return tasks.filter((t) => t.projectId === filterProjectId);
  }, [tasks, filterProjectId]);

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

  const editing = editingId
    ? (tasks.find((t) => t.id === editingId) ?? null)
    : null;
  const editingSubtasks = editing
    ? listChildTasks(tasks, editing.id)
    : [];

  const title = filterProjectId
    ? (projectTitles[filterProjectId] ?? "任务")
    : "全部任务";

  const confirmDelete = (taskId: string) => {
    if (
      confirmBeforeDelete &&
      !window.confirm("确定删除该任务？此操作不可撤销。")
    ) {
      return;
    }
    onDeleteTask(taskId);
    setEditingId((prev) => (prev === taskId ? null : prev));
  };

  const submitCreate = () => {
    const text = createTitle.trim();
    if (!text) return;
    onCreate(text);
    setCreateTitle("");
  };

  const doneInScope = scopedTasks.filter((t) => t.isDone && !t.parentId);
  const openVisible = visible.filter((t) => !t.isDone);

  return (
    <section className={editing ? "tasks panel tasks--editing" : "tasks panel"}>
      <header className="tasks__header">
        <div className="tasks__title-row">
          <h1>{title}</h1>
          <span className="panel__count">{visible.length}</span>
        </div>
        <div className="tasks__toolbar">
          <label className="tasks__filter">
            <span className="sr-only">筛选项目</span>
            <select
              aria-label="筛选项目"
              value={filterProjectId ?? ""}
              onChange={(e) =>
                onFilterProject(e.target.value ? e.target.value : null)
              }
            >
              <option value="">全部项目</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </label>

          <label className="tasks__check">
            <input
              type="checkbox"
              checked={showCompleted}
              onChange={(e) => onShowCompletedChange(e.target.checked)}
              disabled={status !== "all"}
            />
            显示已完成
          </label>

          <div className="tasks__view-toggle" role="group" aria-label="视图切换">
            <button
              type="button"
              className={
                viewMode === "list"
                  ? "tasks__view-btn is-active"
                  : "tasks__view-btn"
              }
              aria-pressed={viewMode === "list"}
              onClick={() => onViewModeChange("list")}
            >
              列表
            </button>
            <button
              type="button"
              className={
                viewMode === "board"
                  ? "tasks__view-btn is-active"
                  : "tasks__view-btn"
              }
              aria-pressed={viewMode === "board"}
              onClick={() => onViewModeChange("board")}
            >
              看板
            </button>
          </div>
        </div>
      </header>

      <TaskStatsPanel
        stats={stats}
        projectTitles={projectTitles}
        expanded={statsExpanded}
        onToggle={() => setStatsExpanded((v) => !v)}
        onSelectStatus={(next) =>
          setStatus(next === "done" ? "done" : next)
        }
      />

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
          onChange={(e) =>
            setFilterTagId(e.target.value ? e.target.value : null)
          }
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
            if (
              confirmBeforeDelete &&
              !window.confirm(
                `确定清理 ${doneInScope.length} 个已完成任务？此操作不可撤销。`,
              )
            ) {
              return;
            }
            onClearCompleted(doneInScope.map((t) => t.id));
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
        <span className="tasks__bulk-hint">Esc 关闭编辑 · Ctrl+N 新建</span>
      </div>

      <div className="tasks__content">
        <div className="tasks__main">
          {viewMode === "list" ? (
            visible.length === 0 ? (
              <p className="empty">没有匹配的任务。调整筛选，或在下方新建。</p>
            ) : (
              <ul className="list" aria-label="任务列表">
                {visible.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    projectTitle={
                      filterProjectId
                        ? undefined
                        : projectTitles[task.projectId]
                    }
                    tags={taskTagMap[task.id] ?? []}
                    childCount={listChildTasks(tasks, task.id).length}
                    denseMeta={denseMeta}
                    showDoneStyle
                    timerRunning={activeTimerTaskId === task.id}
                    timerElapsedMs={
                      activeTimerTaskId === task.id ? timerElapsedMs : 0
                    }
                    canTime={listChildTasks(tasks, task.id).length === 0}
                    onToggleDone={onToggleDone}
                    onOpen={(t) => setEditingId(t.id)}
                    onPlanToday={onPlanToday}
                    onPlanTime={onPlanTime}
                    onClearPlan={onClearPlan}
                    onToggleTimer={onToggleTimer}
                    onDuplicate={(t) => onDuplicateTask(t.id)}
                    onDelete={(t) => confirmDelete(t.id)}
                  />
                ))}
              </ul>
            )
          ) : (
            <TaskBoard
              tasks={visible}
              buckets={buckets}
              projectTitles={projectTitles}
              onOpen={(t) => setEditingId(t.id)}
              onToggleDone={onToggleDone}
              onMoveColumn={onMoveColumn}
              onPlanToday={onPlanToday}
            />
          )}

          <div className="tasks__create">
            <input
              ref={createRef}
              aria-label="新建任务标题"
              placeholder="新建任务，回车添加（Ctrl+N）"
              value={createTitle}
              onChange={(e) => setCreateTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitCreate();
              }}
            />
            <button
              type="button"
              className="btn btn--primary"
              onClick={submitCreate}
            >
              添加
            </button>
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
            onClose={() => setEditingId(null)}
            onDelete={() => confirmDelete(editing.id)}
            onDuplicate={() => {
              onDuplicateTask(editing.id);
              setEditingId(null);
            }}
            onCreateTag={onCreateTag}
            onAddSubtask={(subTitle) => onAddSubtask(editing.id, subTitle)}
            onToggleSubtask={onToggleDone}
            onDeleteSubtask={(id) => confirmDelete(id)}
            onSave={(draft) => {
              onSaveTask(editing.id, draft);
              setEditingId(null);
            }}
          />
        ) : null}
      </div>
    </section>
  );
}
