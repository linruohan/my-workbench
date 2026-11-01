import { useCallback, useEffect, useState } from "react";
import {
  formatLocalDay,
  inferNoteTitleFromBody,
  parseQuickCapture,
  ReminderUiCooldown,
  type Task,
} from "@wb/domain";
import { createPersistedStore, saveStore } from "./lib/persistence";
import { readPrefs, writePrefs, type AppPrefs } from "./lib/prefs";
import { KnowledgeView } from "./notes/KnowledgeView";
import { SettingsView, type SettingsSectionId } from "./settings/SettingsView";
import { Sidebar, type AppNavId } from "./shell/Sidebar";
import { TitleBar } from "./shell/TitleBar";

export default function App() {
  const [store] = useState(() => createPersistedStore());
  const [nav, setNav] = useState<AppNavId>("today");
  const [tick, setTick] = useState(0);
  const [draft, setDraft] = useState("");
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSectionId>("general");
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [prefs, setPrefs] = useState<AppPrefs>(() => readPrefs());
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
        setNotificationsOpen(true);
        refresh();
      }
    }, 15_000);
    return () => window.clearInterval(id);
  }, [store, cooldown, refresh]);

  void tick;
  const todayTasks = store.listToday(now);
  const plannerTasks = store.listPlannerDay(today);
  const scheduleTasks = store.listScheduleDay(today);
  const allTasks = store.listTasks().filter((t) => !t.isDone);
  const notifications = store.listNotifications();
  const notes = store.listNotes();
  const projects = store.listProjects();

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

  const createNote = () => {
    const note = store.createNote({
      title: "未命名笔记",
      bodyMd: "# 未命名笔记\n\n",
      nowMs: Date.now(),
    });
    setActiveNoteId(note.id);
    refresh();
  };

  const updateNote = (
    id: string,
    patch: { title?: string; bodyMd?: string },
  ) => {
    const current = store.getNote(id);
    if (!current) return;
    const nextPatch = { ...patch };
    if (
      patch.bodyMd !== undefined &&
      (current.title === "未命名笔记" ||
        current.title === inferNoteTitleFromBody(current.bodyMd))
    ) {
      nextPatch.title = inferNoteTitleFromBody(patch.bodyMd);
    }
    store.updateNote(id, nextPatch);
    refresh();
  };

  const deleteNote = (id: string) => {
    store.deleteNote(id);
    setActiveNoteId((prev) => (prev === id ? null : prev));
    refresh();
  };

  const goNav = (id: AppNavId) => {
    setSettingsOpen(false);
    setNav(id);
  };

  const openSettings = (section: SettingsSectionId = "general") => {
    setSettingsSection(section);
    setSettingsOpen(true);
  };

  const updatePrefs = (next: AppPrefs) => {
    setPrefs(next);
    writePrefs(next);
  };

  let body;
  if (settingsOpen) {
    body = (
      <SettingsView
        key={settingsSection}
        prefs={prefs}
        onPrefsChange={updatePrefs}
        onBack={() => setSettingsOpen(false)}
        initialSection={settingsSection}
      />
    );
  } else if (nav === "today") {
    body = (
      <TaskList
        title="今日"
        empty={
          prefs.showTips
            ? "从任务里拖进来，或按下方输入写下今天要做的事。"
            : "今天还没有任务。"
        }
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
  } else if (nav === "knowledge") {
    body = (
      <KnowledgeView
        notes={notes}
        activeId={activeNoteId}
        onSelect={setActiveNoteId}
        onCreate={createNote}
        onChange={updateNote}
        onDelete={deleteNote}
      />
    );
  } else {
    body = (
      <TaskList
        title="任务"
        empty={
          prefs.showTips
            ? "收件箱是空的。输入一句话开始捕获。"
            : "暂无任务。"
        }
        tasks={allTasks}
        onComplete={complete}
        onPlanToday={scheduleToday}
        onPlanTime={scheduleAfternoon}
      />
    );
  }

  return (
    <div className="shell">
      <TitleBar
        notificationsOpen={notificationsOpen}
        onNotificationsOpenChange={setNotificationsOpen}
        notifications={notifications}
        activeReminders={activeReminders}
        onCompleteReminder={(taskId, remindAt) => {
          const t = store.getTask(taskId);
          if (t) complete(t);
          dismissReminder(taskId, remindAt);
        }}
        onDismissReminder={dismissReminder}
      />
      <div
        className={
          sidebarCollapsed ? "shell__body is-collapsed" : "shell__body"
        }
      >
        <Sidebar
          collapsed={sidebarCollapsed}
          onToggleCollapsed={() => setSidebarCollapsed((v) => !v)}
          nav={nav}
          onNav={goNav}
          settingsOpen={settingsOpen}
          onOpenSettings={() => openSettings("general")}
          projects={projects}
          notes={notes}
          onCreateProject={() => {
            const title = window.prompt("项目名称", "新项目");
            if (!title?.trim()) return;
            store.createProject(title.trim());
            goNav("projects");
            refresh();
          }}
          onSelectNote={(id) => {
            setActiveNoteId(id);
            goNav("knowledge");
          }}
          onNewChat={() => {
            goNav("today");
            window.alert("Agent 会话将在后续版本接入，当前可先用快速捕获。");
          }}
          onAutomations={() => setNotificationsOpen(true)}
          onCustomize={() => openSettings("appearance")}
          displayName={prefs.displayName || "本地用户"}
        />
        <main className="main">
          {body}
          {!settingsOpen && nav !== "knowledge" ? (
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
          ) : null}
        </main>
      </div>
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
