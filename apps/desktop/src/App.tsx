import { useCallback, useEffect, useState } from "react";
import {
  formatLocalDay,
  parseQuickCapture,
  ReminderUiCooldown,
  type Task,
} from "@wb/domain";
import { createPersistedStore, saveStore } from "./lib/persistence";
import { ThemeToggle } from "./theme/ThemeToggle";

type NavId = "today" | "planner" | "schedule" | "projects" | "notifications";

const NAV: Array<{ id: NavId; label: string }> = [
  { id: "today", label: "今日" },
  { id: "planner", label: "计划" },
  { id: "schedule", label: "时间表" },
  { id: "projects", label: "任务" },
  { id: "notifications", label: "通知" },
];

export default function App() {
  const [store] = useState(() => createPersistedStore());
  const [nav, setNav] = useState<NavId>("today");
  const [tick, setTick] = useState(0);
  const [draft, setDraft] = useState("");
  const [cooldown] = useState(() => new ReminderUiCooldown());
  const [activeReminders, setActiveReminders] = useState<
    Array<{ taskId: string; title: string; remindAt: number; isDeadline: boolean }>
  >([]);
  const [now, setNow] = useState(() => Date.now());

  const today = formatLocalDay(now);

  const refresh = useCallback(() => {
    saveStore(store);
    setNow(Date.now());
    setTick((n) => n + 1);
  }, [store]);

  useEffect(() => {
    const id = window.setInterval(() => {
      const at = Date.now();
      setNow(at);
      const delivered = store.deliverDueReminders(at);
      const visible = delivered.filter(
        (d) => !cooldown.isSuppressed(d.taskId, d.remindAt, at),
      );
      if (visible.length) {
        setActiveReminders((prev) => [...visible, ...prev].slice(0, 5));
        refresh();
      }
    }, 15_000);
    return () => window.clearInterval(id);
  }, [store, cooldown, refresh]);

  // tick forces re-read
  void tick;
  const todayTasks = store.listToday(now);
  const plannerTasks = store.listPlannerDay(today);
  const scheduleTasks = store.listScheduleDay(today);
  const allTasks = store.listTasks().filter((t) => !t.isDone);
  const notifications = store.listNotifications();

  const capture = () => {
    const text = draft.trim();
    if (!text) return;
    const parsed = parseQuickCapture(text, { nowMs: Date.now() });
    let projectId = parsed.projectId ?? "inbox";
    if (parsed.projectTitle) {
      const created = store.createProject(parsed.projectTitle);
      projectId = created.id;
    }
    const task = store.createTask({
      title: parsed.title,
      projectId,
      nowMs: Date.now(),
    });
    if (parsed.dueDay || parsed.dueWithTime || parsed.deadlineDay) {
      store.scheduleTask(task.id, {
        dueDay: parsed.dueDay,
        dueWithTime: parsed.dueWithTime,
        deadlineDay: parsed.deadlineDay,
        remindAt: parsed.remindAt,
      });
    }
    setDraft("");
    refresh();
  };

  const scheduleToday = (task: Task) => {
    store.scheduleTask(task.id, { dueDay: today });
    refresh();
  };

  const scheduleAfternoon = (task: Task) => {
    const at = new Date();
    at.setHours(15, 0, 0, 0);
    store.scheduleTask(task.id, {
      dueWithTime: at.getTime(),
      remindOption: "m15",
    });
    refresh();
  };

  const complete = (task: Task) => {
    store.completeTask(task.id);
    refresh();
  };

  const dismissReminder = (taskId: string, remindAt: number) => {
    cooldown.dismiss(taskId, remindAt, Date.now());
    setActiveReminders((list) =>
      list.filter((r) => !(r.taskId === taskId && r.remindAt === remindAt)),
    );
  };

  let body;
  if (nav === "today") {
    body = (
      <TaskList
        title="今日"
        empty="从任务里拖进来，或按下方输入写下今天要做的事。"
        tasks={todayTasks}
        onComplete={complete}
        onPlanToday={scheduleToday}
        onPlanTime={scheduleAfternoon}
      />
    );
  } else if (nav === "planner") {
    body = (
      <TaskList
        title={`计划 · ${today}`}
        empty="这一天还没有全天计划任务。"
        tasks={plannerTasks}
        onComplete={complete}
        onPlanToday={scheduleToday}
        onPlanTime={scheduleAfternoon}
      />
    );
  } else if (nav === "schedule") {
    body = (
      <TaskList
        title={`时间表 · ${today}`}
        empty="没有排到具体时刻的任务。"
        tasks={scheduleTasks}
        onComplete={complete}
        onPlanToday={scheduleToday}
        onPlanTime={scheduleAfternoon}
      />
    );
  } else if (nav === "notifications") {
    body = (
      <section className="panel">
        <header className="panel__header">
          <h1>通知</h1>
        </header>
        {notifications.length === 0 ? (
          <p className="empty">暂无通知。提醒到期后会出现在这里。</p>
        ) : (
          <ul className="list">
            {notifications.map((n) => (
              <li key={n.id} className="list__row">
                <div>
                  <div className="list__title">{n.title}</div>
                  <div className="list__meta">
                    {n.kind} · {n.status}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  } else {
    body = (
      <TaskList
        title="任务"
        empty="收件箱是空的。输入一句话开始捕获。"
        tasks={allTasks}
        onComplete={complete}
        onPlanToday={scheduleToday}
        onPlanTime={scheduleAfternoon}
      />
    );
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">个人工作台</div>
        <nav className="nav">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              className={nav === item.id ? "nav__item is-active" : "nav__item"}
              onClick={() => setNav(item.id)}
            >
              {item.label}
              {item.id === "notifications" && notifications.length > 0
                ? ` (${notifications.length})`
                : ""}
            </button>
          ))}
        </nav>
        <ThemeToggle />
        <p className="sidebar__hint">数据仅保存在本机浏览器存储 / 本地库</p>
      </aside>
      <main className="main">
        {activeReminders[0] ? (
          <div className="toast" role="alertdialog" aria-label="提醒">
            <div>
              <strong>{activeReminders[0].title}</strong>
              <div className="toast__meta">
                {activeReminders[0].isDeadline ? "截止提醒" : "计划提醒"}
              </div>
            </div>
            <div className="toast__actions">
              <button
                type="button"
                onClick={() => {
                  const t = store.getTask(activeReminders[0]!.taskId);
                  if (t) complete(t);
                  dismissReminder(
                    activeReminders[0]!.taskId,
                    activeReminders[0]!.remindAt,
                  );
                }}
              >
                完成
              </button>
              <button
                type="button"
                onClick={() =>
                  dismissReminder(
                    activeReminders[0]!.taskId,
                    activeReminders[0]!.remindAt,
                  )
                }
              >
                稍后
              </button>
            </div>
          </div>
        ) : null}
        {body}
        <footer className="composer">
          <input
            aria-label="快速捕获"
            placeholder="写下任务，如：明天 下午3:00 评审 提前15分钟"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") capture();
            }}
          />
          <button type="button" className="primary" onClick={capture}>
            添加
          </button>
        </footer>
      </main>
    </div>
  );
}

function TaskList(props: {
  title: string;
  empty: string;
  tasks: Task[];
  onComplete: (t: Task) => void;
  onPlanToday: (t: Task) => void;
  onPlanTime: (t: Task) => void;
}) {
  return (
    <section className="panel">
      <header className="panel__header">
        <h1>{props.title}</h1>
        <span className="panel__count">{props.tasks.length}</span>
      </header>
      {props.tasks.length === 0 ? (
        <p className="empty">{props.empty}</p>
      ) : (
        <ul className="list">
          {props.tasks.map((task) => (
            <li key={task.id} className="list__row">
              <button
                type="button"
                className="check"
                aria-label={`完成 ${task.title}`}
                onClick={() => props.onComplete(task)}
              />
              <div className="list__body">
                <div className="list__title">{task.title}</div>
                <div className="list__meta">
                  {task.dueWithTime
                    ? new Date(task.dueWithTime).toLocaleString("zh-CN")
                    : task.dueDay
                      ? task.dueDay
                      : "未排期"}
                  {task.remindAt ? " · 有提醒" : ""}
                </div>
              </div>
              <div className="list__actions">
                <button type="button" onClick={() => props.onPlanToday(task)}>
                  今天
                </button>
                <button type="button" onClick={() => props.onPlanTime(task)}>
                  15:00
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
