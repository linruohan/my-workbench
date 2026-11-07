/** Only one microphone consumer (preview or dictation) may own the device. */

type MicOwner = {
  id: string;
  /** Called only when another consumer preempts this owner. */
  onPreempt: () => void | Promise<void>;
};

let owner: MicOwner | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function subscribeMicLock(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function micLockOwnerId(): string | null {
  return owner?.id ?? null;
}

export function isMicLockedBy(id: string): boolean {
  return owner?.id === id;
}

/** Take exclusive mic ownership; previous owner is preempted first. */
export async function acquireMicLock(
  id: string,
  onPreempt: () => void | Promise<void>,
): Promise<void> {
  if (owner && owner.id === id) {
    owner = { id, onPreempt };
    return;
  }
  if (owner) {
    const previous = owner;
    owner = null;
    notify();
    try {
      await previous.onPreempt();
    } catch {
      // ignore previous release failures
    }
  }
  owner = { id, onPreempt };
  notify();
}

/** Drop ownership without invoking onPreempt (voluntary stop). */
export function releaseMicLock(id: string): void {
  if (!owner || owner.id !== id) return;
  owner = null;
  notify();
}
