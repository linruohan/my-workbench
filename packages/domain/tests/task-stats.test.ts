import { describe, expect, it } from "vitest";
import {
  computeTaskStats,
  filterTasks,
  isTaskOverdue,
  matchTaskQuery,
  sortTasks,
} from "../src/index.js";
import type { Task } from "../src/index.js";

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

describe("task stats and filters", () => {
  it("detects overdue and aggregates stats", () => {
    const today = "2026-11-01";
    const tasks = [
      task({ id: "1", title: "逾期", dueDay: "2026-10-30" }),
      task({ id: "2", title: "今天", dueDay: today }),
      task({ id: "3", title: "未排" }),
      task({
        id: "4",
        title: "完成",
        isDone: true,
        doneOn: Date.parse("2026-11-01T12:00:00"),
        timeEstimate: 30 * 60_000,
        timeSpent: 20 * 60_000,
      }),
    ];
    expect(isTaskOverdue(tasks[0]!, today)).toBe(true);
    const stats = computeTaskStats(tasks, { today });
    expect(stats.open).toBe(3);
    expect(stats.overdue).toBe(1);
    expect(stats.dueToday).toBe(1);
    expect(stats.unplanned).toBe(1);
    expect(stats.completedToday).toBe(1);
    expect(stats.estimateMinutes).toBe(30);
    expect(stats.spentMinutes).toBe(20);
  });

  it("filters by query and status, sorts by title", () => {
    const tasks = [
      task({ id: "a", title: "周报", notes: "团队", dueDay: "2026-10-01", updatedAt: 2 }),
      task({ id: "b", title: "邮件", updatedAt: 3 }),
      task({ id: "c", title: "周会", isDone: true, updatedAt: 1 }),
    ];
    expect(matchTaskQuery(tasks[0]!, "团队")).toBe(true);
    expect(filterTasks(tasks, { query: "周" }).map((t) => t.id)).toEqual(["a", "c"]);
    expect(filterTasks(tasks, { status: "open" })).toHaveLength(2);
    expect(
      filterTasks(tasks, { status: "overdue", today: "2026-11-01" }).map((t) => t.id),
    ).toEqual(["a"]);
    const byTitle = sortTasks(tasks, "title").map((t) => t.title);
    expect(byTitle).toEqual([...byTitle].sort((a, b) => a.localeCompare(b, "zh-CN")));
    expect(sortTasks(tasks, "updated").map((t) => t.id)).toEqual(["b", "a", "c"]);
  });
});
