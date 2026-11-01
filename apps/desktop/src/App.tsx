import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActiveTimer,
  formatLocalDay,
  reorderIds,
  inferNoteTitleFromBody,
  parseQuickCapture,
  ReminderUiCooldown,
  type ProjectBucket,
  type Tag,
  type Task,
  type TaskBoardColumnId,
  type TimedSchedule,
} from "@wb/domain";
import {
  createPersistedStore,
  hydrateStore,
  saveStore,
} from "./lib/persistence";
import { hydratePrefs, readPrefs, writePrefs, type AppPrefs } from "./lib/prefs";
import {
  DEFAULT_DATA_DIR_DISPLAY,
  isTauriRuntime,
  resolveDataDir,
} from "./lib/paths";
import { KnowledgeView } from "./notes/KnowledgeView";
import { SettingsView, type SettingsSectionId } from "./settings/SettingsView";
import { Sidebar, type AppNavId } from "./shell/Sidebar";
import { TitleBar } from "./shell/TitleBar";
import {
  TaskEditor,
  type TaskEditorSave,
} from "./tasks/TaskEditor";
import { TaskRow } from "./tasks/TaskRow";
import { TasksView, type TasksViewMode } from "./tasks/TasksView";
import { TimedTaskEditor } from "./timed/TimedTaskEditor";
import { TimedTaskList } from "./timed/TimedTaskList";

const TASKS_VIEW_KEY = "wb.tasks.viewMode";
const TASKS_SHOW_DONE_KEY = "wb.tasks.showCompleted";

function readTasksViewMode(): TasksViewMode {
  const raw = localStorage.getItem(TASKS_VIEW_KEY);
  if (raw === "board" || raw === "stats") return raw;
  return "list";
}

function readShowCompleted(): boolean {
  return localStorage.getItem(TASKS_SHOW_DONE_KEY) === "1";
}

export default function App() {
  const [store] = useState(() => createPersistedStore());
  const [nav, setNav] = useState<AppNavId>(() => readPrefs().startupView);
  const [tick, setTick] = useState(0);
  const [draft, setDraft] = useState("");
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSectionId>("general");
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [prefs, setPrefs] = useState<AppPrefs>(() => readPrefs());
  const [dataDir, setDataDir] = useState(DEFAULT_DATA_DIR_DISPLAY);
  const [ready, setReady] = useState(() => !isTauriRuntime());
  const [timedEditing, setTimedEditing] = useState(false);
  const [timedEditId, setTimedEditId] = useState<string | null>(null);
  const [timedDraft, setTimedDraft] = useState<{
    title: string;
    command: string;
    schedule: TimedSchedule | null;
  }>({
    title: "未命名定时任务",
    command: "",
    schedule: null,
  });
  const [filterProjectId, setFilterProjectId] = useState<string | null>(null);
  const [tasksViewMode, setTasksViewMode] = useState<TasksViewMode>(() =>
    readTasksViewMode(),
  );
  const [showCompleted, setShowCompleted] = useState(() => readShowCompleted());
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [cooldown] = useState(() => new ReminderUiCooldown());
  const [timer] = useState(() => new ActiveTimer());
  const [activeTimerTaskId, setActiveTimerTaskId] = useState<string | null>(
    null,
  );
  const [timerStartedAt, setTimerStartedAt] = useState<number | null>(null);
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
    let cancelled = false;
    void (async () => {
      await hydrateStore(store);
      const nextPrefs = await hydratePrefs();
      const dir = await resolveDataDir();
      if (cancelled) return;
      setPrefs(nextPrefs);
      setNav(nextPrefs.startupView);
      setDataDir(dir);
      setReady(true);
      setTick((n) => n + 1);
    })();
    return () => {
      cancelled = true;
    };
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

  useEffect(() => {
    if (!activeTimerTaskId) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [activeTimerTaskId]);

  void tick;
  const todayTasks = store.listToday(now);
  const plannerTasks = store.listPlannerDay(today);
  const scheduleTasks = store.listScheduleDay(today);
  const allTasks = store.listTasks();
  const openTasks = allTasks.filter((t) => !t.isDone);
  const notifications = store.listNotifications();
  const notes = store.listNotes();
  const projects = store.listProjects();
  const timedTasks = store.listTimedTasks();
  const allTags = store.listTags();
  const taskBuckets = useMemo(() => {
    const map: Record<string, ProjectBucket> = {};
    for (const t of allTasks) {
      map[t.id] = store.getTaskBucket(t.id);
    }
    return map;
  }, [allTasks, store]);
  const taskTagMap = useMemo(() => {
    const map: Record<string, Tag[]> = {};
    for (const t of allTasks) {
      map[t.id] = store.listTagsForTask(t.id);
    }
    return map;
  }, [allTasks, store]);

  const editingTask = editingTaskId
    ? (store.getTask(editingTaskId) ?? null)
    : null;
  const timerElapsedMs =
    activeTimerTaskId && timerStartedAt != null
      ? Math.max(0, now - timerStartedAt)
      : 0;

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
      ...(prefs.defaultRemind !== "none"
        ? { remindOption: prefs.defaultRemind }
        : {}),
    });
    refresh();
  };

  const clearPlan = (task: Task) => {
    store.scheduleTask(task.id, {
      dueDay: null,
      dueWithTime: null,
      remindAt: null,
    });
    refresh();
  };

  const settleSegment = (segment: {
    taskId: string;
    startedAt: number;
    endedAt: number;
  }) => {
    try {
      store.addTimeSpent(segment.taskId, segment.startedAt, segment.endedAt);
    } catch {
      // parent-with-children cannot be timed; ignore settle
    }
  };

  const stopTimerIfTask = (taskId: string) => {
    if (activeTimerTaskId !== taskId) return;
    const stopped = timer.stop(Date.now());
    if (stopped) settleSegment(stopped);
    setActiveTimerTaskId(null);
    setTimerStartedAt(null);
  };

  const complete = (task: Task) => {
    stopTimerIfTask(task.id);
    store.completeTask(task.id);
    refresh();
  };

  const toggleDone = (task: Task) => {
    if (task.isDone) store.uncompleteTask(task.id);
    else {
      stopTimerIfTask(task.id);
      store.completeTask(task.id);
    }
    refresh();
  };

  const clearCompletedTasks = (taskIds: string[]) => {
    for (const id of taskIds) {
      stopTimerIfTask(id);
      store.deleteTask(id);
    }
    refresh();
  };

  const reorderToday = (fromId: string, toId: string) => {
    const ids = todayTasks.map((t) => t.id);
    store.setTodayOrder(reorderIds(ids, fromId, toId));
    refresh();
  };

  const changeTasksViewMode = (mode: TasksViewMode) => {
    setTasksViewMode(mode);
    localStorage.setItem(TASKS_VIEW_KEY, mode);
  };

  const changeShowCompleted = (show: boolean) => {
    setShowCompleted(show);
    localStorage.setItem(TASKS_SHOW_DONE_KEY, show ? "1" : "0");
  };

  const moveTaskColumn = (taskId: string, column: TaskBoardColumnId) => {
    const task = store.getTask(taskId);
    if (!task) return;
    if (column === "done") {
      stopTimerIfTask(taskId);
      if (!task.isDone) store.completeTask(taskId);
    } else {
      if (task.isDone) store.uncompleteTask(taskId);
      store.setTaskBucket(taskId, column);
    }
    refresh();
  };

  const toggleTimer = (task: Task) => {
    const at = Date.now();
    if (activeTimerTaskId === task.id) {
      const stopped = timer.stop(at);
      if (stopped) settleSegment(stopped);
      setActiveTimerTaskId(null);
      setTimerStartedAt(null);
      refresh();
      return;
    }
    const { previous } = timer.start(task.id, at);
    if (previous) settleSegment(previous);
    setActiveTimerTaskId(task.id);
    setTimerStartedAt(at);
    refresh();
  };

  const createTag = (title: string): Tag | null => {
    try {
      const tag = store.createTag(title);
      refresh();
      return tag;
    } catch {
      return null;
    }
  };

  const saveEditedTask = (taskId: string, draft: TaskEditorSave) => {
    const task = store.getTask(taskId);
    if (!task) return;
    store.updateTask(taskId, {
      title: draft.title,
      notes: draft.notes,
      projectId: draft.projectId,
      timeEstimate: draft.timeEstimateMinutes * 60_000,
    });

    const currentTagIds = store.listTagsForTask(taskId).map((t) => t.id);
    for (const tagId of draft.tagIds) {
      if (!currentTagIds.includes(tagId)) store.assignTag(taskId, tagId);
    }
    for (const tagId of currentTagIds) {
      if (!draft.tagIds.includes(tagId)) store.unassignTag(taskId, tagId);
    }

    if (draft.isDone && !task.isDone) store.completeTask(taskId);
    if (!draft.isDone && task.isDone) store.uncompleteTask(taskId);
    if (!draft.isDone) store.setTaskBucket(taskId, draft.bucket);

    if (draft.dueMode === "none") {
      store.scheduleTask(taskId, {
        dueDay: null,
        dueWithTime: null,
        remindAt: null,
      });
    } else if (draft.dueMode === "day") {
      store.scheduleTask(taskId, {
        dueDay: draft.dueDay,
        dueWithTime: null,
        remindAt: null,
      });
    } else {
      const ms = Date.parse(draft.dueWithTimeLocal);
      store.scheduleTask(taskId, {
        dueWithTime: Number.isNaN(ms) ? Date.now() : ms,
        ...(draft.remindOption !== "none"
          ? { remindOption: draft.remindOption }
          : { remindAt: null }),
      });
    }

    store.scheduleTask(taskId, {
      deadlineDay: draft.deadlineDay ? draft.deadlineDay : null,
      deadlineWithTime: null,
    });
    refresh();
  };

  const deleteTask = (taskId: string) => {
    store.deleteTask(taskId);
    setEditingTaskId((prev) => (prev === taskId ? null : prev));
    refresh();
  };

  const duplicateTask = (taskId: string) => {
    store.duplicateTask(taskId);
    refresh();
  };

  const addSubtask = (parentId: string, title: string) => {
    const parent = store.getTask(parentId);
    if (!parent) return;
    store.createTask({
      title,
      projectId: parent.projectId,
      parentId,
      nowMs: Date.now(),
    });
    refresh();
  };

  const createNamedTask = (title: string) => {
    store.createTask({
      title,
      projectId: filterProjectId ?? "inbox",
      nowMs: Date.now(),
    });
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
    if (
      prefs.confirmBeforeDelete &&
      !window.confirm("确定删除这篇笔记？此操作不可撤销。")
    ) {
      return;
    }
    store.deleteNote(id);
    setActiveNoteId((prev) => (prev === id ? null : prev));
    refresh();
  };

  const goNav = (id: AppNavId) => {
    setSettingsOpen(false);
    setTimedEditing(false);
    setTimedEditId(null);
    setEditingTaskId(null);
    setNav(id);
  };

  const openTimedCreate = () => {
    setSettingsOpen(false);
    setTimedEditId(null);
    setTimedDraft({
      title: "未命名定时任务",
      command: "",
      schedule: null,
    });
    setTimedEditing(true);
    setNav("timed");
  };

  const openTimedEdit = (id: string) => {
    const task = store.getTimedTask(id);
    if (!task) return;
    setTimedEditId(id);
    setTimedDraft({
      title: task.title,
      command: task.command,
      schedule: task.schedule,
    });
    setTimedEditing(true);
    setNav("timed");
  };

  const saveTimedTask = () => {
    if (!timedDraft.schedule || !timedDraft.title.trim()) return;
    if (timedEditId) {
      store.updateTimedTask(timedEditId, {
        title: timedDraft.title,
        command: timedDraft.command,
        schedule: timedDraft.schedule,
      });
    } else {
      store.createTimedTask({
        title: timedDraft.title,
        command: timedDraft.command,
        schedule: timedDraft.schedule,
        nowMs: Date.now(),
      });
    }
    setTimedEditing(false);
    setTimedEditId(null);
    refresh();
  };

  const deleteTimedTask = (id: string) => {
    if (
      prefs.confirmBeforeDelete &&
      !window.confirm("确定删除该定时任务？")
    ) {
      return;
    }
    store.deleteTimedTask(id);
    if (timedEditId === id) {
      setTimedEditing(false);
      setTimedEditId(null);
    }
    refresh();
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
        dataDir={dataDir}
        onPrefsChange={updatePrefs}
        onBack={() => setSettingsOpen(false)}
        initialSection={settingsSection}
      />
    );
  } else if (nav === "today") {
    const todayEmpty =
      prefs.showTips
        ? "从任务里拖进来，或按下方输入写下今天要做的事。"
        : "今天还没有任务。";
    const suggest =
      prefs.proactiveSuggest &&
      prefs.workMode === "office" &&
      todayTasks.length === 0 &&
      openTasks.length > 0
        ? `建议：还有 ${openTasks.length} 件未排期任务可排到今天。`
        : null;
    body = (
      <TaskList
        title="今日"
        empty={suggest ?? todayEmpty}
        tasks={todayTasks}
        denseMeta={prefs.workMode === "office"}
        reorderable
        hint="拖拽任务可调整今日顺序"
        activeTimerTaskId={activeTimerTaskId}
        timerElapsedMs={timerElapsedMs}
        onToggleDone={toggleDone}
        onOpen={(t) => setEditingTaskId(t.id)}
        onPlanToday={scheduleToday}
        onPlanTime={scheduleAfternoon}
        onClearPlan={clearPlan}
        onToggleTimer={toggleTimer}
        onReorder={reorderToday}
      />
    );
  } else if (nav === "planner") {
    body = (
      <TaskList
        title={`计划 · ${today}`}
        empty="这一天还没有全天计划任务。"
        tasks={plannerTasks}
        activeTimerTaskId={activeTimerTaskId}
        timerElapsedMs={timerElapsedMs}
        onToggleDone={toggleDone}
        onOpen={(t) => setEditingTaskId(t.id)}
        onPlanToday={scheduleToday}
        onPlanTime={scheduleAfternoon}
        onClearPlan={clearPlan}
        onToggleTimer={toggleTimer}
      />
    );
  } else if (nav === "schedule") {
    body = (
      <TaskList
        title={`时间表 · ${today}`}
        empty="没有排到具体时刻的任务。"
        tasks={scheduleTasks}
        activeTimerTaskId={activeTimerTaskId}
        timerElapsedMs={timerElapsedMs}
        onToggleDone={toggleDone}
        onOpen={(t) => setEditingTaskId(t.id)}
        onPlanToday={scheduleToday}
        onPlanTime={scheduleAfternoon}
        onClearPlan={clearPlan}
        onToggleTimer={toggleTimer}
      />
    );
  } else if (nav === "knowledge") {
    body = (
      <KnowledgeView
        notes={notes}
        activeId={activeNoteId}
        preferLastNote={prefs.openLastNote}
        onSelect={setActiveNoteId}
        onCreate={createNote}
        onChange={updateNote}
        onDelete={deleteNote}
      />
    );
  } else if (nav === "timed") {
    body = timedEditing ? (
      <TimedTaskEditor
        draft={timedDraft}
        existing={timedEditId ? store.getTimedTask(timedEditId) : null}
        history={timedTasks}
        onChange={(patch) => setTimedDraft((d) => ({ ...d, ...patch }))}
        onSubmit={saveTimedTask}
        onCancel={() => {
          setTimedEditing(false);
          setTimedEditId(null);
        }}
      />
    ) : (
      <TimedTaskList
        tasks={timedTasks}
        onCreate={openTimedCreate}
        onOpen={openTimedEdit}
        onDelete={deleteTimedTask}
      />
    );
  } else {
    body = (
      <TasksView
        tasks={allTasks}
        projects={projects}
        tags={allTags}
        taskTagMap={taskTagMap}
        buckets={taskBuckets}
        filterProjectId={filterProjectId}
        viewMode={tasksViewMode}
        showCompleted={showCompleted}
        denseMeta={prefs.workMode === "office"}
        defaultRemind={prefs.defaultRemind}
        confirmBeforeDelete={prefs.confirmBeforeDelete}
        activeTimerTaskId={activeTimerTaskId}
        timerElapsedMs={timerElapsedMs}
        onViewModeChange={changeTasksViewMode}
        onFilterProject={setFilterProjectId}
        onShowCompletedChange={changeShowCompleted}
        onToggleDone={toggleDone}
        onPlanToday={scheduleToday}
        onPlanTime={scheduleAfternoon}
        onClearPlan={clearPlan}
        onToggleTimer={toggleTimer}
        onMoveColumn={moveTaskColumn}
        onSaveTask={saveEditedTask}
        onDeleteTask={deleteTask}
        onDuplicateTask={duplicateTask}
        onClearCompleted={clearCompletedTasks}
        onCreateTag={createTag}
        onAddSubtask={addSubtask}
        onCreate={createNamedTask}
      />
    );
  }

  if (!ready) {
    return (
      <div className="shell shell--loading" aria-busy="true">
        <TitleBar
          notificationsOpen={false}
          onNotificationsOpenChange={() => undefined}
          notifications={[]}
          activeReminders={[]}
          onCompleteReminder={() => undefined}
          onDismissReminder={() => undefined}
        />
        <div className="shell__loading">正在加载本地数据…</div>
      </div>
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
          activeProjectId={filterProjectId}
          notes={notes}
          onCreateProject={() => {
            const title = window.prompt("项目名称", "新项目");
            if (!title?.trim()) return;
            const created = store.createProject(title.trim());
            setFilterProjectId(created.id);
            goNav("projects");
            refresh();
          }}
          onSelectProject={setFilterProjectId}
          onSelectNote={(id) => {
            setActiveNoteId(id);
            goNav("knowledge");
          }}
          onNewChat={() => {
            goNav("today");
            window.alert("Agent 会话将在后续版本接入，当前可先用快速捕获。");
          }}
          onAutomations={openTimedCreate}
          displayName={prefs.displayName || "本地用户"}
        />
        <main className="main">
          {body}
          {editingTask && nav !== "projects" ? (
            <div className="task-editor-overlay">
              <TaskEditor
                key={editingTask.id}
                task={editingTask}
                bucket={taskBuckets[editingTask.id] ?? "active"}
                projects={projects}
                tags={allTags}
                selectedTagIds={(taskTagMap[editingTask.id] ?? []).map(
                  (t) => t.id,
                )}
                subtasks={store.listSubtasks(editingTask.id)}
                defaultRemind={prefs.defaultRemind}
                onClose={() => setEditingTaskId(null)}
                onDelete={() => {
                  if (
                    prefs.confirmBeforeDelete &&
                    !window.confirm("确定删除该任务？此操作不可撤销。")
                  ) {
                    return;
                  }
                  deleteTask(editingTask.id);
                }}
                onDuplicate={() => {
                  duplicateTask(editingTask.id);
                  setEditingTaskId(null);
                }}
                onCreateTag={createTag}
                onAddSubtask={(title) => addSubtask(editingTask.id, title)}
                onToggleSubtask={toggleDone}
                onDeleteSubtask={(id) => {
                  if (
                    prefs.confirmBeforeDelete &&
                    !window.confirm("确定删除该子任务？此操作不可撤销。")
                  ) {
                    return;
                  }
                  deleteTask(id);
                }}
                onSave={(draft) => {
                  saveEditedTask(editingTask.id, draft);
                  setEditingTaskId(null);
                }}
              />
            </div>
          ) : null}
          {!settingsOpen && nav !== "knowledge" && nav !== "timed" ? (
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
  denseMeta?: boolean;
  reorderable?: boolean;
  hint?: string;
  activeTimerTaskId?: string | null;
  timerElapsedMs?: number;
  onToggleDone: (t: Task) => void;
  onOpen: (t: Task) => void;
  onPlanToday: (t: Task) => void;
  onPlanTime: (t: Task) => void;
  onClearPlan?: (t: Task) => void;
  onToggleTimer?: (t: Task) => void;
  onReorder?: (fromId: string, toId: string) => void;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  return (
    <section className="panel">
      <header className="panel__header">
        <h1>{props.title}</h1>
        <span className="panel__count">{props.tasks.length}</span>
      </header>
      {props.hint && props.tasks.length > 0 ? (
        <p className="panel__hint">{props.hint}</p>
      ) : null}
      {props.tasks.length === 0 ? (
        <p className="empty">{props.empty}</p>
      ) : (
        <ul className="list" aria-label={`${props.title}列表`}>
          {props.tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              denseMeta={props.denseMeta}
              timerRunning={props.activeTimerTaskId === task.id}
              timerElapsedMs={
                props.activeTimerTaskId === task.id
                  ? (props.timerElapsedMs ?? 0)
                  : 0
              }
              draggable={props.reorderable}
              dropTarget={props.reorderable && overId === task.id && dragId !== task.id}
              onDragStart={
                props.reorderable
                  ? (id) => {
                      setDragId(id);
                      setOverId(id);
                    }
                  : undefined
              }
              onDragOver={
                props.reorderable
                  ? (id) => setOverId(id)
                  : undefined
              }
              onDropOn={
                props.reorderable
                  ? (toId) => {
                      if (dragId && props.onReorder) {
                        props.onReorder(dragId, toId);
                      }
                      setDragId(null);
                      setOverId(null);
                    }
                  : undefined
              }
              onToggleDone={props.onToggleDone}
              onOpen={props.onOpen}
              onPlanToday={props.onPlanToday}
              onPlanTime={props.onPlanTime}
              onClearPlan={props.onClearPlan}
              onToggleTimer={props.onToggleTimer}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
