import { useEffect, useRef, useState } from "react";
import type { MemoryWorkbenchRepository } from "@wb/db/memory";
import {
  agentEmptyGreeting,
  agentRetryPlan,
  describeToolArgs,
  describeToolResult,
  formatAgentMoment,
  permissionModeLabel,
  relativizeScheduleText,
  resolveSlash,
  slashSuggestions,
  type AgentMessage,
  type AgentPermissionMode,
  type SlashAction,
} from "@wb/domain";
import { readCredential } from "./credentials";
import type { AgentUiEffect } from "./execute";
import { htmlTextHitCount, literalHitCount, markHtmlHits, splitHits } from "./find-text";
import { readInputHistory, rememberInput } from "./input-history";
import { enqueuePrompt, recallQueuedPrompt, removeQueuedPrompt } from "./prompt-queue";
import { renderChatMarkdown } from "../lib/markdown";
import { ModelMenu } from "./ModelMenu";
import { modelGroups, readProviderStore } from "./providers";
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
  activeTimerTaskId: string | null;
  timerStartedAt: number | null;
  onSelectThread: (id: string | null) => void;
  onCreateThread: () => void;
  onOpenModels: () => void;
  onEffects: (effects: AgentUiEffect[]) => void;
  onRefresh: () => void;
};

const EXAMPLES = ["今天有什么", "创建任务 写周报，排到明天并提前15分钟提醒", "晨报"];

export function AgentView({
  store,
  threadId,
  displayName,
  activeTimerTaskId,
  timerStartedAt,
  onSelectThread,
  onCreateThread,
  onOpenModels,
  onEffects,
  onRefresh,
}: Props) {
  const threads = store.listAgentThreads();
  const thread = threads.find((item) => item.id === threadId) ?? threads[0] ?? null;
  const messages = thread ? store.listAgentMessages(thread.id) : [];
  const pending = thread
    ? (store.listAgentApprovals(thread.id).find((item) => item.status === "pending") ??
      null)
    : null;
  const [draftThreadId, setDraftThreadId] = useState(thread?.id ?? "");
  const [draft, setDraft] = useState("");
  const [live, setLive] = useState("");
  const [busyThreadId, setBusyThreadId] = useState<string | null>(null);
  const [queues, setQueues] = useState<Record<string, string[]>>({});
  const [queueRev, setQueueRev] = useState(0);
  const [pinned, setPinned] = useState(true);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findIndex, setFindIndex] = useState(0);
  const [findTick, setFindTick] = useState(0);
  const [error, setError] = useState("");
  const [picker, setPicker] = useState<null | "mode" | "model">(null);
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
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
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "SELECT" || tag === "TEXTAREA" || tag === "INPUT") return;
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
    if (!findOpen) return;
    findInputRef.current?.focus();
    findInputRef.current?.select();
  }, [findOpen, findTick]);

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
      timer: { taskId: activeTimerTaskId, startedAt: timerStartedAt },
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

  const sendPrompt = async (content: string): Promise<boolean> => {
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
        { ...current, signal: controller.signal },
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
      onCreateThread();
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
    say(command, action.text);
  };

  const send = async (text: string) => {
    const content = text.trim();
    if (!content || !thread) return;
    if (busyThreadId && busyThreadId !== thread.id) {
      setError("另一个会话还在回答");
      return;
    }
    const action = resolveSlash(content, thread.permissionMode);
    if (busyHere) {
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
    await sendPrompt(content);
  };

  const retryLast = () => {
    if (!thread || busyThreadId || pending || sending.current) return;
    const plan = agentRetryPlan(store.listAgentMessages(thread.id));
    if (!plan) return;
    const action = resolveSlash(plan.text, thread.permissionMode);
    store.deleteAgentMessagesFrom(thread.id, plan.userMessageId);
    onRefresh();
    if (action) {
      runSlash(action, plan.text);
      return;
    }
    void sendPrompt(plan.text);
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

  const removeThread = (id: string, title: string) => {
    if (!window.confirm(`删除会话「${title}」？对话会从本机移除。`)) return;
    store.deleteAgentThread(id);
    setQueues((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    if (wantDrain.current === id) wantDrain.current = null;
    if (thread?.id === id) {
      onSelectThread(store.listAgentThreads()[0]?.id ?? null);
    }
    onRefresh();
  };

  const mode = thread?.permissionMode ?? "confirm";
  const suggestions = slashSuggestions(draft);
  const showSlash = !slashUi.dismissed && !busyHere && suggestions.length > 0;
  const slashPick = Math.min(slashUi.index, Math.max(suggestions.length - 1, 0));
  const nowMs = Date.now();
  const turns = conversationBlocks(messages, Boolean(pending));
  const blockTexts = turns.map((turn) =>
    turn.kind === "user"
      ? turn.message.content
      : turn.messages
          .map((message) => displayContent(message, nowMs))
          .filter(Boolean)
          .join("\n\n"),
  );
  const findNeedle = findOpen ? findQuery : "";
  let findCursor = 0;
  const findBases = blockTexts.map((text, index) => {
    const base = findCursor;
    const turn = turns[index];
    findCursor += !findNeedle.trim()
      ? 0
      : turn?.kind === "user"
        ? literalHitCount(text, findNeedle)
        : htmlTextHitCount(renderChatMarkdown(text), findNeedle);
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
  const lastAgentId = [...turns].reverse().find((turn) => turn.kind === "agent")
    ?.messages[0]?.id;
  const queued = queueLength(thread?.queueJson ?? null);
  const queuedPrompts = thread ? (queues[thread.id] ?? []) : [];
  const slashDraft = Boolean(
    thread && draft.trim() && resolveSlash(draft.trim(), thread.permissionMode),
  );
  const argLines = pending ? describeToolArgs(parseArgs(pending.argsJson), nowMs) : "";

  return (
    <section className="agent" aria-label="Agent">
      <aside className="agent__threads">
        <header className="agent__threads-head">
          <h1>会话</h1>
          <button type="button" className="btn" onClick={onCreateThread}>
            新建
          </button>
        </header>
        {threads.length === 0 ? (
          <p className="agent__hint">还没有会话。</p>
        ) : (
          <ul className="agent__thread-list">
            {threads.map((item) => (
              <li key={item.id} className="agent__thread-row">
                <button
                  type="button"
                  className={
                    thread?.id === item.id ? "agent__thread is-active" : "agent__thread"
                  }
                  onClick={() => onSelectThread(item.id)}
                >
                  <span>{item.title}</span>
                  <small>
                    {permissionModeLabel(item.permissionMode)} ·{" "}
                    {formatAgentMoment(item.updatedAt, nowMs)}
                  </small>
                </button>
                <button
                  type="button"
                  className="agent__thread-delete"
                  aria-label={`删除会话 ${item.title}`}
                  title="删除会话"
                  onClick={() => removeThread(item.id, item.title)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <div className="agent__main">
        {thread ? (
          <header className="agent__bar">
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
              className="btn"
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

        <div className="agent__log-wrap">
          <div
            className="agent__log"
            ref={logRef}
            aria-live="polite"
            onScroll={(event) => {
              const node = event.currentTarget;
              const next = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
              stickRef.current = next;
              setPinned((current) => (current === next ? current : next));
            }}
          >
            <div className="agent__log-body">
              {!thread ? (
                <div className="agent__empty">
                  <p>用自然语言管理任务、笔记和提醒。</p>
                  <button type="button" className="primary" onClick={onCreateThread}>
                    新建会话
                  </button>
                </div>
              ) : messages.length === 0 ? (
                <div className="agent__empty">
                  <p className="agent__greeting">
                    {agentEmptyGreeting(new Date().getHours())}
                  </p>
                  <p>
                    未配置外部模型时，使用本机工作台理解常用指令。写操作默认需要确认。
                  </p>
                  <div className="agent__examples">
                    {EXAMPLES.map((example) => (
                      <button
                        key={example}
                        type="button"
                        className="btn"
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
                  if (turn.kind === "user") {
                    return (
                      <article
                        key={turn.message.id}
                        className="agent__msg agent__msg--user"
                        aria-label="你"
                      >
                        <p>
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
                        <div className="agent__msg-actions">
                          <button
                            type="button"
                            className="agent__copy"
                            onClick={() =>
                              void copyReply(turn.message.id, turn.message.content)
                            }
                          >
                            {copied === turn.message.id ? "已复制" : "复制"}
                          </button>
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
                <article className="agent__msg agent__msg--assistant" aria-label="Agent">
                  <AgentMarkdown text={live} />
                </article>
              ) : null}
              {busyHere && !live ? <p className="agent__hint">正在思考…</p> : null}
            </div>
          </div>
          {thread && messages.length > 0 && !pinned ? (
            <button type="button" className="btn agent__jump" onClick={jumpBottom}>
              回到底部
            </button>
          ) : null}
        </div>

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
          className="agent__composer"
          onSubmit={(event) => {
            event.preventDefault();
            const picked = showSlash ? suggestions[slashPick] : null;
            void send(picked ? `/${picked.name}` : draft);
          }}
        >
          <div className="agent__composer-shell">
            {showSlash ? (
              <ul className="agent__slash" aria-label="斜杠命令">
                {suggestions.map((command, index) => (
                  <li key={command.name}>
                    <button
                      type="button"
                      className={index === slashPick ? "is-active" : undefined}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => void send(`/${command.name}`)}
                    >
                      <span>/{command.name}</span>
                      <small>{command.summary}</small>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <textarea
              ref={inputRef}
              aria-label="给 Agent 发消息"
              placeholder={
                busyHere
                  ? "这条会排在当前回答之后"
                  : pending
                    ? "请先处理待确认操作"
                    : "告诉 Agent 你要做什么，输入 / 查看命令"
              }
              title={
                busyHere
                  ? "Enter 把这条排到当前回答之后"
                  : "Enter 发送，Shift+Enter 换行，↑ 召回上一条"
              }
              value={draft}
              disabled={!thread}
              rows={2}
              onChange={(event) => {
                historyNav.current = null;
                const value = event.target.value;
                setDraft(value);
                if (thread) drafts.current.set(thread.id, value);
              }}
              onKeyDown={(event) => {
                if (showSlash && event.key === "ArrowDown") {
                  event.preventDefault();
                  setSlashUi((ui) => ({
                    ...ui,
                    index: (slashPick + 1) % suggestions.length,
                  }));
                  return;
                }
                if (showSlash && event.key === "ArrowUp") {
                  event.preventDefault();
                  setSlashUi((ui) => ({
                    ...ui,
                    index: (slashPick - 1 + suggestions.length) % suggestions.length,
                  }));
                  return;
                }
                if (showSlash && event.key === "Tab") {
                  event.preventDefault();
                  const command = suggestions[slashPick];
                  if (!command) return;
                  const value = `/${command.name} `;
                  setDraft(value);
                  if (thread) drafts.current.set(thread.id, value);
                  return;
                }
                if (showSlash && event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setSlashUi((ui) => ({ ...ui, dismissed: true }));
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
                  const picked = showSlash ? suggestions[slashPick] : null;
                  void send(picked ? `/${picked.name}` : draft);
                }
              }}
            />
            <div className="agent__composer-bar">
              {thread ? (
                <ModeMenu
                  mode={mode}
                  open={picker === "mode"}
                  onOpenChange={(next) => {
                    setPicker((current) =>
                      next ? "mode" : current === "mode" ? null : current,
                    );
                  }}
                  onChange={applyMode}
                />
              ) : null}
              {thread ? (
                <ModelMenu
                  modelRef={thread.modelRef}
                  open={picker === "model"}
                  onOpenChange={(next) => {
                    setPicker((current) =>
                      next ? "model" : current === "model" ? null : current,
                    );
                  }}
                  onSelect={(modelRef) => {
                    store.updateAgentThread(thread.id, { modelRef });
                    onRefresh();
                  }}
                  onOpenSettings={onOpenModels}
                />
              ) : null}
              <div className="agent__composer-actions">
                {busyHere ? (
                  <>
                    <button
                      type="button"
                      className="btn"
                      disabled={!draft.trim() || slashDraft}
                      onClick={() => void send(draft)}
                    >
                      排队
                    </button>
                    <button type="button" className="primary" onClick={stop}>
                      停止
                    </button>
                  </>
                ) : (
                  <button
                    type="submit"
                    className="primary"
                    disabled={!thread || Boolean(pending) || !draft.trim()}
                  >
                    发送
                  </button>
                )}
              </div>
            </div>
          </div>
        </form>
      </div>
    </section>
  );
}

const MODES: Array<{ id: AgentPermissionMode; label: string; hint: string }> = [
  { id: "confirm", label: "需确认", hint: "写入前先问你" },
  { id: "session_auto", label: "本会话自动", hint: "普通写入直接执行，删除仍要确认" },
  { id: "readonly", label: "只读", hint: "不能修改任务、笔记和项目" },
];

function ModeMenu({
  mode,
  open,
  onOpenChange,
  onChange,
}: {
  mode: AgentPermissionMode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (mode: AgentPermissionMode) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const current = MODES.find((item) => item.id === mode) ?? MODES[0]!;

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
    <div className="agent__model" ref={rootRef}>
      <button
        type="button"
        className="agent__model-trigger"
        aria-label="会话权限"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        <span>{current.label}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open ? (
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

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
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
  const html = renderChatMarkdown(text);
  return (
    <div
      className="agent__md"
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

function conversationBlocks(
  messages: AgentMessage[],
  pending: boolean,
): Array<
  { kind: "user"; message: AgentMessage } | { kind: "agent"; messages: AgentMessage[] }
> {
  const visible = messages.filter((message, index) => {
    const next = messages[index + 1];
    return !(
      isStatusMessage(message) &&
      (next?.role === "tool" || (pending && index === messages.length - 1))
    );
  });
  const blocks: Array<
    { kind: "user"; message: AgentMessage } | { kind: "agent"; messages: AgentMessage[] }
  > = [];
  for (const message of visible) {
    if (message.role === "user") {
      blocks.push({ kind: "user", message });
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

function isRemoteModel(modelRef: string | undefined): boolean {
  return Boolean(modelRef && !modelRef.startsWith("builtin:"));
}
