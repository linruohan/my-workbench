import type { SchedulePatch, Task } from "./types.js";
import { formatLocalDay } from "./date.js";

export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainError";
  }
}

/**
 * Apply schedule fields with Super Productivity mutual-exclusivity rules.
 * dueWithTime clears dueDay; dueDay clears dueWithTime. Same for deadlines.
 */
export function applySchedulePatch<T extends SchedulePatch>(
  current: T,
  patch: SchedulePatch,
): T {
  const next: SchedulePatch = { ...current };

  const settingDueWithTime =
    Object.prototype.hasOwnProperty.call(patch, "dueWithTime") &&
    patch.dueWithTime != null;
  const settingDueDay =
    Object.prototype.hasOwnProperty.call(patch, "dueDay") &&
    patch.dueDay != null;
  const clearingDueWithTime =
    Object.prototype.hasOwnProperty.call(patch, "dueWithTime") &&
    patch.dueWithTime == null;
  const clearingDueDay =
    Object.prototype.hasOwnProperty.call(patch, "dueDay") && patch.dueDay == null;

  if (settingDueWithTime && settingDueDay) {
    throw new DomainError("due_day and due_with_time are mutually exclusive");
  }

  if (settingDueWithTime) {
    next.dueWithTime = patch.dueWithTime!;
    next.dueDay = null;
  } else if (settingDueDay) {
    next.dueDay = patch.dueDay!;
    next.dueWithTime = null;
  } else {
    if (clearingDueWithTime) next.dueWithTime = null;
    if (clearingDueDay) next.dueDay = null;
  }

  const settingDeadlineWithTime =
    Object.prototype.hasOwnProperty.call(patch, "deadlineWithTime") &&
    patch.deadlineWithTime != null;
  const settingDeadlineDay =
    Object.prototype.hasOwnProperty.call(patch, "deadlineDay") &&
    patch.deadlineDay != null;

  if (settingDeadlineWithTime && settingDeadlineDay) {
    throw new DomainError(
      "deadline_day and deadline_with_time are mutually exclusive",
    );
  }

  if (settingDeadlineWithTime) {
    next.deadlineWithTime = patch.deadlineWithTime!;
    next.deadlineDay = null;
  } else if (settingDeadlineDay) {
    next.deadlineDay = patch.deadlineDay!;
    next.deadlineWithTime = null;
  } else {
    if (Object.prototype.hasOwnProperty.call(patch, "deadlineWithTime")) {
      next.deadlineWithTime = patch.deadlineWithTime ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "deadlineDay")) {
      next.deadlineDay = patch.deadlineDay ?? null;
    }
  }

  if (Object.prototype.hasOwnProperty.call(patch, "remindAt")) {
    next.remindAt = patch.remindAt ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "deadlineRemindAt")) {
    next.deadlineRemindAt = patch.deadlineRemindAt ?? null;
  }

  return next as T;
}

/** Read planned local day; dueWithTime wins if both somehow present. */
export function plannedDayOf(task: Pick<Task, "dueDay" | "dueWithTime">): string | null {
  if (task.dueWithTime != null) {
    return formatLocalDay(task.dueWithTime);
  }
  return task.dueDay;
}

export function clearPlanFields<T extends SchedulePatch>(task: T): T {
  return {
    ...task,
    dueDay: null,
    dueWithTime: null,
    remindAt: null,
  };
}

export function assertNoRepeatOnSubtask(
  parentId: string | null,
  repeatCfgId: string | null,
): void {
  if (parentId && repeatCfgId) {
    throw new DomainError("subtasks cannot have repeat configuration");
  }
}

export function assertTagIdAllowed(tagId: string): void {
  if (tagId === "TODAY" || tagId.toUpperCase() === "TODAY") {
    throw new DomainError("TODAY tag is forbidden");
  }
}
