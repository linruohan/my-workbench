import { useEffect, useMemo, useRef, useState } from "react";
import {
  addLocalDays,
  formatLocalDay,
  parseLocalDay,
} from "@wb/domain";

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
};

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

function splitDateTimeLocal(value: string): { day: string; time: string } {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(value);
  if (m) return { day: m[1]!, time: m[2]! };
  const now = Date.now();
  return { day: formatLocalDay(now), time: "15:00" };
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
        <div className="cal-popover__title">
          {formatMonthTitle(props.viewMonth)}
        </div>
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

export function DateField({
  label,
  value,
  onChange,
  allowEmpty,
  emptyLabel = "未设置",
}: DateProps) {
  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(
    () => value || formatLocalDay(Date.now()),
  );
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (value) setViewMonth(value);
  }, [value]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="cal-field" ref={rootRef}>
      <button
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
      {open ? (
        <div className="cal-popover" role="dialog" aria-label="选择日期">
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
        </div>
      ) : null}
    </div>
  );
}

export function DateTimeField({ label, valueLocal, onChange }: DateTimeProps) {
  const parts = splitDateTimeLocal(valueLocal);
  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(parts.day);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setViewMonth(parts.day);
  }, [parts.day]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const display = (() => {
    const ms = Date.parse(valueLocal);
    if (Number.isNaN(ms)) return "选择时刻";
    return new Date(ms).toLocaleString("zh-CN", {
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  })();

  return (
    <div className="cal-field" ref={rootRef}>
      <button
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
      {open ? (
        <div
          className="cal-popover cal-popover--datetime"
          role="dialog"
          aria-label="选择日期与时间"
        >
          <CalendarMonth
            value={parts.day}
            viewMonth={viewMonth}
            onViewMonth={setViewMonth}
            onPick={(day) => onChange(`${day}T${parts.time}`)}
          />
          <div className="cal-popover__footer cal-popover__footer--datetime">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                const t = formatLocalDay(Date.now());
                onChange(`${t}T${parts.time}`);
                setViewMonth(t);
              }}
            >
              今天
            </button>
            <label className="cal-popover__time-label" htmlFor="cal-time">
              时间
            </label>
            <input
              id="cal-time"
              className="field__control cal-popover__time-input"
              type="time"
              value={parts.time}
              onChange={(e) =>
                onChange(`${parts.day}T${e.target.value || "00:00"}`)
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
        </div>
      ) : null}
    </div>
  );
}
