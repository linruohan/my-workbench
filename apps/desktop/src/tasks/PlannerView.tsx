import {
  formatTimelineDayHeader,
  groupPlannerByDay,
  type Tag,
  type Task,
} from "@wb/domain";
import { TaskRow } from "./TaskRow";

type Props = {
  tasks: Task[];
  projectTitles?: Record<string, string>;
  taskTagMap?: Record<string, Tag[]>;
  nowMs: number;
  activeTimerTaskId?: string | null;
  timerElapsedMs?: number;
  onToggleDone: (task: Task) => void;
  onOpen: (task: Task) => void;
};

export function PlannerView({
  tasks,
  projectTitles,
  taskTagMap,
  nowMs,
  activeTimerTaskId,
  timerElapsedMs = 0,
  onToggleDone,
  onOpen,
}: Props) {
  const groups = groupPlannerByDay(tasks);

  return (
    <section className="panel planner">
      <header className="panel__header">
        <h1>计划</h1>
        <span className="panel__count">{tasks.length}</span>
      </header>
      <p className="panel__hint">按日期时间线汇总全部已排期任务</p>
      {groups.length === 0 ? (
        <p className="empty">还没有排期的任务。</p>
      ) : (
        <div className="planner__timeline">
          {groups.map((group) => (
            <section key={group.day} className="planner__day">
              <h2 className="planner__day-label">
                {formatTimelineDayHeader(group.day, nowMs)}
              </h2>
              <ul className="list" aria-label={`${group.day} 计划`}>
                {group.tasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    projectTitle={projectTitles?.[task.projectId]}
                    tags={taskTagMap?.[task.id] ?? []}
                    denseMeta
                    nowMs={nowMs}
                    timerRunning={activeTimerTaskId === task.id}
                    timerElapsedMs={activeTimerTaskId === task.id ? timerElapsedMs : 0}
                    onToggleDone={onToggleDone}
                    onOpen={onOpen}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
