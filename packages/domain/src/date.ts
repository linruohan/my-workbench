/** Format local calendar day as YYYY-MM-DD. */
export function formatLocalDay(ms: number, timeZone?: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone ?? undefined,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date(ms));
}

/** Start of local calendar day in ms (local timezone of the runtime). */
export function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Parse YYYY-MM-DD as local midnight. */
export function parseLocalDay(day: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) {
    throw new Error(`Invalid day: ${day}`);
  }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const da = Number(m[3]);
  return new Date(y, mo - 1, da, 0, 0, 0, 0).getTime();
}

export function addLocalDays(day: string, days: number): string {
  const start = parseLocalDay(day);
  return formatLocalDay(start + days * 24 * 60 * 60 * 1000);
}

export function compareDay(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Signed day distance: target − today, in local calendar days. */
export function dayOffset(day: string, nowMs: number): number {
  return Math.round(
    (parseLocalDay(day) - parseLocalDay(formatLocalDay(nowMs))) / 86_400_000,
  );
}

const WEEKDAY_CN = ["日", "一", "二", "三", "四", "五", "六"] as const;

/** Monday of the ISO-like local week containing `day` (Mon–Sun). */
export function mondayOfLocalWeek(day: string): string {
  const d = new Date(parseLocalDay(day));
  const wd = d.getDay(); // 0=Sun … 6=Sat
  const offset = wd === 0 ? -6 : 1 - wd;
  return addLocalDays(day, offset);
}

/**
 * Natural-language calendar day relative to `nowMs`.
 * Updates as the clock crosses midnight: 明天 → 今天, 今天 → 昨天, etc.
 */
export function formatRelativeDay(day: string, nowMs: number): string {
  const offset = dayOffset(day, nowMs);
  if (offset === 0) return "今天";
  if (offset === 1) return "明天";
  if (offset === 2) return "后天";
  if (offset === -1) return "昨天";
  if (offset === -2) return "前天";

  const today = formatLocalDay(nowMs);
  const thisMonday = mondayOfLocalWeek(today);
  const targetMonday = mondayOfLocalWeek(day);
  const weekDiff = Math.round(
    (parseLocalDay(targetMonday) - parseLocalDay(thisMonday)) / 86_400_000 / 7,
  );
  const weekday = WEEKDAY_CN[new Date(parseLocalDay(day)).getDay()] ?? "";

  if (weekDiff === 0) return `周${weekday}`;
  if (weekDiff === 1) return `下周${weekday}`;
  if (weekDiff === -1) return `上周${weekday}`;

  const d = new Date(parseLocalDay(day));
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const da = d.getDate();
  const nowY = new Date(nowMs).getFullYear();
  return y === nowY ? `${m}月${da}日` : `${y}年${m}月${da}日`;
}

/** HH:mm in local time. */
export function formatLocalClock(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** Relative day + clock, e.g. "今天 14:00" / "下周一 09:30". */
export function formatRelativeMoment(ms: number, nowMs: number): string {
  return `${formatRelativeDay(formatLocalDay(ms), nowMs)} ${formatLocalClock(ms)}`;
}
