/**
 * In-memory per-thread observed paths for the fs observation policy.
 * Cleared when the process restarts; models must re-read after reload.
 */

import { clearObserved, markObserved, observationKey } from "@wb/domain";

const byThread = new Map<string, Set<string>>();

function setFor(threadId: string): Set<string> {
  const id = threadId.trim();
  let set = byThread.get(id);
  if (!set) {
    set = new Set();
    byThread.set(id, set);
  }
  return set;
}

export function rememberObservedPath(
  threadId: string | null | undefined,
  absolutePath: string,
): void {
  const id = threadId?.trim();
  if (!id || !absolutePath.trim()) return;
  markObserved(setFor(id), absolutePath);
}

export function forgetObservedPath(
  threadId: string | null | undefined,
  absolutePath: string,
): void {
  const id = threadId?.trim();
  if (!id) return;
  const set = byThread.get(id);
  if (!set) return;
  clearObserved(set, absolutePath);
}

export function observedPathsFor(
  threadId: string | null | undefined,
): ReadonlySet<string> {
  const id = threadId?.trim();
  if (!id) return new Set();
  return byThread.get(id) ?? new Set();
}

export function clearThreadObservations(threadId: string): void {
  byThread.delete(threadId.trim());
}

export function observationPathKey(absolutePath: string): string {
  return observationKey(absolutePath);
}
