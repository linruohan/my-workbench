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
