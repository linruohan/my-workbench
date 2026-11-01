import type { ReminderOptionId } from "./types.js";

const MIN = 60_000;
const HOUR = 60 * MIN;

export function remindOptionToMilliseconds(
  dueMs: number,
  option: ReminderOptionId,
): number | null {
  switch (option) {
    case "none":
      return null;
    case "at_start":
      return dueMs;
    case "m5":
      return dueMs - 5 * MIN;
    case "m10":
      return dueMs - 10 * MIN;
    case "m15":
      return dueMs - 15 * MIN;
    case "m30":
      return dueMs - 30 * MIN;
    case "h1":
      return dueMs - HOUR;
    default: {
      const _exhaustive: never = option;
      return _exhaustive;
    }
  }
}

export function millisecondsDiffToRemindOption(
  dueMs: number,
  remindAt: number | null | undefined,
): ReminderOptionId {
  if (typeof remindAt !== "number") return "none";
  const diff = dueMs - remindAt;
  if (diff >= HOUR) return "h1";
  if (diff >= 30 * MIN) return "m30";
  if (diff >= 15 * MIN) return "m15";
  if (diff >= 10 * MIN) return "m10";
  if (diff >= 5 * MIN) return "m5";
  if (diff <= 0) return "at_start";
  return "none";
}

/** Recompute remindAt from an offset when rescheduling dueWithTime. */
export function shiftRemindAt(
  previousDue: number | null,
  previousRemindAt: number | null,
  nextDue: number,
): number | null {
  if (previousRemindAt == null || previousDue == null) return previousRemindAt;
  const option = millisecondsDiffToRemindOption(previousDue, previousRemindAt);
  return remindOptionToMilliseconds(nextDue, option);
}
