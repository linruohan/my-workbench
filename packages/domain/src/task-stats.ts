import { compareDay, formatLocalDay } from "./date.js";
import { plannedDayOf } from "./scheduling.js";
import type { Task } from "./types.js";

export type TaskStatusFilter =
  | "all"
  | "open"
  | "done"
  | "overdue"
  | "unplanned"
  | "today";

export type TaskSortKey = "updated" | "created" | "due" | "title";

export type TaskStats = {
  total: number;
  open: number;
  done: number;
  overdue: number;
  dueToday: number;
  unplanned: number;
  completedToday: number;
  estimateMinutes: number;
  spentMinutes: number;
  byProject: Array<{
    projectId: string;
    open: number;
    done: number;
    overdue: number;
  }>;
};

export function isTaskOverdue(
  task: Pick<Task, "isDone" | "dueDay" | "dueWithTime" | "deadlineDay">,
  today = formatLocalDay(Date.now()),
): boolean {
  if (task.isDone) return false;
  if (task.deadlineDay && compareDay(task.deadlineDay, today) < 0) return true;
  const planned = plannedDayOf(task);
  if (planned && compareDay(planned, today) < 0) return true;
  return false;
}

export function isTaskDueToday(
  task: Pick<Task, "isDone" | "dueDay" | "dueWithTime">,
  today = formatLocalDay(Date.now()),
): boolean {
  if (task.isDone) return false;
  return plannedDayOf(task) === today;
}

export function isTaskUnplanned(
  task: Pick<Task, "isDone" | "dueDay" | "dueWithTime">,
): boolean {
  return !task.isDone && plannedDayOf(task) == null;
}

export function matchTaskQuery(
  task: Pick<Task, "title" | "notes">,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    task.title.toLowerCase().includes(q) ||
    task.notes.toLowerCase().includes(q)
  );
}

export function computeTaskStats(
  tasks: Task[],
  opts: { nowMs?: number; today?: string } = {},
): TaskStats {
  const nowMs = opts.nowMs ?? Date.now();
  const today = opts.today ?? formatLocalDay(nowMs);
  const byProject = new Map<
    string,
    { open: number; done: number; overdue: number }
  >();

  let open = 0;
  let done = 0;
  let overdue = 0;
  let dueToday = 0;
  let unplanned = 0;
  let completedToday = 0;
  let estimateMs = 0;
  let spentMs = 0;

  for (const task of tasks) {
    const row = byProject.get(task.projectId) ?? {
      open: 0,
      done: 0,
      overdue: 0,
    };
    estimateMs += Math.max(0, task.timeEstimate);
    spentMs += Math.max(0, task.timeSpent);

    if (task.isDone) {
      done += 1;
      row.done += 1;
      if (task.doneOn != null && formatLocalDay(task.doneOn) === today) {
        completedToday += 1;
      }
    } else {
      open += 1;
      row.open += 1;
      if (isTaskOverdue(task, today)) {
        overdue += 1;
        row.overdue += 1;
      }
      if (isTaskDueToday(task, today)) dueToday += 1;
      if (isTaskUnplanned(task)) unplanned += 1;
    }
    byProject.set(task.projectId, row);
  }

  return {
    total: tasks.length,
    open,
    done,
    overdue,
    dueToday,
    unplanned,
    completedToday,
    estimateMinutes: Math.round(estimateMs / 60_000),
    spentMinutes: Math.round(spentMs / 60_000),
    byProject: [...byProject.entries()]
      .map(([projectId, counts]) => ({ projectId, ...counts }))
      .sort((a, b) => b.open + b.done - (a.open + a.done)),
  };
}

export function filterTasks(
  tasks: Task[],
  opts: {
    query?: string;
    status?: TaskStatusFilter;
    projectId?: string | null;
    showCompleted?: boolean;
    today?: string;
    rootsOnly?: boolean;
  } = {},
): Task[] {
  const today = opts.today ?? formatLocalDay(Date.now());
  const status = opts.status ?? "all";
  return tasks.filter((task) => {
    if (opts.rootsOnly && task.parentId) return false;
    if (opts.projectId && task.projectId !== opts.projectId) return false;
    if (!matchTaskQuery(task, opts.query ?? "")) return false;

    if (status === "open") return !task.isDone;
    if (status === "done") return task.isDone;
    if (status === "overdue") return isTaskOverdue(task, today);
    if (status === "unplanned") return isTaskUnplanned(task);
    if (status === "today") return isTaskDueToday(task, today);

    if (opts.showCompleted === false && task.isDone) return false;
    return true;
  });
}

export function sortTasks(
  tasks: Task[],
  sortKey: TaskSortKey = "updated",
): Task[] {
  const list = [...tasks];
  list.sort((a, b) => {
    if (sortKey === "title") {
      return a.title.localeCompare(b.title, "zh-CN");
    }
    if (sortKey === "created") return b.createdAt - a.createdAt;
    if (sortKey === "due") {
      const da = plannedDayOf(a) ?? "9999-99-99";
      const db = plannedDayOf(b) ?? "9999-99-99";
      const cmp = compareDay(da, db);
      if (cmp !== 0) return cmp;
      return b.updatedAt - a.updatedAt;
    }
    return b.updatedAt - a.updatedAt;
  });
  return list;
}

export function listChildTasks(tasks: Task[], parentId: string): Task[] {
  return tasks
    .filter((t) => t.parentId === parentId)
    .sort((a, b) => a.createdAt - b.createdAt);
}
