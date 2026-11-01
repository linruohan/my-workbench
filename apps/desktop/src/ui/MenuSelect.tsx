import { useEffect, useId, useRef, useState } from "react";

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
  const listId = useId();
  const selected = options.find((o) => o.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div
      className={className ? `menu-select ${className}` : "menu-select"}
      ref={rootRef}
    >
      <button
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
      {open ? (
        <ul
          id={listId}
          className="menu-select__list"
          role="listbox"
          aria-label={label}
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
        </ul>
      ) : null}
    </div>
  );
}
