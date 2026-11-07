import { useRef, type ReactNode } from "react";
import { VoiceInputButton } from "./VoiceInputButton";
import { injectVoiceIntoField, insertVoiceText } from "./text";
import { useVoiceInput } from "./VoiceInputContext";

type Props = {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  className?: string;
  /** Where to place the mic relative to the control. */
  placement?: "end" | "toolbar";
  children: ReactNode;
};

type TextControl = HTMLTextAreaElement | HTMLInputElement;

function findField(root: HTMLElement | null): TextControl | null {
  if (!root) return null;
  return root.querySelector(
    "textarea, input:not([type='checkbox']):not([type='radio']):not([type='button']):not([type='submit'])",
  ) as TextControl | null;
}

function readCaret(root: HTMLElement | null): number | null {
  const el = findField(root);
  if (!el || typeof el.selectionStart !== "number") return null;
  return el.selectionStart;
}

function focusField(root: HTMLElement | null, caret?: number | null): number | null {
  const el = findField(root);
  if (!el) return null;
  const pos =
    caret == null || !Number.isFinite(caret)
      ? typeof el.selectionStart === "number"
        ? el.selectionStart
        : el.value.length
      : Math.max(0, Math.min(Math.floor(caret), el.value.length));
  try {
    el.focus({ preventScroll: true });
    if (typeof el.setSelectionRange === "function") {
      el.setSelectionRange(pos, pos);
    }
  } catch {
    el.focus();
  }
  return pos;
}

/** Wrap a text field and attach a hold-to-talk mic that pastes at the caret. */
export function VoiceField({
  value,
  onChange,
  disabled = false,
  className,
  placement = "end",
  children,
}: Props) {
  const voice = useVoiceInput();
  const controlRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<number | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  if (!voice.enabled) {
    return <>{children}</>;
  }

  const rememberCaret = () => {
    const caret = readCaret(controlRef.current);
    if (caret != null) caretRef.current = caret;
  };

  const armField = () => {
    rememberCaret();
    const pos = focusField(
      controlRef.current,
      caretRef.current ?? valueRef.current.length,
    );
    if (pos != null) caretRef.current = pos;
  };

  // Only show while CapsLock/mic PTT is active (or transient errors); never idle "ready".
  const hint = voice.status?.split("\n")[0]?.trim() || "";

  return (
    <div
      className={
        placement === "toolbar"
          ? ["voice-field", "voice-field--toolbar", className].filter(Boolean).join(" ")
          : ["voice-field", className].filter(Boolean).join(" ")
      }
    >
      <div
        className="voice-field__control"
        ref={controlRef}
        onKeyUp={rememberCaret}
        onClick={rememberCaret}
        onSelect={rememberCaret}
        onInput={rememberCaret}
      >
        {hint ? (
          <div className="voice-field__hint" role="status" aria-live="polite">
            {hint}
          </div>
        ) : null}
        {children}
      </div>
      <VoiceInputButton
        disabled={disabled}
        onArm={armField}
        onInsert={(text) => {
          const el = findField(controlRef.current);
          if (el) {
            // Restore caret remembered at arm time, then paste-inject.
            const pos = caretRef.current ?? el.value.length;
            try {
              el.focus({ preventScroll: true });
              el.setSelectionRange(pos, pos);
            } catch {
              // ignore
            }
            const result = injectVoiceIntoField(el, text);
            caretRef.current = result.caret;
            onChange(result.value);
            requestAnimationFrame(() => focusField(controlRef.current, result.caret));
            return;
          }
          const { value: next, caret } = insertVoiceText(
            valueRef.current,
            text,
            caretRef.current ?? valueRef.current.length,
          );
          caretRef.current = caret;
          onChange(next);
          requestAnimationFrame(() => focusField(controlRef.current, caret));
        }}
      />
    </div>
  );
}

/** Floating status line for surfaces that already sit above a composer (e.g. Agent). */
export function VoiceStatusLine() {
  const { status } = useVoiceInput();
  if (!status) return null;
  return (
    <div className="voice-status" role="status">
      {status.split("\n")[0]}
    </div>
  );
}
