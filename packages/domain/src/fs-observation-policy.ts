/**
 * Session-scoped "read before overwrite" guard (dsh-fs-observation-policy inspired).
 * No version/staleness checks — only whether this session observed the path.
 */

export const FS_NOT_OBSERVED = "FS_NOT_OBSERVED";

export type ObservationDecision =
  { ok: true } | { ok: false; code: typeof FS_NOT_OBSERVED; reason: string };

/** Normalize for Set membership (slash style, trimmed). */
export function observationKey(absolutePath: string): string {
  return absolutePath.trim().replace(/\\/g, "/").replace(/\/+$/u, "") || "/";
}

export function markObserved(observed: Set<string>, absolutePath: string): void {
  const key = observationKey(absolutePath);
  if (key) observed.add(key);
}

export function clearObserved(observed: Set<string>, absolutePath: string): void {
  observed.delete(observationKey(absolutePath));
}

export function isObserved(observed: ReadonlySet<string>, absolutePath: string): boolean {
  return observed.has(observationKey(absolutePath));
}

/** Overwrite / edit an existing file — must have been read (or created) this session. */
export function assertCanModifyExisting(
  observed: ReadonlySet<string>,
  absolutePath: string,
  displayPath?: string,
): ObservationDecision {
  if (isObserved(observed, absolutePath)) return { ok: true };
  const label = displayPath?.trim() || absolutePath;
  return {
    ok: false,
    code: FS_NOT_OBSERVED,
    reason: `cannot modify "${label}": file has not been read — read the file, then retry`,
  };
}

/** Delete an existing file — same gate as modify. */
export function assertCanDeleteExisting(
  observed: ReadonlySet<string>,
  absolutePath: string,
  displayPath?: string,
): ObservationDecision {
  if (isObserved(observed, absolutePath)) return { ok: true };
  const label = displayPath?.trim() || absolutePath;
  return {
    ok: false,
    code: FS_NOT_OBSERVED,
    reason: `cannot delete "${label}": file has not been read — read the file, then retry`,
  };
}
