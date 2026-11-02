import type { CSSProperties } from "react";
import type { TaskStats, TaskStatusFilter } from "@wb/domain";

type MetricKey = "open" | "overdue" | "today" | "unplanned" | "done";

type Props = {
  stats: TaskStats;
  projectTitles: Record<string, string>;
  onDrill?: (status: Exclude<TaskStatusFilter, "all">) => void;
};

function formatMinutes(mins: number): string {
  if (mins < 60) return `${mins} 分钟`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`;
}

function completionRate(stats: TaskStats): number {
  if (stats.total === 0) return 0;
  return Math.round((stats.done / stats.total) * 100);
}

function barWidth(part: number, total: number): string {
  if (total <= 0) return "0%";
  return `${Math.max(4, Math.round((part / total) * 100))}%`;
}

export function TaskStatsPanel({ stats, projectTitles, onDrill }: Props) {
  const metrics: Array<{
    key: MetricKey;
    label: string;
    hint: string;
    value: number;
    tone?: "warn" | "ok" | "accent";
    status: Exclude<TaskStatusFilter, "all">;
  }> = [
    {
      key: "open",
      label: "未完成",
      hint: "仍待处理",
      value: stats.open,
      status: "open",
    },
    {
      key: "overdue",
      label: "已逾期",
      hint: "需优先处理",
      value: stats.overdue,
      tone: "warn",
      status: "overdue",
    },
    {
      key: "today",
      label: "今日到期",
      hint: "今天计划内",
      value: stats.dueToday,
      tone: "accent",
      status: "today",
    },
    {
      key: "unplanned",
      label: "未排期",
      hint: "尚无计划日",
      value: stats.unplanned,
      status: "unplanned",
    },
    {
      key: "done",
      label: "今日完成",
      hint: "今天勾选完成",
      value: stats.completedToday,
      tone: "ok",
      status: "done",
    },
  ];

  const rate = completionRate(stats);
  const projectTotalMax = Math.max(
    1,
    ...stats.byProject.map((row) => row.open + row.done),
  );

  return (
    <section className="task-stats" aria-label="任务统计">
      <div className="task-stats__hero">
        <div className="task-stats__hero-main">
          <p className="task-stats__eyebrow">概览</p>
          <p className="task-stats__hero-value">{stats.total}</p>
          <p className="task-stats__hero-label">范围内任务总数</p>
        </div>
        <div className="task-stats__hero-side">
          <div
            className="task-stats__ring"
            style={{ "--rate": `${rate}%` } as CSSProperties}
          >
            <span className="task-stats__ring-value">{rate}%</span>
            <span className="task-stats__ring-label">完成率</span>
          </div>
          <dl className="task-stats__hero-meta">
            <div>
              <dt>已完成</dt>
              <dd>{stats.done}</dd>
            </div>
            <div>
              <dt>预计耗时</dt>
              <dd>{formatMinutes(stats.estimateMinutes)}</dd>
            </div>
            <div>
              <dt>已用时间</dt>
              <dd>{formatMinutes(stats.spentMinutes)}</dd>
            </div>
          </dl>
        </div>
      </div>

      <div className="task-stats__grid">
        {metrics.map((metric) => (
          <button
            key={metric.key}
            type="button"
            className={
              metric.tone ? `task-stats__metric is-${metric.tone}` : "task-stats__metric"
            }
            onClick={() => onDrill?.(metric.status)}
          >
            <span className="task-stats__metric-value">{metric.value}</span>
            <span className="task-stats__metric-label">{metric.label}</span>
            <span className="task-stats__metric-hint">{metric.hint}</span>
          </button>
        ))}
      </div>

      <section className="task-stats__projects" aria-label="按项目汇总">
        <header className="task-stats__section-head">
          <h2>按项目</h2>
          <span>{stats.byProject.length} 个项目</span>
        </header>
        {stats.byProject.length === 0 ? (
          <p className="empty">暂无任务可汇总。</p>
        ) : (
          <ul className="task-stats__project-list">
            {stats.byProject.map((row) => {
              const total = row.open + row.done;
              return (
                <li key={row.projectId} className="task-stats__project">
                  <div className="task-stats__project-top">
                    <strong>{projectTitles[row.projectId] ?? row.projectId}</strong>
                    <span>{total} 项</span>
                  </div>
                  <div
                    className="task-stats__bar"
                    aria-hidden
                    style={{ width: barWidth(total, projectTotalMax) }}
                  >
                    <span
                      className="task-stats__bar-open"
                      style={{
                        width:
                          total === 0 ? "0%" : `${Math.round((row.open / total) * 100)}%`,
                      }}
                    />
                    <span
                      className="task-stats__bar-done"
                      style={{
                        width:
                          total === 0 ? "0%" : `${Math.round((row.done / total) * 100)}%`,
                      }}
                    />
                  </div>
                  <div className="task-stats__project-counts">
                    <span>未完成 {row.open}</span>
                    <span className={row.overdue > 0 ? "is-warn" : undefined}>
                      逾期 {row.overdue}
                    </span>
                    <span>已完成 {row.done}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </section>
  );
}
