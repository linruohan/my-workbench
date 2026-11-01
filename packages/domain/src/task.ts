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
    title:
      patch.title !== undefined
        ? patch.title.trim() || "未命名任务"
        : task.title,
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

export function formatTaskPlanMeta(
  task: Pick<Task, "dueDay" | "dueWithTime" | "remindAt" | "deadlineDay">,
): string {
  const parts: string[] = [];
  if (task.dueWithTime != null) {
    parts.push(new Date(task.dueWithTime).toLocaleString("zh-CN"));
  } else if (task.dueDay) {
    parts.push(task.dueDay);
  } else {
    parts.push("未排期");
  }
  if (task.deadlineDay) parts.push(`截止 ${task.deadlineDay}`);
  if (task.remindAt) parts.push("有提醒");
  return parts.join(" · ");
}
