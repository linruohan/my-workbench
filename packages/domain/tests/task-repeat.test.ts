import { describe, expect, it } from "vitest";
import {
  decodeTaskRepeat,
  encodeTaskRepeat,
  makePresetSchedule,
  markTaskCompleteAndAdvance,
  type Task,
} from "../src/index.js";

function makeTask(patch: Partial<Task> = {}): Task {
  const now = Date.parse("2026-01-01T09:00:00");
  return {
    id: "t1",
    projectId: "inbox",
    parentId: null,
    title: "周会",
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
    timeSpent: 0,
    timeSpentOnDay: {},
    repeatCfgId: null,
    createdAt: now,
    updatedAt: now,
    ...patch,
  };
}

describe("task-repeat", () => {
  it("round-trips a timed schedule through repeat_cfg_id text", () => {
    const schedule = makePresetSchedule("daily", "09:30");
    const encoded = encodeTaskRepeat(schedule);
    expect(decodeTaskRepeat(encoded)).toEqual(schedule);
    expect(decodeTaskRepeat(null)).toBeNull();
    expect(decodeTaskRepeat("not-json")).toBeNull();
  });

  it("advances a repeating task to its next occurrence on completion", () => {
    const completed = new Date(2026, 0, 5, 9, 30, 0).getTime(); // 周一 09:30 完成当日任务
    const task = makeTask({
      dueWithTime: completed,
      repeatCfgId: encodeTaskRepeat(makePresetSchedule("daily", "09:00")),
      remindAt: completed - 15 * 60_000,
    });
    const next = markTaskCompleteAndAdvance(task, completed);
    expect(next).not.toBeNull();
    expect(next!.isDone).toBe(false);
    expect(next!.doneOn).toBeNull();
    expect(next!.dueWithTime).toBe(new Date(2026, 0, 6, 9, 0, 0, 0).getTime());
    expect(next!.dueDay).toBeNull();
    // 提醒偏移随计划平移：仍提前 15 分钟
    expect(next!.remindAt).toBe(next!.dueWithTime! - 15 * 60_000);
  });

  it("keeps day-plan shape when repeating a day-only task", () => {
    const completed = new Date(2026, 0, 5, 14, 0, 0).getTime();
    const task = makeTask({
      dueDay: "2026-01-05",
      repeatCfgId: encodeTaskRepeat(makePresetSchedule("weekly", "09:00")),
    });
    const next = markTaskCompleteAndAdvance(task, completed);
    expect(next).not.toBeNull();
    expect(next!.dueWithTime).toBeNull();
    expect(next!.dueDay).toBe("2026-01-12"); // 下周一
  });

  it("falls back to plain completion without a repeat config", () => {
    const now = Date.now();
    const task = makeTask({ dueWithTime: now });
    expect(markTaskCompleteAndAdvance(task, now)).toBeNull();
  });

  it("ends a repeating task past its end date", () => {
    const now = Date.parse("2026-02-10T10:00:00");
    const task = makeTask({
      dueWithTime: now,
      repeatCfgId: encodeTaskRepeat({
        kind: "custom",
        every: 1,
        unit: "day",
        atTime: "09:00",
        endMode: "on_date",
        endDate: "2026-01-31",
      }),
    });
    expect(markTaskCompleteAndAdvance(task, now)).toBeNull();
  });
});
