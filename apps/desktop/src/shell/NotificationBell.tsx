import { useEffect, useRef } from "react";
import { IconBell } from "./icons";

export type NotificationItem = {
  id: string;
  title: string;
  kind: string;
  status: string;
  fireAt: number;
};

export type ActiveReminder = {
  taskId: string;
  title: string;
  remindAt: number;
  isDeadline: boolean;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  notifications: NotificationItem[];
  activeReminders: ActiveReminder[];
  onCompleteReminder: (taskId: string, remindAt: number) => void;
  onDismissReminder: (taskId: string, remindAt: number) => void;
};

export function NotificationBell({
  open,
  onOpenChange,
  notifications,
  activeReminders,
  onCompleteReminder,
  onDismissReminder,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const count = notifications.length + activeReminders.length;

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        onOpenChange(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onOpenChange]);

  return (
    <div className="notif" ref={rootRef}>
      <button
        type="button"
        className={open ? "titlebar__btn is-active" : "titlebar__btn"}
        aria-label={count > 0 ? `通知（${count}）` : "通知"}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => onOpenChange(!open)}
      >
        <span className="notif__icon">
          <IconBell size={15} />
          {count > 0 ? (
            <span className="notif__badge">{count > 9 ? "9+" : count}</span>
          ) : null}
        </span>
      </button>
      {open ? (
        <div className="notif__panel" role="dialog" aria-label="通知中心">
          <header className="notif__header">
            <strong>通知</strong>
            <span className="notif__count">{count}</span>
          </header>
          {activeReminders.length === 0 && notifications.length === 0 ? (
            <p className="notif__empty">暂无通知。提醒到期后会出现在这里。</p>
          ) : (
            <ul className="notif__list">
              {activeReminders.map((r) => (
                <li key={`${r.taskId}-${r.remindAt}`} className="notif__item">
                  <div className="notif__item-body">
                    <div className="notif__item-title">{r.title}</div>
                    <div className="notif__item-meta">
                      {r.isDeadline ? "截止提醒" : "计划提醒"} · 待处理
                    </div>
                  </div>
                  <div className="notif__item-actions">
                    <button
                      type="button"
                      onClick={() => onCompleteReminder(r.taskId, r.remindAt)}
                    >
                      完成
                    </button>
                    <button
                      type="button"
                      onClick={() => onDismissReminder(r.taskId, r.remindAt)}
                    >
                      稍后
                    </button>
                  </div>
                </li>
              ))}
              {notifications.map((n) => (
                <li key={n.id} className="notif__item">
                  <div className="notif__item-body">
                    <div className="notif__item-title">{n.title}</div>
                    <div className="notif__item-meta">
                      {n.kind} · {n.status} · {new Date(n.fireAt).toLocaleString("zh-CN")}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
