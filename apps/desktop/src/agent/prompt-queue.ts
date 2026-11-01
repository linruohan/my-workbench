/** Prompts waiting to run after the current remote turn. Renderer-local, not the tool queue. */

export function enqueuePrompt(queue: readonly string[], text: string): string[] {
  const next = text.trim();
  if (!next) return [...queue];
  return [...queue, next];
}

export function removeQueuedPrompt(queue: readonly string[], index: number): string[] {
  if (!Number.isInteger(index) || index < 0 || index >= queue.length) return [...queue];
  return queue.filter((_, item) => item !== index);
}

/** Move one queued line into an empty composer. A non-empty draft is left untouched. */
export function recallQueuedPrompt(
  queue: readonly string[],
  index: number,
  draft: string,
): { queue: string[]; draft: string } | null {
  if (draft.trim()) return null;
  if (!Number.isInteger(index) || index < 0 || index >= queue.length) return null;
  return {
    queue: queue.filter((_, item) => item !== index),
    draft: queue[index] ?? "",
  };
}
