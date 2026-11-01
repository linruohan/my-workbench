export const INBOX_PROJECT_ID = "inbox";
export const FORBIDDEN_TODAY_TAG_ID = "TODAY";

export type ProjectBucket = "active" | "backlog";

export type ReminderOptionId = "none" | "at_start" | "m5" | "m10" | "m15" | "m30" | "h1";

export type RepeatCycle = "day" | "week" | "month";
export type RepeatScheduleType = "fixed" | "after_completion";
export type OverduePolicy = "keep_latest" | "keep_all";

export type NotificationKind =
  "task_remind" | "deadline_remind" | "event_remind" | "agent" | "system";

export type NotificationStatus =
  "pending" | "delivered" | "snoozed" | "dismissed" | "acted";

export interface Project {
  id: string;
  title: string;
  isArchived: boolean;
  isDone: boolean;
  doneOn: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface Task {
  id: string;
  projectId: string;
  parentId: string | null;
  title: string;
  notes: string;
  isDone: boolean;
  doneOn: number | null;
  dueDay: string | null;
  dueWithTime: number | null;
  deadlineDay: string | null;
  deadlineWithTime: number | null;
  remindAt: number | null;
  deadlineRemindAt: number | null;
  timeEstimate: number;
  timeSpent: number;
  timeSpentOnDay: Record<string, number>;
  repeatCfgId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Tag {
  id: string;
  title: string;
  color: string | null;
}

export interface CalendarEvent {
  id: string;
  title: string;
  startAt: number;
  endAt: number;
  remindAt: number | null;
  notes: string;
}

export interface Note {
  id: string;
  projectId: string | null;
  title: string;
  bodyMd: string;
  createdAt: number;
  updatedAt: number;
}

/** Typora-like editor presentation modes. */
export type NoteEditorMode = "live" | "source" | "preview";

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  refType: string | null;
  refId: string | null;
  fireAt: number;
  status: NotificationStatus;
  snoozeUntil: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface SchedulePatch {
  dueDay?: string | null;
  dueWithTime?: number | null;
  deadlineDay?: string | null;
  deadlineWithTime?: number | null;
  remindAt?: number | null;
  deadlineRemindAt?: number | null;
}
