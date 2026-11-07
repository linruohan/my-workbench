import { createId } from "./id.js";
import { formatLocalDay } from "./date.js";
import type {
  TimedIntervalUnit,
  TimedSchedule,
  TimedSchedulePreset,
  TimedTask,
} from "./types.js";

export const DEFAULT_AT_TIME = "09:00";

export function normalizeAtTime(raw: string | null | undefined): string {
  if (!raw || !/^\d{2}:\d{2}$/.test(raw)) return DEFAULT_AT_TIME;
  return raw;
}

export function normalizeTimedSchedule(raw: TimedSchedule): TimedSchedule {
  if (raw.kind === "preset") {
    return {
      kind: "preset",
      preset: raw.preset,
      atTime: normalizeAtTime(raw.atTime),
    };
  }
  return {
    kind: "custom",
    every: Math.max(1, Math.floor(raw.every || 1)),
    unit: raw.unit,
    atTime: normalizeAtTime(raw.atTime),
    endMode: raw.endMode ?? "never",
    endDate: raw.endDate ?? null,
  };
}

/** Resolve a single schedule from current or legacy multi-schedule payloads. */
export function resolveTimedSchedule(
  input:
    | TimedSchedule
    | TimedSchedule[]
    | null
    | undefined
    | { schedule?: TimedSchedule | null; schedules?: TimedSchedule[] },
): TimedSchedule | null {
  if (!input) return null;
  if (Array.isArray(input)) {
    const first = input[0];
    return first ? normalizeTimedSchedule(first) : null;
  }
  if ("kind" in input) {
    return normalizeTimedSchedule(input);
  }
  if (input.schedule) return normalizeTimedSchedule(input.schedule);
  const first = input.schedules?.[0];
  return first ? normalizeTimedSchedule(first) : null;
}

export function createTimedTaskDraft(input: {
  title?: string;
  command?: string;
  schedule?: TimedSchedule | null;
  /** @deprecated use schedule */
  schedules?: TimedSchedule[];
  nowMs?: number;
}): TimedTask {
  const now = input.nowMs ?? Date.now();
  const schedule = resolveTimedSchedule(input.schedule ?? input.schedules ?? null);
  return {
    id: createId(now),
    title: (input.title ?? "未命名定时任务").trim() || "未命名定时任务",
    command: input.command ?? "",
    schedule,
    enabled: true,
    lastRunAt: null,
    nextRunAt: schedule ? computeNextRunAt(schedule, now) : null,
    createdAt: now,
    updatedAt: now,
  };
}

export function patchTimedTask(
  task: TimedTask,
  patch: {
    title?: string;
    command?: string;
    schedule?: TimedSchedule | null;
    /** @deprecated use schedule */
    schedules?: TimedSchedule[];
    enabled?: boolean;
    lastRunAt?: number | null;
  },
  nowMs = Date.now(),
): TimedTask {
  const schedule =
    patch.schedule !== undefined
      ? resolveTimedSchedule(patch.schedule)
      : patch.schedules !== undefined
        ? resolveTimedSchedule(patch.schedules)
        : task.schedule;
  const lastRunAt = patch.lastRunAt !== undefined ? patch.lastRunAt : task.lastRunAt;
  const fromMs = lastRunAt != null && lastRunAt > 0 ? lastRunAt : nowMs;
  return {
    ...task,
    title:
      patch.title !== undefined ? patch.title.trim() || "未命名定时任务" : task.title,
    command: patch.command !== undefined ? patch.command : task.command,
    schedule,
    enabled: patch.enabled !== undefined ? patch.enabled : task.enabled,
    lastRunAt,
    nextRunAt: schedule ? computeNextRunAt(schedule, fromMs) : null,
    updatedAt: nowMs,
  };
}

/** Mark a timed task as fired and advance nextRunAt. */
export function markTimedTaskRan(task: TimedTask, nowMs = Date.now()): TimedTask {
  return patchTimedTask(task, { lastRunAt: nowMs }, nowMs);
}

export function timedPresetLabel(preset: TimedSchedulePreset): string {
  if (preset === "hourly") return "每小时";
  if (preset === "daily") return "每天";
  if (preset === "weekdays") return "每工作日";
  if (preset === "weekly") return "每周";
  return "每月";
}

export function timedIntervalUnitLabel(unit: TimedIntervalUnit): string {
  if (unit === "minute") return "分钟";
  if (unit === "hour") return "小时";
  if (unit === "day") return "天";
  if (unit === "week") return "周";
  if (unit === "month") return "个月";
  return "年";
}

export function timedScheduleKindLabel(schedule: TimedSchedule): string {
  if (schedule.kind === "custom") return "自定义";
  return timedPresetLabel(schedule.preset);
}

export function timedFrequencyLabel(schedule: TimedSchedule): string {
  if (schedule.kind === "preset") {
    if (schedule.preset === "hourly") return "每小时";
    if (schedule.preset === "daily") return "每1天";
    if (schedule.preset === "weekdays") return "每工作日";
    if (schedule.preset === "weekly") return "每1周";
    return "每1个月";
  }
  return `每${schedule.every}${timedIntervalUnitLabel(schedule.unit)}`;
}

export function timedScheduleLabel(schedule: TimedSchedule | null): string {
  if (!schedule) return "未设置计划";
  const s = normalizeTimedSchedule(schedule);
  if (s.kind === "preset") {
    if (s.preset === "hourly") return timedPresetLabel(s.preset);
    return `${timedPresetLabel(s.preset)} · ${s.atTime}`;
  }
  const unit = timedIntervalUnitLabel(s.unit);
  const base = `每 ${s.every} ${unit}`;
  const withTime =
    s.unit === "minute" || s.unit === "hour" ? base : `${base}，${s.atTime}`;
  if (s.endMode === "on_date" && s.endDate) {
    return `${withTime} · 至 ${s.endDate}`;
  }
  return withTime;
}

export function timedScheduleSummary(schedule: TimedSchedule): string {
  const s = normalizeTimedSchedule(schedule);
  if (s.kind === "preset") {
    if (s.preset === "hourly") return "GMT+8 每小时";
    return `GMT+8 ${timedPresetLabel(s.preset)}，${s.atTime}`;
  }
  const unit = timedIntervalUnitLabel(s.unit);
  if (s.unit === "minute" || s.unit === "hour") {
    return `GMT+8 每 ${s.every} ${unit}`;
  }
  return `GMT+8 每 ${s.every} ${unit}，${s.atTime}`;
}

/** @deprecated use timedScheduleLabel */
export function timedSchedulesSummary(
  schedule: TimedSchedule | TimedSchedule[] | null | undefined,
): string {
  return timedScheduleLabel(resolveTimedSchedule(schedule));
}

function applyAtTime(date: Date, atTime: string): void {
  const [hh, mm] = normalizeAtTime(atTime).split(":").map(Number);
  date.setHours(hh ?? 9, mm ?? 0, 0, 0);
}

/** @deprecated use computeNextRunAt */
export function computeNextRunFromSchedules(
  schedules: TimedSchedule[] | TimedSchedule | null | undefined,
  fromMs = Date.now(),
): number | null {
  const schedule = resolveTimedSchedule(schedules);
  return schedule ? computeNextRunAt(schedule, fromMs) : null;
}

export function computeNextRunAt(
  schedule: TimedSchedule,
  fromMs = Date.now(),
): number | null {
  const s = normalizeTimedSchedule(schedule);
  if (s.kind === "custom" && s.endMode === "on_date" && s.endDate) {
    const end = Date.parse(`${s.endDate}T23:59:59`);
    if (!Number.isNaN(end) && fromMs > end) return null;
  }

  const d = new Date(fromMs);
  d.setSeconds(0, 0);

  if (s.kind === "preset") {
    if (s.preset === "hourly") {
      d.setMinutes(0, 0, 0);
      d.setHours(d.getHours() + 1);
      return d.getTime();
    }
    applyAtTime(d, s.atTime);
    if (s.preset === "daily") {
      if (d.getTime() <= fromMs) d.setDate(d.getDate() + 1);
      return d.getTime();
    }
    if (s.preset === "weekdays") {
      do {
        if (d.getTime() <= fromMs) d.setDate(d.getDate() + 1);
        applyAtTime(d, s.atTime);
        const day = d.getDay();
        if (day !== 0 && day !== 6 && d.getTime() > fromMs) break;
        d.setDate(d.getDate() + 1);
        applyAtTime(d, s.atTime);
      } while (true);
      return d.getTime();
    }
    if (s.preset === "weekly") {
      const day = d.getDay();
      const add = day === 1 ? (d.getTime() > fromMs ? 0 : 7) : (8 - day) % 7 || 7;
      d.setDate(d.getDate() + add);
      applyAtTime(d, s.atTime);
      if (d.getTime() <= fromMs) {
        d.setDate(d.getDate() + 7);
        applyAtTime(d, s.atTime);
      }
      return d.getTime();
    }
    d.setDate(1);
    applyAtTime(d, s.atTime);
    if (d.getTime() <= fromMs) {
      d.setMonth(d.getMonth() + 1);
      applyAtTime(d, s.atTime);
    }
    return d.getTime();
  }

  const every = Math.max(1, Math.floor(s.every));
  if (s.unit === "minute") {
    const next = new Date(fromMs);
    next.setSeconds(0, 0);
    next.setMinutes(next.getMinutes() + every);
    return next.getTime();
  }
  if (s.unit === "hour") {
    const next = new Date(fromMs);
    next.setSeconds(0, 0);
    next.setMinutes(0, 0);
    next.setHours(next.getHours() + every);
    return next.getTime();
  }

  applyAtTime(d, s.atTime);
  if (d.getTime() <= fromMs) {
    if (s.unit === "day") d.setDate(d.getDate() + every);
    else if (s.unit === "week") d.setDate(d.getDate() + every * 7);
    else if (s.unit === "month") d.setMonth(d.getMonth() + every);
    else d.setFullYear(d.getFullYear() + every);
    applyAtTime(d, s.atTime);
  }

  if (s.endMode === "on_date" && s.endDate) {
    const end = Date.parse(`${s.endDate}T23:59:59`);
    if (!Number.isNaN(end) && d.getTime() > end) return null;
  }
  return d.getTime();
}

/**
 * Auto-fire only when overdue within this grace window.
 * Older due times (e.g. while the app was closed) are treated as missed/expired.
 */
export const TIMED_TASK_MISS_GRACE_MS = 90_000;

export function isTimedTaskDue(task: TimedTask, nowMs = Date.now()): boolean {
  return task.enabled && task.nextRunAt != null && task.nextRunAt <= nowMs;
}

/** Due long enough that catch-up should wait for an explicit "run now". */
export function isTimedTaskMissed(
  task: TimedTask,
  nowMs = Date.now(),
  graceMs = TIMED_TASK_MISS_GRACE_MS,
): boolean {
  return (
    isTimedTaskDue(task, nowMs) &&
    task.nextRunAt != null &&
    nowMs - task.nextRunAt > graceMs
  );
}

/** Due inside the grace window — safe for the background ticker to fire. */
export function isTimedTaskAutoDue(
  task: TimedTask,
  nowMs = Date.now(),
  graceMs = TIMED_TASK_MISS_GRACE_MS,
): boolean {
  return isTimedTaskDue(task, nowMs) && !isTimedTaskMissed(task, nowMs, graceMs);
}

/** Human-readable overdue label, e.g. "已过期 2 小时". */
export function formatTimedTaskOverdue(nextRunAt: number, nowMs = Date.now()): string {
  const overdueMs = Math.max(0, nowMs - nextRunAt);
  const sec = Math.floor(overdueMs / 1000);
  if (sec < 60) return `已过期 ${Math.max(1, sec)} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `已过期 ${min} 分钟`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `已过期 ${hr} 小时`;
  return `已过期 ${Math.floor(hr / 24)} 天`;
}

/** Prepend selected skill slash tokens when the command does not already name them. */
export function buildTimedTaskPrompt(
  command: string,
  skillNames: readonly string[],
): string {
  const body = command.trim();
  const names = [
    ...new Set(
      skillNames
        .map((name) => name.trim())
        .filter(Boolean)
        .map((name) => name.replace(/^\//, "")),
    ),
  ];
  if (!names.length) return body;
  const tokens = names
    .filter((name) => {
      const token = `/${name}`;
      const pattern = new RegExp(`(?:^|\\s)${escapeRegExp(token)}(?=\\s|$)`);
      return !pattern.test(body);
    })
    .map((name) => `/${name}`);
  if (!tokens.length) return body;
  return body ? `${tokens.join(" ")} ${body}` : tokens.join(" ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function makePresetSchedule(
  preset: TimedSchedulePreset,
  atTime = DEFAULT_AT_TIME,
): TimedSchedule {
  return { kind: "preset", preset, atTime: normalizeAtTime(atTime) };
}

export function defaultCustomSchedule(nowMs = Date.now()): TimedSchedule {
  return {
    kind: "custom",
    every: 1,
    unit: "day",
    atTime: DEFAULT_AT_TIME,
    endMode: "never",
    endDate: formatLocalDay(nowMs),
  };
}

/** Migrate legacy `{ schedules }` payloads into a single `{ schedule }`. */
export function coerceTimedTask(
  raw: TimedTask & {
    schedule?: TimedSchedule | null;
    schedules?: TimedSchedule[];
  },
): TimedTask {
  const { schedules: _legacy, ...rest } = raw;
  const schedule = resolveTimedSchedule(raw);
  return {
    ...rest,
    schedule,
    nextRunAt: schedule ? computeNextRunAt(schedule, raw.updatedAt ?? Date.now()) : null,
  };
}
