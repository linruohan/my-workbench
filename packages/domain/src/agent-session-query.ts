/**
 * Workspace-scoped session history search (lightweight DSH session-query).
 */

import type { AgentMessage, AgentThread } from "./agent.js";

export type SessionSearchHit = {
  threadId: string;
  title: string;
  messageId: string;
  role: string;
  snippet: string;
  createdAt: number;
};

export function searchSessionMessages(input: {
  query: string;
  threads: readonly AgentThread[];
  messagesFor: (threadId: string) => readonly AgentMessage[];
  /** Exclude the calling thread (DSH excludes caller). */
  excludeThreadId?: string;
  maxResults?: number;
}): { ok: true; hits: SessionSearchHit[] } | { ok: false; reason: string } {
  const query = input.query.trim().toLowerCase();
  if (!query) return { ok: false, reason: "请提供 query" };
  if (query.length > 200) return { ok: false, reason: "query 过长" };
  const max = Math.min(100, Math.max(1, input.maxResults ?? 40));
  const hits: SessionSearchHit[] = [];
  for (const thread of input.threads) {
    if (input.excludeThreadId && thread.id === input.excludeThreadId) continue;
    const messages = input.messagesFor(thread.id);
    for (const message of messages) {
      if (!message.content.toLowerCase().includes(query)) continue;
      hits.push({
        threadId: thread.id,
        title: thread.title,
        messageId: message.id,
        role: message.role,
        snippet: clipSnippet(message.content, query),
        createdAt: message.createdAt,
      });
      if (hits.length >= max) {
        return { ok: true, hits };
      }
    }
  }
  hits.sort((a, b) => b.createdAt - a.createdAt);
  return { ok: true, hits };
}

export function sessionTrace(input: {
  thread: AgentThread;
  messages: readonly AgentMessage[];
  limit?: number;
}): {
  threadId: string;
  title: string;
  events: Array<{
    role: string;
    toolName: string | null;
    snippet: string;
    createdAt: number;
  }>;
} {
  const limit = Math.min(80, Math.max(1, input.limit ?? 40));
  const slice = input.messages.slice(-limit);
  return {
    threadId: input.thread.id,
    title: input.thread.title,
    events: slice.map((message) => ({
      role: message.role,
      toolName: message.toolName,
      snippet: message.content.trim().slice(0, 240),
      createdAt: message.createdAt,
    })),
  };
}

function clipSnippet(content: string, query: string): string {
  const lower = content.toLowerCase();
  const at = lower.indexOf(query);
  if (at < 0) return content.trim().slice(0, 160);
  const start = Math.max(0, at - 40);
  const end = Math.min(content.length, at + query.length + 80);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < content.length ? "…" : "";
  return `${prefix}${content.slice(start, end).trim()}${suffix}`;
}

/** Message-backed session event (1-based seq in chronological order). */
export type SessionEventSummary = {
  seq: number;
  messageId: string;
  type: string;
  role: string;
  toolName: string | null;
  toolCallId: string | null;
  snippet: string;
  createdAt: number;
};

export type SessionEventFull = SessionEventSummary & {
  content: string;
  toolCallsJson: string | null;
};

function eventTypeFor(message: AgentMessage): string {
  if (message.role === "tool") return `tool/${message.toolName || "result"}`;
  if (message.role === "assistant" && message.toolCallsJson)
    return "assistant/tool_calls";
  if (message.role === "assistant") return "assistant/message";
  if (message.role === "user") return "user/message";
  return "system/notice";
}

function toEventSummary(message: AgentMessage, seq: number): SessionEventSummary {
  return {
    seq,
    messageId: message.id,
    type: eventTypeFor(message),
    role: message.role,
    toolName: message.toolName,
    toolCallId: message.toolCallId,
    snippet: message.content.trim().slice(0, 240),
    createdAt: message.createdAt,
  };
}

function toEventFull(message: AgentMessage, seq: number): SessionEventFull {
  return {
    ...toEventSummary(message, seq),
    content: message.content,
    toolCallsJson: message.toolCallsJson,
  };
}

/**
 * Search events in one session. When `excludeAfterMessageId` is set (caller’s
 * latest user turn), only earlier messages are visible — approximates DSH’s
 * “stop before the invoking step”.
 */
export function searchSessionEvents(input: {
  query: string;
  messages: readonly AgentMessage[];
  maxResults?: number;
  excludeAfterMessageId?: string | null;
  eventTypes?: readonly string[];
}): { ok: true; hits: SessionEventSummary[] } | { ok: false; reason: string } {
  const query = input.query.trim().toLowerCase();
  if (!query) return { ok: false, reason: "请提供 query" };
  if (query.length > 200) return { ok: false, reason: "query 过长" };
  const max = Math.min(100, Math.max(1, input.maxResults ?? 40));
  const types = input.eventTypes
    ?.map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  let end = input.messages.length;
  if (input.excludeAfterMessageId) {
    const at = input.messages.findIndex(
      (item) => item.id === input.excludeAfterMessageId,
    );
    if (at >= 0) end = at;
  }
  const hits: SessionEventSummary[] = [];
  for (let i = 0; i < end; i += 1) {
    const message = input.messages[i]!;
    const summary = toEventSummary(message, i + 1);
    if (
      types?.length &&
      !types.some((type) => summary.type.toLowerCase().includes(type))
    ) {
      continue;
    }
    const hay =
      `${summary.type}\n${message.content}\n${message.toolName ?? ""}`.toLowerCase();
    if (!hay.includes(query)) continue;
    hits.push(summary);
    if (hits.length >= max) break;
  }
  return { ok: true, hits };
}

export function readSessionEvent(input: {
  messages: readonly AgentMessage[];
  seq: number;
  before?: number;
  after?: number;
}):
  | {
      ok: true;
      event: SessionEventFull;
      before: SessionEventSummary[];
      after: SessionEventSummary[];
    }
  | { ok: false; reason: string } {
  const seq = Math.floor(input.seq);
  if (!Number.isFinite(seq) || seq < 1 || seq > input.messages.length) {
    return { ok: false, reason: `seq 超出范围（1–${input.messages.length || 0}）` };
  }
  const index = seq - 1;
  const message = input.messages[index]!;
  const beforeCount = Math.min(20, Math.max(0, Math.floor(input.before ?? 0)));
  const afterCount = Math.min(20, Math.max(0, Math.floor(input.after ?? 0)));
  const beforeStart = Math.max(0, index - beforeCount);
  const beforeEvents = input.messages
    .slice(beforeStart, index)
    .map((item, offset) => toEventSummary(item, beforeStart + offset + 1));
  const afterEvents = input.messages
    .slice(index + 1, index + 1 + afterCount)
    .map((item, offset) => toEventSummary(item, index + 2 + offset));
  return {
    ok: true,
    event: toEventFull(message, seq),
    before: beforeEvents,
    after: afterEvents,
  };
}

/** Positional neighbors + tool-call / tool-result relationships for one event. */
export function traceSessionEvent(input: {
  messages: readonly AgentMessage[];
  seq: number;
}):
  | {
      ok: true;
      event: SessionEventSummary;
      previous: SessionEventSummary | null;
      next: SessionEventSummary | null;
      related: SessionEventSummary[];
    }
  | { ok: false; reason: string } {
  const seq = Math.floor(input.seq);
  if (!Number.isFinite(seq) || seq < 1 || seq > input.messages.length) {
    return { ok: false, reason: `seq 超出范围（1–${input.messages.length || 0}）` };
  }
  const index = seq - 1;
  const message = input.messages[index]!;
  const event = toEventSummary(message, seq);
  const previous = index > 0 ? toEventSummary(input.messages[index - 1]!, index) : null;
  const next =
    index + 1 < input.messages.length
      ? toEventSummary(input.messages[index + 1]!, index + 2)
      : null;
  const related: SessionEventSummary[] = [];
  const callId = message.toolCallId;
  if (callId) {
    for (let i = 0; i < input.messages.length; i += 1) {
      if (i === index) continue;
      const other = input.messages[i]!;
      if (other.toolCallId === callId) {
        related.push(toEventSummary(other, i + 1));
        continue;
      }
      if (other.role === "assistant" && other.toolCallsJson?.includes(callId)) {
        related.push(toEventSummary(other, i + 1));
      }
    }
  } else if (message.role === "assistant" && message.toolCallsJson) {
    for (let i = index + 1; i < input.messages.length; i += 1) {
      const other = input.messages[i]!;
      if (other.role !== "tool") break;
      related.push(toEventSummary(other, i + 1));
    }
  }
  return { ok: true, event, previous, next, related };
}
