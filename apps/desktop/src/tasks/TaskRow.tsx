import {
  formatTaskPlanMeta,
  type Task,
} from "@wb/domain";

type Props = {
  task: Task;
  projectTitle?: string;
  denseMeta?: boolean;
  showDoneStyle?: boolean;
  onToggleDone: (task: Task) => void;
  onOpen: (task: Task) => void;
  onPlanToday?: (task: Task) => void;
  onPlanTime?: (task: Task) => void;
  draggable?: boolean;
  onDragStart?: (taskId: string) => void;
};

export function TaskRow({
  task,
  projectTitle,
  denseMeta,
  showDoneStyle,
  onToggleDone,
  onOpen,
  onPlanToday,
  onPlanTime,
  draggable,
  onDragStart,
}: Props) {
  return (
    <li
      className={
        showDoneStyle && task.isDone ? "list__row is-done" : "list__row"
      }
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
        <div className="list__title">{task.title}</div>
        {denseMeta ? null : (
          <div className="list__meta">
            {formatTaskPlanMeta(task)}
            {projectTitle ? ` · ${projectTitle}` : ""}
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
      </div>
    </li>
  );
}
