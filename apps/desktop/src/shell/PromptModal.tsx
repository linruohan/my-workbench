import { useEffect, useId, useRef, useState } from "react";
import { IconClose } from "./icons";

type Props = {
  open: boolean;
  title: string;
  label: string;
  initialValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onCancel: () => void;
  onConfirm: (value: string) => void;
};

export function PromptModal({
  open,
  title,
  label,
  initialValue = "",
  confirmLabel = "确定",
  cancelLabel = "取消",
  onCancel,
  onConfirm,
}: Props) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (!open) return;
    setValue(initialValue);
    const frame = requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, initialValue]);

  if (!open) return null;

  const submit = () => {
    const next = value.trim();
    if (!next) return;
    onConfirm(next);
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          }
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
      >
        <header className="modal__header">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" aria-label="关闭" onClick={onCancel}>
            <IconClose size={16} />
          </button>
        </header>

        <div className="modal__body">
          <div className="field">
            <label className="field__label" htmlFor={inputId}>
              {label}
            </label>
            <input
              ref={inputRef}
              id={inputId}
              className="date-input"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
        </div>

        <footer className="modal__footer">
          <button type="button" className="btn" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!value.trim()}
            onClick={submit}
          >
            {confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
