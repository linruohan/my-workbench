import { useMemo, useState } from "react";
import {
  type ProjectBucket,
  type ReminderOptionId,
  type Task,
  type TaskBoardColumnId,
} from "@wb/domain";
import { TaskBoard } from "./TaskBoard";
import { TaskEditor, type TaskEditorSave } from "./TaskEditor";
import { TaskRow } from "./TaskRow";

export type TasksViewMode = "list" | "board";

type Props = {
  tasks: Task[];
  projects: Array<{ id: string; title: string }>;
  buckets: Record<string, ProjectBucket>;
  filterProjectId: string | null;
  viewMode: TasksViewMode;
  showCompleted: boolean;
  denseMeta?: boolean;
  defaultRemind: ReminderOptionId;
  confirmBeforeDelete: boolean;
  onViewModeChange: (mode: TasksViewMode) => void;
  onFilterProject: (projectId: string | null) => void;
  onShowCompletedChange: (show: boolean) => void;
  onToggleDone: (task: Task) => void;
  onPlanToday: (task: Task) => void;
  onPlanTime: (task: Task) => void;
  onMoveColumn: (taskId: string, column: TaskBoardColumnId) => void;
  onSaveTask: (taskId: string, draft: TaskEditorSave) => void;
  onDeleteTask: (taskId: string) => void;
  onCreate: (title: string) => void;
};

export function TasksView({
  tasks,
  projects,
  buckets,
  filterProjectId,
  viewMode,
  showCompleted,
  denseMeta,
  defaultRemind,
  confirmBeforeDelete,
  onViewModeChange,
  onFilterProject,
  onShowCompletedChange,
  onToggleDone,
  onPlanToday,
  onPlanTime,
  onMoveColumn,
  onSaveTask,
  onDeleteTask,
  onCreate,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [createTitle, setCreateTitle] = useState("");

  const projectTitles = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of projects) map[p.id] = p.title;
    return map;
  }, [projects]);

  const visible = useMemo(() => {
    return tasks.filter((t) => {
      if (filterProjectId && t.projectId !== filterProjectId) return false;
      if (!showCompleted && t.isDone) return false;
      return true;
    });
  }, [tasks, filterProjectId, showCompleted]);

  const editing = editingId
    ? (tasks.find((t) => t.id === editingId) ?? null)
    : null;

  const title = filterProjectId
    ? (projectTitles[filterProjectId] ?? "任务")
    : "全部任务";

  const submitCreate = () => {
    const text = createTitle.trim();
    if (!text) return;
    onCreate(text);
    setCreateTitle("");
  };

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

      <div className="tasks__content">
        <div className="tasks__main">
          {viewMode === "list" ? (
            visible.length === 0 ? (
              <p className="empty">还没有任务。用下方输入框新建，或用快速捕获。</p>
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
                    denseMeta={denseMeta}
                    showDoneStyle
                    onToggleDone={onToggleDone}
                    onOpen={(t) => setEditingId(t.id)}
                    onPlanToday={onPlanToday}
                    onPlanTime={onPlanTime}
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
            />
          )}

          <div className="tasks__create">
            <input
              aria-label="新建任务标题"
              placeholder="新建任务，回车添加"
              value={createTitle}
              onChange={(e) => setCreateTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitCreate();
              }}
            />
            <button type="button" className="btn btn--primary" onClick={submitCreate}>
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
            defaultRemind={defaultRemind}
            onClose={() => setEditingId(null)}
            onDelete={() => {
              if (
                confirmBeforeDelete &&
                !window.confirm("确定删除该任务？此操作不可撤销。")
              ) {
                return;
              }
              onDeleteTask(editing.id);
              setEditingId(null);
            }}
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
