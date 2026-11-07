/**
 * Spill file aging helpers (DSH spill-local cleanupPeriodDays inspired).
 */

/** Default retention; `0` disables cleanup. */
export const SPILL_CLEANUP_PERIOD_DAYS = 30;

export type SpillFileMeta = {
  name: string;
  path: string;
  isDir: boolean;
  mtimeMs?: number | null;
};

/** Pick ordinary spill files older than `maxAgeDays` (by mtime). */
export function selectExpiredSpillFiles(
  entries: readonly SpillFileMeta[],
  options?: { maxAgeDays?: number; nowMs?: number },
): SpillFileMeta[] {
  const maxAgeDays = options?.maxAgeDays ?? SPILL_CLEANUP_PERIOD_DAYS;
  if (maxAgeDays <= 0) return [];
  const nowMs = options?.nowMs ?? Date.now();
  const cutoff = nowMs - maxAgeDays * 24 * 60 * 60 * 1000;
  return entries.filter((entry) => {
    if (entry.isDir) return false;
    if (!entry.name || entry.name.startsWith(".")) return false;
    const mtime = entry.mtimeMs;
    if (typeof mtime !== "number" || !Number.isFinite(mtime)) return false;
    return mtime < cutoff;
  });
}
