import { compareDay, formatLocalDay } from "./date.js";
import { plannedDayOf } from "./scheduling.js";
import type { Task } from "./types.js";

export interface TodayQueryOptions {
  nowMs: number;
  /** Optional explicit today string; defaults to local day of nowMs. */
  today?: string;
}

/**
 * Today membership is computed from plan fields only — never from tags.
 * Includes incomplete tasks whose planned day is today or earlier.
 */
export function isTodayMember(
  task: Pick<Task, "isDone" | "dueDay" | "dueWithTime" | "parentId" | "id">,
  opts: TodayQueryOptions,
): boolean {
  if (task.isDone) return false;
  const day = plannedDayOf(task);
  if (!day) return false;
  const today = opts.today ?? formatLocalDay(opts.nowMs);
  return compareDay(day, today) <= 0;
}

/**
 * Order today list: honor todayOrder positions, drop stale ids,
 * nest under parent when parent is also in today (exclude child from flat list).
 */
export function selectTodayTasks(
  tasks: Task[],
  todayOrder: string[],
  opts: TodayQueryOptions,
): Task[] {
  const members = tasks.filter((t) => isTodayMember(t, opts));
  const byId = new Map(members.map((t) => [t.id, t]));
  const parentAlsoToday = new Set(
    members.filter((t) => t.parentId && byId.has(t.parentId)).map((t) => t.id),
  );

  const flat = members.filter((t) => !parentAlsoToday.has(t.id));
  const flatIds = new Set(flat.map((t) => t.id));

  const ordered: Task[] = [];
  const seen = new Set<string>();

  for (const id of todayOrder) {
    if (!flatIds.has(id) || seen.has(id)) continue;
    const task = byId.get(id);
    if (!task) continue;
    ordered.push(task);
    seen.add(id);
  }

  const rest = flat
    .filter((t) => !seen.has(t.id))
    .sort((a, b) => {
      const at = a.dueWithTime ?? Number.POSITIVE_INFINITY;
      const bt = b.dueWithTime ?? Number.POSITIVE_INFINITY;
      if (at !== bt) return at - bt;
      return a.createdAt - b.createdAt;
    });

  return [...ordered, ...rest];
}

/**
 * Planner shows incomplete root tasks that have a plan (all-day or timed).
 * Pass `day` to limit to that local calendar day; omit to include any planned day.
 */
export function isPlannerMember(
  task: Pick<Task, "isDone" | "dueDay" | "dueWithTime" | "parentId">,
  day?: string | null,
): boolean {
  if (task.isDone || task.parentId) return false;
  const planned = plannedDayOf(task);
  if (!planned) return false;
  if (day == null || day === "") return true;
  return planned === day;
}

/** Planned tasks sorted by day, then clock time, then createdAt. */
export function selectPlannerTasks(tasks: Task[], day?: string | null): Task[] {
  return tasks
    .filter((t) => isPlannerMember(t, day))
    .sort((a, b) => {
      const da = plannedDayOf(a) ?? "9999-99-99";
      const db = plannedDayOf(b) ?? "9999-99-99";
      const byDay = compareDay(da, db);
      if (byDay !== 0) return byDay;
      const at = a.dueWithTime ?? Number.POSITIVE_INFINITY;
      const bt = b.dueWithTime ?? Number.POSITIVE_INFINITY;
      if (at !== bt) return at - bt;
      return a.createdAt - b.createdAt;
    });
}

/** Group already-sorted planner tasks into day sections. */
export function groupPlannerByDay(tasks: Task[]): Array<{ day: string; tasks: Task[] }> {
  const groups: Array<{ day: string; tasks: Task[] }> = [];
  for (const task of tasks) {
    const day = plannedDayOf(task);
    if (!day) continue;
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.tasks.push(task);
    else groups.push({ day, tasks: [task] });
  }
  return groups;
}

/** Schedule timeline shows tasks with a concrete time on that local day. */
export function isScheduleMember(
  task: Pick<Task, "isDone" | "dueWithTime">,
  day: string,
): boolean {
  if (task.isDone || task.dueWithTime == null) return false;
  return formatLocalDay(task.dueWithTime) === day;
}
