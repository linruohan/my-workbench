import { useMemo } from "react";
import {
  formatTimedTaskOverdue,
  isTimedTaskMissed,
  timedScheduleLabel,
  type TimedTask,
} from "@wb/domain";

export type TimedTaskBindingView = {
  threadTitle: string | null;
  skillCount: number;
  autoSession: boolean;
};

type Props = {
  tasks: TimedTask[];
  nowMs?: number;
  bindings?: Record<string, TimedTaskBindingView>;
  onCreate: () => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onRunNow?: (id: string) => void;
  onSkip?: (id: string) => void;
  onRunAllMissed?: () => void;
  onSkipAllMissed?: () => void;
  onToggleEnabled?: (id: string, enabled: boolean) => void;
};

function bindingMeta(
  taskId: string,
  bindings: Record<string, TimedTaskBindingView> | undefined,
): string {
  const bind = bindings?.[taskId];
  if (!bind) return "";
  const parts: string[] = [];
  if (bind.skillCount > 0) parts.push(`${bind.skillCount} 个技能`);
  if (bind.threadTitle) parts.push(`会话 · ${bind.threadTitle}`);
  else if (bind.autoSession) parts.push("自动创建会话");
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}

function sortByNextRun(a: TimedTask, b: TimedTask): number {
  if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
  const an = a.nextRunAt ?? Number.MAX_SAFE_INTEGER;
  const bn = b.nextRunAt ?? Number.MAX_SAFE_INTEGER;
  if (an !== bn) return an - bn;
  return b.updatedAt - a.updatedAt;
}

export function TimedTaskList({
  tasks,
  nowMs = Date.now(),
  bindings,
  onCreate,
  onOpen,
  onDelete,
  onRunNow,
  onSkip,
  onRunAllMissed,
  onSkipAllMissed,
  onToggleEnabled,
}: Props) {
  const { expired, upcoming } = useMemo(() => {
    const missed: TimedTask[] = [];
    const rest: TimedTask[] = [];
    for (const task of tasks) {
      if (isTimedTaskMissed(task, nowMs)) missed.push(task);
      else rest.push(task);
    }
    missed.sort(sortByNextRun);
    rest.sort(sortByNextRun);
    return { expired: missed, upcoming: rest };
  }, [tasks, nowMs]);

  return (
    <section className="panel">
      <header className="panel__header timed-list__header">
        <div className="timed-list__title">
          <h1>定时任务</h1>
          <span className="panel__count">{tasks.length}</span>
        </div>
        <button type="button" className="btn btn--primary" onClick={onCreate}>
          新建定时任务
        </button>
      </header>
      <p className="panel__hint">按计划自动执行的指令与自动化。</p>

      {expired.length > 0 ? (
        <div className="timed-missed" role="status">
          <div className="timed-missed__head">
            <div className="timed-missed__head-text">
              <strong>有 {expired.length} 个已过期的定时任务</strong>
              <span>程序中断期间错过的执行，可立即补跑或跳过本次。</span>
            </div>
            <div className="timed-missed__head-actions">
              {onRunAllMissed ? (
                <button type="button" className="btn btn--primary" onClick={onRunAllMissed}>
                  全部立即执行
                </button>
              ) : null}
              {onSkipAllMissed ? (
                <button type="button" className="btn" onClick={onSkipAllMissed}>
                  全部跳过
                </button>
              ) : null}
            </div>
          </div>
          <ul className="timed-missed__list">
            {expired.map((task) => (
              <li key={`missed-${task.id}`} className="timed-missed__row">
                <button
                  type="button"
                  className="timed-missed__open"
                  onClick={() => onOpen(task.id)}
                >
                  <div className="timed-missed__title">
                    <span className="timed-missed__badge">已过期</span>
                    {task.title}
                  </div>
                  <div className="timed-missed__meta">
                    {task.nextRunAt
                      ? formatTimedTaskOverdue(task.nextRunAt, nowMs)
                      : "已过期"}
                    {task.nextRunAt
                      ? ` · 原定 ${new Date(task.nextRunAt).toLocaleString("zh-CN")}`
                      : ""}
                    {bindingMeta(task.id, bindings)}
                  </div>
                </button>
                <div className="timed-missed__actions">
                  {onRunNow ? (
                    <button
                      type="button"
                      className="btn btn--primary"
                      onClick={() => onRunNow(task.id)}
                    >
                      立即执行
                    </button>
                  ) : null}
                  {onSkip ? (
                    <button type="button" className="btn" onClick={() => onSkip(task.id)}>
                      跳过本次
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {tasks.length === 0 ? (
        <p className="empty">还没有定时任务。点击右上角新建。</p>
      ) : upcoming.length === 0 ? (
        <p className="empty">其余任务都在上方过期区，处理完即可恢复日程。</p>
      ) : (
        <ul className="list">
          {upcoming.map((t) => (
            <li key={t.id} className="list__row list__row--plain">
              <button
                type="button"
                className="list__body timed-list__open"
                onClick={() => onOpen(t.id)}
              >
                <div className="list__title">
                  {!t.enabled ? (
                    <span className="timed-missed__badge timed-missed__badge--muted">
                      已暂停
                    </span>
                  ) : null}
                  {t.title}
                </div>
                <div className="list__meta">
                  {timedScheduleLabel(t.schedule)}
                  {t.nextRunAt
                    ? ` · 下次 ${new Date(t.nextRunAt).toLocaleString("zh-CN")}`
                    : ""}
                  {t.lastRunAt
                    ? ` · 上次 ${new Date(t.lastRunAt).toLocaleString("zh-CN")}`
                    : ""}
                  {bindingMeta(t.id, bindings)}
                </div>
              </button>
              <div className="list__actions">
                {onToggleEnabled ? (
                  <button type="button" onClick={() => onToggleEnabled(t.id, !t.enabled)}>
                    {t.enabled ? "暂停" : "启用"}
                  </button>
                ) : null}
                {t.enabled && onRunNow ? (
                  <button type="button" onClick={() => onRunNow(t.id)}>
                    立即执行
                  </button>
                ) : null}
                <button type="button" onClick={() => onDelete(t.id)}>
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
