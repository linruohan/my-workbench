import { useState } from "react";
import {
  TASK_BOARD_COLUMNS,
  formatTaskPlanMeta,
  resolveTaskBoardColumn,
  type ProjectBucket,
  type Task,
  type TaskBoardColumnId,
} from "@wb/domain";

type Props = {
  tasks: Task[];
  buckets: Record<string, ProjectBucket>;
  projectTitles: Record<string, string>;
  nowMs?: number;
  onOpen: (task: Task) => void;
  onToggleDone: (task: Task) => void;
  onMoveColumn: (taskId: string, column: TaskBoardColumnId) => void;
  onPlanToday?: (task: Task) => void;
};

export function TaskBoard({
  tasks,
  buckets,
  projectTitles,
  nowMs,
  onOpen,
  onToggleDone,
  onMoveColumn,
  onPlanToday,
}: Props) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<TaskBoardColumnId | null>(null);

  const grouped: Record<TaskBoardColumnId, Task[]> = {
    active: [],
    backlog: [],
    done: [],
  };
  for (const task of tasks) {
    const col = resolveTaskBoardColumn(task, buckets[task.id] ?? "active");
    grouped[col].push(task);
  }

  return (
    <div className="task-board" role="list" aria-label="任务看板">
      {TASK_BOARD_COLUMNS.map((col) => (
        <section
          key={col.id}
          className={
            overColumn === col.id ? "task-board__col is-over" : "task-board__col"
          }
          aria-label={col.label}
          onDragOver={(e) => {
            e.preventDefault();
            setOverColumn(col.id);
          }}
          onDragLeave={() => setOverColumn((cur) => (cur === col.id ? null : cur))}
          onDrop={(e) => {
            e.preventDefault();
            const id = e.dataTransfer.getData("text/task-id") || draggingId || "";
            setOverColumn(null);
            setDraggingId(null);
            if (id) onMoveColumn(id, col.id);
          }}
        >
          <header className="task-board__col-head">
            <h2>{col.label}</h2>
            <span>{grouped[col.id].length}</span>
          </header>
          <ul className="task-board__cards">
            {grouped[col.id].length === 0 ? (
              <li className="task-board__empty">拖拽任务到此处</li>
            ) : (
              grouped[col.id].map((task) => (
                <li key={task.id}>
                  <article
                    className={task.isDone ? "task-card is-done" : "task-card"}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/task-id", task.id);
                      e.dataTransfer.effectAllowed = "move";
                      setDraggingId(task.id);
                    }}
                    onDragEnd={() => {
                      setDraggingId(null);
                      setOverColumn(null);
                    }}
                  >
                    <div className="task-card__top">
                      <button
                        type="button"
                        className={task.isDone ? "check is-checked" : "check"}
                        aria-label={
                          task.isDone ? `取消完成 ${task.title}` : `完成 ${task.title}`
                        }
                        onClick={() => onToggleDone(task)}
                      />
                      <button
                        type="button"
                        className="task-card__title"
                        onClick={() => onOpen(task)}
                      >
                        {task.title}
                      </button>
                    </div>
                    <div className="task-card__meta">
                      {formatTaskPlanMeta(task, nowMs)}
                      {projectTitles[task.projectId]
                        ? ` · ${projectTitles[task.projectId]}`
                        : ""}
                    </div>
                    {!task.isDone && onPlanToday ? (
                      <div className="task-card__actions">
                        <button type="button" onClick={() => onPlanToday(task)}>
                          今天
                        </button>
                      </div>
                    ) : null}
                  </article>
                </li>
              ))
            )}
          </ul>
        </section>
      ))}
    </div>
  );
}
