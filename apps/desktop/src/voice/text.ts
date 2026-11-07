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

function dispatchInsertInput(
  el: HTMLInputElement | HTMLTextAreaElement,
  data: string,
): void {
  el.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data,
    }),
  );
}

/** Write value through the native setter so React controlled inputs see the change. */
export function setNativeFieldValue(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

/**
 * CapsWriter-style paste injection: prefer native insertText (undo-friendly),
 * then fall back to a React-safe value write + input event.
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

  const applyResult = () => {
    setNativeFieldValue(el, result.value);
    try {
      el.setSelectionRange(result.caret, result.caret);
    } catch {
      // ignore selection errors on unsupported inputs
    }
    dispatchInsertInput(el, chunk);
    return result;
  };

  try {
    el.focus({ preventScroll: true });
    el.setSelectionRange(start, end);
    // Native insert keeps the browser undo stack, similar to clipboard paste.
    if (document.execCommand("insertText", false, chunk)) {
      // Reconcile spacing / React controlled value if the DOM drifted.
      if (el.value !== result.value) return applyResult();
      return {
        value: el.value,
        caret: el.selectionStart ?? result.caret,
      };
    }
    if (typeof el.setRangeText === "function") {
      el.setRangeText(chunk, start, end, "end");
      if (el.value !== result.value) return applyResult();
      dispatchInsertInput(el, chunk);
      return {
        value: el.value,
        caret: el.selectionStart ?? result.caret,
      };
    }
  } catch {
    // fall through to pure value rewrite
  }

  return applyResult();
}

export function isVoiceEditable(
  el: Element | null,
): el is HTMLInputElement | HTMLTextAreaElement | HTMLElement {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement) {
    if (el.readOnly || el.disabled) return false;
    const type = (el.type || "text").toLowerCase();
    return ![
      "button",
      "checkbox",
      "radio",
      "submit",
      "reset",
      "file",
      "image",
      "hidden",
      "range",
      "color",
    ].includes(type);
  }
  return Boolean(el.isContentEditable);
}

/** Insert spoken text into an input/textarea or contenteditable element. */
export function injectVoiceIntoEditable(el: HTMLElement, spoken: string): boolean {
  const next = spoken.trim();
  if (!next) return false;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    injectVoiceIntoField(el, next);
    return true;
  }
  if (!el.isContentEditable) return false;
  try {
    el.focus({ preventScroll: true });
    if (document.execCommand("insertText", false, next)) return true;
  } catch {
    // fall through
  }
  try {
    const selection = window.getSelection();
    if (!selection) return false;
    if (selection.rangeCount === 0) {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(next);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    el.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: next,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

function joinSpoken(before: string, spoken: string): string {
  const cur = before.replace(/\s+$/u, "");
  if (!cur) return spoken;
  const needsSpace = !OPEN_EDGE.test(cur);
  return needsSpace ? `${cur} ${spoken}` : `${cur}${spoken}`;
}
