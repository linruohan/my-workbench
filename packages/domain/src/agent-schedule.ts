/**
 * DSH schedule_* helpers mapped onto workbench TimedTask.
 * Supports a small RFC 5545 subset: DTSTART + FREQ/INTERVAL/BYDAY/COUNT/UNTIL.
 */

import type { TimedSchedule, TimedSchedulePreset, TimedTask } from "./types.js";

export type ScheduleTarget = "this_session" | "new_once" | "new";

export type ScheduleView = {
  id: string;
  title: string;
  prompt: string;
  rrule: string;
  target: ScheduleTarget;
  active: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  updatedAt: number;
};

export function parseScheduleRrule(
  raw: string,
):
  | { ok: true; schedule: TimedSchedule; rruleText: string }
  | { ok: false; reason: string } {
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (!text) return { ok: false, reason: "请提供 rrule" };
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  let freq = "";
  let interval = 1;
  let byDay = "";
  let until = "";
  let atTime = "09:00";
  for (const line of lines) {
    if (line.toUpperCase().startsWith("DTSTART")) {
      const stamp = line.split(":")[1] ?? line.split(";")[0] ?? "";
      const match = /(\d{2})(\d{2})(\d{2})$/.exec(
        stamp.replace(/[^0-9TZ]/g, "").slice(-6),
      );
      if (match) atTime = `${match[1]}:${match[2]}`;
      const full = /(\d{8})T(\d{2})(\d{2})/.exec(stamp);
      if (full) atTime = `${full[2]}:${full[3]}`;
      continue;
    }
    const body = line.toUpperCase().startsWith("RRULE:") ? line.slice(6) : line;
    for (const part of body.split(";")) {
      const [key, value] = part.split("=");
      if (!key || value == null) continue;
      if (key === "FREQ") freq = value;
      if (key === "INTERVAL") interval = Math.max(1, Number(value) || 1);
      if (key === "BYDAY") byDay = value;
      if (key === "UNTIL") until = value.slice(0, 8);
    }
  }
  if (!freq) return { ok: false, reason: "rrule 缺少 FREQ" };
  let schedule: TimedSchedule;
  if (freq === "HOURLY") {
    schedule =
      interval === 1
        ? { kind: "preset", preset: "hourly", atTime }
        : {
            kind: "custom",
            every: interval,
            unit: "hour",
            atTime,
            endMode: "never",
            endDate: null,
          };
  } else if (freq === "DAILY") {
    schedule =
      interval === 1
        ? { kind: "preset", preset: "daily", atTime }
        : {
            kind: "custom",
            every: interval,
            unit: "day",
            atTime,
            endMode: "never",
            endDate: null,
          };
  } else if (freq === "WEEKLY") {
    const days = byDay.split(",").filter(Boolean);
    const weekdays = ["MO", "TU", "WE", "TH", "FR"];
    const isWeekdays = days.length === 5 && weekdays.every((day) => days.includes(day));
    if (isWeekdays && interval === 1) {
      schedule = { kind: "preset", preset: "weekdays", atTime };
    } else if (interval === 1 && (!days.length || days.length === 1)) {
      schedule = { kind: "preset", preset: "weekly", atTime };
    } else {
      schedule = {
        kind: "custom",
        every: interval,
        unit: "week",
        atTime,
        endMode: "never",
        endDate: null,
      };
    }
  } else if (freq === "MONTHLY") {
    schedule =
      interval === 1
        ? { kind: "preset", preset: "monthly", atTime }
        : {
            kind: "custom",
            every: interval,
            unit: "month",
            atTime,
            endMode: "never",
            endDate: null,
          };
  } else if (freq === "MINUTELY") {
    schedule = {
      kind: "custom",
      every: interval,
      unit: "minute",
      atTime,
      endMode: "never",
      endDate: null,
    };
  } else {
    return { ok: false, reason: `不支持的 FREQ=${freq}` };
  }
  if (until && /^\d{8}$/.test(until)) {
    const endDate = `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}`;
    if (schedule.kind === "custom") {
      schedule = { ...schedule, endMode: "on_date", endDate };
    } else {
      schedule = {
        kind: "custom",
        every: 1,
        unit: presetToUnit(schedule.preset),
        atTime: schedule.atTime,
        endMode: "on_date",
        endDate,
      };
    }
  }
  return { ok: true, schedule, rruleText: text };
}

export function timedTaskToRrule(task: TimedTask): string {
  const schedule = task.schedule;
  if (!schedule) return "";
  const at = schedule.atTime.replace(":", "");
  const dt = `DTSTART:20260101T${at}00`;
  if (schedule.kind === "preset") {
    if (schedule.preset === "hourly") return `${dt}\nRRULE:FREQ=HOURLY`;
    if (schedule.preset === "daily") return `${dt}\nRRULE:FREQ=DAILY`;
    if (schedule.preset === "weekdays") {
      return `${dt}\nRRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR`;
    }
    if (schedule.preset === "weekly") return `${dt}\nRRULE:FREQ=WEEKLY`;
    return `${dt}\nRRULE:FREQ=MONTHLY`;
  }
  const freq =
    schedule.unit === "minute"
      ? "MINUTELY"
      : schedule.unit === "hour"
        ? "HOURLY"
        : schedule.unit === "day"
          ? "DAILY"
          : schedule.unit === "week"
            ? "WEEKLY"
            : schedule.unit === "month"
              ? "MONTHLY"
              : "YEARLY";
  let rule = `RRULE:FREQ=${freq};INTERVAL=${schedule.every}`;
  if (schedule.endMode === "on_date" && schedule.endDate) {
    rule += `;UNTIL=${schedule.endDate.replace(/-/g, "")}`;
  }
  return `${dt}\n${rule}`;
}

export function viewScheduleTask(
  task: TimedTask,
  meta?: { target?: ScheduleTarget },
): ScheduleView {
  return {
    id: task.id,
    title: task.title,
    prompt: task.command,
    rrule: timedTaskToRrule(task),
    target: meta?.target ?? "this_session",
    active: task.enabled,
    nextRunAt: task.nextRunAt,
    lastRunAt: task.lastRunAt,
    updatedAt: task.updatedAt,
  };
}

export function parseScheduleTarget(raw: unknown): ScheduleTarget | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  if (value === "this_session" || value === "new_once" || value === "new") {
    return value;
  }
  return null;
}

export function formatScheduleListLine(view: ScheduleView): string {
  const when = view.nextRunAt ? new Date(view.nextRunAt).toLocaleString("zh-CN") : "n/a";
  const state = view.active ? "active" : "paused";
  return `${view.id} [${state}] ${view.title} — next ${when}`;
}

function presetToUnit(preset: TimedSchedulePreset): "hour" | "day" | "week" | "month" {
  if (preset === "hourly") return "hour";
  if (preset === "daily" || preset === "weekdays") return "day";
  if (preset === "weekly") return "week";
  return "month";
}
