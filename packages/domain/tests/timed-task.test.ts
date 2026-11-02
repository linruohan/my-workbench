import { describe, expect, it } from "vitest";
import {
  coerceTimedTask,
  computeNextRunAt,
  createTimedTaskDraft,
  makePresetSchedule,
  patchTimedTask,
  timedFrequencyLabel,
  timedScheduleLabel,
  timedScheduleSummary,
} from "../src/index.js";

describe("timed tasks", () => {
  it("creates draft with empty schedule by default", () => {
    const task = createTimedTaskDraft({
      title: "晨报",
      command: "总结昨日",
      nowMs: 1_700_000_000_000,
    });
    expect(task.title).toBe("晨报");
    expect(task.schedule).toBeNull();
    expect(task.nextRunAt).toBeNull();
  });

  it("accepts a single schedule and coerces legacy arrays", () => {
    const task = createTimedTaskDraft({
      nowMs: 1_700_000_000_000,
      schedule: makePresetSchedule("daily", "10:30"),
    });
    expect(task.schedule).toEqual(makePresetSchedule("daily", "10:30"));

    const fromLegacy = coerceTimedTask({
      ...task,
      schedule: null,
      schedules: [makePresetSchedule("weekly"), makePresetSchedule("hourly")],
    } as typeof task & { schedules: ReturnType<typeof makePresetSchedule>[] });
    expect(fromLegacy.schedule).toEqual(makePresetSchedule("weekly"));
  });

  it("builds inline summary for custom schedule", () => {
    expect(
      timedFrequencyLabel({
        kind: "custom",
        every: 1,
        unit: "day",
        atTime: "09:02",
        endMode: "never",
        endDate: null,
      }),
    ).toBe("每1天");
    expect(
      timedScheduleSummary({
        kind: "custom",
        every: 1,
        unit: "day",
        atTime: "09:02",
        endMode: "never",
        endDate: null,
      }),
    ).toBe("GMT+8 每 1 天，09:02");
    expect(timedScheduleLabel(null)).toBe("未设置计划");
  });

  it("patches schedule and recomputes next run", () => {
    const task = createTimedTaskDraft({
      nowMs: 1_700_000_000_000,
      schedule: makePresetSchedule("daily"),
    });
    const next = patchTimedTask(
      task,
      { schedule: makePresetSchedule("hourly") },
      1_700_000_100_000,
    );
    expect(next.schedule).toEqual(makePresetSchedule("hourly"));
    expect(next.nextRunAt).toBe(computeNextRunAt(next.schedule!, 1_700_000_100_000));
  });
});
