import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
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
  isTimedTaskAutoDue,
  isTimedTaskMissed,
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
} from "@wb/domain";
import {
  createPersistedStore,
  getLastSaveStatus,
  hydrateStore,
  saveStore,
  scheduleSaveStore,
  subscribeSaveStatus,
  type SaveStatus,
} from "./lib/persistence";
import { applyUiFont, prefetchSystemFonts } from "./lib/fonts";
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
import {
  deleteScheduleMeta,
  getScheduleMeta,
  setScheduleMeta,
} from "./agent/schedule-meta";
import { KnowledgeView } from "./notes/KnowledgeView";
import {
  loadKnowledgeRoots,
  scanKnowledgeFiles,
  type KbEntry,
  type KbScanProgress,
} from "./notes/kb-api";
import { SettingsView, type SettingsSectionId } from "./settings/SettingsView";
import { CommandPalette, type CommandPaletteResult } from "./shell/CommandPalette";
import { DialogOutlet, useDialog } from "./shell/Dialogs";
import { PromptModal } from "./shell/PromptModal";
import { Sidebar, type AppNavId } from "./shell/Sidebar";
import { TitleBar } from "./shell/TitleBar";
import { PlannerView } from "./tasks/PlannerView";
import { TaskEditor, type TaskEditorSave } from "./tasks/TaskEditor";
import { TaskRow } from "./tasks/TaskRow";
import { TasksView, type TasksViewMode } from "./tasks/TasksView";
import { TimedTaskEditor, type TimedDraft } from "./timed/TimedTaskEditor";
import { TimedTaskList, type TimedTaskBindingView } from "./timed/TimedTaskList";
import { runTimedTaskNow, skipTimedTaskOccurrence } from "./timed/run-timed-task";
import { VoiceField, VoiceInputProvider } from "./voice";

const EMPTY_TIMED_DRAFT: TimedDraft = {
  title: "未命名定时任务",
  command: "",
  schedule: null,
  threadId: null,
  skillIds: [],
  enabled: true,
};

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
  const [agentShowArchived, setAgentShowArchived] = useState(false);
  const forgetAgentThreadRef = useRef<(id: string) => void>(() => {});
  const [tick, setTick] = useState(0);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => readPrefs().sidebarWidth);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>("general");
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [prefs, setPrefs] = useState<AppPrefs>(() => readPrefs());
  const [saveStatus, setSaveStatus] = useState<SaveStatus>(() => getLastSaveStatus());
  const [agentSkills, setAgentSkills] = useState<AgentSkill[]>([]);
  const [hostTools, setHostTools] = useState<HostToolSnapshot[]>([]);
  const [pluginCatalog, setPluginCatalog] = useState<LoadedPlugin[]>([]);
  const [dataDir, setDataDir] = useState(DEFAULT_DATA_DIR_DISPLAY);
  const [ready, setReady] = useState(() => !isTauriRuntime());
  const [timedEditing, setTimedEditing] = useState(false);
  const [timedEditId, setTimedEditId] = useState<string | null>(null);
  const [timedDraft, setTimedDraft] = useState<TimedDraft>(EMPTY_TIMED_DRAFT);
  const [filterProjectId, setFilterProjectId] = useState("inbox");
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const focusComposerRef = useRef<(() => void) | null>(null);
  const [tasksViewMode, setTasksViewMode] = useState<TasksViewMode>(() =>
    readTasksViewMode(),
  );
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [agentThreadId, setAgentThreadId] = useState<string | null>(null);
  const [agentBusyThreadId, setAgentBusyThreadId] = useState<string | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [pendingKbPath, setPendingKbPath] = useState<string | null>(null);
  const [noteFocusToken, setNoteFocusToken] = useState(0);
  const [paletteKbFiles, setPaletteKbFiles] = useState<KbEntry[]>([]);
  const [paletteKbLoading, setPaletteKbLoading] = useState(false);
  const [paletteKbProgress, setPaletteKbProgress] = useState<KbScanProgress | null>(null);
  const [paletteKbRoots, setPaletteKbRoots] = useState<string[]>([]);
  const paletteKbCacheRef = useRef<{
    rootsKey: string;
    at: number;
    files: KbEntry[];
  } | null>(null);
  const [cooldown] = useState(() => new ReminderUiCooldown());
  const [timer] = useState(() => new ActiveTimer());
  const [activeTimerTaskId, setActiveTimerTaskId] = useState<string | null>(null);
  const [timerStartedAt, setTimerStartedAt] = useState<number | null>(null);
  const [activeReminders, setActiveReminders] = useState<
    Array<{ taskId: string; title: string; remindAt: number; isDeadline: boolean }>
  >([]);
  const [now, setNow] = useState(() => Date.now());

  const today = formatLocalDay(now);

  /** 合并写入：短时间内多次改动只落盘一次，避免每个按键都全量序列化 */
  const persist = useCallback(() => {
    scheduleSaveStore(store);
  }, [store]);

  useEffect(() => {
    const flush = () => {
      if (noteRefreshTimer.current != null) {
        window.clearTimeout(noteRefreshTimer.current);
        noteRefreshTimer.current = null;
      }
      saveStore(store);
    };
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, [store]);

  const refresh = useCallback(() => {
    persist();
    setNow(Date.now());
    setTick((n) => n + 1);
  }, [persist]);

  /** 应用内笔记输入高频触发：更新 store 但延后持久化与全局重渲染，避免每键全量刷新 */
  const noteRefreshTimer = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (noteRefreshTimer.current != null) window.clearTimeout(noteRefreshTimer.current);
    };
  }, []);
  const scheduleNoteRefresh = useCallback(() => {
    if (noteRefreshTimer.current != null) window.clearTimeout(noteRefreshTimer.current);
    noteRefreshTimer.current = window.setTimeout(() => {
      noteRefreshTimer.current = null;
      persist();
      setNow(Date.now());
      setTick((n) => n + 1);
    }, 300);
  }, [persist]);

  const flushNoteRefresh = useCallback(() => {
    if (noteRefreshTimer.current == null) return;
    window.clearTimeout(noteRefreshTimer.current);
    noteRefreshTimer.current = null;
    persist();
    setNow(Date.now());
    setTick((n) => n + 1);
  }, [persist]);

  useEffect(() => subscribeSaveStatus(setSaveStatus), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const hydrate = await hydrateStore(store);
      const nextPrefs = await hydratePrefs();
      const dir = await resolveDataDir();
      if (cancelled) return;
      if (hydrate.restoredFromBackup) {
        store.pushNotification({
          kind: "system",
          title: "已从备份恢复数据",
          body: "检测到主数据文件不可用，已自动回退到最近的可用备份。",
        });
      } else if (hydrate.hadLoadIssue) {
        store.pushNotification({
          kind: "system",
          title: "本地数据加载异常",
          body: "读取本地数据时出现问题，当前可能为空白状态，请检查数据目录与备份文件。",
        });
      }
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
    // Wait until the shell is ready so Tauri IPC is available; avoid caching a
    // short browser probe list before the full desktop catalog returns.
    prefetchSystemFonts();
  }, [ready]);

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

  const enabledAgentSkills = useMemo(
    () =>
      dedupeSkillNames(
        [...agentSkills, ...pluginCatalog.flatMap((item) => item.skills)].map(
          (skill) => ({
            ...skill,
            enabled: !prefs.disabledSkillIds.includes(skill.id),
          }),
        ),
      ),
    [agentSkills, pluginCatalog, prefs.disabledSkillIds],
  );

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
        // Missed while the app was down: wait for the timed panel "立即执行".
        if (!isTimedTaskAutoDue(task, at)) continue;
        runTimedTaskNow(store, task, {
          nowMs: at,
          skills: enabledAgentSkills,
        });
        timedFired = true;
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
  }, [store, cooldown, refresh, prefs.agentHooks, enabledAgentSkills]);

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
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === "p" || key === "k") {
        e.preventDefault();
        setCommandPaletteOpen(true);
        return;
      }
      if (settingsOpen) return;
      if (key === "n") {
        e.preventDefault();
        focusComposerRef.current?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen]);

  useEffect(() => {
    if (!commandPaletteOpen) {
      setPaletteKbRoots([]);
      setPaletteKbProgress(null);
      return;
    }
    const roots = loadKnowledgeRoots();
    setPaletteKbRoots(roots);
    if (!isTauriRuntime()) {
      setPaletteKbFiles([]);
      setPaletteKbLoading(false);
      setPaletteKbProgress(null);
      return;
    }
    const rootsKey = roots.join("\0");
    if (roots.length === 0) {
      paletteKbCacheRef.current = null;
      setPaletteKbFiles([]);
      setPaletteKbLoading(false);
      setPaletteKbProgress(null);
      return;
    }
    const cached = paletteKbCacheRef.current;
    const fresh =
      cached && cached.rootsKey === rootsKey && Date.now() - cached.at < 60_000;
    if (fresh) {
      setPaletteKbFiles(cached.files);
      setPaletteKbLoading(false);
      setPaletteKbProgress(null);
      return;
    }
    if (cached && cached.rootsKey === rootsKey) {
      setPaletteKbFiles(cached.files);
      setPaletteKbLoading(false);
    } else {
      setPaletteKbLoading(true);
    }
    let cancelled = false;
    // 扫描会话索引：每批增量展示（从头累积，避免与已展示的缓存列表拼接重复），
    // 进度随批更新；取消时立刻停止取批并由后端终结会话。
    const acc: KbEntry[] = [];
    void scanKnowledgeFiles(roots, {
      maxFiles: 8000,
      isCancelled: () => cancelled,
      onBatch: (batch) => {
        if (cancelled) return;
        acc.push(...batch);
        setPaletteKbFiles(acc.slice());
      },
      onProgress: (progress) => {
        if (cancelled) return;
        setPaletteKbProgress(progress);
      },
    })
      .then((files) => {
        if (cancelled) return;
        paletteKbCacheRef.current = { rootsKey, at: Date.now(), files };
        setPaletteKbFiles(files);
      })
      .catch(() => {
        if (cancelled) return;
        if (!cached || cached.rootsKey !== rootsKey) setPaletteKbFiles([]);
      })
      .finally(() => {
        if (!cancelled) {
          setPaletteKbLoading(false);
          setPaletteKbProgress(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [commandPaletteOpen]);

  const dataTick = tick;
  void dataTick;
  const nowMinute = Math.floor(now / 60_000);
  // 分钟粒度的时间戳：任务视图的相对标签/过期判断只需分钟精度，
  // 传入分钟值让 memo 化视图在秒级 tick 时命中缓存（计时器走独立 timerElapsedMs）。
  const nowMinuteMs = nowMinute * 60_000;
  // 今日列表顺序的版本号：setTodayOrder 不触碰 tasks Map，需要独立信号驱动 todayTasks 重算。
  const [todayOrderRev, bumpTodayOrderRev] = useState(0);
  const allTasks = useMemo(() => store.listTasks(), [store, dataTick]);
  const todayTasks = useMemo(
    () => store.listToday(now),
    // listToday = selectTodayTasks(allTasks, todayOrder, nowMs)：
    // 依赖收敛为任务集合 + 顺序版本 + 分钟粒度时钟，store tick 不再触发全量重算。
    [store, nowMinute, allTasks, todayOrderRev],
  );
  const plannerTasks = useMemo(() => selectPlannerTasks(allTasks), [allTasks]);
  const openTasks = useMemo(() => allTasks.filter((t) => !t.isDone), [allTasks]);
  const notifications = useMemo(() => store.listNotifications(), [store, dataTick]);
  const notes = useMemo(() => store.listNotes(), [store, dataTick]);
  const projects = useMemo(() => store.listProjects(), [store, dataTick]);
  const timedTasks = useMemo(() => store.listTimedTasks(), [store, dataTick]);
  const allTags = useMemo(() => store.listTags(), [store, dataTick]);
  const paletteThreads = useMemo(
    () => store.listAgentThreads({ includeArchived: agentShowArchived }),
    [store, agentShowArchived, dataTick],
  );
  const paletteWorkspaces = useMemo(() => store.listAgentWorkspaces(), [store, dataTick]);
  const timedBindings = useMemo(() => {
    const map: Record<string, TimedTaskBindingView> = {};
    for (const task of timedTasks) {
      const meta = getScheduleMeta(task.id);
      const thread = meta?.threadId != null ? store.getAgentThread(meta.threadId) : null;
      map[task.id] = {
        threadTitle: thread?.title ?? null,
        skillCount: meta?.skillIds?.length ?? 0,
        autoSession: !thread,
      };
    }
    return map;
  }, [timedTasks, store]);
  const doneTasks = useMemo(
    () => allTasks.filter((t) => t.isDone && !t.parentId),
    [allTasks],
  );
  const sortedDoneTasks = useMemo(
    () => [...doneTasks].sort((a, b) => (b.doneOn ?? 0) - (a.doneOn ?? 0)),
    [doneTasks],
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
  const prevTaskBucketsRef = useRef<Record<string, ProjectBucket>>({});
  // listTasks 现在返回稳定引用：所有 bucket 变更都会同时改 tasks Map，
  // 因此 allTasks 引用变化足以覆盖 bucket 变更，无需依赖 dataTick。
  const taskBuckets = useMemo(() => {
    const prev = prevTaskBucketsRef.current;
    const map: Record<string, ProjectBucket> = {};
    for (const t of allTasks) {
      const next = store.getTaskBucket(t.id);
      map[t.id] = prev[t.id] === next ? prev[t.id] : next;
    }
    prevTaskBucketsRef.current = map;
    return map;
  }, [allTasks, store]);
  // store 的 listTagsForTask 已按任务缓存并返回稳定数组引用：
  // 每 tick 只做 Map.get + 引用赋值，标签未变时下游 memo 全部命中。
  const taskTagMap = useMemo(() => {
    const map: Record<string, Tag[]> = {};
    for (const t of allTasks) {
      map[t.id] = store.listTagsForTask(t.id);
    }
    return map;
  }, [allTasks, store, dataTick]);

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

  const settleSegment = useCallback(
    (segment: { taskId: string; startedAt: number; endedAt: number }) => {
      try {
        store.addTimeSpent(segment.taskId, segment.startedAt, segment.endedAt);
      } catch {
        // parent-with-children cannot be timed; ignore settle
      }
    },
    [store],
  );

  const stopTimerIfTask = useCallback(
    (taskId: string) => {
      if (activeTimerTaskId !== taskId) return;
      const stopped = timer.stop(Date.now());
      if (stopped) settleSegment(stopped);
      setActiveTimerTaskId(null);
      setTimerStartedAt(null);
    },
    [activeTimerTaskId, timer, settleSegment],
  );

  const scheduleToday = useCallback(
    (task: Task) => {
      store.scheduleTask(task.id, { dueDay: today });
      refresh();
    },
    [store, today, refresh],
  );

  const scheduleAfternoon = useCallback(
    (task: Task) => {
      const at = new Date();
      at.setHours(15, 0, 0, 0);
      store.scheduleTask(task.id, {
        dueWithTime: at.getTime(),
        ...(prefs.defaultRemind !== "none" ? { remindOption: prefs.defaultRemind } : {}),
      });
      refresh();
    },
    [store, prefs.defaultRemind, refresh],
  );

  const clearPlan = useCallback(
    (task: Task) => {
      store.scheduleTask(task.id, {
        dueDay: null,
        dueWithTime: null,
        remindAt: null,
      });
      refresh();
    },
    [store, refresh],
  );

  const complete = useCallback(
    (task: Task) => {
      stopTimerIfTask(task.id);
      store.completeTask(task.id);
      refresh();
    },
    [stopTimerIfTask, store, refresh],
  );

  const toggleDone = useCallback(
    (task: Task) => {
      if (task.isDone) store.uncompleteTask(task.id);
      else {
        stopTimerIfTask(task.id);
        store.completeTask(task.id);
      }
      refresh();
    },
    [stopTimerIfTask, store, refresh],
  );

  const clearCompletedTasks = useCallback(
    (taskIds: string[]) => {
      for (const id of taskIds) {
        stopTimerIfTask(id);
        store.deleteTask(id);
      }
      refresh();
    },
    [stopTimerIfTask, store, refresh],
  );

  const openTask = useCallback((task: Task) => {
    setEditingTaskId(task.id);
  }, []);

  const reorderToday = useCallback(
    (fromId: string, toId: string) => {
      const ids = todayTasks.map((t) => t.id);
      store.setTodayOrder(reorderIds(ids, fromId, toId));
      bumpTodayOrderRev((value) => value + 1);
      refresh();
    },
    [todayTasks, store, refresh],
  );

  const changeTasksViewMode = useCallback((mode: TasksViewMode) => {
    setTasksViewMode(mode);
    localStorage.setItem(TASKS_VIEW_KEY, mode);
  }, []);

  const moveTaskColumn = useCallback(
    (taskId: string, column: TaskBoardColumnId) => {
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
    },
    [store, stopTimerIfTask, refresh],
  );

  const toggleTimer = useCallback(
    (task: Task) => {
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
    },
    [activeTimerTaskId, timer, settleSegment, refresh],
  );

  const createTag = useCallback(
    (title: string): Tag | null => {
      try {
        const tag = store.createTag(title);
        refresh();
        return tag;
      } catch {
        return null;
      }
    },
    [store, refresh],
  );

  const saveEditedTask = useCallback(
    (taskId: string, draft: TaskEditorSave) => {
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
    },
    [store, refresh],
  );

  const deleteTask = useCallback(
    (taskId: string) => {
      store.deleteTask(taskId);
      setEditingTaskId((prev) => (prev === taskId ? null : prev));
      refresh();
    },
    [store, refresh],
  );

  const duplicateTask = useCallback(
    (taskId: string) => {
      store.duplicateTask(taskId);
      refresh();
    },
    [store, refresh],
  );

  const addSubtask = useCallback(
    (parentId: string, title: string) => {
      const parent = store.getTask(parentId);
      if (!parent) return;
      store.createTask({
        title,
        projectId: parent.projectId,
        parentId,
        nowMs: Date.now(),
      });
      refresh();
    },
    [store, refresh],
  );

  const goNav = (id: AppNavId) => {
    flushNoteRefresh();
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

  const capture = (raw: string): boolean => {
    const text = raw.trim();
    if (!text || settingsOpen) return false;
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
        return true;
      }
      if (cmd === "笔记" || cmd === "note") {
        const note = store.createNote({
          title: arg || "未命名笔记",
          bodyMd: arg ? `# ${arg}\n\n` : "# 未命名笔记\n\n",
          nowMs,
        });
        setActiveNoteId(note.id);
        goNav("knowledge");
        refresh();
        return true;
      }
      if (cmd === "定时" || cmd === "timed") {
        const created = store.createTimedTask({
          title: arg || "未命名定时任务",
          command: "",
          schedule: makePresetSchedule("daily"),
          nowMs,
        });
        refresh();
        openTimedEdit(created.id);
        return true;
      }
    }

    if (nav === "knowledge") {
      const note = store.createNote({
        title: text,
        bodyMd: `# ${text}\n\n`,
        nowMs,
      });
      setActiveNoteId(note.id);
      refresh();
      return true;
    }

    if (nav === "timed") {
      const created = store.createTimedTask({
        title: text,
        command: "",
        schedule: makePresetSchedule("daily"),
        nowMs,
      });
      refresh();
      openTimedEdit(created.id);
      return true;
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
    refresh();
    return true;
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
    scheduleNoteRefresh();
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
    setTimedDraft({ ...EMPTY_TIMED_DRAFT });
    setTimedEditing(true);
    setNav("timed");
  };

  const openTimedEdit = (id: string) => {
    const task = store.getTimedTask(id);
    if (!task) return;
    const meta = getScheduleMeta(id);
    const threadId =
      meta?.threadId && store.getAgentThread(meta.threadId) ? meta.threadId : null;
    setTimedEditId(id);
    setTimedDraft({
      title: task.title,
      command: task.command,
      schedule: task.schedule,
      threadId,
      skillIds: meta?.skillIds ?? [],
      enabled: task.enabled,
    });
    setTimedEditing(true);
    setNav("timed");
  };

  const saveTimedTask = () => {
    if (!timedDraft.schedule || !timedDraft.title.trim()) return;
    if (!timedDraft.command.trim() && timedDraft.skillIds.length === 0) return;
    const nowMs = Date.now();
    const title = timedDraft.title.trim();
    const task = timedEditId
      ? store.updateTimedTask(timedEditId, {
          title,
          command: timedDraft.command,
          schedule: timedDraft.schedule,
          enabled: timedDraft.enabled,
        })
      : store.createTimedTask({
          title,
          command: timedDraft.command,
          schedule: timedDraft.schedule,
          nowMs,
        });
    if (!timedEditId && !timedDraft.enabled) {
      store.updateTimedTask(task.id, { enabled: false }, nowMs);
    }

    // Defer session creation until first run when unbound.
    let threadId = timedDraft.threadId;
    let workspaceId: string | null = null;
    if (threadId) {
      const bound = store.getAgentThread(threadId);
      if (bound) workspaceId = bound.workspaceId;
      else threadId = null;
    }
    if (!threadId) {
      const prior = getScheduleMeta(task.id);
      workspaceId =
        prior?.workspaceId && store.getAgentWorkspace(prior.workspaceId)
          ? prior.workspaceId
          : (store
              .listAgentWorkspaces()
              .find((item) => item.title === DEFAULT_AGENT_WORKSPACE_TITLE)?.id ?? null);
    }

    setScheduleMeta(task.id, {
      target: "this_session",
      threadId,
      workspaceId,
      skillIds: timedDraft.skillIds,
    });
    setTimedEditing(false);
    setTimedEditId(null);
    refresh();
  };

  const runTimedTaskById = (id: string, openSession = true) => {
    const task = store.getTimedTask(id);
    if (!task) return;
    const result = runTimedTaskNow(store, task, { skills: enabledAgentSkills });
    if (openSession && result.threadId) {
      setAgentThreadId(result.threadId);
      setAgentSectionOpen(true);
      goNav("agent");
    } else {
      setNotificationsOpen(true);
    }
    refresh();
  };

  const skipTimedTaskById = (id: string) => {
    const task = store.getTimedTask(id);
    if (!task) return;
    skipTimedTaskOccurrence(store, task);
    refresh();
  };

  const runAllMissedTimedTasks = () => {
    const at = Date.now();
    const missed = store.listTimedTasks().filter((task) => isTimedTaskMissed(task, at));
    let lastThread: string | null = null;
    for (const task of missed) {
      const result = runTimedTaskNow(store, task, {
        nowMs: at,
        skills: enabledAgentSkills,
      });
      if (result.threadId) lastThread = result.threadId;
    }
    if (lastThread) {
      setAgentThreadId(lastThread);
      setAgentSectionOpen(true);
      goNav("agent");
    } else {
      setNotificationsOpen(true);
    }
    refresh();
  };

  const skipAllMissedTimedTasks = () => {
    const at = Date.now();
    for (const task of store.listTimedTasks()) {
      if (!isTimedTaskMissed(task, at)) continue;
      skipTimedTaskOccurrence(store, task, at);
    }
    refresh();
  };

  const toggleTimedTaskEnabled = (id: string, enabled: boolean) => {
    store.updateTimedTask(id, { enabled });
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
    deleteScheduleMeta(id);
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

  const openCommandPaletteResult = (result: CommandPaletteResult) => {
    setSettingsOpen(false);
    if (result.kind === "create-task") {
      const created = store.createTask({
        title: result.title,
        projectId: INBOX_PROJECT_ID,
        nowMs: Date.now(),
      });
      refresh();
      setNav("inbox");
      setFilterProjectId(INBOX_PROJECT_ID);
      setEditingTaskId(created.id);
      return;
    }
    if (result.kind === "create-note") {
      const created = store.createNote({
        title: result.title,
        bodyMd: `# ${result.title}\n\n`,
        nowMs: Date.now(),
      });
      refresh();
      setPendingKbPath(null);
      setActiveNoteId(created.id);
      setNoteFocusToken((value) => value + 1);
      goNav("knowledge");
      return;
    }
    if (result.kind === "nav") {
      if (result.id === "agent") {
        openAgent();
        return;
      }
      goNav(result.id);
      return;
    }
    if (result.kind === "project") {
      openProject(result.id);
      return;
    }
    if (result.kind === "task") {
      const taskViews = new Set<AppNavId>(["today", "inbox", "done", "planner"]);
      if (!taskViews.has(nav)) setNav("today");
      setEditingTaskId(result.id);
      return;
    }
    if (result.kind === "thread") {
      setAgentThreadId(result.id);
      setAgentSectionOpen(true);
      setEditingTaskId(null);
      setNav("agent");
      return;
    }
    if (result.kind === "note") {
      setPendingKbPath(null);
      setActiveNoteId(result.id);
      setNoteFocusToken((value) => value + 1);
      goNav("knowledge");
      return;
    }
    setActiveNoteId(null);
    setPendingKbPath(result.path);
    goNav("knowledge");
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
        nowMs={nowMinuteMs}
        activeTimerTaskId={activeTimerTaskId}
        timerElapsedMs={timerElapsedMs}
        onToggleDone={toggleDone}
        onOpen={openTask}
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
        nowMs={nowMinuteMs}
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
    body = (
      <TaskList
        title="已完成"
        empty="还没有已完成的任务。"
        tasks={sortedDoneTasks}
        projectTitles={projectTitles}
        taskTagMap={taskTagMap}
        hint="汇总全部项目的已完成任务"
        nowMs={nowMinuteMs}
        showDoneStyle
        activeTimerTaskId={activeTimerTaskId}
        timerElapsedMs={timerElapsedMs}
        onToggleDone={toggleDone}
        onOpen={openTask}
      />
    );
  } else if (nav === "planner") {
    body = (
      <PlannerView
        tasks={plannerTasks}
        projectTitles={projectTitles}
        taskTagMap={taskTagMap}
        nowMs={nowMinuteMs}
        activeTimerTaskId={activeTimerTaskId}
        timerElapsedMs={timerElapsedMs}
        onToggleDone={toggleDone}
        onOpen={openTask}
      />
    );
  } else if (nav === "knowledge") {
    body = (
      <KnowledgeView
        notes={notes}
        activeId={activeNoteId}
        preferLastNote={prefs.openLastNote}
        pendingOpenPath={pendingKbPath}
        onPendingOpenPathConsumed={() => setPendingKbPath(null)}
        noteFocusToken={noteFocusToken}
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
        skills={enabledAgentSkills}
        threads={store.listAgentThreads()}
        workspaces={store.listAgentWorkspaces()}
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
        nowMs={now}
        bindings={timedBindings}
        onCreate={openTimedCreate}
        onOpen={openTimedEdit}
        onDelete={deleteTimedTask}
        onRunNow={(id) => runTimedTaskById(id, true)}
        onSkip={skipTimedTaskById}
        onRunAllMissed={runAllMissedTimedTasks}
        onSkipAllMissed={skipAllMissedTimedTasks}
        onToggleEnabled={toggleTimedTaskEnabled}
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
        nowMs={nowMinuteMs}
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
    <VoiceInputProvider
      enabled={prefs.voiceInputEnabled}
      deviceId={prefs.voiceInputDeviceId}
      language={prefs.voiceInputLanguage}
      engine={prefs.voiceInputEngine}
      openSettings={() => openSettings("voice")}
    >
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
          <>
            {!saveStatus.ok && saveStatus.message ? (
              <div className="save-warning" role="alert">
                本地保存失败：{saveStatus.message}
                （请检查磁盘空间或权限，修改可能尚未落盘）
              </div>
            ) : saveStatus.ok && saveStatus.warning ? (
              <div className="save-warning" role="status">
                {saveStatus.warning}
              </div>
            ) : null}
            <div
              className={sidebarCollapsed ? "shell__body is-collapsed" : "shell__body"}
              style={
                sidebarCollapsed
                  ? undefined
                  : ({ ["--wb-sidebar-width"]: `${sidebarWidth}px` } as CSSProperties)
              }
            >
              <Sidebar
                collapsed={sidebarCollapsed}
                onToggleCollapsed={() => setSidebarCollapsed((v) => !v)}
                nav={nav}
                onNav={goNav}
                settingsOpen={settingsOpen}
                onOpenSettings={() => openSettings("general")}
                onOpenSearch={() => setCommandPaletteOpen(true)}
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
                agentShowArchived={agentShowArchived}
                onToggleAgentShowArchived={() => setAgentShowArchived((value) => !value)}
                agentRail={
                  <AgentWorkspaceRail
                    store={store}
                    threadId={agentThreadId}
                    busyThreadId={agentBusyThreadId}
                    showArchived={agentShowArchived}
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
                width={sidebarWidth}
                onWidthChange={setSidebarWidth}
                onWidthCommit={(next) => {
                  setSidebarWidth(next);
                  updatePrefs({ ...prefs, sidebarWidth: next });
                }}
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
                    nowMs={nowMinuteMs}
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
                  <QuickCaptureComposer
                    placeholder={composerPlaceholder(nav, projectTitles[filterProjectId])}
                    focusRef={focusComposerRef}
                    onCapture={capture}
                  />
                ) : null}
              </main>
            </div>
          </>
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
        <CommandPalette
          open={commandPaletteOpen}
          tasks={allTasks}
          projects={projects}
          threads={paletteThreads}
          workspaces={paletteWorkspaces}
          notes={notes}
          kbFiles={paletteKbFiles}
          kbRoots={paletteKbRoots}
          kbLoading={paletteKbLoading}
          kbProgress={paletteKbProgress}
          onClose={() => setCommandPaletteOpen(false)}
          onSelect={openCommandPaletteResult}
        />
        <DialogOutlet />
      </div>
    </VoiceInputProvider>
  );
}

function QuickCaptureComposer(props: {
  placeholder: string;
  focusRef: { current: (() => void) | null };
  onCapture: (text: string) => boolean;
}) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    props.focusRef.current = () => inputRef.current?.focus();
    return () => {
      props.focusRef.current = null;
    };
  }, [props.focusRef]);

  const submit = () => {
    if (props.onCapture(draft)) setDraft("");
  };

  return (
    <footer className="composer">
      <div className="composer__row">
        <VoiceField value={draft} onChange={setDraft} className="composer__voice">
          <input
            ref={inputRef}
            aria-label="快速捕获"
            placeholder={props.placeholder}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
        </VoiceField>
        <button type="button" className="primary" onClick={submit}>
          添加
        </button>
      </div>
    </footer>
  );
}

const TaskList = memo(function TaskList(props: {
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

  const onDragStart = useCallback((id: string) => {
    setDragId(id);
    setOverId(id);
  }, []);
  const onDragOver = useCallback((id: string) => {
    setOverId(id);
  }, []);
  const onDropOn = useCallback(
    (toId: string) => {
      setDragId((currentDrag) => {
        if (currentDrag && props.onReorder) props.onReorder(currentDrag, toId);
        return null;
      });
      setOverId(null);
    },
    [props.onReorder],
  );

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
              onDragStart={props.reorderable ? onDragStart : undefined}
              onDragOver={props.reorderable ? onDragOver : undefined}
              onDropOn={props.reorderable ? onDropOn : undefined}
              onToggleDone={props.onToggleDone}
              onOpen={props.onOpen}
            />
          ))}
        </ul>
      )}
    </section>
  );
});
