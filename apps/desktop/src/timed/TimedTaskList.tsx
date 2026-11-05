import { timedScheduleLabel, type TimedTask } from "@wb/domain";

type Props = {
  tasks: TimedTask[];
  onCreate: () => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
};

export function TimedTaskList({ tasks, onCreate, onOpen, onDelete }: Props) {
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
      {tasks.length === 0 ? (
        <p className="empty">还没有定时任务。点击右上角新建。</p>
      ) : (
        <ul className="list">
          {tasks.map((t) => (
            <li key={t.id} className="list__row list__row--plain">
              <button
                type="button"
                className="list__body timed-list__open"
                onClick={() => onOpen(t.id)}
              >
                <div className="list__title">{t.title}</div>
                <div className="list__meta">
                  {timedScheduleLabel(t.schedule)}
                  {t.nextRunAt
                    ? ` · 下次 ${new Date(t.nextRunAt).toLocaleString("zh-CN")}`
                    : ""}
                </div>
              </button>
              <div className="list__actions">
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
