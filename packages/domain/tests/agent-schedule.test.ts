import { describe, expect, it } from "vitest";
import { parseScheduleRrule, timedTaskToRrule, viewScheduleTask } from "../src/index.js";
import { createTimedTaskDraft } from "../src/index.js";

describe("agent schedule rrule", () => {
  it("parses daily and weekdays rules", () => {
    const daily = parseScheduleRrule("DTSTART:20261107T090000\nRRULE:FREQ=DAILY");
    expect(daily.ok).toBe(true);
    if (daily.ok) {
      expect(daily.schedule).toEqual({
        kind: "preset",
        preset: "daily",
        atTime: "09:00",
      });
    }
    const weekdays = parseScheduleRrule(
      "DTSTART:20261107T100000\nRRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
    );
    expect(weekdays.ok).toBe(true);
    if (weekdays.ok && weekdays.schedule.kind === "preset") {
      expect(weekdays.schedule.preset).toBe("weekdays");
      expect(weekdays.schedule.atTime).toBe("10:00");
    }
  });

  it("round-trips a timed task view", () => {
    const task = createTimedTaskDraft({
      title: "晨报",
      command: "汇总昨日提交",
      schedule: { kind: "preset", preset: "daily", atTime: "09:00" },
      nowMs: 1,
    });
    const view = viewScheduleTask(task, { target: "this_session" });
    expect(view.prompt).toBe("汇总昨日提交");
    expect(timedTaskToRrule(task)).toContain("FREQ=DAILY");
  });
});
