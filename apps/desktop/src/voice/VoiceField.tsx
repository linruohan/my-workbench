import { useRef, type ReactNode } from "react";
import { VoiceInputButton } from "./VoiceInputButton";
import { insertVoiceText } from "./text";
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

/** Wrap a text field and attach a voice button that inserts at the caret. */
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
        {children}
      </div>
      <VoiceInputButton
        disabled={disabled}
        onArm={armField}
        onInsert={(text) => {
          rememberCaret();
          const { value: next, caret } = insertVoiceText(
            valueRef.current,
            text,
            caretRef.current ?? valueRef.current.length,
          );
          caretRef.current = caret;
          onChange(next);
          // Wait for React to commit the new value, then focus + place caret.
          requestAnimationFrame(() => {
            focusField(controlRef.current, caret);
          });
        }}
      />
    </div>
  );
}

export function VoiceStatusLine() {
  const { status } = useVoiceInput();
  if (!status) return null;
  return (
    <div className="voice-status" role="status">
      {status}
    </div>
  );
}
