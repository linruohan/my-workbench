import { describe, expect, it } from "vitest";
import {
  isPlannerMember,
  isScheduleMember,
  isTodayMember,
  selectTodayTasks,
  type Task,
} from "../src/index.js";

function task(partial: Partial<Task> & Pick<Task, "id" | "title">): Task {
  return {
    projectId: "inbox",
    parentId: null,
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
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

describe("today membership", () => {
  const now = new Date(2026, 10, 1, 10, 0).getTime();

  it("includes planned today and earlier, excludes undated and future", () => {
    expect(
      isTodayMember(task({ id: "a", title: "a", dueDay: "2026-11-01" }), {
        nowMs: now,
      }),
    ).toBe(true);
    expect(
      isTodayMember(task({ id: "b", title: "b", dueDay: "2026-10-30" }), {
        nowMs: now,
      }),
    ).toBe(true);
    expect(
      isTodayMember(task({ id: "c", title: "c", dueDay: "2026-11-02" }), {
        nowMs: now,
      }),
    ).toBe(false);
    expect(
      isTodayMember(task({ id: "d", title: "d" }), { nowMs: now }),
    ).toBe(false);
  });

  it("deadline alone does not put task in today", () => {
    expect(
      isTodayMember(
        task({ id: "e", title: "e", deadlineDay: "2026-11-01" }),
        { nowMs: now },
      ),
    ).toBe(false);
  });

  it("hides child when parent is also today; respects todayOrder", () => {
    const parent = task({
      id: "p",
      title: "parent",
      dueDay: "2026-11-01",
      createdAt: 1,
    });
    const child = task({
      id: "c",
      title: "child",
      parentId: "p",
      dueDay: "2026-11-01",
      createdAt: 2,
    });
    const other = task({
      id: "o",
      title: "other",
      dueDay: "2026-11-01",
      createdAt: 3,
    });
    const list = selectTodayTasks([parent, child, other], ["o", "missing"], {
      nowMs: now,
    });
    expect(list.map((t) => t.id)).toEqual(["o", "p"]);
  });

  it("planner excludes timed tasks; schedule includes them", () => {
    const timed = task({
      id: "t",
      title: "t",
      dueWithTime: new Date(2026, 10, 1, 15, 0).getTime(),
    });
    const dayOnly = task({ id: "d", title: "d", dueDay: "2026-11-01" });
    expect(isPlannerMember(timed, "2026-11-01")).toBe(false);
    expect(isPlannerMember(dayOnly, "2026-11-01")).toBe(true);
    expect(isScheduleMember(timed, "2026-11-01")).toBe(true);
    expect(isScheduleMember(dayOnly, "2026-11-01")).toBe(false);
  });
});
