import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePortalMenuPos } from "./portalMenu";

export type MenuSelectOption<T extends string> = {
  value: T;
  label: string;
};

type Props<T extends string> = {
  label: string;
  value: T;
  options: Array<MenuSelectOption<T>>;
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
};

export function MenuSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  className,
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  const selected = options.find((o) => o.value === value) ?? options[0];
  const pos = usePortalMenuPos(open, triggerRef, listRef);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t)) return;
      if (listRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={className ? `menu-select ${className}` : "menu-select"} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="menu-select__trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{selected?.label ?? "请选择"}</span>
        <span className="menu-select__caret" aria-hidden>
          ▾
        </span>
      </button>
      {open
        ? createPortal(
            <ul
              ref={listRef}
              id={listId}
              className="menu-select__list menu-select__list--portal"
              role="listbox"
              aria-label={label}
              style={
                pos
                  ? {
                      top: pos.top,
                      left: pos.left,
                      width: pos.width,
                      maxHeight: pos.maxHeight,
                    }
                  : { visibility: "hidden", top: 0, left: 0 }
              }
            >
              {options.map((opt) => (
                <li key={opt.value} role="presentation">
                  <button
                    type="button"
                    role="option"
                    aria-selected={opt.value === value}
                    className={
                      opt.value === value
                        ? "menu-select__option is-active"
                        : "menu-select__option"
                    }
                    onClick={() => {
                      onChange(opt.value);
                      setOpen(false);
                    }}
                  >
                    {opt.label}
                  </button>
                </li>
              ))}
            </ul>,
            document.body,
          )
        : null}
    </div>
  );
}
