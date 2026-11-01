import { formatLocalDay } from "./date.js";
import type { Task } from "./types.js";

export function sumTimeSpentOnDay(map: Record<string, number>): number {
  return Object.values(map).reduce((a, b) => a + b, 0);
}

/** Format milliseconds as compact Chinese duration (e.g. 1:05 / 12分). */
export function formatDurationMs(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function addTimeSpent(
  map: Record<string, number>,
  day: string,
  deltaMs: number,
): Record<string, number> {
  if (deltaMs <= 0) return { ...map };
  const next = { ...map };
  next[day] = (next[day] ?? 0) + deltaMs;
  return next;
}

export function settleTimerSegment(
  map: Record<string, number>,
  startedAt: number,
  endedAt: number,
): { map: Record<string, number>; added: number } {
  if (endedAt <= startedAt) return { map: { ...map }, added: 0 };
  const day = formatLocalDay(startedAt);
  const added = endedAt - startedAt;
  return { map: addTimeSpent(map, day, added), added };
}

/** Parent with subtasks displays aggregated spent/estimate; does not accept direct timing. */
export function aggregateParentTime(
  parent: Task,
  children: Task[],
): { timeSpent: number; timeEstimate: number; timeSpentOnDay: Record<string, number> } {
  if (children.length === 0) {
    return {
      timeSpent: parent.timeSpent,
      timeEstimate: parent.timeEstimate,
      timeSpentOnDay: { ...parent.timeSpentOnDay },
    };
  }

  const timeSpentOnDay: Record<string, number> = {};
  let timeEstimate = 0;
  for (const child of children) {
    timeEstimate += child.timeEstimate;
    for (const [day, ms] of Object.entries(child.timeSpentOnDay)) {
      timeSpentOnDay[day] = (timeSpentOnDay[day] ?? 0) + ms;
    }
  }
  return {
    timeSpent: sumTimeSpentOnDay(timeSpentOnDay),
    timeEstimate,
    timeSpentOnDay,
  };
}

export class ActiveTimer {
  private taskId: string | null = null;
  private startedAt: number | null = null;

  get current(): { taskId: string; startedAt: number } | null {
    if (!this.taskId || this.startedAt == null) return null;
    return { taskId: this.taskId, startedAt: this.startedAt };
  }

  /**
   * Start timer on taskId. If another task is running, returns the segment to settle first.
   */
  start(
    taskId: string,
    nowMs: number,
  ): { previous: { taskId: string; startedAt: number; endedAt: number } | null } {
    let previous: { taskId: string; startedAt: number; endedAt: number } | null = null;
    if (this.taskId && this.startedAt != null && this.taskId !== taskId) {
      previous = {
        taskId: this.taskId,
        startedAt: this.startedAt,
        endedAt: nowMs,
      };
    }
    this.taskId = taskId;
    this.startedAt = nowMs;
    return { previous };
  }

  stop(nowMs: number): { taskId: string; startedAt: number; endedAt: number } | null {
    if (!this.taskId || this.startedAt == null) return null;
    const segment = {
      taskId: this.taskId,
      startedAt: this.startedAt,
      endedAt: nowMs,
    };
    this.taskId = null;
    this.startedAt = null;
    return segment;
  }
}
