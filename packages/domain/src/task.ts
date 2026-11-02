import { formatRelativeDay, formatRelativeMoment } from "./date.js";
import type { ProjectBucket, Task } from "./types.js";

export type TaskBoardColumnId = "active" | "backlog" | "done";

export const TASK_BOARD_COLUMNS: Array<{
  id: TaskBoardColumnId;
  label: string;
}> = [
  { id: "active", label: "进行中" },
  { id: "backlog", label: "待办箱" },
  { id: "done", label: "已完成" },
];

export function resolveTaskBoardColumn(
  task: Pick<Task, "isDone">,
  bucket: ProjectBucket,
): TaskBoardColumnId {
  if (task.isDone) return "done";
  return bucket;
}

export function patchTaskContent(
  task: Task,
  patch: {
    title?: string;
    notes?: string;
    projectId?: string;
    timeEstimate?: number;
  },
  nowMs = Date.now(),
): Task {
  return {
    ...task,
    title: patch.title !== undefined ? patch.title.trim() || "未命名任务" : task.title,
    notes: patch.notes !== undefined ? patch.notes : task.notes,
    projectId: patch.projectId !== undefined ? patch.projectId : task.projectId,
    timeEstimate:
      patch.timeEstimate !== undefined
        ? Math.max(0, Math.floor(patch.timeEstimate))
        : task.timeEstimate,
    updatedAt: nowMs,
  };
}

export function markTaskComplete(task: Task, nowMs = Date.now()): Task {
  return {
    ...task,
    isDone: true,
    doneOn: nowMs,
    remindAt: null,
    deadlineRemindAt: null,
    updatedAt: nowMs,
  };
}

export function markTaskIncomplete(task: Task, nowMs = Date.now()): Task {
  return {
    ...task,
    isDone: false,
    doneOn: null,
    updatedAt: nowMs,
  };
}

/** Move `fromId` to the position of `toId` within an ordered id list. */
export function reorderIds(ids: string[], fromId: string, toId: string): string[] {
  if (fromId === toId) return [...ids];
  const from = ids.indexOf(fromId);
  const to = ids.indexOf(toId);
  if (from < 0 || to < 0) return [...ids];
  const next = [...ids];
  const [item] = next.splice(from, 1);
  if (!item) return [...ids];
  next.splice(to, 0, item);
  return next;
}

/** Planned day/time only (今天 / 明天 09:00). Null when unscheduled. */
export function formatTaskPlanSchedule(
  task: Pick<Task, "dueDay" | "dueWithTime">,
  nowMs = Date.now(),
): string | null {
  if (task.dueWithTime != null) return formatRelativeMoment(task.dueWithTime, nowMs);
  if (task.dueDay) return formatRelativeDay(task.dueDay, nowMs);
  return null;
}

export function formatTaskPlanMeta(
  task: Pick<
    Task,
    "dueDay" | "dueWithTime" | "remindAt" | "deadlineDay" | "deadlineWithTime"
  >,
  nowMs = Date.now(),
): string {
  const parts: string[] = [];
  const schedule = formatTaskPlanSchedule(task, nowMs);
  parts.push(schedule ?? "未排期");
  if (task.deadlineWithTime != null) {
    parts.push(`截止 ${formatRelativeMoment(task.deadlineWithTime, nowMs)}`);
  } else if (task.deadlineDay) {
    parts.push(`截止 ${formatRelativeDay(task.deadlineDay, nowMs)}`);
  }
  if (task.remindAt) parts.push("有提醒");
  return parts.join(" · ");
}
