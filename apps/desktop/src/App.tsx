import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActiveTimer,
  agentWorkspaceTitleFromPath,
  encodeTaskRepeat,
  filterTasks,
  formatLocalDay,
  INBOX_PROJECT_ID,
  makePresetSchedule,
  reorderIds,
  inferNoteTitleFromBody,
  parseQuickCapture,
  ReminderUiCooldown,
  selectPlannerTasks,
  dedupeSkillNames,
  DEFAULT_AGENT_WORKSPACE_TITLE,
  formatHookNotices,
  normalizeAgentWebUrl,
  WEB_AGENT_THREAD_TITLE,
  assembleHostTools,
  type HostToolSnapshot,
  hooksForEvent,
  mergeCustomCommands,
  mergeSubagents,
  type AgentSkill,
  type LoadedPlugin,
  type ProjectBucket,
  type Tag,
  type Task,
  type TaskBoardColumnId,
  type TimedSchedule,
} from "@wb/domain";
import { createPersistedStore, hydrateStore, saveStore } from "./lib/persistence";
import { applyUiFont } from "./lib/fonts";
import { hydratePrefs, readPrefs, writePrefs, type AppPrefs } from "./lib/prefs";
import { DEFAULT_DATA_DIR_DISPLAY, isTauriRuntime, resolveDataDir } from "./lib/paths";
import { AgentView } from "./agent/AgentView";
import { webSessionSetDefaultFont } from "./agent/web-session";
import { AgentWorkspaceRail } from "./agent/AgentWorkspaceRail";
import type { AgentUiEffect } from "./agent/execute";
import { pickAgentWorkspaceFolder } from "./agent/pick-workspace";
import { readProviderStore } from "./agent/providers";
import { ensurePaddleOcr } from "./agent/ocr-models";
import { loadAgentPlugins } from "./agent/plugins-loader";
import { loadAgentSkills } from "./agent/skills-loader";
import { enqueueScheduleDelivery, getScheduleMeta } from "./agent/schedule-meta";
import { KnowledgeView } from "./notes/KnowledgeView";
import { SettingsView, type SettingsSectionId } from "./settings/SettingsView";
import { useDialog } from "./shell/Dialogs";
import { PromptModal } from "./shell/PromptModal";
import { Sidebar, type AppNavId } from "./shell/Sidebar";
import { TitleBar } from "./shell/TitleBar";
import { PlannerView } from "./tasks/PlannerView";
import { TaskEditor, type TaskEditorSave } from "./tasks/TaskEditor";
import { TaskRow } from "./tasks/TaskRow";
import { TasksView, type TasksViewMode } from "./tasks/TasksView";
import { TimedTaskEditor } from "./timed/TimedTaskEditor";
import { TimedTaskList } from "./timed/TimedTaskList";

const TASKS_VIEW_KEY = "wb.tasks.viewMode";

function readTasksViewMode(): TasksViewMode {
  const raw = localStorage.getItem(TASKS_VIEW_KEY);
  if (raw === "board" || raw === "stats") return raw;
  return "list";
}

function composerPlaceholder(nav: AppNavId, projectTitle: string | undefined): string {
  if (nav === "knowledge") return "写下笔记标题，回车创建（Ctrl+N）";
  if (nav === "timed") return "写下定时任务标题，回车创建每天 09:00（Ctrl+N）";
  if (nav === "today") {
    return "添加到今日，如：下午3:00 评审 提前15分钟（Ctrl+N）";
  }
  if (nav === "inbox") {
    return "添加到收件箱，如：回邮件 明天（Ctrl+N）";
  }
  if (nav === "done") {
    return "新建任务到收件箱（Ctrl+N）";
  }
  if (nav === "planner") {
    return "添加到计划，如：明天 写周报（Ctrl+N）";
  }
  if (nav === "projects") {
    return `添加到「${projectTitle ?? "项目"}」，如：明天 回访客户（Ctrl+N）`;
  }
  return "写下任务或命令（Ctrl+N）";
}

export default function App() {
  const dialog = useDialog();
  const [store] = useState(() => createPersistedStore());
  const [nav, setNav] = useState<AppNavId>(() => readPrefs().startupView);
  const [agentSectionOpen, setAgentSectionOpen] = useState(false);
  const forgetAgentThreadRef = useRef<(id: string) => void>(() => {});
  const [tick, setTick] = useState(0);
  const [draft, setDraft] = useState("");
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>("general");
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [prefs, setPrefs] = useState<AppPrefs>(() => readPrefs());
  const [agentSkills, setAgentSkills] = useState<AgentSkill[]>([]);
  const [hostTools, setHostTools] = useState<HostToolSnapshot[]>([]);
  const [pluginCatalog, setPluginCatalog] = useState<LoadedPlugin[]>([]);
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
  const [filterProjectId, setFilterProjectId] = useState("inbox");
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const composerRef = useRef<HTMLInputElement>(null);
  const [tasksViewMode, setTasksViewMode] = useState<TasksViewMode>(() =>
    readTasksViewMode(),
  );
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [agentThreadId, setAgentThreadId] = useState<string | null>(null);
  const [agentBusyThreadId, setAgentBusyThreadId] = useState<string | null>(null);
  const [cooldown] = useState(() => new ReminderUiCooldown());
  const [timer] = useState(() => new ActiveTimer());
  const [activeTimerTaskId, setActiveTimerTaskId] = useState<string | null>(null);
  const [timerStartedAt, setTimerStartedAt] = useState<number | null>(null);
  const [activeReminders, setActiveReminders] = useState<
    Array<{ taskId: string; title: string; remindAt: number; isDeadline: boolean }>
  >([]);
  const [now, setNow] = useState(() => Date.now());

  const today = formatLocalDay(now);

  const persist = useCallback(() => {
    saveStore(store);
  }, [store]);

  const refresh = useCallback(() => {
    persist();
    setNow(Date.now());
    setTick((n) => n + 1);
  }, [persist]);

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
    applyUiFont(prefs.uiFont);
    void webSessionSetDefaultFont(prefs.webFont);
  }, [prefs.uiFont, prefs.webFont]);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void ensurePaddleOcr().then((result) => {
      if (cancelled) return;
      if (result.ok === true) {
        const stale = store
          .listNotifications()
          .filter(
            (item) => item.title === "识图模型下载失败" && item.status !== "dismissed",
          );
        if (!stale.length) return;
        for (const item of stale) store.dismissNotification(item.id);
        refresh();
        return;
      }
      if (result.skipped) return;
      store.pushNotification({
        kind: "system",
        title: "识图模型下载失败",
        body: result.message,
      });
      setNotificationsOpen(true);
      refresh();
    });
    return () => {
      cancelled = true;
    };
  }, [ready, store, refresh]);

  useEffect(() => {
    let cancelled = false;
    void loadAgentSkills(prefs.skillDirs).then((skills) => {
      if (!cancelled) setAgentSkills(skills);
    });
    return () => {
      cancelled = true;
    };
  }, [prefs.skillDirs]);

  useEffect(() => {
    if (!ready || !prefs.hostToolsFetched) return;
    setHostTools(assembleHostTools(prefs.hostToolRecords, prefs.disabledHostTools));
  }, [prefs.disabledHostTools, prefs.hostToolRecords, prefs.hostToolsFetched, ready]);

  useEffect(() => {
    let cancelled = false;
    void loadAgentPlugins(prefs.pluginDirs).then((plugins) => {
      if (!cancelled) setPluginCatalog(plugins);
    });
    return () => {
      cancelled = true;
    };
  }, [prefs.pluginDirs]);

  useEffect(() => {
    const id = window.setInterval(() => {
      const at = Date.now();
      setNow(at);
      const delivered = store.deliverDueReminders(at);
      const visible = delivered.filter(
        (d) => !cooldown.isSuppressed(d.taskId, d.remindAt, at),
      );
      let timedFired = false;
      for (const task of store.listDueTimedTasks(at)) {
        store.markTimedTaskRan(task.id, at);
        timedFired = true;
        store.pushNotification({
          kind: "system",
          title: `定时任务 · ${task.title}`,
          body: task.command.trim().slice(0, 240) || "已到期",
          nowMs: at,
        });
        const meta = getScheduleMeta(task.id);
        let threadId = meta?.threadId ?? null;
        if (meta?.target === "new") {
          const workspaceId =
            meta.workspaceId ?? store.listAgentWorkspaces()[0]?.id ?? null;
          if (workspaceId) {
            const child = store.createAgentThread({
              workspaceId,
              title: `定时 · ${task.title}`,
              nowMs: at,
            });
            threadId = child.id;
          }
        }
        if (threadId && task.command.trim()) {
          enqueueScheduleDelivery({
            scheduleId: task.id,
            threadId,
            prompt: task.command.trim(),
            title: task.title,
            at,
          });
        }
      }
      if (visible.length) {
        const note = formatHookNotices(
          hooksForEvent(
            [...prefs.agentHooks, ...pluginCatalog.flatMap((item) => item.hooks)],
            "reminder_due",
          ),
        );
        setActiveReminders((prev) =>
          [...visible.map((item) => ({ ...item, note })), ...prev].slice(0, 5),
        );
        setNotificationsOpen(true);
        refresh();
      } else if (timedFired) {
        setNotificationsOpen(true);
        refresh();
      }
    }, 15_000);
    return () => window.clearInterval(id);
  }, [store, cooldown, refresh, prefs.agentHooks, pluginCatalog]);

  // Refresh wall clock at next local midnight so 明天 → 今天 flips promptly.
  useEffect(() => {
    const schedule = () => {
      const at = Date.now();
      const next = new Date(at);
      next.setHours(24, 0, 0, 50);
      return window.setTimeout(
        () => {
          setNow(Date.now());
        },
        Math.max(50, next.getTime() - at),
      );
    };
    let id = schedule();
    const onVisible = () => {
      if (document.visibilityState === "visible") setNow(Date.now());
    };
    document.addEventListener("visibilitychange", onVisible);
    const tick = window.setInterval(() => {
      window.clearTimeout(id);
      id = schedule();
    }, 60_000);
    return () => {
      window.clearTimeout(id);
      window.clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    if (!activeTimerTaskId) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [activeTimerTaskId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (settingsOpen) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        composerRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen]);

  void tick;
  const todayTasks = store.listToday(now);
  const allTasks = store.listTasks();
  const plannerTasks = selectPlannerTasks(allTasks);
  const openTasks = allTasks.filter((t) => !t.isDone);
  const notifications = store.listNotifications();
  const notes = store.listNotes();
  const projects = store.listProjects();
  const timedTasks = store.listTimedTasks();
  const allTags = store.listTags();
  const doneTasks = useMemo(
    () => allTasks.filter((t) => t.isDone && !t.parentId),
    [allTasks],
  );
  const taskNavCounts = useMemo(
    () => ({
      today: todayTasks.length,
      inbox: filterTasks(allTasks, {
        projectId: INBOX_PROJECT_ID,
        showCompleted: false,
        rootsOnly: true,
        today,
      }).length,
      done: doneTasks.length,
      planner: plannerTasks.length,
      timed: timedTasks.length,
    }),
    [todayTasks, allTasks, today, doneTasks, plannerTasks, timedTasks],
  );
  const projectTaskCounts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const p of projects) {
      if (p.id === INBOX_PROJECT_ID) continue;
      map[p.id] = filterTasks(allTasks, {
        projectId: p.id,
        showCompleted: false,
        rootsOnly: true,
        today,
      }).length;
    }
    return map;
  }, [projects, allTasks, today]);
  const projectTitles = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of projects) map[p.id] = p.title;
    return map;
  }, [projects]);
  const taskBuckets = useMemo(() => {
    const map: Record<string, ProjectBucket> = {};
    for (const t of allTasks) {
      map[t.id] = store.getTaskBucket(t.id);
    }
    return map;
  }, [allTasks, store]);
  const taskTagMap = useMemo(() => {
    void tick;
    const map: Record<string, Tag[]> = {};
    for (const t of allTasks) {
      map[t.id] = store.listTagsForTask(t.id);
    }
    return map;
  }, [allTasks, store, tick]);

  const editingTask = editingTaskId ? (store.getTask(editingTaskId) ?? null) : null;
  const openNote = activeNoteId ? store.getNote(activeNoteId) : null;
  const timerTask = activeTimerTaskId ? (store.getTask(activeTimerTaskId) ?? null) : null;
  const agentFocus = [
    editingTask ? `任务「${editingTask.title}」` : "",
    openNote ? `笔记「${openNote.title}」` : "",
    timerTask && timerTask.id !== editingTask?.id ? `正在计时「${timerTask.title}」` : "",
  ]
    .filter(Boolean)
    .join("，");
  const timerElapsedMs =
    activeTimerTaskId && timerStartedAt != null ? Math.max(0, now - timerStartedAt) : 0;

  const scheduleToday = (task: Task) => {
    store.scheduleTask(task.id, { dueDay: today });
    refresh();
  };

  const scheduleAfternoon = (task: Task) => {
    const at = new Date();
    at.setHours(15, 0, 0, 0);
    store.scheduleTask(task.id, {
      dueWithTime: at.getTime(),
      ...(prefs.defaultRemind !== "none" ? { remindOption: prefs.defaultRemind } : {}),
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

    if (!draft.dueWithTimeLocal) {
      store.scheduleTask(taskId, {
        dueDay: null,
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

    if (!draft.deadlineWithTimeLocal) {
      store.scheduleTask(taskId, {
        deadlineDay: null,
        deadlineWithTime: null,
      });
    } else {
      const deadlineMs = Date.parse(draft.deadlineWithTimeLocal);
      const safeDeadline = Number.isNaN(deadlineMs) ? Date.now() : deadlineMs;
      store.scheduleTask(taskId, {
        deadlineWithTime: safeDeadline,
      });
    }

    if (!task.parentId) {
      store.setRepeatCfg(taskId, draft.repeat ? encodeTaskRepeat(draft.repeat) : null);
    }
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

  const goNav = (id: AppNavId) => {
    setSettingsOpen(false);
    setTimedEditing(false);
    setTimedEditId(null);
    setEditingTaskId(null);
    if (id === "inbox") setFilterProjectId(INBOX_PROJECT_ID);
    if (id === "agent") setAgentSectionOpen(true);
    setNav(id);
  };

  const openProject = (projectId: string) => {
    if (projectId === INBOX_PROJECT_ID) {
      goNav("inbox");
      return;
    }
    setFilterProjectId(projectId);
    goNav("projects");
  };

  const capture = () => {
    const text = draft.trim();
    if (!text || settingsOpen) return;
    const nowMs = Date.now();

    if (text.startsWith("/")) {
      const [cmd, ...rest] = text.slice(1).split(/\s+/);
      const arg = rest.join(" ").trim();
      if (cmd === "项目" || cmd === "project") {
        if (!arg) setCreateProjectOpen(true);
        else {
          const created = store.createProject(arg);
          refresh();
          openProject(created.id);
        }
        setDraft("");
        return;
      }
      if (cmd === "笔记" || cmd === "note") {
        const note = store.createNote({
          title: arg || "未命名笔记",
          bodyMd: arg ? `# ${arg}\n\n` : "# 未命名笔记\n\n",
          nowMs,
        });
        setActiveNoteId(note.id);
        goNav("knowledge");
        setDraft("");
        refresh();
        return;
      }
      if (cmd === "定时" || cmd === "timed") {
        store.createTimedTask({
          title: arg || "未命名定时任务",
          command: "",
          schedule: makePresetSchedule("daily"),
          nowMs,
        });
        goNav("timed");
        setDraft("");
        refresh();
        return;
      }
    }

    if (nav === "knowledge") {
      const note = store.createNote({
        title: text,
        bodyMd: `# ${text}\n\n`,
        nowMs,
      });
      setActiveNoteId(note.id);
      setDraft("");
      refresh();
      return;
    }

    if (nav === "timed") {
      store.createTimedTask({
        title: text,
        command: "",
        schedule: makePresetSchedule("daily"),
        nowMs,
      });
      setDraft("");
      refresh();
      return;
    }

    const parsed = parseQuickCapture(text, { nowMs });
    let projectId = INBOX_PROJECT_ID;
    if (parsed.projectTitle) {
      const existing = projects.find((p) => p.title === parsed.projectTitle);
      projectId = existing?.id ?? store.createProject(parsed.projectTitle).id;
    } else if (nav === "projects" || nav === "inbox") {
      projectId = nav === "inbox" ? INBOX_PROJECT_ID : filterProjectId;
    }

    let dueDay = parsed.dueDay;
    let dueWithTime = parsed.dueWithTime;
    if (!dueDay && !dueWithTime) {
      // 今日/计划视图捕获时默认排到「现在」这一天，避免无计划进不了时间线
      if (nav === "today" || nav === "planner") dueDay = formatLocalDay(nowMs);
    }

    const remindOption =
      parsed.remindOption !== "none"
        ? parsed.remindOption
        : dueWithTime && prefs.defaultRemind !== "none"
          ? prefs.defaultRemind
          : undefined;

    const task = store.createTask({
      title: parsed.title,
      projectId,
      nowMs,
    });
    if (dueDay || dueWithTime || parsed.deadlineDay) {
      store.scheduleTask(task.id, {
        dueDay,
        dueWithTime,
        deadlineDay: parsed.deadlineDay,
        remindAt: parsed.remindAt,
        ...(remindOption ? { remindOption } : {}),
      });
    }
    setDraft("");
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

  const updateNote = (id: string, patch: { title?: string; bodyMd?: string }) => {
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

  const deleteNote = async (id: string) => {
    if (prefs.confirmBeforeDelete) {
      const ok = await dialog.confirm({
        title: "删除笔记",
        message: "确定删除这篇笔记？此操作不可撤销。",
        confirmLabel: "删除",
        danger: true,
      });
      if (!ok) return;
    }
    store.deleteNote(id);
    setActiveNoteId((prev) => (prev === id ? null : prev));
    refresh();
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

  const deleteTimedTask = async (id: string) => {
    if (prefs.confirmBeforeDelete) {
      const ok = await dialog.confirm({
        title: "删除定时任务",
        message: "确定删除该定时任务？",
        confirmLabel: "删除",
        danger: true,
      });
      if (!ok) return;
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

  const openAgent = () => {
    const threads = store.listAgentThreads();
    const current = threads.find((item) => item.id === agentThreadId) ?? threads[0];
    if (current) setAgentThreadId(current.id);
    else setAgentThreadId(null);
    refresh();
    goNav("agent");
  };

  const toggleAgentSection = () => {
    if (settingsOpen || nav !== "agent") {
      openAgent();
      return;
    }
    setAgentSectionOpen((open) => !open);
  };

  const newAgentChat = (opts: { workspaceId?: string; rootPath?: string }) => {
    const nowMs = Date.now();
    let workspaceId = opts.workspaceId;
    if (opts.rootPath) {
      const existing = store.findAgentWorkspaceByRootPath(opts.rootPath);
      const workspace =
        existing ??
        store.createAgentWorkspace({
          title: agentWorkspaceTitleFromPath(opts.rootPath),
          rootPath: opts.rootPath,
          nowMs,
        });
      workspaceId = workspace.id;
    }
    const created = store.createAgentThread({
      nowMs,
      workspaceId,
      modelRef: readProviderStore().defaultModelRef,
    });
    setAgentThreadId(created.id);
    refresh();
    goNav("agent");
  };

  const newAgentChatFromFolder = async () => {
    const rootPath = await pickAgentWorkspaceFolder(dialog.prompt);
    if (!rootPath) return;
    newAgentChat({ rootPath });
  };

  const openAgentWebSession = async () => {
    const raw = await dialog.prompt({
      title: "打开网页",
      label: "网址",
      confirmLabel: "打开",
    });
    if (!raw) return;
    const webUrl = normalizeAgentWebUrl(raw);
    if (!webUrl) {
      await dialog.alert({ title: "无法打开", message: "请输入 http 或 https 网址。" });
      return;
    }
    const existing = store
      .listAgentWorkspaces()
      .find((item) => item.title === DEFAULT_AGENT_WORKSPACE_TITLE);
    const workspace =
      existing ?? store.createAgentWorkspace({ title: DEFAULT_AGENT_WORKSPACE_TITLE });
    const created = store.createAgentThread({
      workspaceId: workspace.id,
      title: WEB_AGENT_THREAD_TITLE,
      webUrl,
      modelRef: readProviderStore().defaultModelRef,
    });
    setAgentThreadId(created.id);
    refresh();
    goNav("agent");
  };

  const applyAgentEffects = (effects: AgentUiEffect[]) => {
    for (const effect of effects) {
      if (effect.type === "navigate") goNav(effect.nav);
      else if (effect.type === "open-task") setEditingTaskId(effect.taskId);
      else if (effect.type === "open-note") {
        setActiveNoteId(effect.noteId);
        goNav("knowledge");
      } else if (effect.type === "notifications") setNotificationsOpen(true);
      else if (effect.type === "timer-start") {
        const task = store.getTask(effect.taskId);
        if (task && activeTimerTaskId !== task.id) toggleTimer(task);
      } else if (effect.type === "timer-stop") {
        if (activeTimerTaskId) {
          const task = store.getTask(activeTimerTaskId);
          if (task) toggleTimer(task);
        }
      } else if (effect.type === "rename") {
        updatePrefs({ ...prefs, displayName: effect.displayName });
      }
    }
    refresh();
  };

  let body;
  if (nav === "today") {
    const todayEmpty = prefs.showTips
      ? "从各项目里拖进来，或按下方输入写下今天要做的事。"
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
        projectTitles={projectTitles}
        taskTagMap={taskTagMap}
        denseMeta={prefs.workMode === "office"}
        reorderable
        hint="汇总全部项目 · 拖拽可调整今日顺序"
        nowMs={now}
        activeTimerTaskId={activeTimerTaskId}
        timerElapsedMs={timerElapsedMs}
        onToggleDone={toggleDone}
        onOpen={(t) => setEditingTaskId(t.id)}
        onReorder={reorderToday}
      />
    );
  } else if (nav === "inbox") {
    body = (
      <TasksView
        tasks={allTasks}
        projects={projects}
        tags={allTags}
        taskTagMap={taskTagMap}
        buckets={taskBuckets}
        filterProjectId={INBOX_PROJECT_ID}
        viewMode={tasksViewMode}
        denseMeta={prefs.workMode === "office"}
        defaultRemind={prefs.defaultRemind}
        confirmBeforeDelete={prefs.confirmBeforeDelete}
        activeTimerTaskId={activeTimerTaskId}
        timerElapsedMs={timerElapsedMs}
        nowMs={now}
        onViewModeChange={changeTasksViewMode}
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
      />
    );
  } else if (nav === "done") {
    const doneList = [...doneTasks].sort((a, b) => (b.doneOn ?? 0) - (a.doneOn ?? 0));
    body = (
      <TaskList
        title="已完成"
        empty="还没有已完成的任务。"
        tasks={doneList}
        projectTitles={projectTitles}
        taskTagMap={taskTagMap}
        hint="汇总全部项目的已完成任务"
        nowMs={now}
        showDoneStyle
        activeTimerTaskId={activeTimerTaskId}
        timerElapsedMs={timerElapsedMs}
        onToggleDone={toggleDone}
        onOpen={(t) => setEditingTaskId(t.id)}
      />
    );
  } else if (nav === "planner") {
    body = (
      <PlannerView
        tasks={plannerTasks}
        projectTitles={projectTitles}
        taskTagMap={taskTagMap}
        nowMs={now}
        activeTimerTaskId={activeTimerTaskId}
        timerElapsedMs={timerElapsedMs}
        onToggleDone={toggleDone}
        onOpen={(t) => setEditingTaskId(t.id)}
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
  } else if (nav === "agent") {
    body = (
      <AgentView
        store={store}
        threadId={agentThreadId}
        displayName={prefs.displayName}
        rules={prefs.agentRules}
        skills={dedupeSkillNames(
          [...agentSkills, ...pluginCatalog.flatMap((item) => item.skills)].map(
            (skill) => ({
              ...skill,
              enabled: !prefs.disabledSkillIds.includes(skill.id),
            }),
          ),
        )}
        memories={prefs.agentMemories}
        onMemories={(next) => {
          setPrefs((current) => {
            const updated = { ...current, agentMemories: next };
            writePrefs(updated);
            return updated;
          });
        }}
        commands={mergeCustomCommands(
          prefs.agentCommands,
          pluginCatalog.flatMap((item) => item.commands),
        )}
        subagents={mergeSubagents(
          prefs.agentSubagents,
          pluginCatalog.flatMap((item) => item.subagents),
        )}
        hooks={[...prefs.agentHooks, ...pluginCatalog.flatMap((item) => item.hooks)]}
        plugins={pluginCatalog
          .filter((item) => !item.error)
          .map((item) => ({
            name: item.name,
            version: item.version,
            description: item.description,
          }))}
        mcpServers={[...prefs.mcpServers, ...pluginCatalog.flatMap((item) => item.mcp)]}
        hostTools={hostTools}
        focus={agentFocus || null}
        activeTimerTaskId={activeTimerTaskId}
        timerStartedAt={timerStartedAt}
        onSelectThread={setAgentThreadId}
        onCreateThread={(workspaceId) => newAgentChat({ workspaceId })}
        onCreateFromFolder={() => void newAgentChatFromFolder()}
        onOpenModels={() => openSettings("models")}
        onOpenSkills={() => openSettings("skills")}
        onEffects={applyAgentEffects}
        onRefresh={refresh}
        onPersist={persist}
        onBusyThreadChange={setAgentBusyThreadId}
        forgetThreadRef={forgetAgentThreadRef}
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
        denseMeta={prefs.workMode === "office"}
        defaultRemind={prefs.defaultRemind}
        confirmBeforeDelete={prefs.confirmBeforeDelete}
        activeTimerTaskId={activeTimerTaskId}
        timerElapsedMs={timerElapsedMs}
        nowMs={now}
        onViewModeChange={changeTasksViewMode}
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
        onDismissNotification={(id) => {
          store.dismissNotification(id);
          refresh();
        }}
      />
      {settingsOpen ? (
        <SettingsView
          key={settingsSection}
          prefs={prefs}
          dataDir={dataDir}
          onPrefsChange={updatePrefs}
          onBack={() => setSettingsOpen(false)}
          initialSection={settingsSection}
          onHostTools={setHostTools}
        />
      ) : (
        <div className={sidebarCollapsed ? "shell__body is-collapsed" : "shell__body"}>
          <Sidebar
            collapsed={sidebarCollapsed}
            onToggleCollapsed={() => setSidebarCollapsed((v) => !v)}
            nav={nav}
            onNav={goNav}
            settingsOpen={settingsOpen}
            onOpenSettings={() => openSettings("general")}
            projects={projects}
            activeProjectId={filterProjectId}
            taskNavCounts={taskNavCounts}
            projectTaskCounts={projectTaskCounts}
            notes={notes}
            onCreateProject={() => setCreateProjectOpen(true)}
            onSelectProject={openProject}
            onSelectNote={(id) => {
              setActiveNoteId(id);
              goNav("knowledge");
            }}
            onOpenAgent={openAgent}
            agentOpen={agentSectionOpen}
            onToggleAgent={toggleAgentSection}
            onOpenAgentWeb={() => void openAgentWebSession()}
            onCreateAgentFromFolder={() => void newAgentChatFromFolder()}
            agentRail={
              <AgentWorkspaceRail
                store={store}
                threadId={agentThreadId}
                busyThreadId={agentBusyThreadId}
                onSelectThread={(id) => {
                  setAgentThreadId(id);
                  goNav("agent");
                }}
                onCreateThread={(workspaceId) => newAgentChat({ workspaceId })}
                onForgetThread={(id) => forgetAgentThreadRef.current(id)}
                onRefresh={refresh}
              />
            }
            displayName={prefs.displayName || "本地用户"}
          />
          <main className="main">
            {body}
            {editingTask && nav !== "projects" ? (
              <TaskEditor
                key={editingTask.id}
                task={editingTask}
                bucket={taskBuckets[editingTask.id] ?? "active"}
                projects={projects}
                tags={allTags}
                selectedTagIds={(taskTagMap[editingTask.id] ?? []).map((t) => t.id)}
                subtasks={store.listSubtasks(editingTask.id)}
                defaultRemind={prefs.defaultRemind}
                nowMs={now}
                onClose={() => setEditingTaskId(null)}
                onDelete={() => {
                  void (async () => {
                    if (prefs.confirmBeforeDelete) {
                      const ok = await dialog.confirm({
                        title: "删除任务",
                        message: "确定删除该任务？此操作不可撤销。",
                        confirmLabel: "删除",
                        danger: true,
                      });
                      if (!ok) return;
                    }
                    deleteTask(editingTask.id);
                  })();
                }}
                onDuplicate={() => {
                  duplicateTask(editingTask.id);
                  setEditingTaskId(null);
                }}
                onCreateTag={createTag}
                onAddSubtask={(title) => addSubtask(editingTask.id, title)}
                onToggleSubtask={toggleDone}
                onDeleteSubtask={(id) => {
                  void (async () => {
                    if (prefs.confirmBeforeDelete) {
                      const ok = await dialog.confirm({
                        title: "删除子任务",
                        message: "确定删除该子任务？此操作不可撤销。",
                        confirmLabel: "删除",
                        danger: true,
                      });
                      if (!ok) return;
                    }
                    deleteTask(id);
                  })();
                }}
                onSave={(draft) => {
                  saveEditedTask(editingTask.id, draft);
                  setEditingTaskId(null);
                }}
              />
            ) : null}
            {nav !== "agent" ? (
              <footer className="composer">
                <input
                  ref={composerRef}
                  aria-label="快速捕获"
                  placeholder={composerPlaceholder(nav, projectTitles[filterProjectId])}
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
      )}
      <PromptModal
        open={createProjectOpen}
        title="新建项目"
        label="项目名称"
        initialValue="新项目"
        confirmLabel="创建"
        onCancel={() => setCreateProjectOpen(false)}
        onConfirm={(title) => {
          const created = store.createProject(title);
          setCreateProjectOpen(false);
          refresh();
          openProject(created.id);
        }}
      />
    </div>
  );
}

function TaskList(props: {
  title: string;
  empty: string;
  tasks: Task[];
  projectTitles?: Record<string, string>;
  taskTagMap?: Record<string, Tag[]>;
  denseMeta?: boolean;
  showDoneStyle?: boolean;
  reorderable?: boolean;
  hint?: string;
  nowMs?: number;
  activeTimerTaskId?: string | null;
  timerElapsedMs?: number;
  onToggleDone: (t: Task) => void;
  onOpen: (t: Task) => void;
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
      {props.hint ? <p className="panel__hint">{props.hint}</p> : null}
      {props.tasks.length === 0 ? (
        <p className="empty">{props.empty}</p>
      ) : (
        <ul className="list" aria-label={`${props.title}列表`}>
          {props.tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              projectTitle={props.projectTitles?.[task.projectId]}
              tags={props.taskTagMap?.[task.id] ?? []}
              denseMeta={props.denseMeta}
              showDoneStyle={props.showDoneStyle}
              nowMs={props.nowMs}
              timerRunning={props.activeTimerTaskId === task.id}
              timerElapsedMs={
                props.activeTimerTaskId === task.id ? (props.timerElapsedMs ?? 0) : 0
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
              onDragOver={props.reorderable ? (id) => setOverId(id) : undefined}
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
            />
          ))}
        </ul>
      )}
    </section>
  );
}
