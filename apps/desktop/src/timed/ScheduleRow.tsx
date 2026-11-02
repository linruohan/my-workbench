import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_AT_TIME,
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

const PRESETS: TimedSchedulePreset[] = [
  "hourly",
  "daily",
  "weekdays",
  "weekly",
  "monthly",
];

const UNITS: TimedIntervalUnit[] = ["minute", "hour", "day", "week", "month", "year"];

type Props = {
  schedule: TimedSchedule;
  onChange: (next: TimedSchedule) => void;
  onDelete: () => void;
};

export function ScheduleRow({ schedule, onChange, onDelete }: Props) {
  const [kindOpen, setKindOpen] = useState(false);
  const [freqOpen, setFreqOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const showTime =
    !(schedule.kind === "preset" && schedule.preset === "hourly") &&
    !(
      schedule.kind === "custom" &&
      (schedule.unit === "minute" || schedule.unit === "hour")
    );

  useEffect(() => {
    if (!kindOpen && !freqOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setKindOpen(false);
        setFreqOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [kindOpen, freqOpen]);

  const setKind = (next: "custom" | TimedSchedulePreset) => {
    if (next === "custom") {
      onChange({
        kind: "custom",
        every: 1,
        unit: "day",
        atTime: schedule.atTime || DEFAULT_AT_TIME,
        endMode: schedule.kind === "custom" ? schedule.endMode : "never",
        endDate: schedule.kind === "custom" ? schedule.endDate : null,
      });
    } else {
      onChange(makePresetSchedule(next, schedule.atTime || DEFAULT_AT_TIME));
    }
    setKindOpen(false);
  };

  return (
    <div className="schedule-row" ref={rootRef}>
      <div className="schedule-row__controls">
        <div className="pill-menu">
          <button
            type="button"
            className="pill"
            aria-label="计划类型"
            aria-expanded={kindOpen}
            onClick={() => {
              setFreqOpen(false);
              setKindOpen((v) => !v);
            }}
          >
            {timedScheduleKindLabel(schedule)}
            <span className="pill__caret">▾</span>
          </button>
          {kindOpen ? (
            <ul className="pill-menu__list" role="listbox" aria-label="计划类型选项">
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
            </ul>
          ) : null}
        </div>

        <div className="pill-menu">
          <button
            type="button"
            className="pill"
            aria-label="频率"
            aria-expanded={freqOpen}
            disabled={schedule.kind !== "custom"}
            onClick={() => {
              if (schedule.kind !== "custom") return;
              setKindOpen(false);
              setFreqOpen((v) => !v);
            }}
          >
            {timedFrequencyLabel(schedule)}
            <span className="pill__caret">▾</span>
          </button>
          {freqOpen && schedule.kind === "custom" ? (
            <div className="pill-menu__panel" role="dialog" aria-label="编辑频率">
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
            </div>
          ) : null}
        </div>

        {showTime ? (
          <>
            <span className="schedule-row__at">于</span>
            <label className="pill pill--time">
              <input
                type="time"
                aria-label="执行时间"
                value={schedule.atTime || DEFAULT_AT_TIME}
                onChange={(e) =>
                  onChange({ ...schedule, atTime: e.target.value || DEFAULT_AT_TIME })
                }
              />
              <span className="pill__caret">▾</span>
            </label>
          </>
        ) : null}

        <span className="schedule-row__summary">{timedScheduleSummary(schedule)}</span>
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
