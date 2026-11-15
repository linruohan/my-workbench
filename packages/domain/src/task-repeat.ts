import { formatLocalDay } from "./date.js";
import { markTaskComplete } from "./task.js";
import { computeNextRunAt, normalizeTimedSchedule } from "./timed-task.js";
import type { Task, TimedSchedule } from "./types.js";

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

/**
 * 完成带重复节奏的任务后的下一次出现点（复用定时任务节奏模型）。
 * 一次性节奏（once）完成即终结，返回 null；无下一次（结束日期已过）也返回 null。
 */
export function nextRepeatOccurrence(
  schedule: TimedSchedule,
  nowMs = Date.now(),
): number | null {
  const s = normalizeTimedSchedule(schedule);
  if (s.kind === "once") return null;
  return computeNextRunAt(s, nowMs);
}

/**
 * 完成重复任务并推进：本次完成写 doneOn 并清提醒，随后同一任务复归未完成、
 * 计划推进到下一次出现点。保持原计划的日/时刻形态，把提醒偏移随计划平移。
 * 返回 null 表示无重复配置或无下一次——调用方按普通完成处理。
 */
export function markTaskCompleteAndAdvance(task: Task, nowMs = Date.now()): Task | null {
  const schedule = decodeTaskRepeat(task.repeatCfgId);
  if (!schedule) return null;
  const nextAt = nextRepeatOccurrence(schedule, nowMs);
  if (nextAt == null) return null;
  const next = markTaskComplete(task, nowMs);
  // 复归为待办：完成记录留在本次（doneOn 已写），下一次继续用同一个任务
  next.isDone = false;
  next.doneOn = null;
  if (task.dueWithTime != null) {
    next.dueWithTime = nextAt;
    next.dueDay = null;
    // 平移提醒偏移，保持与计划的提前量一致
    if (task.remindAt != null) {
      next.remindAt = nextAt - (task.dueWithTime - task.remindAt);
    }
  } else {
    next.dueDay = formatLocalDay(nextAt);
    next.dueWithTime = null;
    next.remindAt = null;
  }
  next.updatedAt = nowMs;
  return next;
}
