/** Append transcribed speech into an existing field value. */
export function appendVoiceText(current: string, spoken: string): string {
  return insertVoiceText(current, spoken, null).value;
}

const OPEN_EDGE = /[\s([{（【「『"'“‘]$/u;
const CLOSE_EDGE = /^[\s)\]）】」』"'”’.,!?;:…]/u;

/**
 * Insert spoken text at a caret. When caret is null, appends at the end.
 * Returns the next value and where the caret should land after insert.
 */
export function insertVoiceText(
  current: string,
  spoken: string,
  caret: number | null | undefined,
): { value: string; caret: number } {
  const next = spoken.trim();
  const pos =
    caret == null || !Number.isFinite(caret)
      ? current.length
      : Math.max(0, Math.min(Math.floor(caret), current.length));
  if (!next) return { value: current, caret: pos };

  const before = current.slice(0, pos);
  const after = current.slice(pos);
  const head = joinSpoken(before, next);
  const gap =
    after.length > 0 &&
    !/^\s/u.test(after) &&
    !OPEN_EDGE.test(head) &&
    !CLOSE_EDGE.test(after);
  const value = gap ? `${head} ${after}` : `${head}${after}`;
  return { value, caret: head.length };
}

function joinSpoken(before: string, spoken: string): string {
  const cur = before.replace(/\s+$/u, "");
  if (!cur) return spoken;
  const needsSpace = !OPEN_EDGE.test(cur);
  return needsSpace ? `${cur} ${spoken}` : `${cur}${spoken}`;
}
