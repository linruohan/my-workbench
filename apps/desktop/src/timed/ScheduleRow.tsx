import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  DEFAULT_AT_TIME,
  makeOnceSchedule,
  makePresetSchedule,
  timedFrequencyLabel,
  timedIntervalUnitLabel,
  timedPresetLabel,
  timedScheduleKindLabel,
  timedScheduleSummary,
  type TimedIntervalUnit,
  type TimedSchedule,
  type TimedSchedulePreset,
} from "@wb/domain";
import { usePortalMenuPos } from "../ui/portalMenu";

const PRESETS: TimedSchedulePreset[] = [
  "hourly",
  "daily",
  "weekdays",
  "weekly",
  "monthly",
];

const UNITS: TimedIntervalUnit[] = ["minute", "hour", "day", "week", "month", "year"];

const TIME_START_MIN = 9 * 60;
const TIME_END_MIN = 21 * 60;

const HALF_HOUR_TIMES = Array.from(
  { length: (TIME_END_MIN - TIME_START_MIN) / 30 + 1 },
  (_, i) => {
    const total = TIME_START_MIN + i * 30;
    const h = String(Math.floor(total / 60)).padStart(2, "0");
    const m = String(total % 60).padStart(2, "0");
    return `${h}:${m}`;
  },
);

/** Default lead time when switching a schedule to one-off. */
const ONCE_DEFAULT_LEAD_MS = 10 * 60 * 1000;

function snapHalfHour(raw: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) return DEFAULT_AT_TIME;
  const hh = Math.min(23, Math.max(0, Number(m[1])));
  const mm = Math.min(59, Math.max(0, Number(m[2])));
  let total = Math.round((hh * 60 + mm) / 30) * 30;
  total = Math.min(TIME_END_MIN, Math.max(TIME_START_MIN, total));
  const outH = String(Math.floor(total / 60)).padStart(2, "0");
  const outM = String(total % 60).padStart(2, "0");
  return `${outH}:${outM}`;
}

/** Format a timestamp as a value for <input type="datetime-local" step="1">. */
function msToDateTimeLocal(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Parse a datetime-local value (with optional seconds) back to a local timestamp. */
function dateTimeLocalToMs(value: string): number {
  return new Date(value).getTime();
}

type Props = {
  schedule: TimedSchedule;
  onChange: (next: TimedSchedule) => void;
  onDelete: () => void;
};

export function ScheduleRow({ schedule, onChange, onDelete }: Props) {
  const [kindOpen, setKindOpen] = useState(false);
  const [freqOpen, setFreqOpen] = useState(false);
  const [timeOpen, setTimeOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const kindTriggerRef = useRef<HTMLButtonElement>(null);
  const kindMenuRef = useRef<HTMLUListElement>(null);
  const freqTriggerRef = useRef<HTMLButtonElement>(null);
  const freqMenuRef = useRef<HTMLDivElement>(null);
  const timeTriggerRef = useRef<HTMLButtonElement>(null);
  const timeMenuRef = useRef<HTMLUListElement>(null);

  const kindPos = usePortalMenuPos(kindOpen, kindTriggerRef, kindMenuRef, 180);
  const freqPos = usePortalMenuPos(freqOpen, freqTriggerRef, freqMenuRef, 280);
  const timePos = usePortalMenuPos(timeOpen, timeTriggerRef, timeMenuRef, 260);

  const atTime = snapHalfHour(
    schedule.kind === "once" ? DEFAULT_AT_TIME : schedule.atTime || DEFAULT_AT_TIME,
  );
  const isOnce = schedule.kind === "once";
  const showTime =
    !isOnce &&
    !(schedule.kind === "preset" && schedule.preset === "hourly") &&
    !(
      schedule.kind === "custom" &&
      (schedule.unit === "minute" || schedule.unit === "hour")
    );
  const showDateTime = isOnce;

  useEffect(() => {
    if (!kindOpen && !freqOpen && !timeOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t)) return;
      if (kindMenuRef.current?.contains(t)) return;
      if (freqMenuRef.current?.contains(t)) return;
      if (timeMenuRef.current?.contains(t)) return;
      setKindOpen(false);
      setFreqOpen(false);
      setTimeOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setKindOpen(false);
      setFreqOpen(false);
      setTimeOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [kindOpen, freqOpen, timeOpen]);

  const setKind = (next: "once" | "custom" | TimedSchedulePreset) => {
    if (next === "once") {
      // Preserve the existing target time when possible; otherwise default to 10 min later.
      const existingAt =
        schedule.kind === "once" ? schedule.at : Date.now() + ONCE_DEFAULT_LEAD_MS;
      onChange(makeOnceSchedule(existingAt));
    } else if (next === "custom") {
      onChange({
        kind: "custom",
        every: 1,
        unit: "day",
        atTime,
        endMode: schedule.kind === "custom" ? schedule.endMode : "never",
        endDate: schedule.kind === "custom" ? schedule.endDate : null,
      });
    } else {
      onChange(makePresetSchedule(next, atTime));
    }
    setKindOpen(false);
  };

  const setAtTime = (next: string) => {
    if (schedule.kind === "once") return;
    onChange({ ...schedule, atTime: snapHalfHour(next) });
    setTimeOpen(false);
  };

  return (
    <div className="schedule-row" ref={rootRef}>
      <div className="schedule-row__controls">
        <div className="pill-menu">
          <button
            ref={kindTriggerRef}
            type="button"
            className="pill"
            aria-label="计划类型"
            aria-expanded={kindOpen}
            aria-haspopup="listbox"
            onClick={() => {
              setFreqOpen(false);
              setTimeOpen(false);
              setKindOpen((v) => !v);
            }}
          >
            {timedScheduleKindLabel(schedule)}
            <span className="pill__caret">▾</span>
          </button>
          {kindOpen
            ? createPortal(
                <ul
                  ref={kindMenuRef}
                  className="pill-menu__list pill-menu__list--portal"
                  role="listbox"
                  aria-label="计划类型选项"
                  style={
                    kindPos
                      ? {
                          top: kindPos.top,
                          left: kindPos.left,
                          width: kindPos.width,
                          maxHeight: kindPos.maxHeight,
                        }
                      : { visibility: "hidden", top: 0, left: 0 }
                  }
                >
                  <li>
                    <button type="button" onClick={() => setKind("once")}>
                      一次性
                    </button>
                  </li>
                  {PRESETS.map((preset) => (
                    <li key={preset}>
                      <button type="button" onClick={() => setKind(preset)}>
                        {timedPresetLabel(preset)}
                      </button>
                    </li>
                  ))}
                  <li>
                    <button type="button" onClick={() => setKind("custom")}>
                      自定义
                    </button>
                  </li>
                </ul>,
                document.body,
              )
            : null}
        </div>

        <div className="pill-menu">
          <button
            ref={freqTriggerRef}
            type="button"
            className="pill"
            aria-label="频率"
            aria-expanded={freqOpen}
            disabled={schedule.kind !== "custom"}
            onClick={() => {
              if (schedule.kind !== "custom") return;
              setKindOpen(false);
              setTimeOpen(false);
              setFreqOpen((v) => !v);
            }}
          >
            {timedFrequencyLabel(schedule)}
            <span className="pill__caret">▾</span>
          </button>
          {freqOpen && schedule.kind === "custom"
            ? createPortal(
                <div
                  ref={freqMenuRef}
                  className="pill-menu__panel pill-menu__panel--portal"
                  role="dialog"
                  aria-label="编辑频率"
                  style={
                    freqPos
                      ? {
                          top: freqPos.top,
                          left: freqPos.left,
                          width: freqPos.width,
                          maxHeight: freqPos.maxHeight,
                        }
                      : { visibility: "hidden", top: 0, left: 0 }
                  }
                >
                  <div className="custom-freq custom-freq--compact">
                    <input
                      className="stepper"
                      type="number"
                      min={1}
                      aria-label="重复间隔"
                      value={schedule.every}
                      onChange={(e) =>
                        onChange({
                          ...schedule,
                          every: Math.max(1, Number(e.target.value) || 1),
                        })
                      }
                    />
                    <select
                      className="pill-select"
                      aria-label="频率单位"
                      value={schedule.unit}
                      onChange={(e) =>
                        onChange({
                          ...schedule,
                          unit: e.target.value as TimedIntervalUnit,
                        })
                      }
                    >
                      {UNITS.map((u) => (
                        <option key={u} value={u}>
                          {timedIntervalUnitLabel(u)}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>,
                document.body,
              )
            : null}
        </div>

        {showTime ? (
          <>
            <span className="schedule-row__at">于</span>
            <div className="pill-menu">
              <button
                ref={timeTriggerRef}
                type="button"
                className="pill"
                aria-label="执行时间"
                aria-expanded={timeOpen}
                aria-haspopup="listbox"
                onClick={() => {
                  setKindOpen(false);
                  setFreqOpen(false);
                  setTimeOpen((v) => !v);
                }}
              >
                {atTime}
                <span className="pill__caret">▾</span>
              </button>
              {timeOpen
                ? createPortal(
                    <ul
                      ref={timeMenuRef}
                      className="pill-menu__list pill-menu__list--portal pill-menu__list--time"
                      role="listbox"
                      aria-label="执行时间"
                      style={
                        timePos
                          ? {
                              top: timePos.top,
                              left: timePos.left,
                              width: timePos.width,
                              maxHeight: timePos.maxHeight,
                            }
                          : { visibility: "hidden", top: 0, left: 0 }
                      }
                    >
                      {HALF_HOUR_TIMES.map((t) => (
                        <li key={t}>
                          <button
                            type="button"
                            role="option"
                            aria-selected={t === atTime}
                            className={t === atTime ? "is-active" : undefined}
                            onClick={() => setAtTime(t)}
                          >
                            {t}
                          </button>
                        </li>
                      ))}
                    </ul>,
                    document.body,
                  )
                : null}
            </div>
          </>
        ) : null}

        {showDateTime && schedule.kind === "once" ? (
          <div className="pill-menu">
            <input
              type="datetime-local"
              step="1"
              className="pill pill--input"
              aria-label="执行时间（精确到秒）"
              value={msToDateTimeLocal(schedule.at)}
              onChange={(e) => {
                const ms = dateTimeLocalToMs(e.target.value);
                if (Number.isFinite(ms)) {
                  onChange({ kind: "once", at: ms });
                }
              }}
            />
          </div>
        ) : null}

        <span className="schedule-row__summary">
          {timedScheduleSummary(isOnce ? schedule : { ...schedule, atTime })}
        </span>
      </div>

      <button
        type="button"
        className="schedule-row__delete"
        aria-label={`删除计划 ${timedScheduleKindLabel(schedule)}`}
        onClick={onDelete}
        title="删除计划"
      >
        <TrashIcon />
      </button>
    </div>
  );
}

function TrashIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M19 6l-1 14H6L5 6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}
