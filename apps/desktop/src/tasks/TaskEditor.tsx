import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  decodeTaskRepeat,
  defaultCustomSchedule,
  formatLocalDay,
  formatTaskPlanMeta,
  makePresetSchedule,
  millisecondsDiffToRemindOption,
  timedPresetLabel,
  timedScheduleLabel,
  type ProjectBucket,
  type ReminderOptionId,
  type Tag,
  type Task,
  type TimedSchedule,
  type TimedSchedulePreset,
} from "@wb/domain";
import { ScheduleRow } from "../timed/ScheduleRow";
import { DateField, DateTimeField } from "../ui/CalendarField";
import { MenuSelect } from "../ui/MenuSelect";
import { TagPicker } from "../ui/TagPicker";

export type TaskEditorSave = {
  title: string;
  notes: string;
  projectId: string;
  bucket: ProjectBucket;
  dueMode: "none" | "day" | "time";
  dueDay: string;
  dueWithTimeLocal: string;
  deadlineDay: string;
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
  onSave: (patch: TaskEditorSave) => void;
  onDelete: () => void;
  onDuplicate?: () => void;
  onCreateTag?: (title: string) => Tag | null;
  onAddSubtask?: (title: string) => void;
  onToggleSubtask?: (subtask: Task) => void;
  onDeleteSubtask?: (subtaskId: string) => void;
  onClose: () => void;
};

const PRESETS: TimedSchedulePreset[] = [
  "hourly",
  "daily",
  "weekdays",
  "weekly",
  "monthly",
];

const STATUS_OPTIONS = [
  { value: "active", label: "进行中" },
  { value: "backlog", label: "待办箱" },
  { value: "done", label: "已完成" },
] as const;

const DUE_OPTIONS = [
  { value: "none", label: "未排期" },
  { value: "day", label: "全天" },
  { value: "time", label: "时刻" },
] as const;

const REMIND_OPTIONS: Array<{ value: ReminderOptionId; label: string }> = [
  { value: "none", label: "不提醒" },
  { value: "at_start", label: "准时" },
  { value: "m5", label: "提前 5 分钟" },
  { value: "m10", label: "提前 10 分钟" },
  { value: "m15", label: "提前 15 分钟" },
  { value: "m30", label: "提前 30 分钟" },
  { value: "h1", label: "提前 1 小时" },
];

function toDatetimeLocal(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromTask(
  task: Task,
  bucket: ProjectBucket,
  defaultRemind: ReminderOptionId,
  selectedTagIds: string[],
): TaskEditorSave {
  const remindOption =
    task.dueWithTime != null
      ? millisecondsDiffToRemindOption(task.dueWithTime, task.remindAt)
      : task.remindAt != null
        ? defaultRemind
        : "none";
  return {
    title: task.title,
    notes: task.notes,
    projectId: task.projectId,
    bucket,
    dueMode: task.dueWithTime != null ? "time" : task.dueDay ? "day" : "none",
    dueDay: task.dueDay ?? formatLocalDay(Date.now()),
    dueWithTimeLocal:
      task.dueWithTime != null
        ? toDatetimeLocal(task.dueWithTime)
        : toDatetimeLocal(Date.now()),
    deadlineDay: task.deadlineDay ?? "",
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
    fromTask(task, bucket, defaultRemind, selectedTagIds),
  );
  const [subtaskTitle, setSubtaskTitle] = useState("");
  const [repeatMenuOpen, setRepeatMenuOpen] = useState(false);
  const repeatMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!repeatMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!repeatMenuRef.current?.contains(e.target as Node)) {
        setRepeatMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [repeatMenuOpen]);

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
              {formatTaskPlanMeta(task)}
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
              className="field__control field__control--area"
              rows={2}
              value={draft.notes}
              placeholder="补充说明、清单或上下文"
              aria-label="备注"
              onChange={(e) => patch({ notes: e.target.value })}
            />
          </section>

          <section className="task-editor__section">
            <div className="task-editor__inline-row">
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
            </div>

            <div className="task-editor__inline">
              <span className="task-editor__inline-label">标签：</span>
              <TagPicker
                tags={tags}
                selectedIds={draft.tagIds}
                onCreateTag={onCreateTag}
                onChange={(tagIds) => setDraft((d) => ({ ...d, tagIds }))}
              />
            </div>
          </section>

          <section className="task-editor__section">
            <div className="task-editor__inline-row">
              <div className="task-editor__inline">
                <span className="task-editor__inline-label">计划：</span>
                <MenuSelect
                  label="计划方式"
                  value={draft.dueMode}
                  options={[...DUE_OPTIONS]}
                  onChange={(dueMode) => patch({ dueMode })}
                />
              </div>
              <div className="task-editor__inline">
                <span className="task-editor__inline-label">时长：</span>
                <input
                  id="task-estimate"
                  className="field__control task-editor__inline-input"
                  type="number"
                  min={0}
                  step={5}
                  aria-label="预计时长（分钟）"
                  value={draft.timeEstimateMinutes}
                  onChange={(e) =>
                    patch({
                      timeEstimateMinutes: Math.max(
                        0,
                        Math.floor(Number(e.target.value) || 0),
                      ),
                    })
                  }
                />
                <span className="task-editor__inline-suffix">分钟</span>
              </div>
            </div>

            {draft.dueMode === "day" || draft.dueMode === "time" ? (
              <div className="task-editor__inline-row">
                <div className="task-editor__inline">
                  <span className="task-editor__inline-label">
                    {draft.dueMode === "time" ? "时刻：" : "日期："}
                  </span>
                  <DateTimeField
                    label={draft.dueMode === "time" ? "计划时刻" : "计划日期"}
                    valueLocal={
                      draft.dueMode === "time"
                        ? draft.dueWithTimeLocal
                        : `${draft.dueDay || formatLocalDay(Date.now())}T09:00`
                    }
                    onChange={(dueWithTimeLocal) => {
                      const time = dueWithTimeLocal.slice(11, 16) || "09:00";
                      const dueDay = dueWithTimeLocal.slice(0, 10);
                      // 改了时间则自动切到「时刻」；仅改日期时保留当前计划方式
                      if (draft.dueMode === "day" && time !== "09:00") {
                        patch({
                          dueMode: "time",
                          dueDay,
                          dueWithTimeLocal,
                        });
                      } else if (draft.dueMode === "day") {
                        patch({ dueDay, dueWithTimeLocal });
                      } else {
                        patch({ dueWithTimeLocal });
                      }
                    }}
                  />
                </div>
                {draft.dueMode === "time" ? (
                  <div className="task-editor__inline">
                    <span className="task-editor__inline-label">提醒：</span>
                    <MenuSelect
                      label="提醒"
                      value={draft.remindOption}
                      options={REMIND_OPTIONS}
                      onChange={(remindOption) => patch({ remindOption })}
                    />
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="task-editor__inline">
              <span className="task-editor__inline-label">截止：</span>
              <DateField
                label="截止日期"
                value={draft.deadlineDay}
                allowEmpty
                emptyLabel="未设置截止日期"
                onChange={(deadlineDay) => patch({ deadlineDay })}
              />
            </div>

            {canRepeat ? (
              <div className="schedule-board" ref={repeatMenuRef}>
                {draft.repeat ? (
                  <ScheduleRow
                    schedule={draft.repeat}
                    onChange={(repeat) => patch({ repeat })}
                    onDelete={() => patch({ repeat: null })}
                  />
                ) : (
                  <>
                    <button
                      type="button"
                      className="schedule-add"
                      aria-expanded={repeatMenuOpen}
                      onClick={() => setRepeatMenuOpen((v) => !v)}
                    >
                      + 添加重复
                    </button>
                    {repeatMenuOpen ? (
                      <ul className="schedule-menu" role="menu" aria-label="添加重复">
                        {PRESETS.map((preset) => (
                          <li key={preset}>
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                patch({
                                  repeat: makePresetSchedule(preset),
                                });
                                setRepeatMenuOpen(false);
                              }}
                            >
                              {timedPresetLabel(preset)}
                            </button>
                          </li>
                        ))}
                        <li>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              patch({ repeat: defaultCustomSchedule() });
                              setRepeatMenuOpen(false);
                            }}
                          >
                            自定义
                          </button>
                        </li>
                      </ul>
                    ) : null}
                  </>
                )}
              </div>
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
