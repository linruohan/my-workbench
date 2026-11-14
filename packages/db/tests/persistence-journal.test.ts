import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@wb/domain";
import { MemoryWorkbenchRepository } from "../src/memory-repository.js";

function makeMessage(
  threadId: string,
  id: string,
  role: AgentMessage["role"],
  overrides: Partial<AgentMessage> = {},
): AgentMessage {
  return {
    id,
    threadId,
    role,
    content: `内容 ${id}`,
    toolName: null,
    toolCallId: null,
    toolCallsJson: null,
    createdAt: 1000 + Number(id.replace(/\D/g, "") || 0),
    ...overrides,
  };
}

/** 校验一批消息里没有调用方失踪的工具结果。 */
function hasOrphanToolResults(messages: readonly AgentMessage[]): boolean {
  const keptCalls = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant" && message.toolCallsJson) {
      const calls = JSON.parse(message.toolCallsJson) as Array<{ id: string }>;
      for (const call of calls) keptCalls.add(call.id);
    }
    if (message.role === "tool" && !keptCalls.has(message.toolCallId ?? "")) {
      return true;
    }
  }
  return false;
}

describe("agent message trim integrity", () => {
  it("drops tool results together with their trimmed caller", () => {
    const store = new MemoryWorkbenchRepository();
    const thread = store.createAgentThread({});
    const calls = JSON.stringify([{ id: "c1", name: "note_get", args: {} }]);
    const raw: AgentMessage[] = [];
    // 19 条普通消息（u0–u18）+ assistant 调用（19）+ 2 条结果（20/21）
    // → 裁剪边界（1220 − 1200 = 20）恰好落在结果 t20 上
    for (let i = 0; i < 19; i += 1) {
      raw.push(makeMessage(thread.id, `u${i}`, "user"));
    }
    raw.push(makeMessage(thread.id, "a19", "assistant", { toolCallsJson: calls }));
    raw.push(
      makeMessage(thread.id, "t20", "tool", { toolName: "note_get", toolCallId: "c1" }),
    );
    raw.push(
      makeMessage(thread.id, "t21", "tool", { toolName: "note_get", toolCallId: "c1" }),
    );
    for (let i = 22; i < 1220; i += 1) {
      raw.push(makeMessage(thread.id, `x${i}`, "user"));
    }
    store.importSnapshot(
      JSON.stringify({
        tasks: [],
        projects: [],
        buckets: [],
        todayOrder: [],
        notifications: [],
        agentWorkspaces: [{ id: "w1", title: "工作区", createdAt: 1, updatedAt: 1 }],
        agentThreads: [{ ...thread, workspaceId: "w1" }],
        agentMessages: raw,
      }),
    );
    const kept = store.listAgentMessages(thread.id);
    // 边界扩展后从 x22 开始：调用方 a19 与两条结果同批移除
    expect(kept.length).toBe(1198);
    expect(kept[0]?.id).toBe("x22");
    const keptIds = new Set(kept.map((message) => message.id));
    expect(keptIds.has("a19")).toBe(false);
    expect(keptIds.has("t20")).toBe(false);
    expect(keptIds.has("t21")).toBe(false);
    expect(hasOrphanToolResults(kept)).toBe(false);
    store.markPersisted();
  });

  it("keeps everything when the whole overflow is tool results", () => {
    const store = new MemoryWorkbenchRepository();
    const thread = store.createAgentThread({});
    const raw: AgentMessage[] = [
      makeMessage(thread.id, "a0", "assistant", {
        toolCallsJson: JSON.stringify([{ id: "c0", name: "shell", args: {} }]),
        createdAt: 0,
      }),
    ];
    for (let i = 1; i < 1250; i += 1) {
      raw.push(
        makeMessage(thread.id, `t${i}`, "tool", { toolName: "shell", toolCallId: "c0" }),
      );
    }
    store.importSnapshot(
      JSON.stringify({
        tasks: [],
        projects: [],
        buckets: [],
        todayOrder: [],
        notifications: [],
        agentThreads: [{ ...thread, workspaceId: thread.workspaceId }],
        agentMessages: raw,
      }),
    );
    const kept = store.listAgentMessages(thread.id);
    // 边界扩展到尽头也不会裁出孤儿；这种极端场景宁可保留
    expect(kept.length).toBe(raw.length);
    expect(hasOrphanToolResults(kept)).toBe(false);
    store.markPersisted();
  });
});

describe("persistence journal", () => {
  it("journals agent messages per entity and stays idempotent until persisted", () => {
    const store = new MemoryWorkbenchRepository();
    const thread = store.createAgentThread({});
    const first = store.collectPendingChanges();
    expect(first?.replaced).toContain("agent_thread");
    expect(first?.replaced).toContain("agent_workspace");
    // collect 只读：连续两次汇出同一批变更
    expect(store.collectPendingChanges()?.replaced).toContain("agent_thread");
    store.markPersisted();
    expect(store.collectPendingChanges()).toBeNull();

    const message = store.appendAgentMessage({
      threadId: thread.id,
      role: "user",
      content: "你好",
    });
    const changes = store.collectPendingChanges();
    const messageRows =
      changes?.upserts.filter((row) => row.kind === "agent_message") ?? [];
    expect(messageRows).toHaveLength(1);
    expect(JSON.parse(messageRows[0]!.data)).toMatchObject({ content: "你好" });
    expect(messageRows[0]?.seq).toBe(message.createdAt);
    // append 同时会更新线程标题/工作区时间戳 → 这些 kind 也在待写集合里
    expect(changes?.replaced).toContain("agent_thread");
    expect(changes?.replaced).toContain("agent_workspace");
    expect(
      store
        .collectPendingChanges()
        ?.upserts.filter((row) => row.kind === "agent_message"),
    ).toHaveLength(1);
    store.markPersisted();

    store.deleteAgentMessagesFrom(thread.id, message.id);
    const after = store.collectPendingChanges();
    expect(after?.deletes).toEqual([{ kind: "agent_message", id: message.id }]);
    store.markPersisted();
    expect(store.collectPendingChanges()).toBeNull();
  });

  it("journals task edits as bounded replace-kind collections", () => {
    const store = new MemoryWorkbenchRepository();
    const task = store.createTask({ title: "写周报" });
    const changes = store.collectPendingChanges();
    expect(changes?.replaced).toContain("task");
    expect(changes?.replaced).toContain("task_bucket");
    const taskRows = changes?.upserts.filter((row) => row.kind === "task") ?? [];
    expect(taskRows).toHaveLength(1);
    expect(JSON.parse(taskRows[0]!.data)).toMatchObject({ title: "写周报" });
    store.markPersisted();

    store.completeTask(task.id);
    expect(store.collectPendingChanges()?.replaced).toContain("task");
    store.markPersisted();

    store.deleteTask(task.id);
    const after = store.collectPendingChanges();
    expect(after?.replaced).toContain("task");
    expect(after?.replaced).toContain("task_tag");
    expect(after?.replaced).toContain("today_order");
    store.markPersisted();
    expect(store.collectPendingChanges()).toBeNull();
  });

  it("marks today order and notes dirty through their touch paths", () => {
    const store = new MemoryWorkbenchRepository();
    store.markPersisted();
    store.setTodayOrder(["t1", "t2"]);
    expect(store.collectPendingChanges()?.replaced).toContain("today_order");
    store.markPersisted();

    const note = store.createNote({ title: "会议纪要" });
    const changes = store.collectPendingChanges();
    expect(changes?.replaced).toContain("note");
    expect(changes?.upserts.some((row) => row.id === note.id)).toBe(true);
    store.markPersisted();

    store.deleteNote(note.id);
    expect(store.collectPendingChanges()?.replaced).toContain("note");
    store.markPersisted();
  });

  it("treats importSnapshot as a full replace for every kind", () => {
    const store = new MemoryWorkbenchRepository();
    store.importSnapshot(
      JSON.stringify({
        tasks: [],
        projects: [],
        buckets: [],
        todayOrder: [],
        notifications: [],
      }),
    );
    const changes = store.collectPendingChanges();
    for (const kind of [
      "task",
      "task_bucket",
      "project",
      "today_order",
      "notification",
      "note",
      "timed_task",
      "tag",
      "task_tag",
      "agent_workspace",
      "agent_thread",
      "agent_message",
      "agent_approval",
    ] as const) {
      expect(changes?.replaced).toContain(kind);
    }
    store.markPersisted();
    expect(store.collectPendingChanges()).toBeNull();
  });

  it("serializes agent messages with seq for ordered reload", () => {
    const store = new MemoryWorkbenchRepository();
    const thread = store.createAgentThread({});
    const older = store.appendAgentMessage({
      threadId: thread.id,
      role: "user",
      content: "先问",
      nowMs: 1000,
    });
    const newer = store.appendAgentMessage({
      threadId: thread.id,
      role: "assistant",
      content: "后答",
      nowMs: 2000,
    });
    store.markPersisted();
    const third = store.appendAgentMessage({
      threadId: thread.id,
      role: "user",
      content: "再问",
      nowMs: 3000,
    });
    const changes = store.collectPendingChanges();
    const rows = (changes?.upserts ?? []).filter((row) => row.kind === "agent_message");
    expect(rows.map((row) => row.id)).toEqual([third.id]);
    // 新 append 的行带单调 seq，旧消息已持久化不再重复写
    expect(rows[0]!.seq).toBe(3000);
    expect(older.createdAt).toBe(1000);
    expect(newer.createdAt).toBe(2000);
    store.markPersisted();
  });
});
