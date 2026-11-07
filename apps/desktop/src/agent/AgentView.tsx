import { useEffect, useRef, useState } from "react";
import type { MemoryWorkbenchRepository } from "@wb/db/memory";
import {
  addAgentMemory,
  agentEditPlan,
  agentEmptyGreeting,
  agentRetryPlan,
  acceptSkillSlashToken,
  applyMention,
  applySlashToken,
  collapseSkillTokenOnDelete,
  skillComposerTokens,
  stripSkillPickMarks,
  tidySkillPickMarks,
  chatProviderFor,
  compactMarkerText,
  findSubagent,
  forgetAgentMemory,
  formatAgentBubbleTime,
  formatMemoriesForPrompt,
  formatReplyElapsed,
  formatSubagentList,
  describeToolArgDiff,
  formatAgentMoment,
  manualCompactPlan,
  normalizeAgentWebUrl,
  findProvider,
  localOcrReply,
  localOcrUserMessage,
  mentionQuery,
  mentionSuggestions,
  modelCanSeeImages,
  modelSwitchText,
  permissionModeLabel,
  parseModelRef,
  relativizeScheduleText,
  resolveSlash,
  SLASH_COMMANDS,
  slashSkillSuggestions,
  slashSuggestions,
  skillsLoadedInTranscript,
  toolActionTitle,
  toolResultLabel,
  subagentTurnText,
  type AgentCustomCommand,
  type AgentGoal,
  type AgentHook,
  type AgentMemory,
  type AgentMessage,
  type AgentPermissionMode,
  type AgentSkill,
  type AgentSubagent,
  type AgentTodoItem,
  type AskUserQuestion,
  type HostToolSnapshot,
  type McpServer,
  type SlashAction,
  parseAskUserQuestions,
  applyGoalSlash,
  formatGoalRoundPrompt,
  parseGoalSlash,
  shouldContinueGoal,
} from "@wb/domain";
import {
  AGENT_LOG_VIRTUAL_MIN,
  agentLogVisibleRange,
  buildHeightMetrics,
  estimateAgentTurnHeight,
} from "./agent-log-virtual";
import { agentTurnPieces } from "./agent-turn-pieces";
import { readCredential } from "./credentials";
import { runHostTool } from "./host-tools";
import type { AgentUiEffect } from "./execute";
import { htmlTextHitCount, literalHitCount, markHtmlHits, splitHits } from "./find-text";
import { readInputHistory, rememberInput } from "./input-history";
import { enqueuePrompt, recallQueuedPrompt, removeQueuedPrompt } from "./prompt-queue";
import { writeClipboard } from "../lib/clipboard";
import { copyCodeBlock } from "../lib/code-copy";
import { errorMessage } from "../lib/errors";
import { isTauriRuntime } from "../lib/paths";
import { renderChatMarkdown } from "../lib/markdown";
import { externalHrefFromEvent, openExternalUrl } from "../lib/open-external";
import { useDialog } from "../shell/Dialogs";
import {
  IconArrowUp,
  IconCommand,
  IconFolder,
  IconGitBranch,
  IconMaximize,
  IconShield,
  IconMore,
  IconPencil,
  IconPin,
  IconRestore,
  IconPlus,
  IconRefresh,
  IconStop,
} from "../shell/icons";
import { readGitBranch } from "../notes/kb-api";
import { AgentTerminalPanel } from "./AgentTerminalPanel";
import { ModelMenu } from "./ModelMenu";
import { readTerminalPanelOpen, writeTerminalPanelOpen } from "./terminal-api";
import { imageDataUrl } from "./ocr-image";
import { recognizeLocalImage } from "./ocr-engine";
import { insertVoiceText, VoiceField, VoiceInputButton, VoiceStatusLine } from "../voice";
import {
  onWebSessionResume,
  webSessionClose,
  webSessionEmbedded,
  webSessionHeld,
  webSessionHide,
  webSessionReload,
  webSessionShow,
} from "./web-session";
import { modelGroups, readProviderStore, setDefaultModel } from "./providers";
import { takePendingAgentNotices } from "./agent-registry";
import {
  listWatchedRunning,
  pollBackgroundJobs,
  takePendingJobNotices,
} from "./job-watch";
import { takeScheduleDeliveries } from "./schedule-meta";
import { cleanupToolSpill } from "./spill-store";
import {
  askUserTimedConfig,
  previewAgentContext,
  resumeAgentQueue,
  settleAgentApproval,
  settleAgentQuestion,
  settleAgentQuestionTimeout,
  startAgentTurn,
  type AgentTurnEnv,
} from "./turn";

type Props = {
  store: MemoryWorkbenchRepository;
  threadId: string | null;
  displayName: string;
  rules: string;
  /** Enabled skills discovered from Settings → 技能. */
  skills?: AgentSkill[];
  memories?: AgentMemory[];
  onMemories?: (next: AgentMemory[]) => void;
  commands?: AgentCustomCommand[];
  subagents?: AgentSubagent[];
  hooks?: AgentHook[];
  plugins?: Array<{ name: string; version: string; description: string }>;
  mcpServers?: McpServer[];
  hostTools?: HostToolSnapshot[];
  /** Open task, note, or timer, already phrased for the prompt. */
  focus?: string | null;
  activeTimerTaskId: string | null;
  timerStartedAt: number | null;
  onSelectThread: (id: string | null) => void;
  /** Create a session inside an existing workspace. */
  onCreateThread: (workspaceId: string) => void;
  /** Top-level new session: caller opens the folder picker first. */
  onCreateFromFolder: () => void;
  onOpenModels: () => void;
  /** Open Settings → 技能. */
  onOpenSkills?: () => void;
  onEffects: (effects: AgentUiEffect[]) => void;
  onRefresh: () => void;
  /** Persist the store without re-rendering the whole shell (used on tool steps). */
  onPersist?: () => void;
  /** Tell the shell which session is currently answering. */
  onBusyThreadChange?: (threadId: string | null) => void;
  /** Lets the sidebar workspace rail drop this view's queued prompts. */
  forgetThreadRef?: { current: (id: string) => void };
};

const EXAMPLES = ["今天有什么", "创建任务 写周报，排到明天并提前15分钟提醒", "晨报"];

async function applyWebFullscreen(on: boolean, frame: HTMLElement | null) {
  if (isTauriRuntime()) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setFullscreen(on);
    return;
  }
  if (!frame) return;
  if (on) {
    if (document.fullscreenElement !== frame) await frame.requestFullscreen();
    return;
  }
  if (document.fullscreenElement) await document.exitFullscreen();
}

export function AgentView({
  store,
  threadId,
  displayName,
  rules,
  skills = [],
  memories = [],
  onMemories,
  commands = [],
  subagents = [],
  hooks = [],
  plugins = [],
  mcpServers = [],
  hostTools = [],
  focus = null,
  activeTimerTaskId,
  timerStartedAt,
  onSelectThread,
  onCreateThread,
  onCreateFromFolder,
  onOpenModels,
  onOpenSkills,
  onEffects,
  onRefresh,
  onPersist,
  onBusyThreadChange,
  forgetThreadRef,
}: Props) {
  const dialog = useDialog();
  const workspaces = store.listAgentWorkspaces();
  const activeThreads = store.listAgentThreads();
  const thread =
    (threadId ? store.getAgentThread(threadId) : null) ?? activeThreads[0] ?? null;
  const messages = thread ? store.listAgentMessages(thread.id) : [];
  const pending = thread
    ? (store.listAgentApprovals(thread.id).find((item) => item.status === "pending") ??
      null)
    : null;
  const [draftThreadId, setDraftThreadId] = useState(thread?.id ?? "");
  const [draft, setDraft] = useState("");
  const [pendingImage, setPendingImage] = useState<{
    name: string;
    url: string;
    blob: Blob;
  } | null>(null);
  const [live, setLive] = useState("");
  const liveBuf = useRef("");
  const liveRaf = useRef<number | null>(null);
  const [busyThreadId, setBusyThreadId] = useState<string | null>(null);
  const [logScroll, setLogScroll] = useState({ top: 0, height: 480 });
  /** Local transcript bump so tool steps do not re-render the whole shell. */
  const [transcriptRev, setTranscriptRev] = useState(0);
  const [queues, setQueues] = useState<Record<string, string[]>>({});
  const [todosByThread, setTodosByThread] = useState<Record<string, AgentTodoItem[]>>({});
  const [goalsByThread, setGoalsByThread] = useState<Record<string, AgentGoal | null>>(
    {},
  );
  const goalsByThreadRef = useRef(goalsByThread);
  goalsByThreadRef.current = goalsByThread;
  const [cwdByThread, setCwdByThread] = useState<Record<string, string>>({});
  const [questionAnswers, setQuestionAnswers] = useState<
    Record<string, string | string[]>
  >({});
  const [askTimedLeft, setAskTimedLeft] = useState<number | null>(null);
  const [queueRev, setQueueRev] = useState(0);
  const [queuePausedById, setQueuePausedById] = useState<Record<string, boolean>>({});
  const measuredHeights = useRef<Map<number, number>>(new Map());
  const [measureTick, setMeasureTick] = useState(0);
  void measureTick;
  const turnsLenRef = useRef(0);
  const tipSigRef = useRef("");
  const wasLiveRef = useRef(false);
  const [pinned, setPinned] = useState(true);
  const [findOpen, setFindOpen] = useState(false);
  const [termOpen, setTermOpen] = useState(() => readTerminalPanelOpen());
  const [termRefresh, setTermRefresh] = useState(0);
  const [webReload, setWebReload] = useState(0);
  const [webFullscreen, setWebFullscreen] = useState(false);
  const [webSessionError, setWebSessionError] = useState("");
  const [findQuery, setFindQuery] = useState("");
  const [findIndex, setFindIndex] = useState(0);
  const [findTick, setFindTick] = useState(0);
  const [error, setError] = useState("");
  const [picker, setPicker] = useState<null | "mode" | "model" | "plus" | "workspace">(
    null,
  );
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [threadMenuOpen, setThreadMenuOpen] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composerMirrorRef = useRef<HTMLDivElement>(null);
  const slashListRef = useRef<HTMLUListElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const imageUrlRef = useRef<string | null>(null);
  const approveBtnRef = useRef<HTMLButtonElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const activeHitRef = useRef(0);
  const drafts = useRef(new Map<string, string>());
  const stickRef = useRef(true);
  const ignoreTitleBlur = useRef(false);
  const historyNav = useRef<{ index: number; saved: string } | null>(null);
  const placeCaret = useRef(false);
  const stopRef = useRef<AbortController | null>(null);
  const queuesRef = useRef(queues);
  const wantDrain = useRef<string | null>(null);
  const wantGoalContinue = useRef<string | null>(null);
  const draining = useRef(false);
  const sendPromptRef = useRef<
    (
      content: string,
      subagent?: AgentSubagent,
      imageDataUrl?: string,
      options?: { goalRound?: boolean },
    ) => Promise<boolean>
  >(async () => false);
  const [copied, setCopied] = useState<string | null>(null);
  const [slashUi, setSlashUi] = useState({ draft: "", dismissed: false, index: 0 });
  const mounted = useRef(true);
  const sending = useRef(false);
  const busyHere = Boolean(thread && busyThreadId === thread.id);
  const busyElsewhere = Boolean(busyThreadId && thread && busyThreadId !== thread.id);
  const queuePaused = Boolean(thread && queuePausedById[thread.id]);
  const queuePausedRef = useRef(queuePaused);
  queuePausedRef.current = queuePaused;
  const queuePausedByIdRef = useRef(queuePausedById);
  queuePausedByIdRef.current = queuePausedById;
  const prevBusyThreadId = useRef(busyThreadId);
  const findOpenRef = useRef(false);

  const setQueuePaused = (paused: boolean) => {
    if (!thread) return;
    const id = thread.id;
    setQueuePausedById((current) => {
      if (!paused) {
        if (!(id in current)) return current;
        const next = { ...current };
        delete next[id];
        return next;
      }
      if (current[id]) return current;
      return { ...current, [id]: true };
    });
  };

  useEffect(() => {
    onBusyThreadChange?.(busyThreadId);
  }, [busyThreadId, onBusyThreadChange]);

  useEffect(() => {
    return () => onBusyThreadChange?.(null);
  }, [onBusyThreadChange]);

  // When the running session finishes, drain this thread's queue if it was only waiting.
  useEffect(() => {
    const wasBusy = prevBusyThreadId.current;
    prevBusyThreadId.current = busyThreadId;
    if (!wasBusy || busyThreadId || !thread) return;
    if (queuePausedByIdRef.current[thread.id]) return;
    if ((queuesRef.current[thread.id] ?? []).length === 0) return;
    wantDrain.current = thread.id;
    setQueueRev((rev) => rev + 1);
  }, [busyThreadId, thread?.id]);

  useEffect(() => {
    if (busyThreadId != null) return;
    setTermRefresh((rev) => rev + 1);
  }, [busyThreadId, transcriptRev]);

  // Poll background jobs + managed subagent notices; wake idle sessions.
  useEffect(() => {
    const tick = window.setInterval(() => {
      void (async () => {
        const noticed = new Set<string>();
        if (isTauriRuntime() && listWatchedRunning().length) {
          try {
            for (const threadId of await pollBackgroundJobs()) noticed.add(threadId);
          } catch {
            /* ignore poll errors */
          }
        }
        if (thread?.id) noticed.add(thread.id);
        for (const threadId of noticed) {
          if (busyThreadId === threadId || sending.current) continue;
          const notices = [
            ...takePendingJobNotices(threadId),
            ...takePendingAgentNotices(threadId),
          ];
          if (!notices.length) continue;
          for (const notice of notices) {
            store.appendAgentMessage({
              threadId,
              role: "system",
              content: notice,
            });
          }
          onPersist?.();
          if (mounted.current) setTranscriptRev((rev) => rev + 1);
          if (thread?.id === threadId && !pending && !sending.current) {
            const isAgent = notices.some((item) => item.startsWith("subagent "));
            void sendPromptRef.current(
              isAgent
                ? "子智能体已结束，请根据系统通知继续（可用 list_agents 查看）。"
                : "后台任务已完成，请根据系统通知继续（必要时用 job_output 读取详情）。",
            );
          }
        }
      })();
    }, 2000);
    return () => window.clearInterval(tick);
  }, [busyThreadId, onPersist, pending, store, thread?.id]);

  // Drain due schedule_* deliveries into the owning session.
  useEffect(() => {
    const tick = window.setInterval(() => {
      if (!thread || busyThreadId || pending || sending.current) return;
      const deliveries = takeScheduleDeliveries(thread.id);
      if (!deliveries.length) return;
      const first = deliveries[0]!;
      for (const extra of deliveries.slice(1)) {
        store.appendAgentMessage({
          threadId: thread.id,
          role: "system",
          content: `定时任务「${extra.title}」已排队：${extra.prompt}`,
        });
      }
      onPersist?.();
      if (mounted.current) setTranscriptRev((rev) => rev + 1);
      void sendPromptRef.current(`【定时任务 · ${first.title}】\n${first.prompt}`);
    }, 3000);
    return () => window.clearInterval(tick);
  }, [busyThreadId, onPersist, pending, store, thread]);

  useEffect(() => {
    writeTerminalPanelOpen(termOpen);
  }, [termOpen]);
  const webSessionRef = useRef(false);
  const webHostRef = useRef<HTMLDivElement>(null);
  const webFrameRef = useRef<HTMLDivElement>(null);
  const webCoveredRef = useRef(false);
  const webSyncRef = useRef<() => void>(() => {});
  const webStateRef = useRef({ id: "", url: "" });
  const webLoginRef = useRef<() => Promise<void>>(async () => {});
  const webEditRef = useRef<() => void>(() => {});
  const webFullscreenRef = useRef(false);
  const webFullscreenApplyRef = useRef<(on: boolean) => void>(() => {});
  const webLoginBusy = useRef(false);
  webSessionRef.current = Boolean(thread?.webUrl);
  webStateRef.current = { id: thread?.id ?? "", url: thread?.webUrl ?? "" };
  findOpenRef.current = findOpen;
  const viewingThreadId = useRef(thread?.id ?? null);
  viewingThreadId.current = thread?.id ?? null;
  queuesRef.current = queues;
  const refocus = useRef(false);
  const pendingRef = useRef(pending);
  const decideRef = useRef<(decision: "approved" | "denied") => void>(() => {});
  pendingRef.current = pending;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Leaving Agent unmounts this tree — abort so the turn cannot keep writing
      // while a fresh mount thinks the session is idle.
      stopRef.current?.abort();
      wantDrain.current = null;
    };
  }, []);

  const workspaceRootPath =
    (thread?.workspaceId
      ? (store.getAgentWorkspace(thread.workspaceId)?.rootPath ??
        workspaces.find((item) => item.id === thread.workspaceId)?.rootPath)
      : null
    )?.trim() ?? "";

  useEffect(() => {
    if (!workspaceRootPath) {
      setGitBranch(null);
      return;
    }
    let cancelled = false;
    setGitBranch(null);
    void readGitBranch(workspaceRootPath).then((branch) => {
      if (!cancelled) setGitBranch(branch);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceRootPath]);

  useEffect(() => {
    if (!workspaceRootPath || !isTauriRuntime()) return;
    void cleanupToolSpill(workspaceRootPath).catch(() => {
      /* spill GC must never block the UI */
    });
  }, [workspaceRootPath]);

  useEffect(() => {
    if (picker !== "workspace") return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".agent__composer-chip-wrap")) return;
      setPicker(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPicker(null);
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [picker]);

  useEffect(() => {
    if (!threadMenuOpen) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".agent__chrome-menu")) return;
      setThreadMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setThreadMenuOpen(false);
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [threadMenuOpen]);

  useEffect(() => {
    const node = logRef.current;
    if (!node) return;
    const sync = () => {
      setLogScroll((current) => {
        const next = { top: node.scrollTop, height: node.clientHeight };
        if (current.top === next.top && current.height === next.height) return current;
        return next;
      });
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(node);
    return () => observer.disconnect();
  }, [thread?.id, thread?.webUrl]);

  useEffect(() => {
    const node = logRef.current;
    if (node && stickRef.current) node.scrollTop = node.scrollHeight;
  }, [messages.length, pending?.id]);

  useEffect(() => {
    if (!live || !stickRef.current) return;
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [live]);

  useEffect(() => {
    return () => {
      if (liveRaf.current != null) window.cancelAnimationFrame(liveRaf.current);
    };
  }, []);

  if ((thread?.id ?? "") !== draftThreadId) {
    setDraftThreadId(thread?.id ?? "");
    setDraft(thread?.id ? (drafts.current.get(thread.id) ?? "") : "");
    setPicker(null);
    setRenaming(false);
    setThreadMenuOpen(false);
    liveBuf.current = "";
    if (liveRaf.current != null) {
      window.cancelAnimationFrame(liveRaf.current);
      liveRaf.current = null;
    }
    setLive("");
    setError("");
    measuredHeights.current.clear();
    setMeasureTick((tick) => tick + 1);
    stickRef.current = true;
    setPinned(true);
    setFindOpen(false);
    setFindQuery("");
    setFindIndex(0);
    if (imageUrlRef.current) {
      URL.revokeObjectURL(imageUrlRef.current);
      imageUrlRef.current = null;
      setPendingImage(null);
    }
  }
  if (slashUi.draft !== draft) {
    setSlashUi({ draft, dismissed: false, index: 0 });
  }

  useEffect(() => {
    const node = inputRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 160)}px`;
    if (!placeCaret.current) return;
    placeCaret.current = false;
    const end = node.value.length;
    node.setSelectionRange(end, end);
  }, [draft, thread?.id]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === "f") {
        if (webSessionRef.current) return;
        event.preventDefault();
        setFindOpen(true);
        setFindTick((tick) => tick + 1);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && key === "n") {
        event.preventDefault();
        inputRef.current?.focus();
        return;
      }
      if (event.key === "Escape" && findOpenRef.current && !event.defaultPrevented) {
        event.preventDefault();
        setFindOpen(false);
        return;
      }
      if (!pendingRef.current || sending.current) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      const inComposer = Boolean(target?.closest(".agent__composer"));
      const inApproval = Boolean(target?.closest(".agent__approval"));
      // Allow Enter/Esc from composer or approval panel; skip other form fields.
      if (
        !inComposer &&
        !inApproval &&
        (tag === "SELECT" || tag === "TEXTAREA" || tag === "INPUT")
      ) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        void decideRef.current("denied");
      } else if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void decideRef.current("approved");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    setQuestionAnswers({});
    if (!pending) return;
    setPicker(null);
    const frame = requestAnimationFrame(() => {
      approveBtnRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [pending?.id]);

  useEffect(() => {
    if (findOpen) {
      findInputRef.current?.focus();
      findInputRef.current?.select();
      return;
    }
    if (!thread || thread.webUrl || pendingRef.current) return;
    inputRef.current?.focus({ preventScroll: true });
  }, [findOpen, findTick, thread?.id, thread?.webUrl]);

  useEffect(() => {
    if (!findOpen || !findQuery.trim()) return;
    const node = logRef.current?.querySelector(
      `[data-find-hit="${activeHitRef.current}"]`,
    );
    if (!(node instanceof HTMLElement)) return;
    stickRef.current = false;
    let parent: HTMLElement | null = node.parentElement;
    while (parent && parent !== logRef.current) {
      if (parent instanceof HTMLDetailsElement && !parent.open) {
        parent.open = true;
        const turn = parent.closest<HTMLElement>("[data-turn-index]");
        const raw = turn?.dataset.turnIndex;
        if (raw != null) {
          const index = Number(raw);
          if (Number.isFinite(index) && measuredHeights.current.delete(index)) {
            setMeasureTick((tick) => tick + 1);
          }
        }
      }
      parent = parent.parentElement;
    }
    node.scrollIntoView({ block: "center", inline: "nearest" });
  }, [findOpen, findQuery, findIndex, findTick, messages.length]);

  useEffect(() => {
    if (!refocus.current || busyHere || pending) return;
    refocus.current = false;
    inputRef.current?.focus();
  }, [busyHere, pending, messages.length]);

  // Keep the composer ready to type when entering Agent or switching sessions.
  useEffect(() => {
    if (!thread || thread.webUrl) return;
    const frame = requestAnimationFrame(() => {
      if (findOpenRef.current || pendingRef.current) return;
      inputRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [thread?.id, thread?.webUrl]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    return () => {
      void webSessionClose();
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: (() => void) | undefined;
    let alive = true;
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      const stopAuth = await listen("web-session-auth", () => {
        void webLoginRef.current();
      });
      const stopEdit = await listen("web-session-edit", () => {
        webEditRef.current();
      });
      const stopFullscreen = await listen<boolean>("web-session-fullscreen", (event) => {
        webFullscreenApplyRef.current(Boolean(event.payload));
      });
      if (!alive) {
        stopAuth();
        stopEdit();
        stopFullscreen();
      } else {
        unlisten = () => {
          stopAuth();
          stopEdit();
          stopFullscreen();
        };
      }
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    webLoginRef.current = async () => {
      if (!thread?.webUrl || webLoginBusy.current) return;
      webLoginBusy.current = true;
      webCoveredRef.current = true;
      await webSessionHide().catch(() => undefined);
      try {
        const raw = await dialog.prompt({
          title: "登录 dsh web",
          label: "把 dsh web 启动时打印的完整地址粘贴到这里",
          confirmLabel: "登录",
        });
        if (!raw) return;
        const webUrl = normalizeAgentWebUrl(raw);
        if (!webUrl) {
          await dialog.alert({
            title: "无法登录",
            message: "请输入 http 或 https 网址。",
          });
          return;
        }
        store.updateAgentThread(thread.id, { webUrl });
        onRefresh();
      } finally {
        webLoginBusy.current = false;
        webCoveredRef.current = false;
        webSyncRef.current();
      }
    };
  }, [dialog, onRefresh, store, thread?.id, thread?.webUrl]);

  useEffect(() => onWebSessionResume(() => webSyncRef.current()), []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    const sync = () => {
      if (webCoveredRef.current || webSessionHeld()) return;
      const url = webStateRef.current.url;
      const threadId = webStateRef.current.id;
      if (!url) {
        void webSessionHide();
        return;
      }
      const node = webHostRef.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      void webSessionShow({
        url,
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
        fullscreen: webFullscreenRef.current,
      }).then(
        (opened) => {
          if (webSessionHeld() || webStateRef.current.id !== threadId) return;
          setWebSessionError("");
          if (opened && opened !== url && store.getAgentThread(threadId)?.webUrl) {
            store.updateAgentThread(threadId, { webUrl: opened });
            onRefresh();
          }
        },
        (err) => {
          if (webSessionHeld() || webStateRef.current.id !== threadId) return;
          const message = errorMessage(err, "无法打开网页");
          setWebSessionError(message);
          if (message.includes("粘贴新打印的地址")) void webLoginRef.current();
        },
      );
    };
    webSyncRef.current = sync;
    sync();
    const observer = new ResizeObserver(sync);
    if (webHostRef.current) observer.observe(webHostRef.current);
    window.addEventListener("resize", sync);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", sync);
      webSyncRef.current = () => {};
    };
  }, [onRefresh, store, thread?.id, thread?.webUrl]);

  useEffect(() => {
    if (thread?.webUrl) return;
    if (!webFullscreenRef.current) return;
    webFullscreenApplyRef.current(false);
  }, [thread?.webUrl]);

  useEffect(() => {
    if (!webFullscreen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector(".modal-backdrop")) return;
      webFullscreenApplyRef.current(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [webFullscreen]);

  useEffect(() => {
    if (isTauriRuntime()) return;
    const onChange = () => {
      const on = document.fullscreenElement === webFrameRef.current;
      if (webFullscreenRef.current === on) return;
      webFullscreenRef.current = on;
      setWebFullscreen(on);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  useEffect(() => {
    if (!thread || busyThreadId || pending || sending.current || draining.current) return;
    if (queuePausedRef.current) {
      wantDrain.current = null;
      wantGoalContinue.current = null;
      return;
    }
    if (wantDrain.current === thread.id) {
      const next = (queuesRef.current[thread.id] ?? [])[0];
      if (!next) {
        wantDrain.current = null;
      } else {
        const threadId = thread.id;
        draining.current = true;
        setQueues((current) => ({
          ...current,
          [threadId]: (current[threadId] ?? []).slice(1),
        }));
        void sendPromptRef.current(next).then((started) => {
          if (started) return;
          draining.current = false;
          wantDrain.current = null;
          setQueues((current) => ({
            ...current,
            [threadId]: [next, ...(current[threadId] ?? [])],
          }));
        });
        return;
      }
    }
    if (wantGoalContinue.current !== thread.id) return;
    const goal = goalsByThreadRef.current[thread.id];
    wantGoalContinue.current = null;
    if (!shouldContinueGoal(goal) || !goal) return;
    draining.current = true;
    void sendPromptRef
      .current(formatGoalRoundPrompt(goal), undefined, undefined, { goalRound: true })
      .then((started) => {
        if (!started) draining.current = false;
      });
  }, [busyThreadId, pending, thread?.id, queueRev, queuePaused]);

  const env = (): AgentTurnEnv | null => {
    if (!thread) return null;
    return {
      store,
      threadId: thread.id,
      providers: readProviderStore().providers,
      readApiKey: readCredential,
      displayName,
      rules,
      skills,
      memories,
      onMemories,
      subagents,
      hooks,
      plugins,
      mcpServers,
      hostTools,
      runHostTool: (args) => runHostTool(hostTools, args),
      todos: todosByThread[thread.id] ?? [],
      onTodos: (next) => {
        setTodosByThread((current) => ({ ...current, [thread.id]: next }));
      },
      goal: goalsByThread[thread.id] ?? null,
      onGoal: (next) => {
        goalsByThreadRef.current = {
          ...goalsByThreadRef.current,
          [thread.id]: next,
        };
        setGoalsByThread((current) => ({ ...current, [thread.id]: next }));
      },
      cwd: cwdByThread[thread.id] ?? undefined,
      onCwd: (next) => {
        setCwdByThread((current) => ({ ...current, [thread.id]: next }));
      },
      timer: { taskId: activeTimerTaskId, startedAt: timerStartedAt },
      workspaceTitle: store.getAgentWorkspace(thread.workspaceId)?.title,
      workspacePath:
        store.getAgentWorkspace(thread.workspaceId)?.rootPath ??
        workspaces.find((item) => item.id === thread.workspaceId)?.rootPath,
      gitBranch,
      focus,
      onStep: () => {
        onPersist?.();
        if (mounted.current) setTranscriptRev((rev) => rev + 1);
      },
      onDelta: (text) => {
        if (!mounted.current || viewingThreadId.current !== thread.id) return;
        liveBuf.current = text;
        if (liveRaf.current != null) return;
        liveRaf.current = window.requestAnimationFrame(() => {
          liveRaf.current = null;
          if (!mounted.current || viewingThreadId.current !== thread.id) return;
          setLive(liveBuf.current);
        });
      },
    };
  };
  const turnEnv = env();
  const contextPreview = turnEnv ? previewAgentContext(turnEnv, messages) : null;
  const loadedSkills = skillsLoadedInTranscript(
    skills,
    messages.map((message) => ({
      role: message.role,
      content: message.content,
      toolName: message.toolName,
    })),
  );
  const contextRatio =
    contextPreview && contextPreview.budget > 0
      ? contextPreview.used / contextPreview.budget
      : 0;

  const finish = (effects: AgentUiEffect[]) => {
    refocus.current = true;
    if (mounted.current) {
      liveBuf.current = "";
      if (liveRaf.current != null) {
        window.cancelAnimationFrame(liveRaf.current);
        liveRaf.current = null;
      }
      setLive("");
      setBusyThreadId(null);
    }
    if (effects.length) onEffects(effects);
    onRefresh();
  };

  const selectModel = (nextRef: string) => {
    if (!thread) {
      if (readProviderStore().defaultModelRef === nextRef) return;
      setDefaultModel(nextRef);
      onRefresh();
      return;
    }
    if (nextRef === thread.modelRef) return;
    const text =
      store.listAgentMessages(thread.id).length > 0
        ? modelSwitchText(thread.modelRef, nextRef, modelRefLabel)
        : null;
    store.updateAgentThread(thread.id, { modelRef: nextRef });
    if (text) {
      store.appendAgentMessage({ threadId: thread.id, role: "system", content: text });
    }
    onRefresh();
  };

  const applyMode = (permissionMode: AgentPermissionMode) => {
    if (!thread) return;
    store.updateAgentThread(thread.id, { permissionMode });
    onRefresh();
    const current = env();
    if (!current) return;
    setBusyThreadId(thread.id);
    void resumeAgentQueue({ ...current, onDelta: undefined }).then(
      (result) => finish(result.effects),
      (caught: unknown) => {
        if (!mounted.current) return;
        setBusyThreadId(null);
        setError(caught instanceof Error ? caught.message : "权限切换失败");
      },
    );
  };

  const say = (command: string, text: string) => {
    if (!thread) return;
    if (thread.title === "新会话") {
      store.updateAgentThread(thread.id, { title: slashThreadTitle(command) });
    }
    const now = Date.now();
    store.appendAgentMessage({
      threadId: thread.id,
      role: "user",
      content: command,
      nowMs: now,
    });
    store.appendAgentMessage({
      threadId: thread.id,
      role: "assistant",
      content: text,
      nowMs: now,
    });
    refocus.current = true;
    onRefresh();
  };

  const takeDraft = (content: string) => {
    rememberInput(content);
    stickRef.current = true;
    setPinned(true);
    historyNav.current = null;
    setDraft("");
    if (thread) drafts.current.delete(thread.id);
    setError("");
  };

  const recallHistory = (direction: -1 | 1) => {
    const history = readInputHistory();
    if (direction < 0 && history.length === 0) return;
    if (!historyNav.current) {
      if (direction > 0) return;
      historyNav.current = { index: -1, saved: draft };
    }
    const nav = historyNav.current;
    const write = (value: string) => {
      placeCaret.current = true;
      setDraft(value);
      if (thread) drafts.current.set(thread.id, value);
    };
    if (direction < 0) {
      nav.index = Math.min(nav.index + 1, history.length - 1);
      write(history[nav.index] ?? "");
      return;
    }
    if (nav.index <= 0) {
      write(nav.saved);
      historyNav.current = null;
      return;
    }
    nav.index -= 1;
    write(history[nav.index] ?? "");
  };

  const sendPrompt = async (
    content: string,
    subagent?: AgentSubagent,
    imageDataUrl?: string,
    options?: { goalRound?: boolean },
  ): Promise<boolean> => {
    const current = env();
    if (!current || sending.current || busyThreadId || pending) return false;
    sending.current = true;
    stickRef.current = true;
    setPinned(true);
    setError("");
    const controller = new AbortController();
    stopRef.current = controller;
    setBusyThreadId(current.threadId);
    try {
      const result = await startAgentTurn(
        {
          ...current,
          imageDataUrl,
          goalRound: options?.goalRound === true,
          signal: controller.signal,
          subagentPrompt: subagent
            ? `你正在作为子智能体「${subagent.name}」回答。\n${subagent.prompt}`
            : undefined,
          toolAllowlist:
            subagent && subagent.toolNames.length ? subagent.toolNames : undefined,
        },
        content,
      );
      finish(result.effects);
      if (!controller.signal.aborted && !queuePausedRef.current) {
        if ((queuesRef.current[current.threadId] ?? []).length > 0) {
          wantDrain.current = current.threadId;
          setQueueRev((rev) => rev + 1);
        } else if (shouldContinueGoal(goalsByThreadRef.current[current.threadId])) {
          wantGoalContinue.current = current.threadId;
          setQueueRev((rev) => rev + 1);
        }
      }
      return true;
    } catch (caught) {
      if (mounted.current) {
        setBusyThreadId(null);
        if (!controller.signal.aborted) {
          setError(caught instanceof Error ? caught.message : "发送失败");
          if (
            !queuePausedRef.current &&
            (queuesRef.current[current.threadId] ?? []).length > 0
          ) {
            wantDrain.current = current.threadId;
            setQueueRev((rev) => rev + 1);
          }
        }
      }
      // Still true: the prompt was already taken; avoid double-send on retry.
      return true;
    } finally {
      if (stopRef.current === controller) stopRef.current = null;
      sending.current = false;
      draining.current = false;
    }
  };
  sendPromptRef.current = sendPrompt;

  const stop = () => {
    stopRef.current?.abort();
    wantDrain.current = null;
    wantGoalContinue.current = null;
    if (thread && (queuesRef.current[thread.id] ?? []).length > 0) {
      setQueuePaused(true);
    }
  };

  const copyReply = async (id: string, text: string) => {
    const ok = await writeClipboard(text);
    if (!ok) {
      setError("复制失败");
      return;
    }
    setError("");
    setCopied(id);
    window.setTimeout(() => {
      if (!mounted.current) return;
      setCopied((current) => (current === id ? null : current));
    }, 1200);
  };

  const runSlash = (action: SlashAction, command: string) => {
    if (!thread) return;
    if (action.type === "new") {
      onCreateFromFolder();
      return;
    }
    if (action.type === "mode") {
      say(command, `已改为${permissionModeLabel(action.mode)}。`);
      applyMode(action.mode);
      return;
    }
    if (action.type === "model-menu") {
      setPicker("model");
      return;
    }
    if (action.type === "model") {
      const known = modelGroups().some((group) =>
        group.models.some((model) => model.ref === action.modelRef),
      );
      if (known) store.updateAgentThread(thread.id, { modelRef: action.modelRef });
      say(command, known ? "已切换模型。" : "没有这个模型。输入 /model 打开选择菜单。");
      return;
    }
    if (action.type === "prompt") {
      void sendPrompt(action.text);
      return;
    }
    if (action.type === "compact") {
      const plan = manualCompactPlan(store.listAgentMessages(thread.id));
      if (!plan) {
        say(command, "当前对话还很短，不必压缩。");
        return;
      }
      const now = Date.now();
      if (thread.title === "新会话") {
        store.updateAgentThread(thread.id, { title: slashThreadTitle(command) });
      }
      store.appendAgentMessage({
        threadId: thread.id,
        role: "user",
        content: command,
        nowMs: now,
      });
      store.appendAgentMessage({
        threadId: thread.id,
        role: "system",
        content: compactMarkerText(plan.summary, plan.dropped),
        nowMs: now,
      });
      store.appendAgentMessage({
        threadId: thread.id,
        role: "assistant",
        content: "已压缩更早的对话。模型之后只看摘要和这之后的内容。",
        nowMs: now,
      });
      onRefresh();
      return;
    }
    if (action.type === "memory") {
      const query = action.text.trim();
      if (!query) {
        say(command, formatMemoriesForPrompt(memories) || "还没有记忆。");
        return;
      }
      const forgetting = /^(?:忘记|忘掉)\s+([\s\S]+)$/.exec(query);
      if (forgetting?.[1]) {
        const result = forgetAgentMemory(memories, forgetting[1].trim());
        if (!result.removed) {
          say(command, "没有匹配的记忆。");
          return;
        }
        onMemories?.(result.memories);
        say(command, `已删除 ${result.removed} 条记忆。`);
        return;
      }
      const result = addAgentMemory(memories, query);
      if (!result.added) {
        say(command, result.reason ?? "无法记下。");
        return;
      }
      onMemories?.(result.memories);
      say(command, `已记住「${result.added.text}」。`);
      return;
    }
    if (action.type === "agent") {
      if (!action.name) {
        say(command, formatSubagentList(subagents));
        return;
      }
      const found = findSubagent(subagents, action.name);
      if (!found) {
        say(command, `没有叫「${action.name}」的子智能体。`);
        return;
      }
      if (!action.task) {
        say(command, `${found.name}：${found.description}`);
        return;
      }
      void sendPrompt(subagentTurnText(found, action.task), found);
      return;
    }
    if (action.type === "goal") {
      const request = parseGoalSlash(action.args);
      const result = applyGoalSlash(goalsByThreadRef.current[thread.id] ?? null, request);
      if (result.ok) {
        goalsByThreadRef.current = {
          ...goalsByThreadRef.current,
          [thread.id]: result.goal,
        };
        setGoalsByThread((current) => ({ ...current, [thread.id]: result.goal }));
        if (
          request.kind === "resume" &&
          result.goal &&
          shouldContinueGoal(result.goal) &&
          !busyThreadId &&
          !pending &&
          !sending.current
        ) {
          wantGoalContinue.current = thread.id;
          setQueueRev((rev) => rev + 1);
        }
      }
      say(command, result.text);
      return;
    }
    say(command, action.text);
  };

  const clearImage = () => {
    if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
    imageUrlRef.current = null;
    setPendingImage(null);
  };

  const attachImage = (file: File) => {
    if (!file.type.startsWith("image/")) {
      setError("只能添加图片");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setError("图片不能超过 8MB");
      return;
    }
    if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
    const url = URL.createObjectURL(file);
    imageUrlRef.current = url;
    setPendingImage({ name: file.name || "图片", url, blob: file });
    setError("");
  };

  const sendImage = async (content: string, shot: { name: string; blob: Blob }) => {
    if (!thread) return;
    const found = findProvider(readProviderStore().providers, thread.modelRef);
    const provider = found ? chatProviderFor(found.provider, found.modelId) : null;
    const caps = found ? found.provider.models[found.modelId] : undefined;
    // OpenCode's local runner only gets text, so fall back to OCR for those turns.
    const openCodeLocal =
      Boolean(found?.provider.kind === "builtin" && caps?.endpoint) && isTauriRuntime();
    if (provider && modelCanSeeImages(provider.kind, caps) && !openCodeLocal) {
      try {
        const dataUrl = await imageDataUrl(shot.blob);
        if (dataUrl.length > 6_500_000) {
          setError("图片太大，当前模型发不出去");
          return;
        }
        await sendPrompt(content || "请看这张图片", undefined, dataUrl);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "无法读取图片");
      }
      return;
    }
    const userText = localOcrUserMessage(content, shot.name);
    const sentAt = Date.now();
    store.appendAgentMessage({
      threadId: thread.id,
      role: "user",
      content: userText,
      nowMs: sentAt,
    });
    onRefresh();
    sending.current = true;
    setBusyThreadId(thread.id);
    try {
      const recognized = await recognizeLocalImage(shot.blob);
      if (recognized.ok === false) {
        store.appendAgentMessage({
          threadId: thread.id,
          role: "assistant",
          content: `本地识图失败：${recognized.message}`,
          nowMs: Date.now(),
        });
        if (!recognized.message.includes("桌面应用")) {
          store.pushNotification({
            kind: "system",
            title:
              recognized.message.includes("下载") ||
              recognized.message.includes("配置目录")
                ? "识图模型下载失败"
                : "本地识图失败",
            body: recognized.message,
          });
        }
        onRefresh();
        return;
      }
      store.appendAgentMessage({
        threadId: thread.id,
        role: "assistant",
        content: localOcrReply(recognized.lines),
        nowMs: Date.now(),
      });
      onRefresh();
    } finally {
      sending.current = false;
      setBusyThreadId(null);
    }
  };

  const send = async (text: string) => {
    const content = stripSkillPickMarks(text).trim();
    const shot = pendingImage;
    if ((!content && !shot) || !thread) return;
    const action = content
      ? resolveSlash(content, thread.permissionMode, commands, skills)
      : null;
    if (shot && action) {
      setError("命令不能和图片一起发送");
      return;
    }
    if (busyHere || busyElsewhere) {
      if (shot) {
        setError(
          busyElsewhere
            ? "另一个会话还在回答，请稍后再发图片"
            : "请等当前回答结束后再发送图片",
        );
        return;
      }
      if (action) {
        setError(
          busyElsewhere
            ? "另一个会话还在回答，请稍后再用命令"
            : "请等当前回答结束后再使用命令",
        );
        return;
      }
      takeDraft(content);
      setQueues((current) => ({
        ...current,
        [thread.id]: enqueuePrompt(current[thread.id] ?? [], content),
      }));
      setError("");
      return;
    }
    if (sending.current) return;
    if (action) {
      if (action.type === "prompt" && pending) return;
      takeDraft(content);
      runSlash(action, content);
      return;
    }
    if (pending) return;
    takeDraft(content);
    if (shot) {
      clearImage();
      await sendImage(content, shot);
      return;
    }
    await sendPrompt(content);
  };

  const retryLast = () => {
    if (!thread || busyThreadId || pending || sending.current) return;
    const plan = agentRetryPlan(store.listAgentMessages(thread.id));
    if (!plan) return;
    const action = resolveSlash(plan.text, thread.permissionMode, commands, skills);
    store.deleteAgentMessagesFrom(thread.id, plan.userMessageId);
    onRefresh();
    if (action) {
      runSlash(action, plan.text);
      return;
    }
    void sendPrompt(plan.text);
  };

  const editLast = () => {
    if (!thread || busyThreadId || pending || sending.current) return;
    const plan = agentEditPlan(store.listAgentMessages(thread.id));
    if (!plan) return;
    if (draft.trim()) {
      setError("先清空输入框，再编辑这条消息");
      return;
    }
    store.deleteAgentMessagesFrom(thread.id, plan.userMessageId);
    placeCaret.current = true;
    setDraft(plan.text);
    drafts.current.set(thread.id, plan.text);
    setError("");
    onRefresh();
    inputRef.current?.focus();
  };

  const releaseQueue = () => {
    if (!thread || busyThreadId || pending || sending.current || draining.current) return;
    if ((queues[thread.id] ?? []).length === 0) return;
    setQueuePaused(false);
    wantDrain.current = thread.id;
    setQueueRev((rev) => rev + 1);
  };

  const syncQueuePaused = (id: string, nextQueue: readonly string[]) => {
    if (nextQueue.length > 0) return;
    setQueuePausedById((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    if (wantDrain.current === id) wantDrain.current = null;
  };

  const recallQueued = (index: number) => {
    if (!thread) return;
    const recalled = recallQueuedPrompt(queues[thread.id] ?? [], index, draft);
    if (!recalled) {
      setError("先清空输入框，再取回排队的消息");
      return;
    }
    setError("");
    setQueues((current) => ({ ...current, [thread.id]: recalled.queue }));
    syncQueuePaused(thread.id, recalled.queue);
    placeCaret.current = true;
    setDraft(recalled.draft);
    drafts.current.set(thread.id, recalled.draft);
    inputRef.current?.focus();
  };

  const removeQueued = (index: number) => {
    if (!thread) return;
    const id = thread.id;
    const nextQueue = removeQueuedPrompt(queues[id] ?? [], index);
    setQueues((current) => ({ ...current, [id]: nextQueue }));
    syncQueuePaused(id, nextQueue);
  };

  const clearQueued = () => {
    if (!thread) return;
    const id = thread.id;
    setQueues((current) => {
      if (!(id in current) || (current[id] ?? []).length === 0) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    syncQueuePaused(id, []);
  };

  const pauseQueue = () => {
    if (!thread) return;
    if ((queues[thread.id] ?? []).length === 0) return;
    wantDrain.current = null;
    setQueuePaused(true);
  };

  const jumpBottom = () => {
    stickRef.current = true;
    setPinned(true);
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  };

  const decide = async (decision: "approved" | "denied") => {
    const current = env();
    if (!current || sending.current || busyThreadId) return;
    if (pending?.toolName === "ask_user_question" && decision === "approved") return;
    sending.current = true;
    setBusyThreadId(current.threadId);
    setError("");
    try {
      const result = await settleAgentApproval(current, decision);
      finish(result.effects);
      if (
        !queuePausedRef.current &&
        (queuesRef.current[current.threadId] ?? []).length > 0
      ) {
        wantDrain.current = current.threadId;
        setQueueRev((rev) => rev + 1);
      }
    } catch (caught) {
      if (mounted.current) {
        setBusyThreadId(null);
        setError(caught instanceof Error ? caught.message : "审批失败");
        if (
          !queuePausedRef.current &&
          (queuesRef.current[current.threadId] ?? []).length > 0
        ) {
          wantDrain.current = current.threadId;
          setQueueRev((rev) => rev + 1);
        }
      }
    } finally {
      sending.current = false;
    }
  };
  decideRef.current = (decision) => {
    void decide(decision);
  };

  const answerQuestionsTimeout = async () => {
    const current = env();
    if (!current || sending.current || busyThreadId) return;
    if (pending?.toolName !== "ask_user_question") return;
    sending.current = true;
    setBusyThreadId(current.threadId);
    setError("");
    try {
      const result = await settleAgentQuestionTimeout(current);
      setQuestionAnswers({});
      setAskTimedLeft(null);
      finish(result.effects);
      if (
        !queuePausedRef.current &&
        (queuesRef.current[current.threadId] ?? []).length > 0
      ) {
        wantDrain.current = current.threadId;
        setQueueRev((rev) => rev + 1);
      }
    } catch (caught) {
      if (mounted.current) {
        setBusyThreadId(null);
        setError(caught instanceof Error ? caught.message : "提问超时处理失败");
      }
    } finally {
      sending.current = false;
    }
  };

  const answerQuestions = async () => {
    const current = env();
    if (!current || sending.current || busyThreadId) return;
    if (pending?.toolName !== "ask_user_question") return;
    sending.current = true;
    setBusyThreadId(current.threadId);
    setError("");
    try {
      const result = await settleAgentQuestion(current, questionAnswers);
      setQuestionAnswers({});
      setAskTimedLeft(null);
      finish(result.effects);
      if (
        !queuePausedRef.current &&
        (queuesRef.current[current.threadId] ?? []).length > 0
      ) {
        wantDrain.current = current.threadId;
        setQueueRev((rev) => rev + 1);
      }
    } catch (caught) {
      if (mounted.current) {
        setBusyThreadId(null);
        setError(caught instanceof Error ? caught.message : "提交回答失败");
      }
    } finally {
      sending.current = false;
    }
  };

  useEffect(() => {
    if (!pending || pending.toolName !== "ask_user_question") {
      setAskTimedLeft(null);
      return;
    }
    let args: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(pending.argsJson);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      setAskTimedLeft(null);
      return;
    }
    const timed = askUserTimedConfig(args);
    if (!timed.timed || timed.timeoutSec < 0) {
      setAskTimedLeft(null);
      return;
    }
    const totalMs = Math.max(1, timed.timeoutSec) * 1000;
    const started = Date.now();
    setAskTimedLeft(Math.ceil(totalMs / 1000));
    const tick = window.setInterval(() => {
      const left = Math.max(0, Math.ceil((totalMs - (Date.now() - started)) / 1000));
      setAskTimedLeft(left);
    }, 250);
    const timer = window.setTimeout(() => {
      window.clearInterval(tick);
      setAskTimedLeft(0);
      void answerQuestionsTimeout();
    }, totalMs);
    return () => {
      window.clearInterval(tick);
      window.clearTimeout(timer);
    };
    // Restart only when the pending ask call changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.id, pending?.toolCallId, pending?.toolName]);

  const commitTitle = (id: string, raw: string) => {
    if (ignoreTitleBlur.current) {
      ignoreTitleBlur.current = false;
      setRenaming(false);
      return;
    }
    const next = raw.trim();
    const current = store.getAgentThread(id);
    setRenaming(false);
    if (!next || next === current?.title) return;
    store.updateAgentThread(id, { title: next });
    onRefresh();
  };

  const forgetThreadLocal = (id: string) => {
    setQueues((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    setQueuePausedById((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    if (wantDrain.current === id) wantDrain.current = null;
  };
  if (forgetThreadRef) forgetThreadRef.current = forgetThreadLocal;

  const mode = thread?.permissionMode ?? "confirm";
  const suggestions = slashSuggestions(draft, commands);
  const skillHits = slashSkillSuggestions(draft, skills, [
    ...SLASH_COMMANDS.flatMap((command) => [command.name, ...command.aliases]),
    ...commands.map((command) => command.name),
  ]);
  const slashRows = [
    ...suggestions.map((command) => ({
      kind: "command" as const,
      name: command.name,
      summary: command.summary,
    })),
    ...skillHits.map((skill) => ({
      kind: "skill" as const,
      name: skill.name,
      summary: skill.summary,
    })),
  ];
  const showSlash = !slashUi.dismissed && !busyHere && slashRows.length > 0;
  const slashPick = Math.min(slashUi.index, Math.max(slashRows.length - 1, 0));
  const mentionItems = mentionSuggestions(
    draft,
    subagents.map((agent) => ({
      kind: "subagent" as const,
      name: agent.name,
      summary: agent.description,
    })),
  );
  const showMention =
    !showSlash && mentionQuery(draft) != null && mentionItems.length > 0;
  const mentionPick = Math.min(slashUi.index, Math.max(mentionItems.length - 1, 0));
  useEffect(() => {
    const list = slashListRef.current;
    const button = list?.querySelector<HTMLButtonElement>("button.is-active");
    if (!list || !button) return;
    const top = button.offsetTop;
    const bottom = top + button.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom - list.clientHeight;
    }
  }, [slashPick, mentionPick, showSlash, showMention]);
  const nowMs = Date.now();
  const turns = conversationBlocks(messages, Boolean(pending));
  const turnPieces = turns.map((turn) =>
    turn.kind === "agent" ? agentTurnPieces(turn.messages, nowMs) : null,
  );
  const findNeedle = findOpen ? findQuery : "";
  if (turnsLenRef.current !== turns.length) {
    const prevLen = turnsLenRef.current;
    turnsLenRef.current = turns.length;
    // Shrink/edit shifts indices; appends keep earlier measured rows.
    if (turns.length < prevLen && measuredHeights.current.size > 0) {
      measuredHeights.current.clear();
      setMeasureTick((tick) => tick + 1);
    }
  }
  const tipSig = `${messages.length}:${messages.at(-1)?.id ?? ""}:${messages.at(-1)?.content.length ?? 0}:${transcriptRev}`;
  if (tipSigRef.current !== tipSig) {
    tipSigRef.current = tipSig;
    const tip = turns.length - 1;
    if (tip >= 0 && measuredHeights.current.delete(tip)) {
      setMeasureTick((tick) => tick + 1);
    }
  }
  const turnHeights = turns.map((turn, index) => {
    const measured = measuredHeights.current.get(index);
    if (measured != null && measured > 0) return measured;
    if (turn.kind === "marker") return estimateAgentTurnHeight("marker", 1);
    if (turn.kind === "user") {
      return estimateAgentTurnHeight(
        "user",
        Math.max(1, turn.message.content.split(/\r?\n/).length),
      );
    }
    const pieces = turnPieces[index] ?? [];
    if (!pieces.length) return 0;
    const toolCount = pieces.filter((piece) => piece.kind === "tool").length;
    const proseLines = pieces
      .filter((piece) => piece.kind === "prose")
      .reduce((sum, piece) => sum + Math.max(1, piece.text.split(/\r?\n/).length), 0);
    return estimateAgentTurnHeight("agent", 0, toolCount, proseLines);
  });
  const logMetrics = buildHeightMetrics(turnHeights);
  const virtualizeLog =
    !findNeedle.trim() && turns.length >= AGENT_LOG_VIRTUAL_MIN && !live;
  const logRange = virtualizeLog
    ? agentLogVisibleRange(logMetrics, logScroll.top, logScroll.height)
    : { start: 0, end: turns.length };
  useEffect(() => {
    if (live) {
      wasLiveRef.current = true;
      return;
    }
    if (!wasLiveRef.current) return;
    wasLiveRef.current = false;
    if (!stickRef.current) return;
    const node = logRef.current;
    if (!node) return;
    const pin = () => {
      if (!stickRef.current || !logRef.current) return;
      logRef.current.scrollTop = logRef.current.scrollHeight;
    };
    pin();
    const raf = window.requestAnimationFrame(pin);
    return () => window.cancelAnimationFrame(raf);
  }, [live, virtualizeLog, logMetrics.total]);
  useEffect(() => {
    if (!virtualizeLog) return;
    const root = logRef.current;
    if (!root) return;
    const observer = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const raw = (entry.target as HTMLElement).dataset.turnIndex;
        if (raw == null) continue;
        const index = Number(raw);
        if (!Number.isFinite(index)) continue;
        const height = Math.ceil(entry.contentRect.height);
        if (height <= 0) continue;
        if (measuredHeights.current.get(index) === height) continue;
        measuredHeights.current.set(index, height);
        changed = true;
      }
      if (changed) setMeasureTick((tick) => tick + 1);
    });
    root.querySelectorAll<HTMLElement>("[data-turn-index]").forEach((node) => {
      observer.observe(node);
    });
    return () => observer.disconnect();
  }, [virtualizeLog, logRange.start, logRange.end, turns.length, messages.length]);
  let findCursor = 0;
  const pieceBases: number[][] = [];
  const findBases = turns.map((turn, index) => {
    const base = findCursor;
    if (!findNeedle.trim()) {
      pieceBases.push([]);
      return base;
    }
    if (turn.kind !== "agent") {
      findCursor += literalHitCount(turn.message.content, findNeedle);
      pieceBases.push([]);
      return base;
    }
    const bases: number[] = [];
    for (const piece of turnPieces[index] ?? []) {
      bases.push(findCursor);
      findCursor += htmlTextHitCount(renderChatMarkdown(piece.text), findNeedle);
    }
    pieceBases.push(bases);
    return base;
  });
  const totalHits = findCursor;
  const activeHit =
    totalHits === 0 ? 0 : ((findIndex % totalHits) + totalHits) % totalHits;
  activeHitRef.current = activeHit;
  const findStatus = !findNeedle.trim()
    ? "输入关键词"
    : totalHits === 0
      ? "无结果"
      : `${activeHit + 1}/${totalHits}`;
  const moveFind = (delta: number) => {
    if (totalHits === 0) return;
    setFindIndex((current) => {
      const base = ((current % totalHits) + totalHits) % totalHits;
      return (base + delta + totalHits) % totalHits;
    });
    setFindTick((tick) => tick + 1);
    stickRef.current = false;
    setPinned(false);
  };
  const retryPlan = !busyHere && !pending ? agentRetryPlan(messages) : null;
  const editPlan = !busyHere && !pending ? agentEditPlan(messages) : null;
  const lastAgentId = [...turns].reverse().find((turn) => turn.kind === "agent")
    ?.messages[0]?.id;
  const queued = queueLength(thread?.queueJson ?? null);
  const queuedPrompts = thread ? (queues[thread.id] ?? []) : [];
  const skillTokens = skillComposerTokens(draft, skills);
  const slashDraft = Boolean(
    thread &&
    draft.trim() &&
    resolveSlash(
      stripSkillPickMarks(draft).trim(),
      thread.permissionMode,
      commands,
      skills,
    ),
  );
  const pendingArgs = pending ? parseArgs(pending.argsJson) : null;
  const pendingQuestions: AskUserQuestion[] =
    pending?.toolName === "ask_user_question" && pendingArgs
      ? (() => {
          const parsed = parseAskUserQuestions(pendingArgs);
          return parsed.ok ? parsed.questions : [];
        })()
      : [];
  const isAskPending = pendingQuestions.length > 0;
  const askTimed = askUserTimedConfig(pendingArgs);
  const argLines =
    pending && pendingArgs && !isAskPending
      ? describeToolArgDiff(
          pendingArgs,
          approvalBeforeSnapshot(store, pending.toolName, pendingArgs),
          nowMs,
        )
      : "";
  const approvalTitle = pending
    ? isAskPending
      ? "需要你的回答"
      : toolActionTitle(pending.toolName)
    : "";
  const questionsReady = pendingQuestions.every((question) => {
    const value = questionAnswers[question.id];
    if (question.multiSelect) {
      return Array.isArray(value) && value.length > 0;
    }
    return typeof value === "string" && value.trim().length > 0;
  });
  const activeWorkspace = thread
    ? (store.getAgentWorkspace(thread.workspaceId) ??
      workspaces.find((item) => item.id === thread.workspaceId) ??
      null)
    : null;
  const showComposerContext = Boolean(thread && activeWorkspace);
  const insertComposerText = (value: string) => {
    setDraft(value);
    if (thread) drafts.current.set(thread.id, value);
    setPicker(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const editWebSession = async () => {
    if (!thread?.webUrl) return;
    webCoveredRef.current = true;
    if (isTauriRuntime()) await webSessionHide().catch(() => undefined);
    try {
      const raw = await dialog.prompt({
        title: "修改链接",
        label: "网址",
        initialValue: thread.webUrl,
        confirmLabel: "保存",
      });
      if (!raw) return;
      const webUrl = normalizeAgentWebUrl(raw);
      if (!webUrl) {
        await dialog.alert({ title: "无法打开", message: "请输入 http 或 https 网址。" });
        return;
      }
      if (webUrl === thread.webUrl) return;
      store.updateAgentThread(thread.id, { webUrl });
      onRefresh();
    } finally {
      webCoveredRef.current = false;
      webSyncRef.current();
    }
  };
  webEditRef.current = () => {
    void editWebSession();
  };
  webFullscreenApplyRef.current = (on: boolean) => {
    const changed = webFullscreenRef.current !== on;
    webFullscreenRef.current = on;
    if (changed) setWebFullscreen(on);
    void applyWebFullscreen(on, webFrameRef.current)
      .catch(() => undefined)
      .finally(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => webSyncRef.current());
        });
      });
  };

  return (
    <section className="agent" aria-label="Agent">
      <div className="agent__main">
        {thread ? (
          <header className="agent__chrome">
            {renaming ? (
              <input
                className="agent__title-input"
                aria-label="会话标题"
                value={titleDraft}
                autoFocus
                maxLength={40}
                onChange={(event) => setTitleDraft(event.target.value)}
                onBlur={(event) => commitTitle(thread.id, event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitTitle(thread.id, event.currentTarget.value);
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    ignoreTitleBlur.current = true;
                    setRenaming(false);
                  }
                }}
              />
            ) : (
              <h1 className="agent__title">
                {thread.pinnedAt != null ? (
                  <IconPin size={14} className="agent__title-pin" />
                ) : null}
                <span>{thread.title}</span>
              </h1>
            )}
            <div className="agent__chrome-menu">
              {workspaceRootPath && isTauriRuntime() ? (
                <button
                  type="button"
                  className={
                    termOpen ? "agent__chrome-action is-on" : "agent__chrome-action"
                  }
                  title="终端"
                  aria-label="终端面板"
                  aria-pressed={termOpen}
                  onClick={() => setTermOpen((open) => !open)}
                >
                  <IconCommand size={16} />
                </button>
              ) : null}
              <button
                type="button"
                className="agent__chrome-action"
                title="会话操作"
                aria-label="会话操作"
                aria-haspopup="menu"
                aria-expanded={threadMenuOpen}
                onClick={() => setThreadMenuOpen((open) => !open)}
              >
                <IconMore size={16} />
              </button>
              {threadMenuOpen ? (
                <div className="agent__thread-menu" role="menu" aria-label="会话操作">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setThreadMenuOpen(false);
                      ignoreTitleBlur.current = false;
                      setTitleDraft(thread.title);
                      setRenaming(true);
                    }}
                  >
                    重命名
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setThreadMenuOpen(false);
                      if (thread.archivedAt != null) {
                        store.unarchiveAgentThread(thread.id);
                        onRefresh();
                        return;
                      }
                      store.archiveAgentThread(thread.id);
                      forgetThreadLocal(thread.id);
                      onSelectThread(
                        store.listAgentThreads().find((item) => item.id !== thread.id)
                          ?.id ?? null,
                      );
                      onRefresh();
                    }}
                  >
                    {thread.archivedAt != null ? "取消归档" : "归档"}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setThreadMenuOpen(false);
                      if (thread.pinnedAt != null) store.unpinAgentThread(thread.id);
                      else store.pinAgentThread(thread.id);
                      onRefresh();
                    }}
                  >
                    {thread.pinnedAt != null ? "取消置顶" : "置顶"}
                  </button>
                </div>
              ) : null}
            </div>
          </header>
        ) : null}
        {thread?.webUrl ? (
          <div
            className={
              webFullscreen ? "agent__web-frame is-fullscreen" : "agent__web-frame"
            }
            ref={webFrameRef}
          >
            <div className="agent__web-tools">
              <button
                type="button"
                className="agent__web-tool"
                title="刷新"
                aria-label="刷新网页"
                onClick={() => {
                  if (webSessionEmbedded()) {
                    void webSessionReload().catch((err) =>
                      setWebSessionError(errorMessage(err, "无法刷新网页")),
                    );
                    return;
                  }
                  setWebReload((count) => count + 1);
                }}
              >
                <IconRefresh size={14} />
              </button>
              <button
                type="button"
                className="agent__web-tool"
                title="修改链接"
                aria-label="修改链接"
                onClick={() => void editWebSession()}
              >
                <IconPencil size={14} />
              </button>
              <button
                type="button"
                className={
                  webFullscreen ? "agent__web-tool is-active" : "agent__web-tool"
                }
                title={webFullscreen ? "退出全屏" : "全屏"}
                aria-label={webFullscreen ? "退出全屏" : "全屏"}
                aria-pressed={webFullscreen}
                onClick={() => webFullscreenApplyRef.current(!webFullscreenRef.current)}
              >
                {webFullscreen ? <IconRestore size={14} /> : <IconMaximize size={14} />}
              </button>
            </div>
            <div className="agent__web-host" ref={webHostRef}>
              {webSessionEmbedded() ? (
                webSessionError ? (
                  <p className="agent__web-error">{webSessionError}</p>
                ) : null
              ) : (
                <iframe
                  key={`${thread.id}-${webReload}`}
                  className="agent__web"
                  title={thread.title}
                  src={thread.webUrl}
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
                />
              )}
            </div>
          </div>
        ) : null}

        {thread?.webUrl ? null : (
          <>
            {findOpen ? (
              <form
                className="agent__find"
                role="search"
                aria-label="在会话中查找"
                onSubmit={(event) => {
                  event.preventDefault();
                  moveFind(1);
                }}
              >
                <input
                  ref={findInputRef}
                  aria-label="查找"
                  placeholder="查找"
                  value={findQuery}
                  onChange={(event) => {
                    setFindQuery(event.target.value);
                    setFindIndex(0);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      moveFind(event.shiftKey ? -1 : 1);
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      setFindOpen(false);
                    }
                  }}
                />
                <span className="agent__find-status" aria-live="polite">
                  {findStatus}
                </span>
                <button
                  type="button"
                  className="btn"
                  disabled={totalHits === 0}
                  onClick={() => moveFind(-1)}
                >
                  上一个
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={totalHits === 0}
                  onClick={() => moveFind(1)}
                >
                  下一个
                </button>
                <button
                  type="button"
                  className="btn"
                  aria-label="关闭查找"
                  onClick={() => setFindOpen(false)}
                >
                  关闭
                </button>
              </form>
            ) : null}

            <div className="agent__stage">
              <div
                className="agent__log"
                ref={logRef}
                onScroll={(event) => {
                  const node = event.currentTarget;
                  const next =
                    node.scrollHeight - node.scrollTop - node.clientHeight < 48;
                  stickRef.current = next;
                  setPinned((current) => (current === next ? current : next));
                  setLogScroll((current) => {
                    const top = node.scrollTop;
                    const height = node.clientHeight;
                    if (current.top === top && current.height === height) return current;
                    return { top, height };
                  });
                }}
              >
                <div
                  className="agent__log-body"
                  style={
                    virtualizeLog
                      ? { minHeight: Math.max(logMetrics.total, logScroll.height) }
                      : undefined
                  }
                >
                  {!thread ? (
                    <div className="agent__empty">
                      <p className="agent__greeting">选一个文件夹开始对话</p>
                      <p className="agent__empty-desc">
                        用自然语言管理任务、笔记和提醒。
                      </p>
                      <button
                        type="button"
                        className="primary"
                        onClick={onCreateFromFolder}
                      >
                        新建会话
                      </button>
                    </div>
                  ) : messages.length === 0 ? (
                    <div className="agent__empty">
                      <p className="agent__greeting">
                        {agentEmptyGreeting(new Date().getHours())}
                      </p>
                      <div className="agent__examples">
                        {EXAMPLES.map((example) => (
                          <button
                            key={example}
                            type="button"
                            className="agent__chip"
                            onClick={() => void send(example)}
                          >
                            {example}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <>
                      {virtualizeLog ? (
                        <div
                          aria-hidden="true"
                          style={{
                            height: logMetrics.offsets[logRange.start] ?? 0,
                            flex: "none",
                          }}
                        />
                      ) : null}
                      {turns.slice(logRange.start, logRange.end).map((turn, offset) => {
                        const index = logRange.start + offset;
                        const findBase = findBases[index] ?? 0;
                        if (turn.kind === "marker") {
                          return (
                            <p
                              key={turn.message.id}
                              className="agent__marker"
                              role="status"
                              data-turn-index={index}
                            >
                              {findNeedle.trim() ? (
                                <HighlightedPlain
                                  text={turn.message.content}
                                  query={findNeedle}
                                  indexBase={findBase}
                                  active={activeHit}
                                />
                              ) : (
                                turn.message.content
                              )}
                            </p>
                          );
                        }
                        if (turn.kind === "user") {
                          return (
                            <article
                              key={turn.message.id}
                              className="agent__msg agent__msg--user"
                              aria-label="你"
                              data-turn-index={index}
                            >
                              <div className="agent__bubble">
                                {findNeedle.trim() ? (
                                  <HighlightedPlain
                                    text={turn.message.content}
                                    query={findNeedle}
                                    indexBase={findBase}
                                    active={activeHit}
                                  />
                                ) : (
                                  turn.message.content
                                )}
                              </div>
                              <div className="agent__msg-actions">
                                <MessageTime ms={turn.message.createdAt} nowMs={nowMs} />
                                <button
                                  type="button"
                                  className="agent__copy"
                                  onClick={() =>
                                    void copyReply(turn.message.id, turn.message.content)
                                  }
                                >
                                  {copied === turn.message.id ? "已复制" : "复制"}
                                </button>
                                {editPlan?.userMessageId === turn.message.id ? (
                                  <button
                                    type="button"
                                    className="agent__copy"
                                    onClick={editLast}
                                  >
                                    编辑
                                  </button>
                                ) : null}
                              </div>
                            </article>
                          );
                        }
                        const pieces = turnPieces[index] ?? [];
                        if (!pieces.length) return null;
                        const id = turn.messages[0]!.id;
                        const stamp = turn.messages[turn.messages.length - 1]!.createdAt;
                        const bases = pieceBases[index] ?? [];
                        const copyText = pieces
                          .map((piece) =>
                            piece.kind === "tool"
                              ? `${piece.summary || piece.label}\n${piece.text}`
                              : piece.text,
                          )
                          .join("\n\n");
                        return (
                          <article
                            key={id}
                            className="agent__msg agent__msg--assistant"
                            aria-label="Agent"
                            data-turn-index={index}
                          >
                            <div className="agent__reply">
                              {pieces.map((piece, pieceIndex) => {
                                const body = (
                                  <AgentMarkdown
                                    text={piece.text}
                                    query={findNeedle}
                                    indexBase={bases[pieceIndex] ?? findBase}
                                    active={activeHit}
                                  />
                                );
                                if (piece.kind !== "tool") {
                                  return <div key={piece.id}>{body}</div>;
                                }
                                return (
                                  <details
                                    key={piece.id}
                                    className="agent__tool"
                                    aria-label={
                                      piece.summary || piece.label || "工具结果"
                                    }
                                    onToggle={() => {
                                      if (measuredHeights.current.delete(index)) {
                                        setMeasureTick((tick) => tick + 1);
                                      }
                                    }}
                                  >
                                    <summary className="agent__tool-summary">
                                      <span className="agent__tool-label">
                                        {piece.label || "工具"}
                                      </span>
                                      {piece.summary ? (
                                        <span className="agent__tool-preview">
                                          {piece.summary}
                                        </span>
                                      ) : null}
                                    </summary>
                                    <div className="agent__tool-body">{body}</div>
                                  </details>
                                );
                              })}
                            </div>
                            <div className="agent__msg-actions">
                              <span className="agent__msg-meta">
                                <MessageTime ms={stamp} nowMs={nowMs} />
                                <ReplyElapsed text={replyElapsed(turns, index, stamp)} />
                              </span>
                              <button
                                type="button"
                                className="agent__copy"
                                onClick={() => void copyReply(id, copyText)}
                              >
                                {copied === id ? "已复制" : "复制"}
                              </button>
                              {retryPlan && id === lastAgentId ? (
                                <button
                                  type="button"
                                  className="agent__copy"
                                  onClick={retryLast}
                                >
                                  重试
                                </button>
                              ) : null}
                            </div>
                          </article>
                        );
                      })}
                      {virtualizeLog ? (
                        <div
                          aria-hidden="true"
                          style={{
                            height: Math.max(
                              0,
                              logMetrics.total -
                                ((logMetrics.offsets[logRange.end] as
                                  number | undefined) ?? logMetrics.total),
                            ),
                            flex: "none",
                          }}
                        />
                      ) : null}
                    </>
                  )}
                  {live ? (
                    <article
                      className="agent__msg agent__msg--assistant"
                      aria-label="Agent"
                      aria-live="polite"
                    >
                      <pre className="agent__live">{live}</pre>
                    </article>
                  ) : null}
                  {busyHere && !live ? <ThinkingStatus messages={messages} /> : null}
                </div>
              </div>
              {thread && messages.length > 0 && !pinned ? (
                <button
                  type="button"
                  className="agent__jump"
                  aria-label="回到底部"
                  onClick={jumpBottom}
                >
                  <IconArrowUp size={16} />
                </button>
              ) : null}
            </div>

            <div className="agent__dock">
              {workspaceRootPath && isTauriRuntime() ? (
                <AgentTerminalPanel
                  open={termOpen}
                  onOpenChange={setTermOpen}
                  rootPath={workspaceRootPath}
                  cwd={(thread ? cwdByThread[thread.id] : null) || workspaceRootPath}
                  refreshKey={termRefresh}
                />
              ) : null}
              {pending ? (
                <div
                  className="agent__approval"
                  role="region"
                  aria-label={isAskPending ? "待回答问题" : "待确认操作"}
                >
                  <div className="agent__approval-head">
                    <strong>{approvalTitle || "需要确认"}</strong>
                    {!isAskPending ? (
                      <p className="agent__approval-summary">
                        {relativizeScheduleText(pending.summary, nowMs)}
                      </p>
                    ) : null}
                    {isAskPending && askTimed.timed ? (
                      <p className="agent__approval-queue">
                        {askTimed.timeoutSec < 0
                          ? "限时提问（无截止）"
                          : askTimedLeft == null
                            ? `限时提问 · ${askTimed.timeoutSec}s`
                            : askTimedLeft > 0
                              ? `限时提问 · ${askTimedLeft}s 后继续`
                              : "限时已到，正在继续…"}
                      </p>
                    ) : null}
                    {queued > 1 ? (
                      <p className="agent__approval-queue">后面还有 {queued - 1} 步。</p>
                    ) : null}
                  </div>
                  {isAskPending ? (
                    <div className="agent__approval-questions">
                      {pendingQuestions.map((question) => (
                        <div key={question.id} className="agent__approval-question">
                          {question.header ? (
                            <p className="agent__approval-q-head">{question.header}</p>
                          ) : null}
                          <p className="agent__approval-summary">{question.question}</p>
                          {question.options?.length ? (
                            <div className="agent__approval-options">
                              {question.options.map((option) => {
                                const selected = question.multiSelect
                                  ? Array.isArray(questionAnswers[question.id]) &&
                                    (questionAnswers[question.id] as string[]).includes(
                                      option.label,
                                    )
                                  : questionAnswers[question.id] === option.label;
                                return (
                                  <button
                                    key={option.label}
                                    type="button"
                                    className={selected ? "primary" : "btn"}
                                    disabled={Boolean(busyThreadId)}
                                    onClick={() => {
                                      setQuestionAnswers((current) => {
                                        if (!question.multiSelect) {
                                          return {
                                            ...current,
                                            [question.id]: option.label,
                                          };
                                        }
                                        const prev = Array.isArray(current[question.id])
                                          ? [...(current[question.id] as string[])]
                                          : [];
                                        const next = prev.includes(option.label)
                                          ? prev.filter((item) => item !== option.label)
                                          : [...prev, option.label];
                                        return { ...current, [question.id]: next };
                                      });
                                    }}
                                  >
                                    {option.label}
                                  </button>
                                );
                              })}
                            </div>
                          ) : (
                            <VoiceField
                              value={
                                typeof questionAnswers[question.id] === "string"
                                  ? (questionAnswers[question.id] as string)
                                  : ""
                              }
                              disabled={Boolean(busyThreadId)}
                              onChange={(value) => {
                                setQuestionAnswers((current) => ({
                                  ...current,
                                  [question.id]: value,
                                }));
                              }}
                            >
                              <input
                                className="agent__approval-input"
                                value={
                                  typeof questionAnswers[question.id] === "string"
                                    ? (questionAnswers[question.id] as string)
                                    : ""
                                }
                                disabled={Boolean(busyThreadId)}
                                placeholder="输入回答"
                                onChange={(event) => {
                                  const value = event.target.value;
                                  setQuestionAnswers((current) => ({
                                    ...current,
                                    [question.id]: value,
                                  }));
                                }}
                              />
                            </VoiceField>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {argLines ? (
                    <details className="agent__approval-more">
                      <summary>{argLines.includes(" → ") ? "变更" : "参数"}</summary>
                      <p className="agent__approval-detail">{argLines}</p>
                    </details>
                  ) : null}
                  <div className="agent__approval-actions">
                    {isAskPending ? (
                      <>
                        <button
                          ref={approveBtnRef}
                          type="button"
                          className="primary"
                          disabled={Boolean(busyThreadId) || !questionsReady}
                          onClick={() => void answerQuestions()}
                        >
                          提交回答
                        </button>
                        <button
                          type="button"
                          className="btn"
                          disabled={Boolean(busyThreadId)}
                          onClick={() => void decide("denied")}
                        >
                          跳过
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          ref={approveBtnRef}
                          type="button"
                          className="primary"
                          disabled={Boolean(busyThreadId)}
                          title={
                            busyElsewhere
                              ? "另一个会话还在回答，结束后再审批"
                              : busyHere
                                ? "当前正在回答"
                                : undefined
                          }
                          onClick={() => void decide("approved")}
                        >
                          批准
                        </button>
                        <button
                          type="button"
                          className="btn"
                          disabled={Boolean(busyThreadId)}
                          title={
                            busyElsewhere
                              ? "另一个会话还在回答，结束后再审批"
                              : busyHere
                                ? "当前正在回答"
                                : undefined
                          }
                          onClick={() => void decide("denied")}
                        >
                          拒绝
                        </button>
                      </>
                    )}
                    <span className="agent__approval-hint">
                      {busyElsewhere
                        ? "另一个会话结束后可继续"
                        : isAskPending
                          ? "填写后提交"
                          : "Enter 批准 · Esc 拒绝"}
                    </span>
                  </div>
                </div>
              ) : null}

              <VoiceStatusLine />

              {error ? (
                <div className="agent__error" role="alert">
                  <span>{error}</span>
                  <button
                    type="button"
                    className="agent__error-dismiss"
                    aria-label="关闭错误提示"
                    onClick={() => setError("")}
                  >
                    关闭
                  </button>
                </div>
              ) : null}

              {queuedPrompts.length > 0 ? (
                <div className="agent__outbox" aria-label="排队消息">
                  <div className="agent__outbox-head">
                    <span>
                      {queuePaused && !busyHere
                        ? `已暂停，排队 ${queuedPrompts.length} 未发送`
                        : queuePaused && busyHere
                          ? `排队 ${queuedPrompts.length}（已暂停后续）`
                          : busyElsewhere
                            ? `排队 ${queuedPrompts.length}（等另一个会话结束）`
                            : `排队 ${queuedPrompts.length}`}
                    </span>
                    <div className="agent__outbox-actions">
                      {busyHere && !queuePaused ? (
                        <button
                          type="button"
                          className="btn"
                          title="当前回答结束后不再自动发送排队"
                          onClick={pauseQueue}
                        >
                          暂停后续
                        </button>
                      ) : null}
                      {!busyHere && !pending && !busyElsewhere ? (
                        <button
                          type="button"
                          className={queuePaused ? "primary" : "btn"}
                          onClick={releaseQueue}
                        >
                          继续发送
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="btn"
                        aria-label="清空排队"
                        onClick={clearQueued}
                      >
                        清空
                      </button>
                    </div>
                  </div>
                  <ol>
                    {queuedPrompts.map((item, index) => (
                      <li key={`${index}-${item}`}>
                        <span>{item}</span>
                        <button
                          type="button"
                          className="btn"
                          aria-label={`取回排队 ${item}`}
                          onClick={() => recallQueued(index)}
                        >
                          取回
                        </button>
                        <button
                          type="button"
                          className="btn"
                          aria-label={`移除排队 ${item}`}
                          onClick={() => removeQueued(index)}
                        >
                          移除
                        </button>
                      </li>
                    ))}
                  </ol>
                </div>
              ) : null}

              <form
                className={
                  showComposerContext ? "agent__composer is-framed" : "agent__composer"
                }
                onSubmit={(event) => {
                  event.preventDefault();
                  if (showMention) {
                    const picked = mentionItems[mentionPick];
                    if (picked) insertComposerText(applyMention(draft, picked.name));
                    return;
                  }
                  const picked = showSlash ? slashRows[slashPick] : null;
                  if (picked?.kind === "skill") {
                    insertComposerText(acceptSkillSlashToken(draft, picked.name));
                    return;
                  }
                  void send(picked ? `/${picked.name}` : draft);
                }}
              >
                {showComposerContext && activeWorkspace ? (
                  <div className="agent__composer-context">
                    <div className="agent__composer-chip-wrap">
                      <button
                        type="button"
                        className="agent__composer-chip"
                        title={activeWorkspace.rootPath || activeWorkspace.title}
                        aria-haspopup="menu"
                        aria-expanded={picker === "workspace"}
                        onClick={() =>
                          setPicker((current) =>
                            current === "workspace" ? null : "workspace",
                          )
                        }
                      >
                        <IconFolder size={14} />
                        <span>{activeWorkspace.title}</span>
                        <span aria-hidden="true">▾</span>
                      </button>
                      {picker === "workspace" ? (
                        <div
                          className="agent__thread-menu agent__composer-chip-menu"
                          role="menu"
                          aria-label="工作区"
                        >
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setPicker(null);
                              onCreateThread(activeWorkspace.id);
                            }}
                          >
                            在此新建会话
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setPicker(null);
                              onCreateFromFolder();
                            }}
                          >
                            打开其他文件夹…
                          </button>
                        </div>
                      ) : null}
                    </div>
                    {gitBranch ? (
                      <span
                        className="agent__composer-chip agent__composer-chip--static"
                        title={`当前分支 ${gitBranch}`}
                      >
                        <IconGitBranch size={14} />
                        <span>{gitBranch}</span>
                      </span>
                    ) : null}
                    <button
                      type="button"
                      className="agent__composer-chip-add"
                      title="打开其他文件夹"
                      aria-label="打开其他文件夹"
                      onClick={onCreateFromFolder}
                    >
                      <IconPlus size={14} />
                    </button>
                  </div>
                ) : null}
                <div className="agent__composer-shell">
                  {showSlash ? (
                    <ul ref={slashListRef} className="agent__slash" aria-label="斜杠命令">
                      {slashRows.map((row, index) => (
                        <li key={`${row.kind}-${row.name}`}>
                          {row.kind === "skill" &&
                          slashRows[index - 1]?.kind !== "skill" ? (
                            <div className="agent__slash-label">技能</div>
                          ) : null}
                          <button
                            type="button"
                            className={index === slashPick ? "is-active" : undefined}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => {
                              if (row.kind === "skill") {
                                insertComposerText(
                                  acceptSkillSlashToken(draft, row.name),
                                );
                                return;
                              }
                              void send(`/${row.name}`);
                            }}
                          >
                            <span>/{row.name}</span>
                            <small>
                              {row.kind === "skill"
                                ? `技能 · ${row.summary}`
                                : row.summary}
                            </small>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {showMention ? (
                    <ul ref={slashListRef} className="agent__slash" aria-label="提及">
                      {mentionItems.map((item, index) => (
                        <li key={`${item.kind}-${item.name}`}>
                          <button
                            type="button"
                            className={index === mentionPick ? "is-active" : undefined}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() =>
                              insertComposerText(applyMention(draft, item.name))
                            }
                          >
                            <span>@{item.name}</span>
                            <small>子智能体 · {item.summary}</small>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {pendingImage ? (
                    <div className="agent__composer-shot">
                      <img src={pendingImage.url} alt="" />
                      <span>{pendingImage.name}</span>
                      <button type="button" aria-label="移除图片" onClick={clearImage}>
                        ×
                      </button>
                    </div>
                  ) : null}
                  <input
                    ref={imageInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
                    hidden
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (file) attachImage(file);
                    }}
                  />
                  <div className="agent__composer-input">
                    {skillTokens.length > 0 ? (
                      <div
                        ref={composerMirrorRef}
                        className="agent__composer-mirror"
                        aria-hidden
                      >
                        <ComposerSkillText text={draft} tokens={skillTokens} />
                      </div>
                    ) : null}
                    <textarea
                      ref={inputRef}
                      className={skillTokens.length > 0 ? "has-skill-token" : undefined}
                      aria-label="给 Agent 发消息"
                      placeholder={
                        busyHere
                          ? "这条会排在当前回答之后"
                          : busyElsewhere
                            ? "另一个会话还在回答，这条会先排队"
                            : pending
                              ? "请先处理待确认操作"
                              : "向工作台提问，使用 / 选择命令或能力"
                      }
                      title={
                        pending
                          ? busyElsewhere
                            ? "另一个会话结束后可审批"
                            : "Enter 批准 · Esc 拒绝"
                          : busyHere || busyElsewhere
                            ? "Enter 把这条加入排队"
                            : "Enter 发送，Shift+Enter 换行，↑ 召回上一条"
                      }
                      value={draft}
                      disabled={!thread}
                      readOnly={Boolean(pending)}
                      rows={2}
                      onPaste={(event) => {
                        const file = Array.from(event.clipboardData.files).find((item) =>
                          item.type.startsWith("image/"),
                        );
                        if (!file) return;
                        event.preventDefault();
                        attachImage(file);
                      }}
                      onScroll={(event) => {
                        const mirror = composerMirrorRef.current;
                        if (!mirror) return;
                        mirror.scrollTop = event.currentTarget.scrollTop;
                        mirror.scrollLeft = event.currentTarget.scrollLeft;
                      }}
                      onChange={(event) => {
                        historyNav.current = null;
                        const raw = event.target.value;
                        const value = tidySkillPickMarks(raw, skills);
                        const caret = event.target.selectionStart ?? value.length;
                        const removed =
                          raw.slice(0, caret).length -
                          tidySkillPickMarks(raw.slice(0, caret), skills).length;
                        setDraft(value);
                        if (thread) drafts.current.set(thread.id, value);
                        if (value !== raw) {
                          const next = Math.max(0, caret - removed);
                          requestAnimationFrame(() => {
                            inputRef.current?.setSelectionRange(next, next);
                          });
                        }
                      }}
                      onKeyDown={(event) => {
                        if (
                          (event.key === "Backspace" || event.key === "Delete") &&
                          !event.altKey &&
                          !event.ctrlKey &&
                          !event.metaKey &&
                          !event.nativeEvent.isComposing
                        ) {
                          const field = event.currentTarget;
                          const collapsed = collapseSkillTokenOnDelete(
                            draft,
                            field.selectionStart ?? draft.length,
                            field.selectionEnd ?? draft.length,
                            event.key,
                            skills,
                          );
                          if (collapsed) {
                            event.preventDefault();
                            historyNav.current = null;
                            setDraft(collapsed.text);
                            if (thread) drafts.current.set(thread.id, collapsed.text);
                            const caret = collapsed.caret;
                            requestAnimationFrame(() => {
                              inputRef.current?.setSelectionRange(caret, caret);
                            });
                            return;
                          }
                        }
                        if (pending) {
                          if (event.key === "Escape") {
                            event.preventDefault();
                            void decide("denied");
                            return;
                          }
                          if (event.key === "Enter" && !event.shiftKey) {
                            event.preventDefault();
                            void decide("approved");
                            return;
                          }
                        }
                        if (showSlash && event.key === "ArrowDown") {
                          event.preventDefault();
                          setSlashUi((ui) => ({
                            ...ui,
                            index: (slashPick + 1) % slashRows.length,
                          }));
                          return;
                        }
                        if (showSlash && event.key === "ArrowUp") {
                          event.preventDefault();
                          setSlashUi((ui) => ({
                            ...ui,
                            index: (slashPick - 1 + slashRows.length) % slashRows.length,
                          }));
                          return;
                        }
                        if (showSlash && event.key === "Tab") {
                          event.preventDefault();
                          const row = slashRows[slashPick];
                          if (!row) return;
                          insertComposerText(
                            row.kind === "skill"
                              ? acceptSkillSlashToken(draft, row.name)
                              : applySlashToken(draft, `/${row.name}`),
                          );
                          return;
                        }
                        if (showSlash && event.key === "Escape") {
                          event.preventDefault();
                          event.stopPropagation();
                          setSlashUi((ui) => ({ ...ui, dismissed: true }));
                          return;
                        }
                        if (
                          showMention &&
                          (event.key === "ArrowDown" || event.key === "ArrowUp")
                        ) {
                          event.preventDefault();
                          const delta = event.key === "ArrowDown" ? 1 : -1;
                          setSlashUi((ui) => ({
                            ...ui,
                            index:
                              (mentionPick + delta + mentionItems.length) %
                              mentionItems.length,
                          }));
                          return;
                        }
                        if (
                          showMention &&
                          (event.key === "Tab" || event.key === "Enter")
                        ) {
                          event.preventDefault();
                          const picked = mentionItems[mentionPick];
                          if (picked)
                            insertComposerText(applyMention(draft, picked.name));
                          return;
                        }
                        const node = event.currentTarget;
                        if (event.key === "ArrowUp" && atFirstLine(node)) {
                          event.preventDefault();
                          recallHistory(-1);
                          return;
                        }
                        if (
                          event.key === "ArrowDown" &&
                          historyNav.current &&
                          atFirstLine(node)
                        ) {
                          event.preventDefault();
                          recallHistory(1);
                          return;
                        }
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          const picked = showSlash ? slashRows[slashPick] : null;
                          if (picked?.kind === "skill") {
                            insertComposerText(acceptSkillSlashToken(draft, picked.name));
                            return;
                          }
                          void send(picked ? `/${picked.name}` : draft);
                        }
                      }}
                    />
                  </div>
                  <div className="agent__composer-bar">
                    <div className="agent__composer-leading">
                      <ComposerPlusMenu
                        disabled={!thread || Boolean(pending)}
                        open={picker === "plus"}
                        onOpenChange={(next) => {
                          setPicker((current) =>
                            next ? "plus" : current === "plus" ? null : current,
                          );
                        }}
                        onInsert={(value) => insertComposerText(value)}
                        onRun={(value) => {
                          setPicker(null);
                          void send(value);
                        }}
                        onOpenMode={() => setPicker("mode")}
                        onOpenModel={() => setPicker("model")}
                        onAddImage={() => imageInputRef.current?.click()}
                      />
                      {thread ? (
                        <ModeMenu
                          mode={mode}
                          disabled={Boolean(pending)}
                          open={picker === "mode"}
                          onOpenChange={(next) => {
                            setPicker((current) =>
                              next ? "mode" : current === "mode" ? null : current,
                            );
                          }}
                          onChange={applyMode}
                        />
                      ) : null}
                    </div>
                    <div className="agent__composer-actions">
                      {loadedSkills.length > 0 ? (
                        <button
                          type="button"
                          className="agent__loaded-skills"
                          title={`本会话已引用：${loadedSkills
                            .map((skill) => `/${skill.name}`)
                            .join("、")}。点击打开设置 · 技能。`}
                          aria-label="打开设置中的技能"
                          onClick={() => onOpenSkills?.()}
                        >
                          技能{" "}
                          {loadedSkills
                            .slice(0, 2)
                            .map((skill) => `/${skill.name}`)
                            .join(" ")}
                          {loadedSkills.length > 2 ? ` +${loadedSkills.length - 2}` : ""}
                        </button>
                      ) : null}
                      {thread && contextPreview ? (
                        <span
                          className={
                            contextRatio >= 0.85
                              ? "agent__context-usage is-tight"
                              : "agent__context-usage"
                          }
                          title={
                            contextPreview.includesSystem
                              ? `发给模型的内容大约 ${contextPreview.used} / ${contextPreview.budget}。含系统提示和对话。接近上限时会先清空较早的工具结果，再压缩更早的对话。`
                              : `本机模型大约使用 ${contextPreview.used} / ${contextPreview.budget}。只计对话。接近上限时会先清空较早的工具结果，再压缩更早的对话。`
                          }
                          aria-label={`上下文大约 ${contextPreview.used} / ${contextPreview.budget}`}
                        >
                          <span className="agent__context-bar" aria-hidden="true">
                            <span
                              style={{
                                width: `${Math.min(100, Math.round(contextRatio * 100))}%`,
                              }}
                            />
                          </span>
                          上下文 {formatContextTokens(contextPreview.used)}/
                          {formatContextTokens(contextPreview.budget)}
                          {contextRatio >= 0.85 ? (
                            <button
                              type="button"
                              className="agent__context-compact"
                              disabled={busyHere || Boolean(pending)}
                              title="压缩更早的对话"
                              onClick={() => runSlash({ type: "compact" }, "/compact")}
                            >
                              压缩
                            </button>
                          ) : null}
                        </span>
                      ) : null}
                      <ModelMenu
                        modelRef={thread?.modelRef ?? readProviderStore().defaultModelRef}
                        disabled={Boolean(pending)}
                        open={picker === "model" && !pending}
                        onOpenChange={(next) => {
                          if (pending) return;
                          setPicker((current) =>
                            next ? "model" : current === "model" ? null : current,
                          );
                        }}
                        onSelect={selectModel}
                        onOpenSettings={onOpenModels}
                      />
                      <VoiceInputButton
                        disabled={!thread || Boolean(pending) || Boolean(thread?.webUrl)}
                        onArm={() => {
                          const node = inputRef.current;
                          if (!node) return;
                          const pos =
                            typeof node.selectionStart === "number"
                              ? node.selectionStart
                              : node.value.length;
                          node.focus({ preventScroll: true });
                          node.setSelectionRange(pos, pos);
                        }}
                        onInsert={(text) => {
                          const el = inputRef.current;
                          const current = el?.value ?? draft;
                          const { value, caret } = insertVoiceText(
                            current,
                            text,
                            el?.selectionStart ?? current.length,
                          );
                          setDraft(value);
                          if (thread) drafts.current.set(thread.id, value);
                          setPicker(null);
                          requestAnimationFrame(() => {
                            const node = inputRef.current;
                            if (!node) return;
                            node.focus({ preventScroll: true });
                            node.setSelectionRange(caret, caret);
                          });
                        }}
                      />
                      {busyHere ? (
                        <>
                          <button
                            type="button"
                            className="agent__queue-btn"
                            disabled={!draft.trim() || slashDraft}
                            onClick={() => void send(draft)}
                          >
                            排队
                          </button>
                          <button
                            type="button"
                            className="agent__send agent__send--stop"
                            aria-label="停止"
                            title="停止"
                            onClick={stop}
                          >
                            <IconStop size={14} />
                          </button>
                        </>
                      ) : busyElsewhere ? (
                        <button
                          type="button"
                          className="agent__queue-btn"
                          disabled={
                            !thread ||
                            Boolean(pending) ||
                            (!draft.trim() && !pendingImage) ||
                            slashDraft
                          }
                          onClick={() => void send(draft)}
                        >
                          排队
                        </button>
                      ) : (
                        <button
                          type="submit"
                          className="agent__send"
                          aria-label="发送"
                          title="发送"
                          disabled={
                            !thread ||
                            Boolean(pending) ||
                            (!draft.trim() && !pendingImage)
                          }
                        >
                          <IconArrowUp size={16} />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </form>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

const MODES: Array<{ id: AgentPermissionMode; label: string; hint: string }> = [
  {
    id: "confirm",
    label: "变更前确认",
    hint: "default / ask — 写入前先问你",
  },
  {
    id: "session_auto",
    label: "本会话自动",
    hint: "auto — 普通写入直接执行，删除仍要确认",
  },
  {
    id: "readonly",
    label: "只读",
    hint: "readonly — 仅允许读取类工具",
  },
];

function ComposerPlusMenu({
  disabled,
  open,
  onOpenChange,
  onInsert,
  onRun,
  onOpenMode,
  onOpenModel,
  onAddImage,
}: {
  disabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInsert: (value: string) => void;
  onRun: (value: string) => void;
  onOpenMode: () => void;
  onOpenModel: () => void;
  onAddImage: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onOpenChange(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onOpenChange(false);
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, onOpenChange]);

  return (
    <div className="agent__composer-plus" ref={rootRef}>
      <button
        type="button"
        className="agent__composer-plus-btn"
        aria-label="添加命令或快捷操作"
        aria-haspopup="menu"
        aria-expanded={open}
        title="添加"
        disabled={disabled}
        onClick={() => onOpenChange(!open)}
      >
        <IconPlus size={16} />
      </button>
      {open ? (
        <div className="agent__thread-menu agent__composer-plus-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => onInsert("/")}>
            插入 /
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onOpenChange(false);
              onAddImage();
            }}
          >
            添加图片
          </button>
          {SLASH_COMMANDS.filter(
            (command) => command.name === "today" || command.name === "brief",
          ).map((command) => (
            <button
              key={command.name}
              type="button"
              role="menuitem"
              onClick={() => onRun(`/${command.name}`)}
            >
              {command.summary}
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onOpenChange(false);
              onOpenMode();
            }}
          >
            切换权限…
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onOpenChange(false);
              onOpenModel();
            }}
          >
            切换模型…
          </button>
          <button type="button" role="menuitem" onClick={() => onRun("/help")}>
            查看命令帮助
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ModeMenu({
  mode,
  disabled = false,
  open,
  onOpenChange,
  onChange,
}: {
  mode: AgentPermissionMode;
  disabled?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (mode: AgentPermissionMode) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const current = MODES.find((item) => item.id === mode) ?? MODES[0]!;

  useEffect(() => {
    if (!open || disabled) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onOpenChange(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onOpenChange(false);
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, disabled, onOpenChange]);

  useEffect(() => {
    if (disabled && open) onOpenChange(false);
  }, [disabled, open, onOpenChange]);

  return (
    <div className="agent__model agent__mode" ref={rootRef}>
      <button
        type="button"
        className="agent__composer-tool"
        aria-label="会话权限"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        title={disabled ? "请先处理待确认操作" : undefined}
        onClick={() => onOpenChange(!open)}
      >
        <IconShield size={14} />
        <span>{current.label}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open && !disabled ? (
        <div
          className="agent__model-menu agent__mode-menu"
          role="dialog"
          aria-label="会话权限"
        >
          <ul>
            {MODES.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={item.id === mode ? "is-active" : undefined}
                  aria-pressed={item.id === mode}
                  onClick={() => {
                    onChange(item.id);
                    onOpenChange(false);
                  }}
                >
                  <span>{item.label}</span>
                  <small>{item.hint}</small>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function ComposerSkillText({
  text,
  tokens,
}: {
  text: string;
  tokens: Array<{ start: number; end: number }>;
}) {
  const parts: Array<{ key: string; skill: boolean; value: string }> = [];
  let cursor = 0;
  tokens.forEach((token, index) => {
    if (token.start > cursor) {
      parts.push({
        key: `t-${cursor}`,
        skill: false,
        value: text.slice(cursor, token.start),
      });
    }
    parts.push({
      key: `s-${index}`,
      skill: true,
      value: text.slice(token.start, token.end),
    });
    cursor = token.end;
  });
  if (cursor < text.length) {
    parts.push({ key: `t-${cursor}`, skill: false, value: text.slice(cursor) });
  }
  return (
    <>
      {parts.map((part) =>
        part.skill ? (
          <mark key={part.key} className="agent__skill-token">
            {part.value}
          </mark>
        ) : (
          <span key={part.key}>{part.value}</span>
        ),
      )}
      {text.endsWith("\n") ? <br /> : null}
    </>
  );
}

function MessageTime({ ms, nowMs }: { ms: number; nowMs: number }) {
  return (
    <time
      className="agent__msg-time"
      dateTime={new Date(ms).toISOString()}
      title={formatAgentMoment(ms, nowMs)}
    >
      {formatAgentBubbleTime(ms, nowMs)}
    </time>
  );
}

function ReplyElapsed({ text }: { text: string }) {
  if (!text) return null;
  return <span className="agent__msg-elapsed">{text}</span>;
}

function replyElapsed(turns: ConversationBlock[], index: number, endMs: number): string {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const turn = turns[cursor];
    if (turn?.kind === "user") return formatReplyElapsed(turn.message.createdAt, endMs);
  }
  return "";
}

function ThinkingStatus({ messages }: { messages: AgentMessage[] }) {
  const start = [...messages].reverse().find((message) => message.role === "user");
  const last = messages[messages.length - 1];
  const toolLabel =
    last?.role === "tool"
      ? toolResultLabel(last.toolName ?? "") || "工具"
      : last?.role === "assistant" && last.toolCallsJson
        ? "工具"
        : "";
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNowMs(Date.now());
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, []);
  const elapsed = start ? formatReplyElapsed(start.createdAt, nowMs) : "";
  return (
    <p className="agent__thinking" aria-live="polite">
      {toolLabel ? `正在使用${toolLabel}…` : "正在思考…"}
      {elapsed ? <span className="agent__msg-time"> {elapsed}</span> : null}
    </p>
  );
}

function AgentMarkdown({
  text,
  query = "",
  indexBase = 0,
  active = -1,
}: {
  text: string;
  query?: string;
  indexBase?: number;
  active?: number;
}) {
  const dialog = useDialog();
  const html = renderChatMarkdown(text);
  return (
    <div
      className="agent__md"
      onClick={(event) => {
        if (copyCodeBlock(event.target)) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        const href = externalHrefFromEvent(event.target);
        if (!href) return;
        event.preventDefault();
        event.stopPropagation();
        if (!(event.ctrlKey || event.metaKey)) return;
        void openExternalUrl(href).catch((err) => {
          void dialog.alert({
            title: "无法打开链接",
            message: errorMessage(err, "无法打开链接"),
          });
        });
      }}
      dangerouslySetInnerHTML={{
        __html: query.trim() ? markHtmlHits(html, query, indexBase, active) : html,
      }}
    />
  );
}

function HighlightedPlain({
  text,
  query,
  indexBase,
  active,
}: {
  text: string;
  query: string;
  indexBase: number;
  active: number;
}) {
  let hit = indexBase;
  return splitHits(text, query).map((part, index) => {
    if (!part.hit) return <span key={index}>{part.text}</span>;
    const id = hit;
    hit += 1;
    return (
      <mark
        key={index}
        className={id === active ? "agent__hit is-current" : "agent__hit"}
        data-find-hit={id}
      >
        {part.text}
      </mark>
    );
  });
}

function slashThreadTitle(command: string): string {
  const name = command.replace(/^\//, "").split(/\s+/)[0]?.toLowerCase() ?? "";
  if (name === "help" || name === "?") return "帮助";
  if (name === "mode") return "权限";
  if (name === "model") return "模型";
  if (name === "today") return "今天";
  if (name === "brief" || name === "晨报") return "晨报";
  return command.slice(0, 18);
}

function atFirstLine(node: HTMLTextAreaElement): boolean {
  const caret = node.selectionStart ?? 0;
  return !node.value.slice(0, caret).includes("\n");
}

function parseArgs(json: string): Record<string, unknown> {
  try {
    const value = JSON.parse(json) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

/** Current task / note fields for approval diffs. Matching ids stay out of the card. */
function approvalBeforeSnapshot(
  store: MemoryWorkbenchRepository,
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> | null {
  if (
    toolName.startsWith("task_") &&
    toolName !== "task_create" &&
    toolName !== "task_add_subtask" &&
    toolName !== "task_list" &&
    toolName !== "task_list_today" &&
    toolName !== "task_get"
  ) {
    const task = resolveTaskSnapshot(store, args);
    if (!task) return null;
    return {
      title: task.title,
      notes: task.notes,
      dueDay: task.dueDay,
      dueWithTime: task.dueWithTime,
      deadlineDay: task.deadlineDay,
      deadlineWithTime: task.deadlineWithTime,
      remindOption: task.remindAt == null ? "none" : undefined,
      timeEstimateMinutes:
        task.timeEstimate > 0 ? Math.round(task.timeEstimate / 60_000) : undefined,
    };
  }
  if (toolName === "note_update" || toolName === "note_delete") {
    const note = resolveNoteSnapshot(store, args);
    if (!note) return null;
    return { title: note.title, bodyMd: note.bodyMd };
  }
  return null;
}

function resolveTaskSnapshot(
  store: MemoryWorkbenchRepository,
  args: Record<string, unknown>,
) {
  const id = typeof args.taskId === "string" ? args.taskId.trim() : "";
  if (id) return store.getTask(id);
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title) return null;
  const tasks = store.listTasks();
  return (
    tasks.find((task) => task.title === title) ??
    tasks.find((task) => task.title.includes(title)) ??
    null
  );
}

function resolveNoteSnapshot(
  store: MemoryWorkbenchRepository,
  args: Record<string, unknown>,
) {
  const id = typeof args.noteId === "string" ? args.noteId.trim() : "";
  if (id) return store.getNote(id);
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title) return null;
  const notes = store.listNotes();
  return (
    notes.find((note) => note.title === title) ??
    notes.find((note) => note.title.includes(title)) ??
    null
  );
}

function queueLength(json: string | null): number {
  if (!json) return 0;
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? value.length : 0;
  } catch {
    return 0;
  }
}

type ConversationBlock =
  | { kind: "user"; message: AgentMessage }
  | { kind: "agent"; messages: AgentMessage[] }
  | { kind: "marker"; message: AgentMessage };

function conversationBlocks(
  messages: AgentMessage[],
  pending: boolean,
): ConversationBlock[] {
  const visible = messages.filter((message, index) => {
    const next = messages[index + 1];
    return !(
      isStatusMessage(message) &&
      (next?.role === "tool" || (pending && index === messages.length - 1))
    );
  });
  const blocks: ConversationBlock[] = [];
  for (const message of visible) {
    if (message.role === "user") {
      blocks.push({ kind: "user", message });
      continue;
    }
    if (message.role === "system") {
      blocks.push({ kind: "marker", message });
      continue;
    }
    const last = blocks[blocks.length - 1];
    if (last?.kind === "agent") last.messages.push(message);
    else blocks.push({ kind: "agent", messages: [message] });
  }
  return blocks;
}

function isStatusMessage(message: AgentMessage): boolean {
  if (message.role !== "assistant") return false;
  const lines = message.content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 && lines.every((line) => /^(正在|准备)/.test(line));
}

function formatContextTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 1000)
    return String(Math.max(0, Math.round(tokens)));
  const kilo = tokens / 1000;
  const text =
    kilo >= 10 ? String(Math.round(kilo)) : kilo.toFixed(1).replace(/\.0$/, "");
  return `${text}k`;
}

function modelRefLabel(ref: string): string {
  const parsed = parseModelRef(ref);
  if (!parsed) return ref;
  const group = modelGroups().find((item) => item.id === parsed.providerId);
  if (!group) return parsed.modelId || ref;
  const model = group.models.find((item) => item.id === parsed.modelId);
  if (group.kind === "builtin" && parsed.modelId === "local") return group.name;
  if (group.kind === "builtin")
    return `${group.name} · ${model?.title || parsed.modelId}`;
  return `${group.name} · ${model?.title || parsed.modelId}`;
}
