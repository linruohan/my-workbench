import { isDshSessionId, mintDshSessionId } from "@wb/domain";

const KEY = "wb.dsh-sessions.v1";

/** One downstream conversation stays on one upstream session. */
export function dshSessionFor(seed: string): string {
  const key = seed.trim() || "global";
  const map = readSessions();
  const current = map[key];
  if (current && isDshSessionId(current)) return current;
  const minted = mintDshSessionId();
  map[key] = minted;
  localStorage.setItem(KEY, JSON.stringify(map));
  return minted;
}

export function dshHostPlatform(): string {
  if (typeof navigator !== "undefined" && navigator.platform.trim()) {
    return navigator.platform.trim();
  }
  return "unknown";
}

function readSessions(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [seed, id] of Object.entries(parsed)) {
      if (typeof id === "string") out[seed] = id;
    }
    return out;
  } catch {
    return {};
  }
}
