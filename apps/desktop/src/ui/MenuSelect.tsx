import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { usePortalMenuPos } from "./portalMenu";

export type MenuSelectOption<T extends string> = {
  value: T;
  label: string;
  style?: CSSProperties;
};

type Props<T extends string> = {
  label: string;
  value: T;
  options: Array<MenuSelectOption<T>>;
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
  preferWidth?: number;
  triggerStyle?: CSSProperties;
};

export function MenuSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  className,
  preferWidth,
  triggerStyle,
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  const selected = options.find((o) => o.value === value) ?? options[0];
  const pos = usePortalMenuPos(open, triggerRef, listRef, preferWidth);

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

  useLayoutEffect(() => {
    if (!open || !listRef.current) return;
    const active = listRef.current.querySelector<HTMLElement>('[aria-selected="true"]');
    active?.scrollIntoView({ block: "nearest" });
  }, [open, value]);

  return (
    <div
      className={className ? `menu-select ${className}` : "menu-select"}
      ref={rootRef}
      data-open={open ? "true" : undefined}
    >
      <button
        ref={triggerRef}
        type="button"
        className={open ? "menu-select__trigger is-open" : "menu-select__trigger"}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        disabled={disabled}
        style={triggerStyle}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="menu-select__value">{selected?.label ?? "请选择"}</span>
        <span className="menu-select__caret" aria-hidden>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path
              d="M2.5 4.25 6 7.75l3.5-3.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
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
              {options.map((opt) => {
                const active = opt.value === value;
                return (
                  <li key={opt.value || "__empty__"} role="presentation">
                    <button
                      type="button"
                      role="option"
                      aria-selected={active}
                      className={
                        active ? "menu-select__option is-active" : "menu-select__option"
                      }
                      style={opt.style}
                      onClick={() => {
                        onChange(opt.value);
                        setOpen(false);
                      }}
                    >
                      <span className="menu-select__option-label">{opt.label}</span>
                      {active ? (
                        <span className="menu-select__check" aria-hidden>
                          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                            <path
                              d="M3 7.2 5.8 10 11 4"
                              stroke="currentColor"
                              strokeWidth="1.7"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>,
            document.body,
          )
        : null}
    </div>
  );
}
