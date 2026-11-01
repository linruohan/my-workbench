import { describe, expect, it } from "vitest";
import {
  applySchedulePatch,
  assertNoRepeatOnSubtask,
  assertTagIdAllowed,
  clearPlanFields,
  DomainError,
  plannedDayOf,
} from "../src/index.js";

describe("applySchedulePatch", () => {
  it("sets dueWithTime and clears dueDay", () => {
    const next = applySchedulePatch(
      { dueDay: "2026-11-01", dueWithTime: null },
      { dueWithTime: 1_762_000_000_000 },
    );
    expect(next.dueWithTime).toBe(1_762_000_000_000);
    expect(next.dueDay).toBeNull();
  });

  it("sets dueDay and clears dueWithTime", () => {
    const next = applySchedulePatch(
      { dueDay: null, dueWithTime: 1_762_000_000_000 },
      { dueDay: "2026-11-02" },
    );
    expect(next.dueDay).toBe("2026-11-02");
    expect(next.dueWithTime).toBeNull();
  });

  it("rejects setting both due fields", () => {
    expect(() =>
      applySchedulePatch(
        { dueDay: null, dueWithTime: null },
        { dueDay: "2026-11-01", dueWithTime: 1 },
      ),
    ).toThrow(DomainError);
  });

  it("applies deadline mutual exclusivity", () => {
    const next = applySchedulePatch(
      { deadlineDay: "2026-11-10", deadlineWithTime: null },
      { deadlineWithTime: 99 },
    );
    expect(next.deadlineWithTime).toBe(99);
    expect(next.deadlineDay).toBeNull();
  });

  it("plannedDayOf prefers dueWithTime", () => {
    expect(
      plannedDayOf({
        dueDay: "2026-11-01",
        dueWithTime: new Date(2026, 10, 3, 15, 0).getTime(),
      }),
    ).toBe("2026-11-03");
  });

  it("clearPlanFields removes schedule reminder", () => {
    const next = clearPlanFields({
      dueDay: "2026-11-01",
      dueWithTime: null,
      remindAt: 1,
    });
    expect(next.dueDay).toBeNull();
    expect(next.remindAt).toBeNull();
  });

  it("forbids TODAY tag and repeat on subtask", () => {
    expect(() => assertTagIdAllowed("TODAY")).toThrow(DomainError);
    expect(() => assertNoRepeatOnSubtask("parent", "cfg")).toThrow(DomainError);
    expect(() => assertNoRepeatOnSubtask(null, "cfg")).not.toThrow();
  });
});
