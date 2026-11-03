import { useState } from "react";
import {
  TASK_BOARD_COLUMNS,
  decodeTaskRepeat,
  formatLocalDay,
  formatTaskPlanSchedule,
  isTaskOverdue,
  resolveTaskBoardColumn,
  timedScheduleLabel,
  type ProjectBucket,
  type Task,
  type TaskBoardColumnId,
} from "@wb/domain";
import { IconRepeat } from "../shell/icons";

type Props = {
  tasks: Task[];
  buckets: Record<string, ProjectBucket>;
  projectTitles: Record<string, string>;
  nowMs?: number;
  onOpen: (task: Task) => void;
  onToggleDone: (task: Task) => void;
  onMoveColumn: (taskId: string, column: TaskBoardColumnId) => void;
};

export function TaskBoard({
  tasks,
  buckets,
  projectTitles,
  nowMs = Date.now(),
  onOpen,
  onToggleDone,
  onMoveColumn,
}: Props) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<TaskBoardColumnId | null>(null);
  const today = formatLocalDay(nowMs);

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
              grouped[col.id].map((task) => {
                const plan = formatTaskPlanSchedule(task, nowMs);
                const overdue = isTaskOverdue(task, today, nowMs);
                const repeat = decodeTaskRepeat(task.repeatCfgId);
                const repeatLabel = repeat ? timedScheduleLabel(repeat) : null;
                return (
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
                        {plan || repeatLabel ? (
                          <span
                            className={overdue ? "list__plan is-overdue" : "list__plan"}
                            title={[repeatLabel, plan].filter(Boolean).join(" · ")}
                          >
                            {repeatLabel ? (
                              <span
                                className="list__plan-repeat"
                                aria-label={`重复：${repeatLabel}`}
                              >
                                <IconRepeat size={13} />
                              </span>
                            ) : null}
                            {plan ? (
                              <span className="list__plan-text">{plan}</span>
                            ) : null}
                          </span>
                        ) : null}
                        {(plan || repeatLabel) && projectTitles[task.projectId]
                          ? " · "
                          : ""}
                        {projectTitles[task.projectId] ?? ""}
                      </div>
                    </article>
                  </li>
                );
              })
            )}
          </ul>
        </section>
      ))}
    </div>
  );
}
