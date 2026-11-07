import { describe, expect, it } from "vitest";
import {
  readSessionEvent,
  searchSessionEvents,
  searchSessionMessages,
  sessionTrace,
  traceSessionEvent,
} from "../src/index.js";
import type { AgentMessage, AgentThread } from "../src/index.js";

describe("session query", () => {
  const threads: AgentThread[] = [
    {
      id: "a",
      workspaceId: "w",
      projectId: null,
      title: "会话 A",
      modelRef: "builtin:workbench/local",
      permissionMode: "confirm",
      queueJson: null,
      webUrl: null,
      archivedAt: null,
      pinnedAt: null,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: "b",
      workspaceId: "w",
      projectId: null,
      title: "会话 B",
      modelRef: "builtin:workbench/local",
      permissionMode: "confirm",
      queueJson: null,
      webUrl: null,
      archivedAt: null,
      pinnedAt: null,
      createdAt: 2,
      updatedAt: 2,
    },
  ];
  const messages: Record<string, AgentMessage[]> = {
    a: [
      {
        id: "m1",
        threadId: "a",
        role: "user",
        content: "修复登录超时",
        toolName: null,
        toolCallId: null,
        toolCallsJson: null,
        createdAt: 10,
      },
    ],
    b: [
      {
        id: "m2",
        threadId: "b",
        role: "assistant",
        content: "已处理登录超时问题",
        toolName: null,
        toolCallId: null,
        toolCallsJson: null,
        createdAt: 20,
      },
    ],
  };

  it("searches other sessions and traces one", () => {
    const found = searchSessionMessages({
      query: "登录",
      threads,
      messagesFor: (id) => messages[id] ?? [],
      excludeThreadId: "a",
    });
    expect(found.ok).toBe(true);
    if (found.ok) {
      expect(found.hits).toHaveLength(1);
      expect(found.hits[0]?.threadId).toBe("b");
    }
    const trace = sessionTrace({
      thread: threads[0]!,
      messages: messages.a!,
      limit: 10,
    });
    expect(trace.events).toHaveLength(1);
  });

  it("searches and reads message-backed session events", () => {
    const timeline: AgentMessage[] = [
      {
        id: "u1",
        threadId: "a",
        role: "user",
        content: "请跑测试",
        toolName: null,
        toolCallId: null,
        toolCallsJson: null,
        createdAt: 1,
      },
      {
        id: "a1",
        threadId: "a",
        role: "assistant",
        content: "好的",
        toolName: null,
        toolCallId: null,
        toolCallsJson: JSON.stringify([{ id: "c1", name: "bash", args: {} }]),
        createdAt: 2,
      },
      {
        id: "t1",
        threadId: "a",
        role: "tool",
        content: "tests passed",
        toolName: "bash",
        toolCallId: "c1",
        toolCallsJson: null,
        createdAt: 3,
      },
      {
        id: "u2",
        threadId: "a",
        role: "user",
        content: "现在搜一下测试",
        toolName: null,
        toolCallId: null,
        toolCallsJson: null,
        createdAt: 4,
      },
    ];
    const found = searchSessionEvents({
      query: "测试",
      messages: timeline,
      excludeAfterMessageId: "u2",
    });
    expect(found.ok).toBe(true);
    if (found.ok) {
      expect(found.hits.some((hit) => hit.messageId === "u1")).toBe(true);
      expect(found.hits.some((hit) => hit.messageId === "u2")).toBe(false);
    }
    const read = readSessionEvent({ messages: timeline, seq: 3, before: 1, after: 1 });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.event.toolName).toBe("bash");
      expect(read.before).toHaveLength(1);
      expect(read.after).toHaveLength(1);
    }
    const traced = traceSessionEvent({ messages: timeline, seq: 2 });
    expect(traced.ok).toBe(true);
    if (traced.ok) {
      expect(traced.related.some((item) => item.messageId === "t1")).toBe(true);
    }
  });
});
