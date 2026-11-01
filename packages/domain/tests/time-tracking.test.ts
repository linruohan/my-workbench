import { describe, expect, it } from "vitest";
import {
  ActiveTimer,
  aggregateParentTime,
  settleTimerSegment,
  type Task,
} from "../src/index.js";

function baseTask(id: string, spent: Record<string, number> = {}): Task {
  const timeSpent = Object.values(spent).reduce((a, b) => a + b, 0);
  return {
    id,
    projectId: "inbox",
    parentId: null,
    title: id,
    notes: "",
    isDone: false,
    doneOn: null,
    dueDay: null,
    dueWithTime: null,
    deadlineDay: null,
    deadlineWithTime: null,
    remindAt: null,
    deadlineRemindAt: null,
    timeEstimate: 0,
    timeSpent,
    timeSpentOnDay: spent,
    repeatCfgId: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("time tracking", () => {
  it("settles segment onto local day", () => {
    const start = new Date(2026, 10, 1, 9, 0).getTime();
    const end = start + 30 * 60_000;
    const { map, added } = settleTimerSegment({}, start, end);
    expect(added).toBe(30 * 60_000);
    expect(Object.values(map)[0]).toBe(30 * 60_000);
  });

  it("aggregates children onto parent display", () => {
    const parent = baseTask("p");
    const c1 = {
      ...baseTask("c1", { "2026-11-01": 1000 }),
      parentId: "p",
      timeEstimate: 5000,
    };
    const c2 = {
      ...baseTask("c2", { "2026-11-01": 2000 }),
      parentId: "p",
      timeEstimate: 7000,
    };
    const agg = aggregateParentTime(parent, [c1, c2]);
    expect(agg.timeSpent).toBe(3000);
    expect(agg.timeEstimate).toBe(12000);
  });

  it("switches active timer and returns previous segment", () => {
    const timer = new ActiveTimer();
    timer.start("a", 100);
    const { previous } = timer.start("b", 200);
    expect(previous).toEqual({ taskId: "a", startedAt: 100, endedAt: 200 });
    expect(timer.current?.taskId).toBe("b");
    expect(timer.stop(250)).toEqual({
      taskId: "b",
      startedAt: 200,
      endedAt: 250,
    });
  });
});
