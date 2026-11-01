import {
  formatTaskPlanMeta,
  isTaskOverdue,
  type Task,
} from "@wb/domain";

type Props = {
  task: Task;
  projectTitle?: string;
  childCount?: number;
  denseMeta?: boolean;
  showDoneStyle?: boolean;
  onToggleDone: (task: Task) => void;
  onOpen: (task: Task) => void;
  onPlanToday?: (task: Task) => void;
  onPlanTime?: (task: Task) => void;
  onDelete?: (task: Task) => void;
  onDuplicate?: (task: Task) => void;
  draggable?: boolean;
  onDragStart?: (taskId: string) => void;
};

export function TaskRow({
  task,
  projectTitle,
  childCount = 0,
  denseMeta,
  showDoneStyle,
  onToggleDone,
  onOpen,
  onPlanToday,
  onPlanTime,
  onDelete,
  onDuplicate,
  draggable,
  onDragStart,
}: Props) {
  const overdue = isTaskOverdue(task);

  return (
    <li
      className={[
        "list__row",
        showDoneStyle && task.isDone ? "is-done" : "",
        overdue ? "is-overdue" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      draggable={draggable}
      onDragStart={
        draggable && onDragStart
          ? (e) => {
              e.dataTransfer.setData("text/task-id", task.id);
              e.dataTransfer.effectAllowed = "move";
              onDragStart(task.id);
            }
          : undefined
      }
    >
      <button
        type="button"
        className={task.isDone ? "check is-checked" : "check"}
        aria-label={task.isDone ? `取消完成 ${task.title}` : `完成 ${task.title}`}
        onClick={() => onToggleDone(task)}
      />
      <button
        type="button"
        className="list__body list__body--btn"
        aria-label={`打开 ${task.title}`}
        onClick={() => onOpen(task)}
      >
        <div className="list__title">
          {task.title}
          {childCount > 0 ? (
            <span className="list__badge">{childCount} 子任务</span>
          ) : null}
          {overdue ? <span className="list__badge list__badge--warn">逾期</span> : null}
        </div>
        {denseMeta ? null : (
          <div className="list__meta">
            {formatTaskPlanMeta(task)}
            {projectTitle ? ` · ${projectTitle}` : ""}
            {task.timeEstimate > 0
              ? ` · 预计 ${Math.round(task.timeEstimate / 60_000)} 分`
              : ""}
          </div>
        )}
      </button>
      <div className="list__actions">
        {onPlanToday ? (
          <button type="button" onClick={() => onPlanToday(task)}>
            今天
          </button>
        ) : null}
        {onPlanTime ? (
          <button type="button" onClick={() => onPlanTime(task)}>
            15:00
          </button>
        ) : null}
        {onDuplicate ? (
          <button type="button" onClick={() => onDuplicate(task)}>
            复制
          </button>
        ) : null}
        {onDelete ? (
          <button type="button" onClick={() => onDelete(task)}>
            删除
          </button>
        ) : null}
      </div>
    </li>
  );
}
