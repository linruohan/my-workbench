import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  defaultCustomSchedule,
  makePresetSchedule,
  timedPresetLabel,
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

type Pos = { top: number; left: number; width: number; maxHeight: number };

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (schedule: TimedSchedule) => void;
  addLabel?: string;
  menuLabel?: string;
  emptyHint?: ReactNode;
};

function placeMenu(trigger: HTMLElement, menu: HTMLElement): Pos {
  const rect = trigger.getBoundingClientRect();
  const gap = 6;
  const width = Math.max(rect.width, 220);
  const menuH = menu.offsetHeight || 240;
  const spaceBelow = window.innerHeight - rect.bottom - gap - 8;
  const spaceAbove = rect.top - gap - 8;
  const openUp = spaceBelow < Math.min(menuH, 220) && spaceAbove > spaceBelow;
  const maxHeight = Math.max(160, openUp ? spaceAbove : spaceBelow);
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
  const top = openUp
    ? Math.max(8, rect.top - gap - Math.min(menuH, maxHeight))
    : rect.bottom + gap;
  return { top, left, width, maxHeight };
}

export function ScheduleAddMenu({
  open,
  onOpenChange,
  onPick,
  addLabel = "+ 添加重复",
  menuLabel = "添加重复",
  emptyHint,
}: Props) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Pos | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    let raf = 0;
    const update = () => {
      if (!triggerRef.current || !menuRef.current) return;
      setPos(placeMenu(triggerRef.current, menuRef.current));
    };
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
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      onOpenChange(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onOpenChange(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onOpenChange]);

  const pick = (schedule: TimedSchedule) => {
    onPick(schedule);
    onOpenChange(false);
  };

  return (
    <div className="schedule-board" ref={rootRef}>
      {emptyHint}
      <button
        ref={triggerRef}
        type="button"
        className="schedule-add"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => onOpenChange(!open)}
      >
        {addLabel}
      </button>
      {open
        ? createPortal(
            <ul
              ref={menuRef}
              className="schedule-menu schedule-menu--portal"
              role="menu"
              aria-label={menuLabel}
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
              {PRESETS.map((preset) => (
                <li key={preset}>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => pick(makePresetSchedule(preset))}
                  >
                    {timedPresetLabel(preset)}
                  </button>
                </li>
              ))}
              <li>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => pick(defaultCustomSchedule())}
                >
                  自定义
                </button>
              </li>
            </ul>,
            document.body,
          )
        : null}
    </div>
  );
}
