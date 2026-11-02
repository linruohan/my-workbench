import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { addLocalDays, formatLocalDay, parseLocalDay } from "@wb/domain";

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

type DateProps = {
  label: string;
  value: string;
  onChange: (day: string) => void;
  allowEmpty?: boolean;
  emptyLabel?: string;
};

type DateTimeProps = {
  label: string;
  valueLocal: string;
  onChange: (local: string) => void;
  allowEmpty?: boolean;
  emptyLabel?: string;
  /** Used when picking a day while value is empty. */
  defaultTime?: string;
};

type PopoverPos = { top: number; left: number; width: number };

function monthMatrix(anchorDay: string): string[] {
  const start = parseLocalDay(anchorDay);
  const first = new Date(start);
  first.setDate(1);
  const firstDay = formatLocalDay(first.getTime());
  const weekday = (first.getDay() + 6) % 7;
  const gridStart = addLocalDays(firstDay, -weekday);
  return Array.from({ length: 42 }, (_, i) => addLocalDays(gridStart, i));
}

function shiftMonth(day: string, delta: number): string {
  const d = new Date(parseLocalDay(day));
  d.setDate(1);
  d.setMonth(d.getMonth() + delta);
  return formatLocalDay(d.getTime());
}

function formatDisplayDay(day: string): string {
  if (!day) return "未设置";
  const d = new Date(parseLocalDay(day));
  return d.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  });
}

function formatMonthTitle(day: string): string {
  const d = new Date(parseLocalDay(day));
  return d.toLocaleDateString("zh-CN", { year: "numeric", month: "long" });
}

function splitDateTimeLocal(
  value: string,
  fallbackTime = "09:00",
): { day: string; time: string } {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(value);
  if (m) return { day: m[1]!, time: m[2]! };
  const now = Date.now();
  return { day: formatLocalDay(now), time: fallbackTime };
}

function placePopover(
  trigger: HTMLElement,
  popover: HTMLElement,
  preferWidth: number,
): PopoverPos {
  const rect = trigger.getBoundingClientRect();
  const gap = 4;
  const width = Math.min(preferWidth, window.innerWidth - 16);
  let left = Math.min(rect.left, window.innerWidth - width - 8);
  left = Math.max(8, left);

  const spaceBelow = window.innerHeight - rect.bottom - gap;
  const spaceAbove = rect.top - gap;
  const needed = popover.offsetHeight || 280;

  let top: number;
  if (spaceBelow >= needed || spaceBelow >= spaceAbove) {
    top = rect.bottom + gap;
    if (top + needed > window.innerHeight - 8) {
      top = Math.max(8, window.innerHeight - needed - 8);
    }
  } else {
    top = rect.top - needed - gap;
    if (top < 8) top = 8;
  }

  return { top, left, width };
}

function CalendarMonth(props: {
  value: string;
  viewMonth: string;
  onViewMonth: (day: string) => void;
  onPick: (day: string) => void;
}) {
  const days = useMemo(() => monthMatrix(props.viewMonth), [props.viewMonth]);
  const today = formatLocalDay(Date.now());
  const viewMonthKey = props.viewMonth.slice(0, 7);

  return (
    <>
      <div className="cal-popover__head">
        <button
          type="button"
          className="cal-popover__nav"
          aria-label="上个月"
          onClick={() => props.onViewMonth(shiftMonth(props.viewMonth, -1))}
        >
          ‹
        </button>
        <div className="cal-popover__title">{formatMonthTitle(props.viewMonth)}</div>
        <button
          type="button"
          className="cal-popover__nav"
          aria-label="下个月"
          onClick={() => props.onViewMonth(shiftMonth(props.viewMonth, 1))}
        >
          ›
        </button>
      </div>
      <div className="cal-popover__weekdays">
        {WEEKDAYS.map((w) => (
          <span key={w}>{w}</span>
        ))}
      </div>
      <div className="cal-popover__grid">
        {days.map((day) => {
          const inMonth = day.slice(0, 7) === viewMonthKey;
          const selected = day === props.value;
          const isToday = day === today;
          return (
            <button
              key={day}
              type="button"
              className={[
                "cal-popover__day",
                inMonth ? "" : "is-outside",
                selected ? "is-selected" : "",
                isToday ? "is-today" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => props.onPick(day)}
            >
              {Number(day.slice(8))}
            </button>
          );
        })}
      </div>
    </>
  );
}

function useCalPopover(open: boolean, preferWidth: number) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<PopoverPos | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    let raf = 0;
    const update = () => {
      if (!triggerRef.current || !popoverRef.current) return;
      setPos(placePopover(triggerRef.current, popoverRef.current, preferWidth));
    };
    // Measure twice: first paint may underestimate height (time row etc.).
    update();
    raf = requestAnimationFrame(() => {
      update();
      raf = requestAnimationFrame(update);
    });
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, preferWidth]);

  return { triggerRef, popoverRef, rootRef, pos };
}

export function DateField({
  label,
  value,
  onChange,
  allowEmpty,
  emptyLabel = "未设置",
}: DateProps) {
  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(() => value || formatLocalDay(Date.now()));
  const { triggerRef, popoverRef, rootRef, pos } = useCalPopover(open, 248);

  useEffect(() => {
    if (value) setViewMonth(value);
  }, [value]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, rootRef, popoverRef]);

  return (
    <div className="cal-field" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="menu-select__trigger"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{value ? formatDisplayDay(value) : emptyLabel}</span>
        <span className="menu-select__caret" aria-hidden>
          ▾
        </span>
      </button>
      {open
        ? createPortal(
            <div
              ref={popoverRef}
              className="cal-popover cal-popover--portal"
              role="dialog"
              aria-label="选择日期"
              style={
                pos
                  ? {
                      top: pos.top,
                      left: pos.left,
                      width: pos.width,
                    }
                  : { visibility: "hidden", top: 0, left: 0 }
              }
            >
              <CalendarMonth
                value={value}
                viewMonth={viewMonth}
                onViewMonth={setViewMonth}
                onPick={(day) => {
                  onChange(day);
                  setOpen(false);
                }}
              />
              <div className="cal-popover__footer">
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => {
                    const t = formatLocalDay(Date.now());
                    onChange(t);
                    setViewMonth(t);
                    setOpen(false);
                  }}
                >
                  今天
                </button>
                {allowEmpty ? (
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => {
                      onChange("");
                      setOpen(false);
                    }}
                  >
                    清除
                  </button>
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

export function DateTimeField({
  label,
  valueLocal,
  onChange,
  allowEmpty,
  emptyLabel = "未设置",
  defaultTime = "09:00",
}: DateTimeProps) {
  const parts = splitDateTimeLocal(valueLocal, defaultTime);
  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(parts.day);
  const { triggerRef, popoverRef, rootRef, pos } = useCalPopover(open, 280);
  const hasValue = Boolean(valueLocal && !Number.isNaN(Date.parse(valueLocal)));

  useEffect(() => {
    setViewMonth(parts.day);
  }, [parts.day]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, rootRef, popoverRef]);

  const display = (() => {
    if (!hasValue) return emptyLabel;
    const ms = Date.parse(valueLocal);
    return new Date(ms).toLocaleString("zh-CN", {
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  })();

  const activeTime = hasValue ? parts.time : defaultTime;
  const activeDay = hasValue ? parts.day : formatLocalDay(Date.now());

  return (
    <div className="cal-field" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="menu-select__trigger"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{display}</span>
        <span className="menu-select__caret" aria-hidden>
          ▾
        </span>
      </button>
      {open
        ? createPortal(
            <div
              ref={popoverRef}
              className="cal-popover cal-popover--datetime cal-popover--portal"
              role="dialog"
              aria-label="选择日期与时间"
              style={
                pos
                  ? {
                      top: pos.top,
                      left: pos.left,
                      width: pos.width,
                    }
                  : { visibility: "hidden", top: 0, left: 0 }
              }
            >
              <CalendarMonth
                value={hasValue ? parts.day : ""}
                viewMonth={viewMonth}
                onViewMonth={setViewMonth}
                onPick={(day) => onChange(`${day}T${activeTime}`)}
              />
              <div className="cal-popover__footer cal-popover__footer--datetime">
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => {
                    const at = Date.now();
                    const t = formatLocalDay(at);
                    const time = hasValue
                      ? parts.time
                      : (() => {
                          const d = new Date(at);
                          const pad = (n: number) => String(n).padStart(2, "0");
                          return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
                        })();
                    onChange(`${t}T${time}`);
                    setViewMonth(t);
                  }}
                >
                  今天
                </button>
                {allowEmpty ? (
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => {
                      onChange("");
                      setOpen(false);
                    }}
                  >
                    清除
                  </button>
                ) : null}
                <input
                  className="field__control cal-popover__time-input"
                  type="time"
                  aria-label="时间"
                  value={activeTime}
                  onChange={(e) =>
                    onChange(
                      `${activeDay}T${e.target.value || defaultTime}`,
                    )
                  }
                />
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => setOpen(false)}
                >
                  完成
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
