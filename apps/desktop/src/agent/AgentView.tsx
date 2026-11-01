import { useEffect, useRef, useState } from "react";
import type { MemoryWorkbenchRepository } from "@wb/db/memory";
import {
  describeToolArgs,
  describeToolResult,
  permissionModeLabel,
  relativizeScheduleText,
  type AgentMessage,
  type AgentPermissionMode,
} from "@wb/domain";
import { readCredential } from "./credentials";
import type { AgentUiEffect } from "./execute";
import { modelChoices, readProviderStore } from "./providers";
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
  const [draft, setDraft] = useState("");
  const [live, setLive] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(true);
  const sending = useRef(false);
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
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages.length, live, pending?.id]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        inputRef.current?.focus();
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
    if (!refocus.current || busy || pending) return;
    refocus.current = false;
    inputRef.current?.focus();
  }, [busy, pending, messages.length]);

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
        if (mounted.current) setLive(text);
      },
    };
  };

  const finish = (effects: AgentUiEffect[]) => {
    refocus.current = true;
    if (mounted.current) {
      setLive("");
      setBusy(false);
    }
    if (effects.length) onEffects(effects);
    onRefresh();
  };

  const send = async (text: string) => {
    const content = text.trim();
    const current = env();
    if (!content || !current || sending.current || busy || pending) return;
    sending.current = true;
    setDraft("");
    setError("");
    if (isRemoteModel(thread?.modelRef)) setBusy(true);
    try {
      const result = await startAgentTurn(current, content);
      finish(result.effects);
    } catch (caught) {
      if (mounted.current) {
        setBusy(false);
        setError(caught instanceof Error ? caught.message : "发送失败");
      }
    } finally {
      sending.current = false;
    }
  };

  const decide = async (decision: "approved" | "denied") => {
    const current = env();
    if (!current || sending.current || busy) return;
    sending.current = true;
    if (isRemoteModel(thread?.modelRef)) setBusy(true);
    setError("");
    try {
      const result = await settleAgentApproval(current, decision);
      finish(result.effects);
    } catch (caught) {
      if (mounted.current) {
        setBusy(false);
        setError(caught instanceof Error ? caught.message : "审批失败");
      }
    } finally {
      sending.current = false;
    }
  };
  decideRef.current = (decision) => {
    void decide(decision);
  };

  const removeThread = (id: string, title: string) => {
    if (!window.confirm(`删除会话「${title}」？对话会从本机移除。`)) return;
    store.deleteAgentThread(id);
    if (thread?.id === id) {
      onSelectThread(store.listAgentThreads()[0]?.id ?? null);
    }
    onRefresh();
  };

  const choices = modelChoices();
  const mode = thread?.permissionMode ?? "confirm";
  const nowMs = Date.now();
  const turns = conversationBlocks(messages, Boolean(pending));
  const queued = queueLength(thread?.queueJson ?? null);
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
                  <small>{permissionModeLabel(item.permissionMode)}</small>
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
            <strong className="agent__title">{thread.title}</strong>
            <label className="agent__field">
              <span>权限</span>
              <select
                aria-label="会话权限"
                value={mode}
                onChange={(event) => {
                  const permissionMode = event.target.value as AgentPermissionMode;
                  store.updateAgentThread(thread.id, { permissionMode });
                  onRefresh();
                  const current = env();
                  if (!current) return;
                  if (isRemoteModel(thread.modelRef)) setBusy(true);
                  void resumeAgentQueue({ ...current, onDelta: undefined }).then(
                    (result) => finish(result.effects),
                    (caught: unknown) => {
                      if (!mounted.current) return;
                      setBusy(false);
                      setError(caught instanceof Error ? caught.message : "权限切换失败");
                    },
                  );
                }}
              >
                <option value="confirm">需确认</option>
                <option value="session_auto">本会话自动</option>
                <option value="readonly">只读</option>
              </select>
            </label>
            <label className="agent__field">
              <span>模型</span>
              <select
                aria-label="会话模型"
                value={thread.modelRef}
                onChange={(event) => {
                  store.updateAgentThread(thread.id, { modelRef: event.target.value });
                  onRefresh();
                }}
              >
                {choices.map((choice) => (
                  <option key={choice.ref} value={choice.ref}>
                    {choice.label}
                  </option>
                ))}
                {choices.some((choice) => choice.ref === thread.modelRef) ? null : (
                  <option value={thread.modelRef}>{thread.modelRef}</option>
                )}
              </select>
            </label>
            <button type="button" className="btn" onClick={onOpenModels}>
              模型设置
            </button>
          </header>
        ) : null}

        <div className="agent__log" ref={logRef} aria-live="polite">
          {!thread ? (
            <div className="agent__empty">
              <p>用自然语言管理任务、笔记和提醒。</p>
              <button type="button" className="primary" onClick={onCreateThread}>
                新建会话
              </button>
            </div>
          ) : messages.length === 0 ? (
            <div className="agent__empty">
              <p>未配置外部模型时，使用本机工作台理解常用指令。写操作默认需要确认。</p>
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
            turns.map((turn) => {
              if (turn.kind === "user") {
                return (
                  <article
                    key={turn.message.id}
                    className="agent__msg agent__msg--user"
                    aria-label="你"
                  >
                    <p>{turn.message.content}</p>
                  </article>
                );
              }
              const text = turn.messages
                .map((message) => displayContent(message, nowMs))
                .filter(Boolean)
                .join("\n\n");
              if (!text) return null;
              return (
                <article
                  key={turn.messages[0]!.id}
                  className="agent__msg agent__msg--assistant"
                  aria-label="Agent"
                >
                  <p>{text}</p>
                </article>
              );
            })
          )}
          {live ? (
            <article className="agent__msg agent__msg--assistant" aria-label="Agent">
              <p>{live}</p>
            </article>
          ) : null}
          {busy && !live ? <p className="agent__hint">正在思考…</p> : null}
        </div>

        {pending ? (
          <div className="agent__approval" role="region" aria-label="待确认操作">
            <div>
              <strong>需要确认</strong>
              <p>{relativizeScheduleText(pending.summary, nowMs)}</p>
              {queued > 1 ? <p>后面还有 {queued - 1} 步。</p> : null}
            </div>
            {argLines ? <p className="agent__approval-detail">{argLines}</p> : null}
            <div className="agent__approval-actions">
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => void decide("approved")}
              >
                批准
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void decide("denied")}
              >
                拒绝
              </button>
              <span className="agent__approval-hint">Enter 批准 · Esc 拒绝</span>
            </div>
          </div>
        ) : null}

        {error ? <p className="agent__error">{error}</p> : null}

        <form
          className="agent__composer"
          onSubmit={(event) => {
            event.preventDefault();
            void send(draft);
          }}
        >
          <textarea
            ref={inputRef}
            aria-label="给 Agent 发消息"
            placeholder={pending ? "请先处理待确认操作" : "告诉 Agent 你要做什么"}
            value={draft}
            disabled={!thread || busy || Boolean(pending)}
            rows={2}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send(draft);
              }
            }}
          />
          <button
            type="submit"
            className="primary"
            disabled={!thread || busy || Boolean(pending)}
          >
            发送
          </button>
        </form>
      </div>
    </section>
  );
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
