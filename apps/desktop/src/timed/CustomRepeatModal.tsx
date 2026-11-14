import { useState } from "react";
import {
  DEFAULT_AT_TIME,
  formatLocalDay,
  timedIntervalUnitLabel,
  type TimedIntervalUnit,
  type TimedSchedule,
} from "@wb/domain";
import { IconClose } from "../shell/icons";

const UNITS: TimedIntervalUnit[] = ["minute", "hour", "day", "week", "month", "year"];

const HALF_HOUR_TIMES = Array.from({ length: 25 }, (_, i) => {
  const total = 9 * 60 + i * 30;
  const h = String(Math.floor(total / 60)).padStart(2, "0");
  const m = String(total % 60).padStart(2, "0");
  return `${h}:${m}`;
});

type Props = {
  initial?: TimedSchedule;
  onCancel: () => void;
  onConfirm: (schedule: TimedSchedule) => void;
};

export function CustomRepeatModal({ initial, onCancel, onConfirm }: Props) {
  const [every, setEvery] = useState(() =>
    initial?.kind === "custom" ? initial.every : 1,
  );
  const [unit, setUnit] = useState<TimedIntervalUnit>(() =>
    initial?.kind === "custom" ? initial.unit : "day",
  );
  const [atTime, setAtTime] = useState(() =>
    initial && initial.kind !== "once" ? initial.atTime : DEFAULT_AT_TIME,
  );
  const [unitOpen, setUnitOpen] = useState(false);
  const [endMode, setEndMode] = useState<"never" | "on_date">(() =>
    initial?.kind === "custom" ? initial.endMode : "never",
  );
  const [endDate, setEndDate] = useState(() => {
    if (initial?.kind === "custom" && initial.endDate) return initial.endDate;
    return formatLocalDay(1_700_000_000_000);
  });

  return (
    <div className="modal-backdrop" role="presentation" onClick={onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-label="自定义重复"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal__header">
          <h2>自定义重复</h2>
          <button type="button" className="icon-btn" aria-label="关闭" onClick={onCancel}>
            <IconClose size={16} />
          </button>
        </header>

        <div className="modal__body">
          <div className="field">
            <label className="field__label">重复频率</label>
            <div className="custom-freq">
              <input
                className="stepper"
                type="number"
                min={1}
                aria-label="重复间隔"
                value={every}
                onChange={(e) => setEvery(Math.max(1, Number(e.target.value) || 1))}
              />
              <div className="unit-menu">
                <button
                  type="button"
                  className="unit-menu__trigger"
                  aria-expanded={unitOpen}
                  onClick={() => setUnitOpen((v) => !v)}
                >
                  {timedIntervalUnitLabel(unit)}
                </button>
                {unitOpen ? (
                  <ul className="unit-menu__list" role="listbox">
                    {UNITS.map((u) => (
                      <li key={u}>
                        <button
                          type="button"
                          className={
                            u === unit ? "unit-menu__item is-active" : "unit-menu__item"
                          }
                          onClick={() => {
                            setUnit(u);
                            setUnitOpen(false);
                          }}
                        >
                          <span>{timedIntervalUnitLabel(u)}</span>
                          {u === unit ? <span>✓</span> : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </div>
          </div>

          {unit !== "minute" && unit !== "hour" ? (
            <div className="field">
              <label className="field__label" htmlFor="custom-at-time">
                执行时间
              </label>
              <select
                id="custom-at-time"
                className="date-input"
                aria-label="执行时间"
                value={HALF_HOUR_TIMES.includes(atTime) ? atTime : DEFAULT_AT_TIME}
                onChange={(e) => setAtTime(e.target.value || DEFAULT_AT_TIME)}
              >
                {HALF_HOUR_TIMES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div className="field">
            <div className="field__label">结束</div>
            <label className="radio">
              <input
                type="radio"
                name="endMode"
                checked={endMode === "never"}
                onChange={() => setEndMode("never")}
              />
              <span>永不结束</span>
            </label>
            <label className="radio">
              <input
                type="radio"
                name="endMode"
                checked={endMode === "on_date"}
                onChange={() => setEndMode("on_date")}
              />
              <span>指定日期</span>
            </label>
            <input
              type="date"
              className="date-input"
              aria-label="结束日期"
              disabled={endMode !== "on_date"}
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>
        </div>

        <footer className="modal__footer">
          <button type="button" className="btn" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() =>
              onConfirm({
                kind: "custom",
                every,
                unit,
                atTime,
                endMode,
                endDate: endMode === "on_date" ? endDate : null,
              })
            }
          >
            确认
          </button>
        </footer>
      </div>
    </div>
  );
}
