import { addLocalDays, formatLocalDay, parseLocalDay } from "./date.js";
import { remindOptionToMilliseconds } from "./reminder.js";
import type { ReminderOptionId } from "./types.js";
import { INBOX_PROJECT_ID } from "./types.js";

export interface QuickCaptureResult {
  title: string;
  projectTitle: string | null;
  projectId: string | null;
  dueDay: string | null;
  dueWithTime: number | null;
  deadlineDay: string | null;
  deadlineWithTime: number | null;
  remindOption: ReminderOptionId;
  remindAt: number | null;
  summary: string[];
}

const WEEKDAY: Record<string, number> = {
  日: 0,
  天: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
};

function nextWeekday(fromDay: string, weekday: number): string {
  const start = parseLocalDay(fromDay);
  const d = new Date(start);
  const current = d.getDay();
  let delta = (weekday - current + 7) % 7;
  if (delta === 0) delta = 7;
  return addLocalDays(fromDay, delta);
}

function atLocalTime(
  day: string,
  hour: number,
  minute: number,
): number {
  const dt = new Date(parseLocalDay(day));
  dt.setHours(hour, minute, 0, 0);
  return dt.getTime();
}

function parseTimeToken(
  text: string,
  day: string,
): { ms: number; consumed: string } | null {
  const hm = /(上午|下午)?\s*(\d{1,2})[:：](\d{2})/.exec(text);
  if (hm) {
    let hour = Number(hm[2]);
    const minute = Number(hm[3]);
    if (hm[1] === "下午" && hour < 12) hour += 12;
    if (hm[1] === "上午" && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) return null;
    return { ms: atLocalTime(day, hour, minute), consumed: hm[0] };
  }
  const cn =
    /(上午|下午)?\s*(\d{1,2})\s*点(半|(\d{1,2})\s*分?)?/.exec(text);
  if (cn) {
    let hour = Number(cn[2]);
    if (cn[1] === "下午" && hour < 12) hour += 12;
    if (cn[1] === "上午" && hour === 12) hour = 0;
    let minute = 0;
    if (cn[3] === "半") minute = 30;
    else if (cn[4]) minute = Number(cn[4]);
    if (hour > 23 || minute > 59) return null;
    return { ms: atLocalTime(day, hour, minute), consumed: cn[0] };
  }
  return null;
}

/** Parse M.D / M/D / M-D / M月D日, optional trailing 号. */
function parseMonthDayToken(
  text: string,
  today: string,
): { day: string; consumed: string } | null {
  const md = /(\d{1,2})月(\d{1,2})日/.exec(text);
  if (md) {
    const month = Number(md[1]);
    const date = Number(md[2]);
    if (month < 1 || month > 12 || date < 1 || date > 31) return null;
    const y = Number(today.slice(0, 4));
    return {
      day: `${y}-${String(month).padStart(2, "0")}-${String(date).padStart(2, "0")}`,
      consumed: md[0],
    };
  }
  const dotted = /(\d{1,2})[.\/\-](\d{1,2})\s*号?/.exec(text);
  if (dotted) {
    const month = Number(dotted[1]);
    const date = Number(dotted[2]);
    if (month < 1 || month > 12 || date < 1 || date > 31) return null;
    const y = Number(today.slice(0, 4));
    return {
      day: `${y}-${String(month).padStart(2, "0")}-${String(date).padStart(2, "0")}`,
      consumed: dotted[0],
    };
  }
  return null;
}

/**
 * Parse a one-line capture. Unrecognized project (#name) stays in title.
 */
export function parseQuickCapture(
  input: string,
  opts: { nowMs: number; workdayStartHour?: number },
): QuickCaptureResult {
  let text = input.trim();
  const today = formatLocalDay(opts.nowMs);
  const summary: string[] = [];

  let projectTitle: string | null = null;
  const projectMatch = /#([^\s#]+)/.exec(text);
  if (projectMatch) {
    projectTitle = projectMatch[1]!;
    text = text.replace(projectMatch[0], " ").trim();
    summary.push(`项目候选 #${projectTitle}`);
  }

  let remindOption: ReminderOptionId = "none";
  const remindMatch = /提前\s*(\d+)\s*分钟/.exec(text);
  if (remindMatch) {
    const n = Number(remindMatch[1]);
    const map: Record<number, ReminderOptionId> = {
      5: "m5",
      10: "m10",
      15: "m15",
      30: "m30",
      60: "h1",
    };
    remindOption = map[n] ?? "none";
    text = text.replace(remindMatch[0], " ").trim();
    if (remindOption !== "none") summary.push(`提醒 提前${n}分钟`);
  }

  let deadlineDay: string | null = null;
  let deadlineWithTime: number | null = null;
  const deadlineMatch =
    /截止\s*(今天|明天|周五|周[一二三四五六日天]|(\d{1,2})月(\d{1,2})日)/.exec(text);
  if (deadlineMatch) {
    const token = deadlineMatch[1]!;
    if (token === "今天") deadlineDay = today;
    else if (token === "明天") deadlineDay = addLocalDays(today, 1);
    else if (token.startsWith("周") || token === "周五") {
      const w = WEEKDAY[token.slice(-1)] ?? WEEKDAY[token.charAt(1)];
      if (w != null) deadlineDay = nextWeekday(today, w);
    } else if (deadlineMatch[2] && deadlineMatch[3]) {
      const y = Number(today.slice(0, 4));
      deadlineDay = `${y}-${String(Number(deadlineMatch[2])).padStart(2, "0")}-${String(Number(deadlineMatch[3])).padStart(2, "0")}`;
    }
    text = text.replace(deadlineMatch[0], " ").trim();
    if (deadlineDay) summary.push(`截止 ${deadlineDay}`);
  }

  let dueDay: string | null = null;
  let dueWithTime: number | null = null;

  if (/今天/.test(text)) {
    dueDay = today;
    text = text.replace(/今天/, " ").trim();
    summary.push(`计划 ${dueDay}`);
  } else if (/明天/.test(text)) {
    dueDay = addLocalDays(today, 1);
    text = text.replace(/明天/, " ").trim();
    summary.push(`计划 ${dueDay}`);
  } else {
    const week = /下周?([一二三四五六日天])/.exec(text);
    if (week) {
      const w = WEEKDAY[week[1]!];
      if (w != null) {
        dueDay = nextWeekday(today, w);
        text = text.replace(week[0], " ").trim();
        summary.push(`计划 ${dueDay}`);
      }
    } else {
      const md = parseMonthDayToken(text, today);
      if (md) {
        dueDay = md.day;
        text = text.replace(md.consumed, " ").trim();
        summary.push(`计划 ${dueDay}`);
      }
    }
  }

  const planDay = dueDay ?? today;
  const time = parseTimeToken(text, planDay);
  if (time) {
    dueWithTime = time.ms;
    dueDay = null;
    text = text.replace(time.consumed, " ").trim();
    summary.push(
      `时刻 ${formatLocalDay(time.ms)} ${new Date(time.ms).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`,
    );
  }

  let remindAt: number | null = null;
  if (remindOption !== "none" && dueWithTime != null) {
    remindAt = remindOptionToMilliseconds(dueWithTime, remindOption);
  }

  const title = text.replace(/\s+/g, " ").trim() || input.trim();

  return {
    title,
    projectTitle,
    projectId: projectTitle ? null : INBOX_PROJECT_ID,
    dueDay,
    dueWithTime,
    deadlineDay,
    deadlineWithTime,
    remindOption,
    remindAt,
    summary,
  };
}
