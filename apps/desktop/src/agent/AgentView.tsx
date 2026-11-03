import { useEffect, useRef, useState } from "react";
import type { MemoryWorkbenchRepository } from "@wb/db/memory";
import {
  addAgentMemory,
  agentEditPlan,
  agentEmptyGreeting,
  agentRetryPlan,
  applyMention,
  applySlashToken,
  chatProviderFor,
  compactMarkerText,
  estimateTranscriptTokens,
  modelContextBudget,
  filterAgentThreads,
  findSubagent,
  forgetAgentMemory,
  formatAgentBubbleTime,
  formatAgentRelativeShort,
  formatMemoriesForPrompt,
  formatSubagentList,
  DEFAULT_AGENT_WORKSPACE_TITLE,
  describeToolArgs,
  describeToolResult,
  formatAgentMoment,
  groupAgentThreadsByWorkspace,
  manualCompactPlan,
  normalizeAgentWebUrl,
  orderAgentWorkspaceThreads,
  withLocalOcrContext,
  WEB_AGENT_THREAD_TITLE,
  findProvider,
  imageOnlyCaption,
  isLocalBuiltin,
  localOcrReply,
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
  subagentTurnText,
  type AgentCustomCommand,
  type AgentHook,
  type AgentMemory,
  type AgentMessage,
  type AgentPermissionMode,
  type AgentSkill,
  type AgentSubagent,
  type AgentThread,
  type HostToolSnapshot,
  type McpServer,
  type SlashAction,
} from "@wb/domain";
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
  IconFilter,
  IconFolder,
  IconFolderOpen,
  IconGitBranch,
  IconGlobe,
  IconHand,
  IconMore,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconStop,
} from "../shell/icons";
import { readGitBranch } from "../notes/kb-api";
import { ModelMenu } from "./ModelMenu";
import { imageDataUrl } from "./ocr-image";
import { recognizeLocalImage } from "./ocr-engine";
import {
  webSessionClose,
  webSessionEmbedded,
  webSessionHide,
  webSessionReload,
  webSessionShow,
} from "./web-session";
import { modelGroups, readProviderStore, setDefaultModel } from "./providers";
import {
  resumeAgentQueue,
  settleAgentApproval,
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
  onEffects: (effects: AgentUiEffect[]) => void;
  onRefresh: () => void;
};

const EXAMPLES = ["今天有什么", "创建任务 写周报，排到明天并提前15分钟提醒", "晨报"];

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
  onEffects,
  onRefresh,
}: Props) {
  const dialog = useDialog();
  const workspaces = store.listAgentWorkspaces();
  const [showArchived, setShowArchived] = useState(false);
  const threads = store.listAgentThreads({ includeArchived: showArchived });
  const activeThreads = store.listAgentThreads();
  const thread =
    threads.find((item) => item.id === threadId) ??
    activeThreads.find((item) => item.id === threadId) ??
    activeThreads[0] ??
    null;
  const messages = thread ? store.listAgentMessages(thread.id) : [];
  const modelCaps = (() => {
    const ref = thread?.modelRef ?? readProviderStore().defaultModelRef;
    const found = findProvider(readProviderStore().providers, ref);
    return found ? found.provider.models[found.modelId] : undefined;
  })();
  const contextBudget = modelContextBudget(modelCaps?.context, modelCaps?.output);
  const contextUsed = estimateTranscriptTokens(messages, contextBudget);
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
  const [busyThreadId, setBusyThreadId] = useState<string | null>(null);
  const [queues, setQueues] = useState<Record<string, string[]>>({});
  const [queueRev, setQueueRev] = useState(0);
  const [pinned, setPinned] = useState(true);
  const [findOpen, setFindOpen] = useState(false);
  const [webReload, setWebReload] = useState(0);
  const [webSessionError, setWebSessionError] = useState("");
  const [findQuery, setFindQuery] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [threadQuery, setThreadQuery] = useState("");
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Record<string, boolean>>(
    {},
  );
  const [renamingWorkspaceId, setRenamingWorkspaceId] = useState<string | null>(null);
  const [workspaceTitleDraft, setWorkspaceTitleDraft] = useState("");
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  const [threadTitleDraft, setThreadTitleDraft] = useState("");
  const [workspaceMenuId, setWorkspaceMenuId] = useState<string | null>(null);
  const [threadMenuId, setThreadMenuId] = useState<string | null>(null);
  const [findIndex, setFindIndex] = useState(0);
  const [findTick, setFindTick] = useState(0);
  const [error, setError] = useState("");
  const [picker, setPicker] = useState<null | "mode" | "model" | "plus" | "workspace">(
    null,
  );
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
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
  const draining = useRef(false);
  const sendPromptRef = useRef<(content: string) => Promise<boolean>>(async () => false);
  const [copied, setCopied] = useState<string | null>(null);
  const [slashUi, setSlashUi] = useState({ draft: "", dismissed: false, index: 0 });
  const mounted = useRef(true);
  const sending = useRef(false);
  const busyHere = Boolean(thread && busyThreadId === thread.id);
  const findOpenRef = useRef(false);
  const webSessionRef = useRef(false);
  const webHostRef = useRef<HTMLDivElement>(null);
  const webCoveredRef = useRef(false);
  const webSyncRef = useRef<() => void>(() => {});
  webSessionRef.current = Boolean(thread?.webUrl);
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
    if (!threadMenuId && !workspaceMenuId && !viewMenuOpen && picker !== "workspace") {
      return;
    }
    const onPointer = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".agent__thread-actions")) return;
      if (target?.closest(".agent__workspace-actions")) return;
      if (target?.closest(".agent__threads-tool")) return;
      if (target?.closest(".agent__composer-chip-wrap")) return;
      setThreadMenuId(null);
      setWorkspaceMenuId(null);
      setViewMenuOpen(false);
      if (picker === "workspace") setPicker(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setThreadMenuId(null);
        setWorkspaceMenuId(null);
        setViewMenuOpen(false);
        if (picker === "workspace") setPicker(null);
      }
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [threadMenuId, workspaceMenuId, viewMenuOpen, picker]);

  useEffect(() => {
    const node = logRef.current;
    if (node && stickRef.current) node.scrollTop = node.scrollHeight;
  }, [messages.length, live, pending?.id]);

  if ((thread?.id ?? "") !== draftThreadId) {
    setDraftThreadId(thread?.id ?? "");
    setDraft(thread?.id ? (drafts.current.get(thread.id) ?? "") : "");
    setPicker(null);
    setRenaming(false);
    setLive("");
    setError("");
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
    const url = thread?.webUrl ?? "";
    const sync = () => {
      if (webCoveredRef.current) return;
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
      }).then(
        () => setWebSessionError(""),
        (err) => setWebSessionError(errorMessage(err, "无法打开网页")),
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
  }, [thread?.webUrl]);

  useEffect(() => {
    if (!thread || busyThreadId || pending || sending.current || draining.current) return;
    if (wantDrain.current !== thread.id) return;
    const next = (queuesRef.current[thread.id] ?? [])[0];
    if (!next) {
      wantDrain.current = null;
      return;
    }
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
  }, [busyThreadId, pending, thread?.id, queueRev]);

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
      timer: { taskId: activeTimerTaskId, startedAt: timerStartedAt },
      workspaceTitle: store.getAgentWorkspace(thread.workspaceId)?.title,
      workspacePath:
        store.getAgentWorkspace(thread.workspaceId)?.rootPath ??
        workspaces.find((item) => item.id === thread.workspaceId)?.rootPath,
      gitBranch,
      focus,
      onStep: onRefresh,
      onDelta: (text) => {
        if (mounted.current && viewingThreadId.current === thread.id) setLive(text);
      },
    };
  };

  const finish = (effects: AgentUiEffect[]) => {
    refocus.current = true;
    if (mounted.current) {
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
    if (isRemoteModel(thread.modelRef)) setBusyThreadId(thread.id);
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
  ): Promise<boolean> => {
    const current = env();
    if (!current || sending.current || busyThreadId || pending) return false;
    sending.current = true;
    stickRef.current = true;
    setPinned(true);
    setError("");
    const controller = new AbortController();
    stopRef.current = controller;
    if (isRemoteModel(thread?.modelRef)) setBusyThreadId(current.threadId);
    try {
      const result = await startAgentTurn(
        {
          ...current,
          imageDataUrl,
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
      if (
        !controller.signal.aborted &&
        (queuesRef.current[current.threadId] ?? []).length > 0
      ) {
        wantDrain.current = current.threadId;
        setQueueRev((rev) => rev + 1);
      }
      return true;
    } catch (caught) {
      if (mounted.current) {
        setBusyThreadId(null);
        if (!controller.signal.aborted) {
          setError(caught instanceof Error ? caught.message : "发送失败");
        }
      }
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
    if (provider && modelCanSeeImages(provider.kind, caps)) {
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
    const recognized = await recognizeLocalImage(shot.blob);
    if (recognized.ok === false) {
      const now = Date.now();
      store.appendAgentMessage({
        threadId: thread.id,
        role: "user",
        content: content
          ? `${content}\n\n${imageOnlyCaption(shot.name)}`
          : imageOnlyCaption(shot.name),
        nowMs: now,
      });
      store.appendAgentMessage({
        threadId: thread.id,
        role: "assistant",
        content: `本地识图失败：${recognized.message}`,
        nowMs: now,
      });
      if (!recognized.message.includes("桌面应用")) {
        store.pushNotification({
          kind: "system",
          title:
            recognized.message.includes("下载") || recognized.message.includes("配置目录")
              ? "识图模型下载失败"
              : "本地识图失败",
          body: recognized.message,
        });
      }
      onRefresh();
      return;
    }
    const local = !found || isLocalBuiltin(found.provider, found.modelId);
    if (!content || local) {
      const now = Date.now();
      store.appendAgentMessage({
        threadId: thread.id,
        role: "user",
        content: content
          ? `${content}\n\n${imageOnlyCaption(shot.name)}`
          : imageOnlyCaption(shot.name),
        nowMs: now,
      });
      store.appendAgentMessage({
        threadId: thread.id,
        role: "assistant",
        content: localOcrReply(recognized.lines),
        nowMs: now,
      });
      onRefresh();
      return;
    }
    await sendPrompt(withLocalOcrContext(content, recognized.lines));
  };

  const send = async (text: string) => {
    const content = text.trim();
    const shot = pendingImage;
    if ((!content && !shot) || !thread) return;
    if (busyThreadId && busyThreadId !== thread.id) {
      setError("另一个会话还在回答");
      return;
    }
    const action = content
      ? resolveSlash(content, thread.permissionMode, commands)
      : null;
    if (shot && action) {
      setError("命令不能和图片一起发送");
      return;
    }
    if (busyHere) {
      if (shot) {
        setError("请等当前回答结束后再发送图片");
        return;
      }
      if (action) {
        setError("请等当前回答结束后再使用命令");
        return;
      }
      takeDraft(content);
      setQueues((current) => ({
        ...current,
        [thread.id]: enqueuePrompt(current[thread.id] ?? [], content),
      }));
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
    const action = resolveSlash(plan.text, thread.permissionMode, commands);
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
    wantDrain.current = thread.id;
    setQueueRev((rev) => rev + 1);
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
    placeCaret.current = true;
    setDraft(recalled.draft);
    drafts.current.set(thread.id, recalled.draft);
    inputRef.current?.focus();
  };

  const removeQueued = (index: number) => {
    if (!thread) return;
    setQueues((current) => ({
      ...current,
      [thread.id]: removeQueuedPrompt(current[thread.id] ?? [], index),
    }));
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
    sending.current = true;
    if (isRemoteModel(thread?.modelRef)) setBusyThreadId(current.threadId);
    setError("");
    try {
      const result = await settleAgentApproval(current, decision);
      finish(result.effects);
      if ((queuesRef.current[current.threadId] ?? []).length > 0) {
        wantDrain.current = current.threadId;
        setQueueRev((rev) => rev + 1);
      }
    } catch (caught) {
      if (mounted.current) {
        setBusyThreadId(null);
        setError(caught instanceof Error ? caught.message : "审批失败");
      }
    } finally {
      sending.current = false;
    }
  };
  decideRef.current = (decision) => {
    void decide(decision);
  };

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
    if (wantDrain.current === id) wantDrain.current = null;
  };

  const removeThread = async (id: string, title: string) => {
    const ok = await dialog.confirm({
      title: "删除会话",
      message: `删除会话「${title}」？对话会从本机移除。`,
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    store.deleteAgentThread(id);
    forgetThreadLocal(id);
    setThreadMenuId(null);
    if (thread?.id === id) {
      onSelectThread(store.listAgentThreads()[0]?.id ?? null);
    }
    onRefresh();
  };

  const archiveThread = (item: AgentThread) => {
    store.archiveAgentThread(item.id);
    forgetThreadLocal(item.id);
    setThreadMenuId(null);
    if (thread?.id === item.id && !showArchived) {
      onSelectThread(store.listAgentThreads()[0]?.id ?? null);
    }
    onRefresh();
  };

  const unarchiveThread = (item: AgentThread) => {
    store.unarchiveAgentThread(item.id);
    setThreadMenuId(null);
    onRefresh();
  };

  const beginRenameThread = (item: AgentThread) => {
    setThreadMenuId(null);
    setWorkspaceMenuId(null);
    setRenamingThreadId(item.id);
    setThreadTitleDraft(item.title);
  };

  const beginRenameWorkspace = (id: string, title: string) => {
    setWorkspaceMenuId(null);
    setThreadMenuId(null);
    setRenamingWorkspaceId(id);
    setWorkspaceTitleDraft(title);
  };

  const commitThreadTitle = (id: string, raw: string) => {
    const next = raw.trim();
    const current = store.getAgentThread(id);
    setRenamingThreadId(null);
    if (!current) return;
    if (!next || next === current.title) return;
    store.updateAgentThread(id, { title: next });
    onRefresh();
  };

  const commitWorkspaceTitle = (id: string, raw: string) => {
    const next = raw.trim();
    const current = store.getAgentWorkspace(id);
    if (!current) {
      setRenamingWorkspaceId(null);
      return;
    }
    if (next && next !== current.title) {
      store.updateAgentWorkspace(id, { title: next });
      onRefresh();
    }
    setRenamingWorkspaceId(null);
  };

  const removeWorkspace = async (id: string, title: string, count: number) => {
    const hint =
      count > 0
        ? `删除工作区「${title}」？其中的 ${count} 个会话也会从本机移除。`
        : `删除工作区「${title}」？`;
    const ok = await dialog.confirm({
      title: "删除工作区",
      message: hint,
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    const selected = thread?.workspaceId === id ? thread.id : null;
    store.deleteAgentWorkspace(id);
    setWorkspaceMenuId(null);
    setCollapsedWorkspaces((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    if (selected) {
      onSelectThread(store.listAgentThreads()[0]?.id ?? null);
    }
    onRefresh();
  };

  const mode = thread?.permissionMode ?? "confirm";
  const suggestions = slashSuggestions(draft, commands);
  const skillHits = slashSkillSuggestions(draft, skills);
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
  const mentionItems = mentionSuggestions(draft, [
    ...skills.map((skill) => ({
      kind: "skill" as const,
      name: skill.name,
      summary: skill.description,
    })),
    ...subagents.map((agent) => ({
      kind: "subagent" as const,
      name: agent.name,
      summary: agent.description,
    })),
  ]);
  const showMention =
    !showSlash && mentionQuery(draft) != null && mentionItems.length > 0;
  const mentionPick = Math.min(slashUi.index, Math.max(mentionItems.length - 1, 0));
  const nowMs = Date.now();
  const turns = conversationBlocks(messages, Boolean(pending));
  const blockTexts = turns.map((turn) =>
    turn.kind === "agent"
      ? turn.messages
          .map((message) => displayContent(message, nowMs))
          .filter(Boolean)
          .join("\n\n")
      : turn.message.content,
  );
  const findNeedle = findOpen ? findQuery : "";
  let findCursor = 0;
  const findBases = blockTexts.map((text, index) => {
    const base = findCursor;
    const turn = turns[index];
    findCursor += !findNeedle.trim()
      ? 0
      : turn?.kind === "agent"
        ? htmlTextHitCount(renderChatMarkdown(text), findNeedle)
        : literalHitCount(text, findNeedle);
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
  const slashDraft = Boolean(
    thread && draft.trim() && resolveSlash(draft.trim(), thread.permissionMode, commands),
  );
  const argLines = pending ? describeToolArgs(parseArgs(pending.argsJson), nowMs) : "";
  const needle = threadQuery.trim().toLowerCase();
  const visibleThreads = filterAgentThreads(threads, threadQuery);
  const workspaceGroups = groupAgentThreadsByWorkspace(workspaces, visibleThreads)
    .map((group) => ({
      ...group,
      titleHit: needle ? group.workspace.title.toLowerCase().includes(needle) : false,
    }))
    .filter((group) => !needle || group.titleHit || group.threads.length > 0);
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
  const openWebSession = async () => {
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
    setCollapsedWorkspaces((current) => ({ ...current, [workspace.id]: false }));
    onSelectThread(created.id);
    onRefresh();
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

  return (
    <section className="agent" aria-label="Agent">
      <aside className="agent__threads">
        <header className="agent__threads-head">
          <h1>工作区</h1>
          <div className="agent__threads-tools">
            <button
              type="button"
              className={
                filterOpen || threadQuery.trim()
                  ? "agent__threads-tool is-on"
                  : "agent__threads-tool"
              }
              title="筛选"
              aria-label="筛选会话或工作区"
              aria-pressed={filterOpen}
              onClick={() => {
                setFilterOpen((value) => !value);
                setViewMenuOpen(false);
              }}
            >
              <IconSearch size={14} />
            </button>
            <div className="agent__threads-tool-wrap">
              <button
                type="button"
                className={
                  showArchived || viewMenuOpen
                    ? "agent__threads-tool is-on"
                    : "agent__threads-tool"
                }
                title="视图"
                aria-label="视图选项"
                aria-haspopup="menu"
                aria-expanded={viewMenuOpen}
                onClick={() => {
                  setViewMenuOpen((value) => !value);
                  setWorkspaceMenuId(null);
                  setThreadMenuId(null);
                }}
              >
                <IconFilter size={14} />
              </button>
              {viewMenuOpen ? (
                <div className="agent__thread-menu" role="menu" aria-label="视图选项">
                  <button
                    type="button"
                    role="menuitem"
                    aria-checked={showArchived}
                    onClick={() => {
                      setShowArchived((value) => !value);
                      setViewMenuOpen(false);
                    }}
                  >
                    {showArchived ? "隐藏已归档" : "显示已归档"}
                  </button>
                </div>
              ) : null}
            </div>
            <button
              type="button"
              className="agent__threads-tool agent__threads-tool--text"
              title="打开网页"
              aria-label="网页"
              onClick={() => void openWebSession()}
            >
              <IconGlobe size={14} />
              <span>网页</span>
            </button>
            <button
              type="button"
              className="agent__threads-tool"
              title="选择文件夹并新建会话"
              aria-label="新建会话"
              onClick={onCreateFromFolder}
            >
              <IconPlus size={14} />
            </button>
          </div>
        </header>
        {filterOpen || threadQuery.trim() ? (
          <label className="agent__thread-filter">
            <input
              aria-label="筛选会话"
              placeholder="筛选会话或工作区"
              value={threadQuery}
              autoFocus={filterOpen}
              onChange={(event) => setThreadQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setThreadQuery("");
                  setFilterOpen(false);
                }
              }}
            />
          </label>
        ) : null}
        {workspaces.length === 0 ? (
          <p className="agent__hint">还没有工作区。点「+」选择一个文件夹。</p>
        ) : workspaceGroups.length === 0 ? (
          <p className="agent__hint">没有匹配的会话。</p>
        ) : (
          <div className="agent__thread-list">
            {workspaceGroups.map(({ workspace, threads: items, titleHit }) => {
              const collapsed =
                !needle &&
                !titleHit &&
                collapsedWorkspaces[workspace.id] === true &&
                thread?.workspaceId !== workspace.id;
              const totalCount = store.listAgentThreads({
                workspaceId: workspace.id,
                includeArchived: true,
              }).length;
              const workspaceMenuOpen = workspaceMenuId === workspace.id;
              return (
                <section
                  key={workspace.id}
                  className="agent__workspace"
                  aria-label={workspace.title}
                >
                  <div
                    className={
                      workspaceMenuOpen
                        ? "agent__workspace-head is-open"
                        : "agent__workspace-head"
                    }
                  >
                    {renamingWorkspaceId === workspace.id ? (
                      <input
                        className="agent__workspace-title-input"
                        aria-label="工作区名称"
                        value={workspaceTitleDraft}
                        autoFocus
                        maxLength={40}
                        onChange={(event) => setWorkspaceTitleDraft(event.target.value)}
                        onBlur={(event) =>
                          commitWorkspaceTitle(workspace.id, event.currentTarget.value)
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            commitWorkspaceTitle(workspace.id, event.currentTarget.value);
                          } else if (event.key === "Escape") {
                            event.preventDefault();
                            setRenamingWorkspaceId(null);
                          }
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        className="agent__workspace-title"
                        title={workspace.rootPath || workspace.title}
                        aria-expanded={!collapsed}
                        onClick={() =>
                          setCollapsedWorkspaces((current) => ({
                            ...current,
                            [workspace.id]: !collapsed,
                          }))
                        }
                      >
                        <span className="agent__workspace-icon" aria-hidden="true">
                          {collapsed ? (
                            <IconFolder size={14} />
                          ) : (
                            <IconFolderOpen size={14} />
                          )}
                        </span>
                        <span className="agent__workspace-name">{workspace.title}</span>
                      </button>
                    )}
                    <div className="agent__workspace-actions">
                      <button
                        type="button"
                        className="agent__workspace-action"
                        title="更多"
                        aria-label={`工作区操作 ${workspace.title}`}
                        aria-haspopup="menu"
                        aria-expanded={workspaceMenuOpen}
                        onClick={() => {
                          setWorkspaceMenuId(workspaceMenuOpen ? null : workspace.id);
                          setThreadMenuId(null);
                          setViewMenuOpen(false);
                        }}
                      >
                        <IconMore size={14} />
                      </button>
                      <button
                        type="button"
                        className="agent__workspace-action"
                        title="在此工作区新建会话"
                        aria-label={`在 ${workspace.title} 新建会话`}
                        onClick={() => onCreateThread(workspace.id)}
                      >
                        <IconPlus size={14} />
                      </button>
                      {workspaceMenuOpen ? (
                        <div
                          className="agent__thread-menu"
                          role="menu"
                          aria-label={`工作区「${workspace.title}」`}
                        >
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() =>
                              beginRenameWorkspace(workspace.id, workspace.title)
                            }
                          >
                            重命名
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="is-danger"
                            onClick={() =>
                              void removeWorkspace(
                                workspace.id,
                                workspace.title,
                                totalCount,
                              )
                            }
                          >
                            删除
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                  {collapsed ? null : items.length === 0 ? (
                    <p className="agent__workspace-empty">还没有会话</p>
                  ) : (
                    <ul className="agent__workspace-threads">
                      {orderAgentWorkspaceThreads(
                        items,
                        workspace.title === DEFAULT_AGENT_WORKSPACE_TITLE,
                      ).map((item) => {
                        const archived = item.archivedAt != null;
                        const menuOpen = threadMenuId === item.id;
                        const age = formatAgentRelativeShort(item.updatedAt, nowMs);
                        return (
                          <li
                            key={item.id}
                            className={
                              menuOpen ? "agent__thread-row is-open" : "agent__thread-row"
                            }
                          >
                            {renamingThreadId === item.id ? (
                              <input
                                className="agent__thread-title-input"
                                aria-label="会话标题"
                                value={threadTitleDraft}
                                autoFocus
                                maxLength={40}
                                onChange={(event) =>
                                  setThreadTitleDraft(event.target.value)
                                }
                                onBlur={(event) =>
                                  commitThreadTitle(item.id, event.currentTarget.value)
                                }
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") {
                                    event.preventDefault();
                                    commitThreadTitle(item.id, event.currentTarget.value);
                                  } else if (event.key === "Escape") {
                                    event.preventDefault();
                                    setRenamingThreadId(null);
                                  }
                                }}
                              />
                            ) : (
                              <button
                                type="button"
                                className={
                                  thread?.id === item.id
                                    ? "agent__thread is-active"
                                    : "agent__thread"
                                }
                                title={item.webUrl || undefined}
                                onClick={() => onSelectThread(item.id)}
                              >
                                <span className="agent__thread-title">
                                  {archived ? "〔归档〕 " : ""}
                                  {item.title}
                                </span>
                                <span className="agent__thread-age">{age}</span>
                              </button>
                            )}
                            <div className="agent__thread-actions">
                              {renamingThreadId === item.id ? null : (
                                <button
                                  type="button"
                                  className="agent__thread-rename"
                                  aria-label={`重命名会话 ${item.title}`}
                                  title="重命名"
                                  onClick={() => beginRenameThread(item)}
                                >
                                  <IconPencil size={14} />
                                </button>
                              )}
                              <button
                                type="button"
                                className="agent__thread-menu-btn"
                                aria-label={`会话操作 ${item.title}`}
                                aria-haspopup="menu"
                                aria-expanded={menuOpen}
                                title="更多"
                                onClick={() => {
                                  setThreadMenuId(menuOpen ? null : item.id);
                                  setWorkspaceMenuId(null);
                                  setViewMenuOpen(false);
                                }}
                              >
                                <IconMore size={14} />
                              </button>
                              {menuOpen ? (
                                <div
                                  className="agent__thread-menu"
                                  role="menu"
                                  aria-label={`会话「${item.title}」`}
                                >
                                  {archived ? (
                                    <button
                                      type="button"
                                      role="menuitem"
                                      onClick={() => unarchiveThread(item)}
                                    >
                                      取消归档
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      role="menuitem"
                                      onClick={() => archiveThread(item)}
                                    >
                                      归档
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    role="menuitem"
                                    className="is-danger"
                                    onClick={() => void removeThread(item.id, item.title)}
                                  >
                                    删除
                                  </button>
                                </div>
                              ) : null}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </aside>

      <div className="agent__main">
        {thread?.webUrl ? (
          <div className="agent__web-frame">
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
        ) : thread ? (
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
              <button
                type="button"
                className="agent__title agent__title-btn"
                title="重命名会话"
                onClick={() => {
                  ignoreTitleBlur.current = false;
                  setTitleDraft(thread.title);
                  setRenaming(true);
                }}
              >
                {thread.title}
              </button>
            )}
            <button
              type="button"
              className="agent__chrome-action"
              title="在会话中查找（Ctrl+F）"
              onClick={() => {
                setFindOpen(true);
                setFindTick((tick) => tick + 1);
              }}
            >
              查找
            </button>
          </header>
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
                aria-live="polite"
                onScroll={(event) => {
                  const node = event.currentTarget;
                  const next =
                    node.scrollHeight - node.scrollTop - node.clientHeight < 48;
                  stickRef.current = next;
                  setPinned((current) => (current === next ? current : next));
                }}
              >
                <div className="agent__log-body">
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
                    turns.map((turn, index) => {
                      const findBase = findBases[index] ?? 0;
                      if (turn.kind === "marker") {
                        return (
                          <p
                            key={turn.message.id}
                            className="agent__marker"
                            role="status"
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
                      const text = turn.messages
                        .map((message) => displayContent(message, nowMs))
                        .filter(Boolean)
                        .join("\n\n");
                      if (!text) return null;
                      const id = turn.messages[0]!.id;
                      const stamp = turn.messages[turn.messages.length - 1]!.createdAt;
                      return (
                        <article
                          key={id}
                          className="agent__msg agent__msg--assistant"
                          aria-label="Agent"
                        >
                          <AgentMarkdown
                            text={text}
                            query={findNeedle}
                            indexBase={findBase}
                            active={activeHit}
                          />
                          <div className="agent__msg-actions">
                            <MessageTime ms={stamp} nowMs={nowMs} />
                            <button
                              type="button"
                              className="agent__copy"
                              onClick={() => void copyReply(id, text)}
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
                    })
                  )}
                  {live ? (
                    <article
                      className="agent__msg agent__msg--assistant"
                      aria-label="Agent"
                    >
                      <AgentMarkdown text={live} />
                    </article>
                  ) : null}
                  {busyHere && !live ? (
                    <p className="agent__thinking" aria-live="polite">
                      正在思考…
                    </p>
                  ) : null}
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
              {pending ? (
                <div className="agent__approval" role="region" aria-label="待确认操作">
                  <div>
                    <strong>需要确认</strong>
                    <p>{relativizeScheduleText(pending.summary, nowMs)}</p>
                    {queued > 1 ? <p>后面还有 {queued - 1} 步。</p> : null}
                  </div>
                  {argLines ? (
                    <details className="agent__approval-more">
                      <summary>详情</summary>
                      <p className="agent__approval-detail">{argLines}</p>
                    </details>
                  ) : null}
                  <div className="agent__approval-actions">
                    <button
                      ref={approveBtnRef}
                      type="button"
                      className="primary"
                      disabled={Boolean(busyThreadId)}
                      onClick={() => void decide("approved")}
                    >
                      批准
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={Boolean(busyThreadId)}
                      onClick={() => void decide("denied")}
                    >
                      拒绝
                    </button>
                    <span className="agent__approval-hint">Enter 批准 · Esc 拒绝</span>
                  </div>
                </div>
              ) : null}

              {error ? <p className="agent__error">{error}</p> : null}

              {queuedPrompts.length > 0 ? (
                <div className="agent__outbox" aria-label="排队消息">
                  <div className="agent__outbox-head">
                    <span>排队 {queuedPrompts.length}</span>
                    {!busyHere && !pending ? (
                      <button type="button" className="btn" onClick={releaseQueue}>
                        继续发送
                      </button>
                    ) : null}
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
                    insertComposerText(applySlashToken(draft, `@${picked.name}`));
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
                    <ul className="agent__slash" aria-label="斜杠命令">
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
                                  applySlashToken(draft, `@${row.name}`),
                                );
                                return;
                              }
                              void send(`/${row.name}`);
                            }}
                          >
                            <span>
                              {row.kind === "skill" ? `@${row.name}` : `/${row.name}`}
                            </span>
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
                    <ul className="agent__slash" aria-label="提及">
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
                            <small>
                              {item.kind === "skill" ? "技能" : "子智能体"} ·{" "}
                              {item.summary}
                            </small>
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
                  <textarea
                    ref={inputRef}
                    aria-label="给 Agent 发消息"
                    placeholder={
                      busyHere
                        ? "这条会排在当前回答之后"
                        : pending
                          ? "请先处理待确认操作"
                          : "向工作台提问，使用 / 选择命令或能力"
                    }
                    title={
                      pending
                        ? "Enter 批准 · Esc 拒绝"
                        : busyHere
                          ? "Enter 把这条排到当前回答之后"
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
                    onChange={(event) => {
                      historyNav.current = null;
                      const value = event.target.value;
                      setDraft(value);
                      if (thread) drafts.current.set(thread.id, value);
                    }}
                    onKeyDown={(event) => {
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
                          applySlashToken(
                            draft,
                            row.kind === "skill" ? `@${row.name}` : `/${row.name}`,
                          ),
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
                      if (showMention && (event.key === "Tab" || event.key === "Enter")) {
                        event.preventDefault();
                        const picked = mentionItems[mentionPick];
                        if (picked) insertComposerText(applyMention(draft, picked.name));
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
                          insertComposerText(applySlashToken(draft, `@${picked.name}`));
                          return;
                        }
                        void send(picked ? `/${picked.name}` : draft);
                      }
                    }}
                  />
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
                      {thread ? (
                        <span
                          className={
                            contextUsed / contextBudget >= 0.85
                              ? "agent__context-usage is-tight"
                              : "agent__context-usage"
                          }
                          title="发给模型的上下文估计。接近上限时会先清空较早的工具结果，再压缩更早的对话。"
                        >
                          上下文 {formatContextTokens(contextUsed)}/
                          {formatContextTokens(contextBudget)}
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
  { id: "confirm", label: "变更前确认", hint: "写入前先问你" },
  { id: "session_auto", label: "本会话自动", hint: "普通写入直接执行，删除仍要确认" },
  { id: "readonly", label: "只读", hint: "不能修改任务、笔记和项目" },
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
        <IconHand size={14} />
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

function displayContent(message: AgentMessage, nowMs: number): string {
  let text = message.content;
  if (message.role === "tool") {
    const splitAt = text.indexOf("\n");
    if (splitAt >= 0) {
      const summary = text.slice(0, splitAt);
      const rest = text.slice(splitAt + 1).trim();
      if (rest.startsWith("{")) {
        try {
          text = describeToolResult(message.toolName ?? "", JSON.parse(rest), summary);
        } catch {
          text = message.content;
        }
      }
    }
  }
  if (message.role === "user") return text;
  return relativizeScheduleText(text, nowMs);
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

function isRemoteModel(modelRef: string | undefined): boolean {
  if (!modelRef) return false;
  if (!modelRef.startsWith("builtin:")) return true;
  const found = findProvider(readProviderStore().providers, modelRef);
  return Boolean(found?.provider.models[found.modelId]?.endpoint);
}
