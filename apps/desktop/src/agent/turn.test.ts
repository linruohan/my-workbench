import { afterEach, describe, expect, it, vi } from "vitest";
import { formatLocalDay } from "@wb/domain";
import { MemoryWorkbenchRepository } from "@wb/db/memory";
import { settleAgentApproval, startAgentTurn } from "./turn";

const now = new Date(2026, 10, 1, 8, 0, 0).getTime();
const tomorrowAtNine = new Date(2026, 10, 2, 9, 0, 0).getTime();

describe("agent turn", () => {
  it("asks before creating, and a denial leaves the database unchanged", async () => {
    const store = new MemoryWorkbenchRepository();
    const thread = store.createAgentThread({ nowMs: now });
    await startAgentTurn({ store, threadId: thread.id, nowMs: now }, "创建任务 验收事项");
    expect(store.listTasks()).toHaveLength(0);
    const pending = store
      .listAgentApprovals(thread.id)
      .find((item) => item.status === "pending");
    expect(pending?.toolName).toBe("task_create");

    await settleAgentApproval({ store, threadId: thread.id, nowMs: now }, "denied");
    expect(store.listTasks()).toHaveLength(0);
    expect(
      store.listAgentApprovals(thread.id).some((item) => item.status === "pending"),
    ).toBe(false);
  });

  it("auto-approves a scheduled reminder, but still asks before delete", async () => {
    const store = new MemoryWorkbenchRepository();
    const thread = store.createAgentThread({
      permissionMode: "session_auto",
      nowMs: now,
    });
    await startAgentTurn(
      { store, threadId: thread.id, nowMs: now },
      "创建任务 写周报，排到明天并提前15分钟提醒",
    );
    const task = store.listTasks().find((item) => item.title === "写周报");
    expect(task?.dueDay).toBeNull();
    expect(task?.dueWithTime).toBe(tomorrowAtNine);
    expect(task?.remindAt).toBe(tomorrowAtNine - 15 * 60_000);
    expect(store.listAgentApprovals(thread.id)).toHaveLength(0);

    await startAgentTurn({ store, threadId: thread.id, nowMs: now }, "删除任务 写周报");
    expect(store.getTask(task!.id)?.title).toBe("写周报");
    expect(
      store.listAgentApprovals(thread.id).some((item) => item.toolName === "task_delete"),
    ).toBe(true);
  });

  it("does not store API keys in the session snapshot", async () => {
    const store = new MemoryWorkbenchRepository();
    const thread = store.createAgentThread({ nowMs: now });
    const secret = "sk-live-secret-value";
    await startAgentTurn(
      {
        store,
        threadId: thread.id,
        nowMs: now,
        apiKey: secret,
        plan: () => {
          throw new Error(`upstream echoed ${secret}`);
        },
      },
      "列出今日",
    );
    const saved = [
      store.exportSnapshot(),
      ...store.listAgentMessages(thread.id).map((message) => message.content),
    ].join("\n");
    expect(saved).not.toContain(secret);
    expect(saved).toContain("[redacted]");
  });

  it("saves a local memory when the session can write", async () => {
    const store = new MemoryWorkbenchRepository();
    const thread = store.createAgentThread({
      permissionMode: "session_auto",
      nowMs: now,
    });
    const saved: string[] = [];
    await startAgentTurn(
      {
        store,
        threadId: thread.id,
        nowMs: now,
        memories: [],
        onMemories: (next) => {
          saved.splice(0, saved.length, ...next.map((item) => item.text));
        },
      },
      "记住 周五写周报",
    );
    expect(saved).toEqual(["周五写周报"]);
  });

  it("answers 今天有什么 with the task titles", async () => {
    const store = new MemoryWorkbenchRepository();
    const task = store.createTask({ title: "写周报", nowMs: now });
    store.scheduleTask(task.id, { dueDay: formatLocalDay(now) }, now);
    const thread = store.createAgentThread({ permissionMode: "readonly", nowMs: now });
    await startAgentTurn({ store, threadId: thread.id, nowMs: now }, "看看今天");
    const reply = store
      .listAgentMessages(thread.id)
      .filter((message) => message.role === "tool")
      .map((message) => message.content)
      .join("\n");
    expect(reply).toContain("写周报");
    expect(reply).toContain(formatLocalDay(now));
    expect(reply).not.toContain('"tasks"');
  });

  it("stops a remote turn before any tool runs", async () => {
    const store = new MemoryWorkbenchRepository();
    const thread = store.createAgentThread({
      modelRef: "custom:test/m",
      nowMs: now,
    });
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.reject(new DOMException("The operation was aborted.", "AbortError")),
      ),
    );
    await startAgentTurn(
      {
        store,
        threadId: thread.id,
        nowMs: now,
        signal: controller.signal,
        providers: [
          {
            id: "custom:test",
            name: "Test",
            kind: "openai-chat-completions",
            baseURL: "http://127.0.0.1:9/v1",
            apiKeyRequired: false,
            enabled: true,
            models: { m: { context: 1024, output: 256 } },
          },
        ],
      },
      "你好",
    );
    const reply = store
      .listAgentMessages(thread.id)
      .map((message) => message.content)
      .join("\n");
    expect(reply).toContain("已停止");
    expect(reply).not.toContain("模型不可用");
    expect(store.listTasks()).toHaveLength(0);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
