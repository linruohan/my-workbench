/** Minimum press duration before a hold-to-talk utterance is transcribed (CapsWriter-style). */
export const VOICE_HOLD_MIN_MS = 500;

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

/**
 * CapsWriter-style paste injection: prefer native insertText (undo-friendly),
 * then fall back to computing the next controlled value for React.
 */
export function injectVoiceIntoField(
  el: HTMLInputElement | HTMLTextAreaElement,
  spoken: string,
): { value: string; caret: number } {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  const withoutSel = el.value.slice(0, start) + el.value.slice(end);
  const result = insertVoiceText(withoutSel, spoken, start);
  const chunk = result.value.slice(start, result.caret);
  if (!chunk) return result;

  try {
    el.focus({ preventScroll: true });
    el.setSelectionRange(start, end);
    // Native insert keeps the browser undo stack, similar to clipboard paste.
    if (document.execCommand("insertText", false, chunk)) {
      return {
        value: el.value,
        caret: el.selectionStart ?? result.caret,
      };
    }
    if (typeof el.setRangeText === "function") {
      el.setRangeText(chunk, start, end, "end");
      el.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertText", data: chunk }),
      );
      return {
        value: el.value,
        caret: el.selectionStart ?? result.caret,
      };
    }
  } catch {
    // fall through to pure value rewrite
  }
  return result;
}

function joinSpoken(before: string, spoken: string): string {
  const cur = before.replace(/\s+$/u, "");
  if (!cur) return spoken;
  const needsSpace = !OPEN_EDGE.test(cur);
  return needsSpace ? `${cur} ${spoken}` : `${cur}${spoken}`;
}
