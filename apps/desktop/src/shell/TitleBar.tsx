import { ThemeToggle } from "../theme/ThemeToggle";
import {
  IconClose,
  IconMaximize,
  IconMinimize,
} from "./icons";
import {
  NotificationBell,
  type ActiveReminder,
  type NotificationItem,
} from "./NotificationBell";
import {
  windowClose,
  windowMinimize,
  windowStartDragging,
  windowToggleMaximize,
} from "./window";

type Props = {
  notificationsOpen: boolean;
  onNotificationsOpenChange: (open: boolean) => void;
  notifications: NotificationItem[];
  activeReminders: ActiveReminder[];
  onCompleteReminder: (taskId: string, remindAt: number) => void;
  onDismissReminder: (taskId: string, remindAt: number) => void;
};

export function TitleBar({
  notificationsOpen,
  onNotificationsOpenChange,
  notifications,
  activeReminders,
  onCompleteReminder,
  onDismissReminder,
}: Props) {
  return (
    <header className="titlebar">
      <div
        className="titlebar__drag"
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          void windowStartDragging();
        }}
      >
        <span className="titlebar__brand">个人工作台</span>
      </div>
      <div className="titlebar__controls">
        <ThemeToggle />
        <NotificationBell
          open={notificationsOpen}
          onOpenChange={onNotificationsOpenChange}
          notifications={notifications}
          activeReminders={activeReminders}
          onCompleteReminder={onCompleteReminder}
          onDismissReminder={onDismissReminder}
        />
        <button
          type="button"
          className="titlebar__btn"
          aria-label="最小化"
          onClick={() => void windowMinimize()}
        >
          <IconMinimize size={14} />
        </button>
        <button
          type="button"
          className="titlebar__btn"
          aria-label="最大化"
          onClick={() => void windowToggleMaximize()}
        >
          <IconMaximize size={14} />
        </button>
        <button
          type="button"
          className="titlebar__btn titlebar__btn--close"
          aria-label="关闭"
          onClick={() => void windowClose()}
        >
          <IconClose size={14} />
        </button>
      </div>
    </header>
  );
}
