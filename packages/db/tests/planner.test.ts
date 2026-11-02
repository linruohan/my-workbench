import { describe, expect, it } from "vitest";
import { formatLocalDay } from "@wb/domain";
import { MemoryWorkbenchRepository } from "../src/memory-repository.js";

describe("planner list after scheduling", () => {
  it("shows all-day and timed tasks when listPlannerDay has no day filter", () => {
    const store = new MemoryWorkbenchRepository();
    const now = new Date(2026, 10, 2, 10, 0).getTime();
    const today = formatLocalDay(now);

    const a = store.createTask({ title: "全天计划", nowMs: now });
    store.scheduleTask(a.id, { dueDay: today }, now);

    const b = store.createTask({ title: "时刻计划", nowMs: now + 1 });
    store.scheduleTask(
      b.id,
      { dueWithTime: new Date(2026, 10, 3, 9, 0).getTime() },
      now,
    );

    const undated = store.createTask({ title: "无日期", nowMs: now + 2 });

    const all = store.listPlannerDay();
    expect(all.map((t) => t.title)).toEqual(["全天计划", "时刻计划"]);
    expect(store.listPlannerDay(today).map((t) => t.title)).toEqual(["全天计划"]);
    expect(store.getTask(undated.id)?.dueDay).toBeNull();
  });
});
