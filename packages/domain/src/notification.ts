export const REMINDER_DISMISS_UI_COOLDOWN_MS = 5 * 60 * 1000;

/** In-memory UI cooldown keyed by occurrence (taskId + remindAt). */
export class ReminderUiCooldown {
  private readonly until = new Map<string, number>();

  static occurrenceKey(taskId: string, remindAt: number): string {
    return `${taskId}:${remindAt}`;
  }

  dismiss(taskId: string, remindAt: number, nowMs: number): void {
    this.until.set(
      ReminderUiCooldown.occurrenceKey(taskId, remindAt),
      nowMs + REMINDER_DISMISS_UI_COOLDOWN_MS,
    );
  }

  isSuppressed(taskId: string, remindAt: number, nowMs: number): boolean {
    const key = ReminderUiCooldown.occurrenceKey(taskId, remindAt);
    const until = this.until.get(key);
    if (until == null) return false;
    if (nowMs >= until) {
      this.until.delete(key);
      return false;
    }
    return true;
  }

  clear(): void {
    this.until.clear();
  }
}

export function shouldFireReminder(remindAt: number | null, nowMs: number): boolean {
  return remindAt != null && remindAt <= nowMs;
}

export interface DueReminder {
  taskId: string;
  title: string;
  remindAt: number;
  isDeadline: boolean;
}

/**
 * Prefer schedule reminder over deadline when both fire for the same task.
 */
export function collectDueReminders(
  tasks: Array<{
    id: string;
    title: string;
    isDone: boolean;
    remindAt: number | null;
    deadlineRemindAt: number | null;
  }>,
  nowMs: number,
): DueReminder[] {
  const out: DueReminder[] = [];
  const seen = new Set<string>();

  for (const task of tasks) {
    if (task.isDone) continue;
    if (shouldFireReminder(task.remindAt, nowMs) && task.remindAt != null) {
      out.push({
        taskId: task.id,
        title: task.title,
        remindAt: task.remindAt,
        isDeadline: false,
      });
      seen.add(task.id);
    }
  }

  for (const task of tasks) {
    if (task.isDone || seen.has(task.id)) continue;
    if (
      shouldFireReminder(task.deadlineRemindAt, nowMs) &&
      task.deadlineRemindAt != null
    ) {
      out.push({
        taskId: task.id,
        title: task.title,
        remindAt: task.deadlineRemindAt,
        isDeadline: true,
      });
    }
  }

  return out;
}
