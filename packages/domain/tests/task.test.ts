import { describe, expect, it } from "vitest";
import {
  formatTaskPlanMeta,
  markTaskComplete,
  markTaskIncomplete,
  patchTaskContent,
  reorderIds,
  resolveTaskBoardColumn,
} from "../src/index.js";
import type { Task } from "../src/index.js";

function sample(partial: Partial<Task> = {}): Task {
  return {
    id: "t1",
    projectId: "inbox",
    parentId: null,
    title: "示例",
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

describe("task helpers", () => {
  it("resolves board columns from done and bucket", () => {
    expect(resolveTaskBoardColumn(sample(), "active")).toBe("active");
    expect(resolveTaskBoardColumn(sample(), "backlog")).toBe("backlog");
    expect(resolveTaskBoardColumn(sample({ isDone: true }), "active")).toBe("done");
  });

  it("patches content and toggles completion", () => {
    const next = patchTaskContent(sample(), { title: " 新标题 ", notes: "备注" }, 10);
    expect(next.title).toBe("新标题");
    expect(next.notes).toBe("备注");
    expect(next.updatedAt).toBe(10);

    const done = markTaskComplete(next, 20);
    expect(done.isDone).toBe(true);
    expect(done.doneOn).toBe(20);

    const open = markTaskIncomplete(done, 30);
    expect(open.isDone).toBe(false);
    expect(open.doneOn).toBeNull();
  });

  it("formats plan meta", () => {
    expect(formatTaskPlanMeta(sample())).toBe("未排期");
    expect(formatTaskPlanMeta(sample({ dueDay: "2026-11-01", remindAt: 1 }))).toBe(
      "2026-11-01 · 有提醒",
    );
  });

  it("reorders ids for today list", () => {
    expect(reorderIds(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
    expect(reorderIds(["a", "b", "c"], "a", "c")).toEqual(["b", "c", "a"]);
  });
});
