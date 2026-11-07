import { afterEach, describe, expect, it } from "vitest";
import { MemoryWorkbenchRepository } from "@wb/db/memory";
import { makePresetSchedule } from "@wb/domain";
import { getScheduleMeta, takeScheduleDeliveries } from "../agent/schedule-meta";
import {
  ensureTimedTaskSession,
  runTimedTaskNow,
  skipTimedTaskOccurrence,
} from "./run-timed-task";

afterEach(() => {
  localStorage.clear();
});

describe("runTimedTaskNow", () => {
  it("creates a default-workspace session named after the task when unbound", () => {
    const store = new MemoryWorkbenchRepository();
    const task = store.createTimedTask({
      title: "晨报汇总",
      command: "总结昨日进展",
      schedule: makePresetSchedule("daily"),
      nowMs: 1000,
    });

    const result = runTimedTaskNow(store, task, { nowMs: 2000 });

    expect(result.delivered).toBe(true);
    expect(result.threadId).toBeTruthy();
    const thread = store.getAgentThread(result.threadId!);
    expect(thread?.title).toBe("晨报汇总");
    expect(store.getAgentWorkspace(thread!.workspaceId)?.title).toBe("默认工作区");

    const meta = getScheduleMeta(task.id);
    expect(meta?.threadId).toBe(result.threadId);

    const deliveries = takeScheduleDeliveries(result.threadId!);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.prompt).toBe("总结昨日进展");
  });

  it("reuses a bound session", () => {
    const store = new MemoryWorkbenchRepository();
    const workspace = store.ensureAgentWorkspace(1);
    const thread = store.createAgentThread({
      workspaceId: workspace.id,
      title: "已有会话",
      nowMs: 2,
    });
    const task = store.createTimedTask({
      title: "复用",
      command: "继续",
      schedule: makePresetSchedule("hourly"),
      nowMs: 3,
    });
    ensureTimedTaskSession(
      store,
      task,
      {
        target: "this_session",
        threadId: thread.id,
        workspaceId: workspace.id,
        skillIds: [],
      },
      4,
    );

    const result = runTimedTaskNow(store, store.getTimedTask(task.id)!, { nowMs: 5 });
    expect(result.threadId).toBe(thread.id);
    expect(getScheduleMeta(task.id)?.threadId).toBe(thread.id);
  });

  it("skips a missed occurrence without delivering", () => {
    const store = new MemoryWorkbenchRepository();
    const task = store.createTimedTask({
      title: "跳过",
      command: "不要跑",
      schedule: makePresetSchedule("hourly"),
      nowMs: 1,
    });
    const next = skipTimedTaskOccurrence(store, task, 3_600_000);
    expect(next.lastRunAt).toBe(3_600_000);
    expect(next.nextRunAt).toBeGreaterThan(3_600_000);
    expect(takeScheduleDeliveries()).toEqual([]);
  });

  it("binds selected skills into the delivery prompt", () => {
    const store = new MemoryWorkbenchRepository();
    const task = store.createTimedTask({
      title: "技能任务",
      command: "开始",
      schedule: makePresetSchedule("daily"),
      nowMs: 1,
    });
    ensureTimedTaskSession(
      store,
      task,
      {
        target: "this_session",
        threadId: null,
        workspaceId: null,
        skillIds: ["sk-review"],
      },
      2,
    );

    const result = runTimedTaskNow(store, store.getTimedTask(task.id)!, {
      nowMs: 3,
      skills: [
        {
          id: "sk-review",
          name: "code-review",
          description: "评审",
          dirPath: "D:/skills/review",
          sourceDirId: "src1",
          body: "",
        },
      ],
    });
    const deliveries = takeScheduleDeliveries(result.threadId!);
    expect(deliveries[0]?.prompt).toBe("/code-review 开始");
  });
});
