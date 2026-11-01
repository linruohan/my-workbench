import { useState } from "react";
import {
  formatLocalDay,
  formatTaskPlanMeta,
  millisecondsDiffToRemindOption,
  type ProjectBucket,
  type ReminderOptionId,
  type Tag,
  type Task,
} from "@wb/domain";

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

  const patch = (partial: Partial<TaskEditorSave>) =>
    setDraft((d) => ({ ...d, ...partial }));

  const canManageSubtasks = !task.parentId && onAddSubtask;

  return (
    <aside className="task-editor" aria-label="编辑任务">
      <header className="task-editor__header">
        <h2>{task.parentId ? "编辑子任务" : "编辑任务"}</h2>
        <button type="button" className="btn btn--ghost" onClick={onClose}>
          关闭
        </button>
      </header>

      <div className="task-editor__body">
        <div className="field">
          <label className="field__label" htmlFor="task-title">
            标题
          </label>
          <input
            id="task-title"
            className="field__control"
            value={draft.title}
            onChange={(e) => patch({ title: e.target.value })}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="task-notes">
            备注
          </label>
          <textarea
            id="task-notes"
            className="field__control field__control--area"
            rows={4}
            value={draft.notes}
            placeholder="补充说明、清单或上下文"
            onChange={(e) => patch({ notes: e.target.value })}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="task-project">
            项目
          </label>
          <select
            id="task-project"
            className="field__control"
            value={draft.projectId}
            onChange={(e) => patch({ projectId: e.target.value })}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
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

        <div className="field">
          <div className="field__label">标签</div>
          <div className="task-editor__tags" role="group" aria-label="任务标签">
            {tags.length === 0 ? (
              <p className="task-editor__hint">还没有标签，可在下方新建。</p>
            ) : (
              tags.map((tag) => {
                const active = draft.tagIds.includes(tag.id);
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
            <div className="task-editor__sub-add">
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
            </div>
          ) : null}
        </div>

        <div className="field">
          <div className="field__label">状态分桶</div>
          <div className="task-editor__seg" role="group" aria-label="状态分桶">
            {(
              [
                ["active", "进行中"],
                ["backlog", "待办箱"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={
                  draft.bucket === id
                    ? "task-editor__seg-btn is-active"
                    : "task-editor__seg-btn"
                }
                onClick={() => patch({ bucket: id, isDone: false })}
              >
                {label}
              </button>
            ))}
            <button
              type="button"
              className={
                draft.isDone
                  ? "task-editor__seg-btn is-active"
                  : "task-editor__seg-btn"
              }
              onClick={() => patch({ isDone: true })}
            >
              已完成
            </button>
          </div>
        </div>

        <div className="field">
          <div className="field__label">计划时间</div>
          <div className="task-editor__seg" role="group" aria-label="计划时间">
            {(
              [
                ["none", "未排期"],
                ["day", "全天"],
                ["time", "时刻"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={
                  draft.dueMode === id
                    ? "task-editor__seg-btn is-active"
                    : "task-editor__seg-btn"
                }
                onClick={() => patch({ dueMode: id })}
              >
                {label}
              </button>
            ))}
          </div>
          {draft.dueMode === "day" ? (
            <input
              className="field__control"
              type="date"
              aria-label="计划日期"
              value={draft.dueDay}
              onChange={(e) => patch({ dueDay: e.target.value })}
            />
          ) : null}
          {draft.dueMode === "time" ? (
            <input
              className="field__control"
              type="datetime-local"
              aria-label="计划时刻"
              value={draft.dueWithTimeLocal}
              onChange={(e) => patch({ dueWithTimeLocal: e.target.value })}
            />
          ) : null}
        </div>

        <div className="field">
          <label className="field__label" htmlFor="task-deadline">
            截止日期（可选）
          </label>
          <input
            id="task-deadline"
            className="field__control"
            type="date"
            value={draft.deadlineDay}
            onChange={(e) => patch({ deadlineDay: e.target.value })}
          />
        </div>

        {draft.dueMode === "time" ? (
          <div className="field">
            <label className="field__label" htmlFor="task-remind">
              提醒
            </label>
            <select
              id="task-remind"
              className="field__control"
              value={draft.remindOption}
              onChange={(e) =>
                patch({ remindOption: e.target.value as ReminderOptionId })
              }
            >
              <option value="none">不提醒</option>
              <option value="at_start">准时</option>
              <option value="m5">提前 5 分钟</option>
              <option value="m10">提前 10 分钟</option>
              <option value="m15">提前 15 分钟</option>
              <option value="m30">提前 30 分钟</option>
              <option value="h1">提前 1 小时</option>
            </select>
          </div>
        ) : null}

        {canManageSubtasks ? (
          <div className="field">
            <div className="field__label">子任务</div>
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
            <div className="task-editor__sub-add">
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
          </div>
        ) : null}

        <p className="task-editor__hint">{formatTaskPlanMeta(task)}</p>
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
  );
}
