import {
  formatDurationMs,
  formatLocalDay,
  formatTaskPlanSchedule,
  isTaskOverdue,
  resolveTagChipColors,
  type Tag,
  type Task,
} from "@wb/domain";

type Props = {
  task: Task;
  projectTitle?: string;
  tags?: Tag[];
  childCount?: number;
  denseMeta?: boolean;
  showDoneStyle?: boolean;
  timerRunning?: boolean;
  timerElapsedMs?: number;
  /** Wall clock for relative plan labels (今天/明天…). */
  nowMs?: number;
  onToggleDone: (task: Task) => void;
  onOpen: (task: Task) => void;
  draggable?: boolean;
  dropTarget?: boolean;
  onDragStart?: (taskId: string) => void;
  onDragOver?: (taskId: string) => void;
  onDropOn?: (taskId: string) => void;
};

export function TaskRow({
  task,
  projectTitle,
  tags = [],
  childCount = 0,
  denseMeta,
  showDoneStyle,
  timerRunning,
  timerElapsedMs = 0,
  nowMs = Date.now(),
  onToggleDone,
  onOpen,
  draggable,
  dropTarget,
  onDragStart,
  onDragOver,
  onDropOn,
}: Props) {
  const overdue = isTaskOverdue(task, formatLocalDay(nowMs), nowMs);
  const planLabel = formatTaskPlanSchedule(task, nowMs);

  return (
    <li
      className={[
        "list__row",
        showDoneStyle && task.isDone ? "is-done" : "",
        overdue ? "is-overdue" : "",
        timerRunning ? "is-timing" : "",
        dropTarget ? "is-drop-target" : "",
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
      onDragOver={
        draggable && onDragOver
          ? (e) => {
              e.preventDefault();
              onDragOver(task.id);
            }
          : undefined
      }
      onDrop={
        draggable && onDropOn
          ? (e) => {
              e.preventDefault();
              onDropOn(task.id);
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
          <span className="list__title-text">{task.title}</span>
          {tags.length > 0 ? (
            <span className="list__tags" aria-label="标签">
              {tags.map((tag) => {
                const colors = resolveTagChipColors(tag);
                return (
                  <span
                    key={tag.id}
                    className="list__tag"
                    style={{
                      background: colors.background,
                      borderColor: colors.border,
                      color: colors.text,
                    }}
                  >
                    {tag.title}
                  </span>
                );
              })}
            </span>
          ) : null}
          {childCount > 0 ? (
            <span className="list__badge">{childCount} 子任务</span>
          ) : null}
          {timerRunning ? (
            <span className="list__badge list__badge--accent">
              计时 {formatDurationMs(timerElapsedMs)}
            </span>
          ) : null}
        </div>
        {denseMeta
          ? null
          : (() => {
              const meta = [
                projectTitle || null,
                task.timeSpent > 0 ? `已用 ${formatDurationMs(task.timeSpent)}` : null,
                task.timeEstimate > 0
                  ? `预计 ${Math.round(task.timeEstimate / 60_000)} 分`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ");
              return meta ? <div className="list__meta">{meta}</div> : null;
            })()}
      </button>
      {planLabel ? (
        <span
          className={overdue ? "list__plan is-overdue" : "list__plan"}
          title={planLabel}
        >
          {planLabel}
        </span>
      ) : (
        <span className="list__plan list__plan--empty" aria-hidden="true" />
      )}
    </li>
  );
}
