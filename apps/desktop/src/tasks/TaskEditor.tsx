import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  decodeTaskRepeat,
  formatTaskPlanMeta,
  millisecondsDiffToRemindOption,
  timedScheduleLabel,
  type ProjectBucket,
  type ReminderOptionId,
  type Tag,
  type Task,
  type TimedSchedule,
} from "@wb/domain";
import { ScheduleAddMenu } from "../timed/ScheduleAddMenu";
import { ScheduleRow } from "../timed/ScheduleRow";
import { DateTimeField } from "../ui/CalendarField";
import { MenuSelect } from "../ui/MenuSelect";
import { TagPicker } from "../ui/TagPicker";

export type TaskEditorSave = {
  title: string;
  notes: string;
  projectId: string;
  bucket: ProjectBucket;
  /** Empty = unscheduled. Local `YYYY-MM-DDTHH:mm`. */
  dueWithTimeLocal: string;
  /** Empty = no deadline. Local `YYYY-MM-DDTHH:mm`. */
  deadlineWithTimeLocal: string;
  remindOption: ReminderOptionId;
  timeEstimateMinutes: number;
  tagIds: string[];
  isDone: boolean;
  repeat: TimedSchedule | null;
};

type Props = {
  task: Task;
  bucket: ProjectBucket;
  projects: Array<{ id: string; title: string }>;
  tags?: Tag[];
  selectedTagIds?: string[];
  subtasks?: Task[];
  defaultRemind: ReminderOptionId;
  nowMs?: number;
  onSave: (patch: TaskEditorSave) => void;
  onDelete: () => void;
  onDuplicate?: () => void;
  onCreateTag?: (title: string) => Tag | null;
  onAddSubtask?: (title: string) => void;
  onToggleSubtask?: (subtask: Task) => void;
  onDeleteSubtask?: (subtaskId: string) => void;
  onClose: () => void;
};

const STATUS_OPTIONS = [
  { value: "active", label: "进行中" },
  { value: "backlog", label: "待办箱" },
  { value: "done", label: "已完成" },
] as const;

const DEFAULT_DEADLINE_TIME = "17:30";

function toDatetimeLocal(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localClock(ms = Date.now()): string {
  return toDatetimeLocal(ms).slice(11, 16);
}

function dayAtTime(day: string, time: string): string {
  return `${day}T${time}`;
}

function autosizeNotes(area: HTMLTextAreaElement | null) {
  if (!area) return;
  area.style.height = "0px";
  const next = Math.max(area.scrollHeight, 40);
  area.style.height = `${next}px`;
}

function fromTask(
  task: Task,
  bucket: ProjectBucket,
  defaultRemind: ReminderOptionId,
  selectedTagIds: string[],
  nowMs = Date.now(),
): TaskEditorSave {
  const remindOption =
    task.dueWithTime != null
      ? millisecondsDiffToRemindOption(task.dueWithTime, task.remindAt)
      : task.remindAt != null
        ? defaultRemind
        : "none";

  let dueWithTimeLocal = "";
  if (task.dueWithTime != null) {
    dueWithTimeLocal = toDatetimeLocal(task.dueWithTime);
  } else if (task.dueDay) {
    dueWithTimeLocal = dayAtTime(task.dueDay, localClock(nowMs));
  }

  let deadlineWithTimeLocal = "";
  if (task.deadlineWithTime != null) {
    deadlineWithTimeLocal = toDatetimeLocal(task.deadlineWithTime);
  } else if (task.deadlineDay) {
    deadlineWithTimeLocal = dayAtTime(task.deadlineDay, DEFAULT_DEADLINE_TIME);
  }

  return {
    title: task.title,
    notes: task.notes,
    projectId: task.projectId,
    bucket,
    dueWithTimeLocal,
    deadlineWithTimeLocal,
    remindOption,
    timeEstimateMinutes: Math.round(Math.max(0, task.timeEstimate) / 60_000),
    tagIds: [...selectedTagIds],
    isDone: task.isDone,
    repeat: decodeTaskRepeat(task.repeatCfgId),
  };
}

export function TaskEditor({
  task,
  bucket,
  projects,
  tags = [],
  selectedTagIds = [],
  subtasks = [],
  defaultRemind,
  nowMs,
  onSave,
  onDelete,
  onDuplicate,
  onCreateTag,
  onAddSubtask,
  onToggleSubtask,
  onDeleteSubtask,
  onClose,
}: Props) {
  const [draft, setDraft] = useState(() =>
    fromTask(task, bucket, defaultRemind, selectedTagIds, nowMs ?? Date.now()),
  );
  const [subtaskTitle, setSubtaskTitle] = useState("");
  const [repeatMenuOpen, setRepeatMenuOpen] = useState(false);
  const notesRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    autosizeNotes(notesRef.current);
  }, [draft.notes]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (repeatMenuOpen) {
        e.preventDefault();
        setRepeatMenuOpen(false);
        return;
      }
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, repeatMenuOpen]);

  const patch = (partial: Partial<TaskEditorSave>) =>
    setDraft((d) => ({ ...d, ...partial }));

  const canManageSubtasks = !task.parentId && onAddSubtask;
  const canRepeat = !task.parentId;
  const statusValue = draft.isDone ? "done" : draft.bucket;

  return createPortal(
    <div className="task-editor-overlay" role="presentation" onClick={onClose}>
      <aside
        className="task-editor"
        role="dialog"
        aria-modal="true"
        aria-label="编辑任务"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="task-editor__header">
          <div>
            <h2>{task.parentId ? "编辑子任务" : "编辑任务"}</h2>
            <p className="task-editor__summary">
              {formatTaskPlanMeta(task, nowMs)}
              {draft.repeat ? ` · ${timedScheduleLabel(draft.repeat)}` : ""}
            </p>
          </div>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="task-editor__body">
          <section className="task-editor__section">
            <input
              id="task-title"
              className="field__control task-editor__title-input"
              value={draft.title}
              placeholder="任务标题"
              aria-label="标题"
              onChange={(e) => patch({ title: e.target.value })}
              autoFocus
            />
            <textarea
              id="task-notes"
              ref={notesRef}
              className="field__control field__control--area task-editor__notes"
              rows={1}
              value={draft.notes}
              placeholder="补充说明、清单或上下文"
              aria-label="备注"
              onChange={(e) => patch({ notes: e.target.value })}
            />
          </section>

          <section className="task-editor__section">
            <div className="task-editor__inline-row task-editor__inline-row--meta">
              <div className="task-editor__inline">
                <span className="task-editor__inline-label">项目：</span>
                <MenuSelect
                  label="项目"
                  value={draft.projectId}
                  options={projects.map((p) => ({
                    value: p.id,
                    label: p.title,
                  }))}
                  onChange={(projectId) => patch({ projectId })}
                />
              </div>
              <div className="task-editor__inline">
                <span className="task-editor__inline-label">状态：</span>
                <MenuSelect
                  label="状态"
                  value={statusValue}
                  options={[...STATUS_OPTIONS]}
                  onChange={(next) => {
                    if (next === "done") patch({ isDone: true });
                    else
                      patch({
                        isDone: false,
                        bucket: next as ProjectBucket,
                      });
                  }}
                />
              </div>
              <div className="task-editor__inline task-editor__inline--tags">
                <span className="task-editor__inline-label">标签：</span>
                <TagPicker
                  tags={tags}
                  selectedIds={draft.tagIds}
                  onCreateTag={onCreateTag}
                  onChange={(tagIds) => setDraft((d) => ({ ...d, tagIds }))}
                />
              </div>
            </div>
          </section>

          <section className="task-editor__section">
            <div className="task-editor__inline-row">
              <div className="task-editor__inline">
                <span className="task-editor__inline-label">开始：</span>
                <DateTimeField
                  label="开始时间"
                  valueLocal={draft.dueWithTimeLocal}
                  allowEmpty
                  emptyLabel="未设置开始时间"
                  defaultTime={localClock(nowMs)}
                  onChange={(dueWithTimeLocal) => patch({ dueWithTimeLocal })}
                />
              </div>
              <div className="task-editor__inline">
                <span className="task-editor__inline-label">截止：</span>
                <DateTimeField
                  label="截止时间"
                  valueLocal={draft.deadlineWithTimeLocal}
                  allowEmpty
                  emptyLabel="未设置截止时间"
                  defaultTime={DEFAULT_DEADLINE_TIME}
                  onChange={(deadlineWithTimeLocal) => patch({ deadlineWithTimeLocal })}
                />
              </div>
            </div>

            {canRepeat ? (
              draft.repeat ? (
                <ScheduleRow
                  schedule={draft.repeat}
                  onChange={(repeat) => patch({ repeat })}
                  onDelete={() => patch({ repeat: null })}
                />
              ) : (
                <ScheduleAddMenu
                  open={repeatMenuOpen}
                  onOpenChange={setRepeatMenuOpen}
                  onPick={(repeat) => patch({ repeat })}
                />
              )
            ) : null}
          </section>

          {canManageSubtasks ? (
            <section className="task-editor__section" aria-label="子任务">
              {subtasks.length > 0 ? (
                <ul className="task-editor__subs" aria-label="子任务列表">
                  {subtasks.map((sub) => (
                    <li key={sub.id} className="task-editor__sub">
                      <button
                        type="button"
                        className={sub.isDone ? "check is-checked" : "check"}
                        aria-label={
                          sub.isDone ? `取消完成 ${sub.title}` : `完成 ${sub.title}`
                        }
                        onClick={() => onToggleSubtask?.(sub)}
                      />
                      <span
                        className={
                          sub.isDone
                            ? "task-editor__sub-title is-done"
                            : "task-editor__sub-title"
                        }
                      >
                        {sub.title}
                      </span>
                      <button
                        type="button"
                        className="btn btn--ghost"
                        onClick={() => onDeleteSubtask?.(sub.id)}
                      >
                        删除
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <input
                aria-label="新建子任务"
                className="field__control"
                placeholder="添加子任务，回车确认"
                value={subtaskTitle}
                onChange={(e) => setSubtaskTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  const title = subtaskTitle.trim();
                  if (!title) return;
                  onAddSubtask?.(title);
                  setSubtaskTitle("");
                }}
              />
            </section>
          ) : null}
        </div>

        <footer className="task-editor__footer">
          <div className="task-editor__footer-left">
            <button type="button" className="btn btn--ghost" onClick={onDelete}>
              删除
            </button>
            {onDuplicate ? (
              <button type="button" className="btn btn--ghost" onClick={onDuplicate}>
                复制
              </button>
            ) : null}
          </div>
          <div className="task-editor__footer-right">
            <button type="button" className="btn" onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => onSave(draft)}
            >
              保存
            </button>
          </div>
        </footer>
      </aside>
    </div>,
    document.body,
  );
}
