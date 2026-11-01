import { describe, expect, it } from "vitest";
import {
  collectDueReminders,
  millisecondsDiffToRemindOption,
  ReminderUiCooldown,
  REMINDER_DISMISS_UI_COOLDOWN_MS,
  remindOptionToMilliseconds,
  shiftRemindAt,
} from "../src/index.js";

describe("reminders", () => {
  const due = new Date(2026, 10, 1, 15, 0).getTime();

  it("computes offsets", () => {
    expect(remindOptionToMilliseconds(due, "none")).toBeNull();
    expect(remindOptionToMilliseconds(due, "at_start")).toBe(due);
    expect(remindOptionToMilliseconds(due, "m15")).toBe(due - 15 * 60_000);
    expect(millisecondsDiffToRemindOption(due, due - 15 * 60_000)).toBe("m15");
  });

  it("shifts remindAt when rescheduling", () => {
    const prevRemind = due - 10 * 60_000;
    const nextDue = due + 60 * 60_000;
    expect(shiftRemindAt(due, prevRemind, nextDue)).toBe(nextDue - 10 * 60_000);
  });

  it("prefers schedule reminder over deadline for same task", () => {
    const list = collectDueReminders(
      [
        {
          id: "1",
          title: "A",
          isDone: false,
          remindAt: due - 1000,
          deadlineRemindAt: due - 500,
        },
      ],
      due,
    );
    expect(list).toHaveLength(1);
    expect(list[0]!.isDeadline).toBe(false);
  });

  it("suppresses UI for cooldown window only", () => {
    const cool = new ReminderUiCooldown();
    const now = 1_000_000;
    cool.dismiss("1", due, now);
    expect(cool.isSuppressed("1", due, now + 1000)).toBe(true);
    expect(cool.isSuppressed("1", due, now + REMINDER_DISMISS_UI_COOLDOWN_MS + 1)).toBe(
      false,
    );
    // reschedule (new remindAt) is not suppressed
    expect(cool.isSuppressed("1", due + 1, now + 1000)).toBe(false);
  });
});
