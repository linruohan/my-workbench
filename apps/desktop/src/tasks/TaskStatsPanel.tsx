import type { TaskStats } from "@wb/domain";

type Props = {
  stats: TaskStats;
  projectTitles: Record<string, string>;
  expanded: boolean;
  onToggle: () => void;
  onSelectStatus?: (
    status: "open" | "overdue" | "today" | "unplanned" | "done",
  ) => void;
};

export function TaskStatsPanel({
  stats,
  projectTitles,
  expanded,
  onToggle,
  onSelectStatus,
}: Props) {
  const cards: Array<{
    key: "open" | "overdue" | "today" | "unplanned" | "done";
    label: string;
    value: number;
    tone?: "warn" | "ok";
  }> = [
    { key: "open", label: "未完成", value: stats.open },
    { key: "overdue", label: "已逾期", value: stats.overdue, tone: "warn" },
    { key: "today", label: "今日到期", value: stats.dueToday },
    { key: "unplanned", label: "未排期", value: stats.unplanned },
    { key: "done", label: "今日完成", value: stats.completedToday, tone: "ok" },
  ];

  return (
    <section className="task-stats" aria-label="任务统计">
      <div className="task-stats__strip">
        {cards.map((card) => (
          <button
            key={card.key}
            type="button"
            className={
              card.tone === "warn"
                ? "task-stats__card is-warn"
                : card.tone === "ok"
                  ? "task-stats__card is-ok"
                  : "task-stats__card"
            }
            onClick={() => onSelectStatus?.(card.key)}
          >
            <span className="task-stats__value">{card.value}</span>
            <span className="task-stats__label">{card.label}</span>
          </button>
        ))}
        <button
          type="button"
          className="task-stats__more"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          {expanded ? "收起明细" : "展开明细"}
        </button>
      </div>

      {expanded ? (
        <div className="task-stats__detail">
          <div className="task-stats__meta">
            <span>共 {stats.total} 项</span>
            <span>预计 {stats.estimateMinutes} 分钟</span>
            <span>已用 {stats.spentMinutes} 分钟</span>
            <span>已完成 {stats.done} 项</span>
          </div>
          {stats.byProject.length === 0 ? (
            <p className="empty">暂无按项目汇总。</p>
          ) : (
            <table className="task-stats__table">
              <thead>
                <tr>
                  <th scope="col">项目</th>
                  <th scope="col">未完成</th>
                  <th scope="col">逾期</th>
                  <th scope="col">已完成</th>
                </tr>
              </thead>
              <tbody>
                {stats.byProject.map((row) => (
                  <tr key={row.projectId}>
                    <td>{projectTitles[row.projectId] ?? row.projectId}</td>
                    <td>{row.open}</td>
                    <td>{row.overdue}</td>
                    <td>{row.done}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}
    </section>
  );
}
