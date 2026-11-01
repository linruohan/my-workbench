import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  decodeTaskRepeat,
  defaultCustomSchedule,
  formatLocalDay,
  makePresetSchedule,
  millisecondsDiffToRemindOption,
  resolveTagChipColors,
  timedPresetLabel,
  timedScheduleLabel,
  type ProjectBucket,
  type ReminderOptionId,
  type Tag,
  type Task,
  type TimedSchedule,
  type TimedSchedulePreset,
} from "@wb/domain";
import {
  IconBell,
  IconClose,
  IconFlag,
  IconPlanner,
  IconPlus,
  IconRepeat,
  IconTag,
} from "../shell/icons";
import { ScheduleRow } from "../timed/ScheduleRow";
import { DateField, DateTimeField } from "../ui/CalendarField";
import { MenuSelect } from "../ui/MenuSelect";

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

type Panel = "none" | "tags" | "remind" | "repeat" | "subs" | "more";

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
  const [newTagTitle, setNewTagTitle] = useState("");
  const [panel, setPanel] = useState<Panel>("none");
  const [repeatMenuOpen, setRepeatMenuOpen] = useState(false);
  const repeatMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (panel !== "none") {
          setPanel("none");
          return;
        }
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, panel]);

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

  const togglePanel = (next: Panel) =>
    setPanel((cur) => (cur === next ? "none" : next));

  const canManageSubtasks = !task.parentId && onAddSubtask;
  const canRepeat = !task.parentId;
  const statusValue = draft.isDone ? "done" : draft.bucket;
  const selectedTags = tags.filter((t) => draft.tagIds.includes(t.id));
  const hasRemind = draft.remindOption !== "none";

  return createPortal(
    <div
      className="task-editor-overlay"
      role="presentation"
      onClick={onClose}
    >
      <aside
        className="task-editor"
        role="dialog"
        aria-modal="true"
        aria-label="编辑任务"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="task-editor__chrome">
          <button
            type="button"
            className="task-editor__icon-btn"
            aria-label="关闭"
            onClick={onClose}
          >
            <IconClose size={16} />
          </button>
        </div>

        <div className="task-editor__body">
          <input
            id="task-title"
            className="task-editor__title"
            value={draft.title}
            placeholder="任务标题"
            aria-label="标题"
            autoFocus
            onChange={(e) => patch({ title: e.target.value })}
          />
          <textarea
            id="task-notes"
            className="task-editor__notes"
            rows={2}
            value={draft.notes}
            placeholder="添加描述"
            aria-label="备注"
            onChange={(e) => patch({ notes: e.target.value })}
          />

          {selectedTags.length > 0 ? (
            <div className="task-editor__chips" aria-label="已选标签">
              {selectedTags.map((tag) => {
                const colors = resolveTagChipColors(tag);
                return (
                  <span
                    key={tag.id}
                    className="task-editor__chip"
                    style={{
                      background: colors.background,
                      borderColor: colors.border,
                      color: colors.text,
                    }}
                  >
                    {tag.title}
                    <button
                      type="button"
                      className="task-editor__chip-x"
                      aria-label={`移除标签 ${tag.title}`}
                      onClick={() =>
                        patch({
                          tagIds: draft.tagIds.filter((id) => id !== tag.id),
                        })
                      }
                    >
                      ×
                    </button>
                  </span>
                );
              })}
            </div>
          ) : null}

          {panel === "tags" ? (
            <div className="task-editor__panel" aria-label="选择标签">
              <div className="task-editor__tags" role="group">
                {tags.length === 0 ? (
                  <p className="task-editor__hint">还没有标签，可在下方新建。</p>
                ) : (
                  tags.map((tag) => {
                    const active = draft.tagIds.includes(tag.id);
                    const colors = resolveTagChipColors(tag);
                    return (
                      <button
                        key={tag.id}
                        type="button"
                        className={
                          active
                            ? "task-editor__tag is-active"
                            : "task-editor__tag"
                        }
                        aria-pressed={active}
                        style={
                          active
                            ? {
                                background: colors.background,
                                borderColor: colors.border,
                                color: colors.text,
                              }
                            : undefined
                        }
                        onClick={() =>
                          patch({
                            tagIds: active
                              ? draft.tagIds.filter((id) => id !== tag.id)
                              : [...draft.tagIds, tag.id],
                          })
                        }
                      >
                        {tag.title}
                      </button>
                    );
                  })
                )}
              </div>
              {onCreateTag ? (
                <input
                  aria-label="新建标签"
                  className="field__control"
                  placeholder="新建标签，回车添加"
                  value={newTagTitle}
                  onChange={(e) => setNewTagTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    const title = newTagTitle.trim();
                    if (!title) return;
                    const created = onCreateTag(title);
                    setNewTagTitle("");
                    if (created) {
                      patch({ tagIds: [...draft.tagIds, created.id] });
                    }
                  }}
                />
              ) : null}
            </div>
          ) : null}

          {panel === "remind" ? (
            <div className="task-editor__panel task-editor__panel--row">
              <MenuSelect
                label="提醒"
                value={draft.remindOption}
                options={REMIND_OPTIONS}
                onChange={(remindOption) => patch({ remindOption })}
              />
            </div>
          ) : null}

          {panel === "more" ? (
            <div className="task-editor__panel task-editor__panel--grid">
              <div className="field">
                <div className="field__label">计划方式</div>
                <MenuSelect
                  label="计划方式"
                  value={draft.dueMode}
                  options={[...DUE_OPTIONS]}
                  onChange={(dueMode) => patch({ dueMode })}
                />
              </div>
              <div className="field">
                <label className="field__label" htmlFor="task-estimate">
                  预计时长（分钟）
                </label>
                <input
                  id="task-estimate"
                  className="field__control"
                  type="number"
                  min={0}
                  step={5}
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
              </div>
              <div className="field task-editor__panel-span">
                <div className="field__label">截止日期</div>
                <DateField
                  label="截止日期"
                  value={draft.deadlineDay}
                  allowEmpty
                  emptyLabel="未设置截止日期"
                  onChange={(deadlineDay) => patch({ deadlineDay })}
                />
              </div>
            </div>
          ) : null}

          {canRepeat && (panel === "repeat" || draft.repeat) ? (
            <div className="task-editor__panel">
              <div className="schedule-board" ref={repeatMenuRef}>
                {draft.repeat ? (
                  <ScheduleRow
                    schedule={draft.repeat}
                    onChange={(repeat) => patch({ repeat })}
                    onDelete={() => {
                      patch({ repeat: null });
                      setPanel("none");
                    }}
                  />
                ) : (
                  <>
                    <p className="schedule-empty">
                      未设置重复。完成后可按相同规则生成下一次。
                    </p>
                    <button
                      type="button"
                      className="schedule-add"
                      aria-expanded={repeatMenuOpen}
                      onClick={() => setRepeatMenuOpen((v) => !v)}
                    >
                      + 添加重复
                    </button>
                    {repeatMenuOpen ? (
                      <ul
                        className="schedule-menu"
                        role="menu"
                        aria-label="添加重复"
                      >
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
            </div>
          ) : null}

          {canManageSubtasks && (panel === "subs" || subtasks.length > 0) ? (
            <div className="task-editor__panel">
              {subtasks.length > 0 ? (
                <ul className="task-editor__subs" aria-label="子任务列表">
                  {subtasks.map((sub) => (
                    <li key={sub.id} className="task-editor__sub">
                      <button
                        type="button"
                        className={sub.isDone ? "check is-checked" : "check"}
                        aria-label={
                          sub.isDone
                            ? `取消完成 ${sub.title}`
                            : `完成 ${sub.title}`
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
              ) : (
                <p className="task-editor__hint">还没有子任务。</p>
              )}
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
            </div>
          ) : null}
        </div>

        <div className="task-editor__toolbar">
          <div className="task-editor__toolbar-left">
            {draft.dueMode === "day" ? (
              <DateField
                label="计划日期"
                value={draft.dueDay}
                variant="ghost"
                compact
                allowEmpty
                emptyLabel="安排时间"
                leading={<IconPlanner size={15} />}
                onChange={(dueDay) => {
                  if (!dueDay) patch({ dueMode: "none" });
                  else patch({ dueDay, dueMode: "day" });
                }}
              />
            ) : (
              <DateTimeField
                label="计划时刻"
                valueLocal={
                  draft.dueMode === "time" ? draft.dueWithTimeLocal : ""
                }
                variant="ghost"
                compact
                allowEmpty
                emptyLabel="安排时间"
                leading={<IconPlanner size={15} />}
                onChange={(dueWithTimeLocal) =>
                  patch({ dueWithTimeLocal, dueMode: "time" })
                }
                onClear={() => patch({ dueMode: "none" })}
              />
            )}

            {canRepeat ? (
              <button
                type="button"
                className={
                  draft.repeat || panel === "repeat"
                    ? "task-editor__tool is-active"
                    : "task-editor__tool"
                }
                aria-label={
                  draft.repeat
                    ? `重复：${timedScheduleLabel(draft.repeat)}`
                    : "添加重复"
                }
                aria-pressed={panel === "repeat" || Boolean(draft.repeat)}
                title={
                  draft.repeat
                    ? timedScheduleLabel(draft.repeat)
                    : "添加重复"
                }
                onClick={() => togglePanel("repeat")}
              >
                <IconRepeat size={15} />
              </button>
            ) : null}

            <MenuSelect
              label="项目"
              value={draft.projectId}
              options={projects.map((p) => ({
                value: p.id,
                label: p.title,
              }))}
              onChange={(projectId) => patch({ projectId })}
              variant="ghost"
            />

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
              variant="ghost"
            />
          </div>

          <div className="task-editor__toolbar-right">
            {canManageSubtasks ? (
              <button
                type="button"
                className={
                  panel === "subs"
                    ? "task-editor__icon-btn is-active"
                    : "task-editor__icon-btn"
                }
                aria-label="子任务"
                aria-pressed={panel === "subs"}
                onClick={() => togglePanel("subs")}
              >
                <IconPlus size={16} />
              </button>
            ) : null}

            <button
              type="button"
              className={
                panel === "tags" || selectedTags.length > 0
                  ? "task-editor__icon-btn is-active"
                  : "task-editor__icon-btn"
              }
              aria-label="标签"
              aria-pressed={panel === "tags"}
              onClick={() => togglePanel("tags")}
            >
              <IconTag size={16} />
              {selectedTags.length > 0 ? (
                <span className="task-editor__badge">
                  {selectedTags.length}
                </span>
              ) : null}
            </button>

            <button
              type="button"
              className={
                panel === "more" ? "task-editor__icon-btn is-active" : "task-editor__icon-btn"
              }
              aria-label="更多排期"
              aria-pressed={panel === "more"}
              title="计划方式、时长与截止日期"
              onClick={() => togglePanel("more")}
            >
              <IconFlag size={16} />
            </button>

            <button
              type="button"
              className={
                panel === "remind" || hasRemind
                  ? "task-editor__icon-btn is-active"
                  : "task-editor__icon-btn"
              }
              aria-label="提醒"
              aria-pressed={panel === "remind"}
              onClick={() => togglePanel("remind")}
            >
              <IconBell size={16} />
            </button>
          </div>
        </div>

        <footer className="task-editor__footer">
          <div className="task-editor__footer-left">
            <button type="button" className="btn btn--ghost" onClick={onDelete}>
              删除
            </button>
            {onDuplicate ? (
              <button
                type="button"
                className="btn btn--ghost"
                onClick={onDuplicate}
              >
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
