/** Lightweight ULID-like id: time prefix + random. Good enough for local single-user. */
export function createId(nowMs = Date.now()): string {
  const time = nowMs.toString(36).padStart(8, "0");
  const rand = Math.random().toString(36).slice(2, 10).padEnd(8, "0");
  return `${time}${rand}`;
}
