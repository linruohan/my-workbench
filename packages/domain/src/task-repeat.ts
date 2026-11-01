import {
  normalizeTimedSchedule,
  type TimedSchedule,
} from "./timed-task.js";

/** Encode a task repeat schedule into the `repeat_cfg_id` text field. */
export function encodeTaskRepeat(schedule: TimedSchedule): string {
  return JSON.stringify(normalizeTimedSchedule(schedule));
}

/** Decode `repeat_cfg_id` back into a TimedSchedule, or null if empty/invalid. */
export function decodeTaskRepeat(raw: string | null | undefined): TimedSchedule | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as TimedSchedule;
    return normalizeTimedSchedule(parsed);
  } catch {
    return null;
  }
}
