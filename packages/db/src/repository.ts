import type Database from "better-sqlite3";
import {
  applySchedulePatch,
  assertNoRepeatOnSubtask,
  assertTagIdAllowed,
  clearPlanFields,
  collectDueReminders,
  createId,
  createNoteDraft,
  DomainError,
  INBOX_PROJECT_ID,
  isPlannerMember,
  isScheduleMember,
  patchNote,
  pickTagColor,
  selectTodayTasks,
  settleTimerSegment,
  sumTimeSpentOnDay,
  type Note,
  type ProjectBucket,
  type ReminderOptionId,
  type SchedulePatch,
  type Tag,
  type Task,
  remindOptionToMilliseconds,
  shiftRemindAt,
} from "@wb/domain";

interface TaskRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  title: string;
  notes: string;
  is_done: number;
  done_on: number | null;
  due_day: string | null;
  due_with_time: number | null;
  deadline_day: string | null;
  deadline_with_time: number | null;
  remind_at: number | null;
  deadline_remind_at: number | null;
  time_estimate: number;
  time_spent: number;
  time_spent_on_day: string;
  repeat_cfg_id: string | null;
  created_at: number;
  updated_at: number;
}

function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    parentId: row.parent_id,
    title: row.title,
    notes: row.notes,
    isDone: row.is_done === 1,
    doneOn: row.done_on,
    dueDay: row.due_day,
    dueWithTime: row.due_with_time,
    deadlineDay: row.deadline_day,
    deadlineWithTime: row.deadline_with_time,
    remindAt: row.remind_at,
    deadlineRemindAt: row.deadline_remind_at,
    timeEstimate: row.time_estimate,
    timeSpent: row.time_spent,
    timeSpentOnDay: JSON.parse(row.time_spent_on_day) as Record<string, number>,
    repeatCfgId: row.repeat_cfg_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class WorkbenchRepository {
  constructor(private readonly db: Database.Database) {}

  listTasks(): Task[] {
    const rows = this.db
      .prepare(`SELECT * FROM tasks ORDER BY created_at ASC`)
      .all() as TaskRow[];
    return rows.map(mapTask);
  }

  getTask(id: string): Task | null {
    const row = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as
      TaskRow | undefined;
    return row ? mapTask(row) : null;
  }

  createTask(input: {
    title: string;
    projectId?: string;
    parentId?: string | null;
    notes?: string;
    bucket?: ProjectBucket;
    nowMs?: number;
  }): Task {
    const now = input.nowMs ?? Date.now();
    const id = createId(now);
    const projectId = input.projectId ?? INBOX_PROJECT_ID;
    const parentId = input.parentId ?? null;
    const bucket = input.bucket ?? "active";

    const project = this.db
      .prepare(`SELECT id FROM projects WHERE id = ?`)
      .get(projectId);
    if (!project) throw new DomainError(`unknown project: ${projectId}`);

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO tasks (
            id, project_id, parent_id, title, notes, is_done, done_on,
            due_day, due_with_time, deadline_day, deadline_with_time,
            remind_at, deadline_remind_at, time_estimate, time_spent,
            time_spent_on_day, repeat_cfg_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, '{}', NULL, ?, ?)`,
        )
        .run(id, projectId, parentId, input.title, input.notes ?? "", now, now);

      const pos = (
        this.db
          .prepare(
            `SELECT COALESCE(MAX(position), -1) + 1 AS p FROM project_tasks WHERE project_id = ? AND bucket = ?`,
          )
          .get(projectId, bucket) as { p: number }
      ).p;

      this.db
        .prepare(
          `INSERT INTO project_tasks (project_id, task_id, bucket, position) VALUES (?, ?, ?, ?)`,
        )
        .run(projectId, id, bucket, pos);
    });
    tx();
    return this.getTask(id)!;
  }

  scheduleTask(
    taskId: string,
    patch: SchedulePatch & { remindOption?: ReminderOptionId },
    nowMs = Date.now(),
  ): Task {
    const task = this.getTask(taskId);
    if (!task) throw new DomainError(`task not found: ${taskId}`);

    let nextPatch: SchedulePatch = { ...patch };
    if (patch.dueWithTime != null && patch.remindOption) {
      nextPatch.remindAt = remindOptionToMilliseconds(
        patch.dueWithTime,
        patch.remindOption,
      );
    } else if (
      patch.dueWithTime != null &&
      task.dueWithTime != null &&
      task.remindAt != null &&
      !Object.prototype.hasOwnProperty.call(patch, "remindAt")
    ) {
      nextPatch.remindAt = shiftRemindAt(
        task.dueWithTime,
        task.remindAt,
        patch.dueWithTime,
      );
    }

    const scheduled = applySchedulePatch(
      {
        dueDay: task.dueDay,
        dueWithTime: task.dueWithTime,
        deadlineDay: task.deadlineDay,
        deadlineWithTime: task.deadlineWithTime,
        remindAt: task.remindAt,
        deadlineRemindAt: task.deadlineRemindAt,
      },
      nextPatch,
    );

    this.db
      .prepare(
        `UPDATE tasks SET
          due_day = ?, due_with_time = ?,
          deadline_day = ?, deadline_with_time = ?,
          remind_at = ?, deadline_remind_at = ?,
          updated_at = ?
         WHERE id = ?`,
      )
      .run(
        scheduled.dueDay ?? null,
        scheduled.dueWithTime ?? null,
        scheduled.deadlineDay ?? null,
        scheduled.deadlineWithTime ?? null,
        scheduled.remindAt ?? null,
        scheduled.deadlineRemindAt ?? null,
        nowMs,
        taskId,
      );

    return this.getTask(taskId)!;
  }

  getTaskBucket(taskId: string): ProjectBucket {
    const row = this.db
      .prepare(`SELECT bucket FROM project_tasks WHERE task_id = ?`)
      .get(taskId) as { bucket: ProjectBucket } | undefined;
    return row?.bucket ?? "active";
  }

  setTaskBucket(
    taskId: string,
    bucket: ProjectBucket,
    nowMs = Date.now(),
  ): Task {
    if (bucket === "backlog") return this.moveToBacklog(taskId, nowMs);
    const task = this.getTask(taskId);
    if (!task) throw new DomainError(`task not found: ${taskId}`);
    this.db
      .prepare(
        `UPDATE project_tasks SET bucket = 'active' WHERE task_id = ?`,
      )
      .run(taskId);
    this.db
      .prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`)
      .run(nowMs, taskId);
    return this.getTask(taskId)!;
  }

  moveToBacklog(taskId: string, nowMs = Date.now()): Task {
    const task = this.getTask(taskId);
    if (!task) throw new DomainError(`task not found: ${taskId}`);
    const cleared = clearPlanFields({
      dueDay: task.dueDay,
      dueWithTime: task.dueWithTime,
      remindAt: task.remindAt,
    });

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE tasks SET due_day = NULL, due_with_time = NULL, remind_at = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(nowMs, taskId);
      this.db
        .prepare(`UPDATE project_tasks SET bucket = 'backlog' WHERE task_id = ?`)
        .run(taskId);
      void cleared;
    });
    tx();
    return this.getTask(taskId)!;
  }

  moveToActive(taskId: string, nowMs = Date.now()): Task {
    return this.setTaskBucket(taskId, "active", nowMs);
  }

  updateTask(
    taskId: string,
    patch: {
      title?: string;
      notes?: string;
      projectId?: string;
      timeEstimate?: number;
    },
    nowMs = Date.now(),
  ): Task {
    const task = this.getTask(taskId);
    if (!task) throw new DomainError(`task not found: ${taskId}`);

    const title =
      patch.title !== undefined
        ? patch.title.trim() || "未命名任务"
        : task.title;
    const notes = patch.notes !== undefined ? patch.notes : task.notes;
    const projectId =
      patch.projectId !== undefined ? patch.projectId : task.projectId;
    const timeEstimate =
      patch.timeEstimate !== undefined
        ? Math.max(0, Math.floor(patch.timeEstimate))
        : task.timeEstimate;

    if (patch.projectId !== undefined) {
      const project = this.db
        .prepare(`SELECT id FROM projects WHERE id = ?`)
        .get(projectId);
      if (!project) throw new DomainError(`unknown project: ${projectId}`);
    }

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE tasks SET title = ?, notes = ?, project_id = ?, time_estimate = ?, updated_at = ? WHERE id = ?`,
        )
        .run(title, notes, projectId, timeEstimate, nowMs, taskId);

      if (patch.projectId !== undefined && patch.projectId !== task.projectId) {
        const bucket = this.getTaskBucket(taskId);
        this.db
          .prepare(`DELETE FROM project_tasks WHERE task_id = ?`)
          .run(taskId);
        const pos = (
          this.db
            .prepare(
              `SELECT COALESCE(MAX(position), -1) + 1 AS p FROM project_tasks WHERE project_id = ? AND bucket = ?`,
            )
            .get(projectId, bucket) as { p: number }
        ).p;
        this.db
          .prepare(
            `INSERT INTO project_tasks (project_id, task_id, bucket, position) VALUES (?, ?, ?, ?)`,
          )
          .run(projectId, taskId, bucket, pos);
      }
    });
    tx();
    return this.getTask(taskId)!;
  }

  deleteTask(taskId: string): void {
    if (!this.getTask(taskId)) {
      throw new DomainError(`task not found: ${taskId}`);
    }
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE tasks SET parent_id = NULL, updated_at = ? WHERE parent_id = ?`,
        )
        .run(Date.now(), taskId);
      this.db.prepare(`DELETE FROM today_order WHERE task_id = ?`).run(taskId);
      this.db.prepare(`DELETE FROM project_tasks WHERE task_id = ?`).run(taskId);
      this.db.prepare(`DELETE FROM task_tags WHERE task_id = ?`).run(taskId);
      this.db.prepare(`DELETE FROM tasks WHERE id = ?`).run(taskId);
    });
    tx();
  }

  completeTask(taskId: string, nowMs = Date.now()): Task {
    this.db
      .prepare(
        `UPDATE tasks SET is_done = 1, done_on = ?, remind_at = NULL, deadline_remind_at = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(nowMs, nowMs, taskId);
    return this.getTask(taskId)!;
  }

  uncompleteTask(taskId: string, nowMs = Date.now()): Task {
    this.db
      .prepare(
        `UPDATE tasks SET is_done = 0, done_on = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(nowMs, taskId);
    return this.getTask(taskId)!;
  }

  setTaskParent(
    taskId: string,
    parentId: string | null,
    nowMs = Date.now(),
  ): Task {
    const task = this.getTask(taskId);
    if (!task) throw new DomainError(`task not found: ${taskId}`);
    if (parentId === taskId) {
      throw new DomainError("task cannot be its own parent");
    }
    if (parentId != null) {
      const parent = this.getTask(parentId);
      if (!parent) throw new DomainError(`parent not found: ${parentId}`);
      if (parent.parentId) {
        throw new DomainError(
          "nested subtasks deeper than one level are not supported",
        );
      }
    }
    this.db
      .prepare(`UPDATE tasks SET parent_id = ?, updated_at = ? WHERE id = ?`)
      .run(parentId, nowMs, taskId);
    return this.getTask(taskId)!;
  }

  listSubtasks(parentId: string): Task[] {
    return this.listTasks()
      .filter((t) => t.parentId === parentId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  duplicateTask(taskId: string, nowMs = Date.now()): Task {
    const task = this.getTask(taskId);
    if (!task) throw new DomainError(`task not found: ${taskId}`);
    const copy = this.createTask({
      title: `${task.title}（副本）`,
      projectId: task.projectId,
      parentId: task.parentId,
      notes: task.notes,
      bucket: this.getTaskBucket(taskId),
      nowMs,
    });
    return this.updateTask(
      copy.id,
      { timeEstimate: task.timeEstimate },
      nowMs,
    );
  }

  addTimeSpent(taskId: string, startedAt: number, endedAt: number): Task {
    const task = this.getTask(taskId);
    if (!task) throw new DomainError(`task not found: ${taskId}`);
    if (task.parentId == null) {
      const children = this.listTasks().filter((t) => t.parentId === taskId);
      if (children.length > 0) {
        throw new DomainError("parent with subtasks cannot be timed directly");
      }
    }
    const { map, added } = settleTimerSegment(task.timeSpentOnDay, startedAt, endedAt);
    const timeSpent = sumTimeSpentOnDay(map);
    this.db
      .prepare(
        `UPDATE tasks SET time_spent_on_day = ?, time_spent = ?, updated_at = ? WHERE id = ?`,
      )
      .run(JSON.stringify(map), timeSpent, endedAt, taskId);
    void added;
    return this.getTask(taskId)!;
  }

  setRepeatCfg(taskId: string, repeatCfgId: string | null, nowMs = Date.now()): Task {
    const task = this.getTask(taskId);
    if (!task) throw new DomainError(`task not found: ${taskId}`);
    assertNoRepeatOnSubtask(task.parentId, repeatCfgId);
    this.db
      .prepare(`UPDATE tasks SET repeat_cfg_id = ?, updated_at = ? WHERE id = ?`)
      .run(repeatCfgId, nowMs, taskId);
    return this.getTask(taskId)!;
  }

  createTag(title: string, id?: string): Tag {
    const trimmed = title.trim();
    if (!trimmed) throw new DomainError("tag title is required");
    const tagId = id ?? createId();
    assertTagIdAllowed(tagId);
    const color = pickTagColor(trimmed);
    this.db
      .prepare(`INSERT INTO tags (id, title, color) VALUES (?, ?, ?)`)
      .run(tagId, trimmed, color);
    return { id: tagId, title: trimmed, color };
  }

  listTags(): Tag[] {
    const rows = this.db
      .prepare(`SELECT id, title, color FROM tags ORDER BY title ASC`)
      .all() as Array<{ id: string; title: string; color: string | null }>;
    return rows.map((r) => ({ id: r.id, title: r.title, color: r.color }));
  }

  deleteTag(tagId: string): void {
    const exists = this.db.prepare(`SELECT id FROM tags WHERE id = ?`).get(tagId);
    if (!exists) throw new DomainError(`tag not found: ${tagId}`);
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM task_tags WHERE tag_id = ?`).run(tagId);
      this.db.prepare(`DELETE FROM tags WHERE id = ?`).run(tagId);
    });
    tx();
  }

  assignTag(taskId: string, tagId: string): void {
    assertTagIdAllowed(tagId);
    if (!this.getTask(taskId)) throw new DomainError(`task not found: ${taskId}`);
    const tag = this.db.prepare(`SELECT id FROM tags WHERE id = ?`).get(tagId);
    if (!tag) throw new DomainError(`tag not found: ${tagId}`);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO task_tags (task_id, tag_id, position) VALUES (?, ?, 0)`,
      )
      .run(taskId, tagId);
  }

  unassignTag(taskId: string, tagId: string): void {
    this.db
      .prepare(`DELETE FROM task_tags WHERE task_id = ? AND tag_id = ?`)
      .run(taskId, tagId);
  }

  listTagsForTask(taskId: string): Tag[] {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.title, t.color
         FROM tags t
         INNER JOIN task_tags tt ON tt.tag_id = t.id
         WHERE tt.task_id = ?
         ORDER BY t.title ASC`,
      )
      .all(taskId) as Array<{ id: string; title: string; color: string | null }>;
    return rows.map((r) => ({ id: r.id, title: r.title, color: r.color }));
  }

  setTodayOrder(taskIds: string[]): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM today_order`).run();
      const ins = this.db.prepare(
        `INSERT INTO today_order (task_id, position) VALUES (?, ?)`,
      );
      taskIds.forEach((id, i) => ins.run(id, i));
    });
    tx();
  }

  getTodayOrder(): string[] {
    const rows = this.db
      .prepare(`SELECT task_id FROM today_order ORDER BY position ASC`)
      .all() as Array<{ task_id: string }>;
    return rows.map((r) => r.task_id);
  }

  listToday(nowMs: number): Task[] {
    return selectTodayTasks(this.listTasks(), this.getTodayOrder(), { nowMs });
  }

  listPlannerDay(day: string): Task[] {
    return this.listTasks().filter((t) => isPlannerMember(t, day));
  }

  listScheduleDay(day: string): Task[] {
    return this.listTasks().filter((t) => isScheduleMember(t, day));
  }

  deliverDueReminders(nowMs: number): Array<{
    id: string;
    taskId: string;
    title: string;
    isDeadline: boolean;
    remindAt: number;
  }> {
    const due = collectDueReminders(this.listTasks(), nowMs);
    const created: Array<{
      id: string;
      taskId: string;
      title: string;
      isDeadline: boolean;
      remindAt: number;
    }> = [];

    const tx = this.db.transaction(() => {
      for (const item of due) {
        const exists = this.db
          .prepare(
            `SELECT id FROM notifications WHERE ref_id = ? AND fire_at = ? AND kind = ?`,
          )
          .get(
            item.taskId,
            item.remindAt,
            item.isDeadline ? "deadline_remind" : "task_remind",
          );
        if (exists) continue;
        const id = createId(nowMs);
        this.db
          .prepare(
            `INSERT INTO notifications (
              id, kind, title, body, ref_type, ref_id, fire_at, status, snooze_until, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'task', ?, ?, 'delivered', NULL, ?, ?)`,
          )
          .run(
            id,
            item.isDeadline ? "deadline_remind" : "task_remind",
            item.title,
            item.isDeadline ? "截止提醒" : "计划提醒",
            item.taskId,
            item.remindAt,
            nowMs,
            nowMs,
          );
        created.push({
          id,
          taskId: item.taskId,
          title: item.title,
          isDeadline: item.isDeadline,
          remindAt: item.remindAt,
        });
      }
    });
    tx();
    return created;
  }

  listNotifications(): Array<{
    id: string;
    kind: string;
    title: string;
    status: string;
    fireAt: number;
    refId: string | null;
  }> {
    const rows = this.db
      .prepare(
        `SELECT id, kind, title, status, fire_at, ref_id FROM notifications ORDER BY fire_at DESC`,
      )
      .all() as Array<{
      id: string;
      kind: string;
      title: string;
      status: string;
      fire_at: number;
      ref_id: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      status: r.status,
      fireAt: r.fire_at,
      refId: r.ref_id,
    }));
  }

  listProjects(): Array<{ id: string; title: string }> {
    const rows = this.db
      .prepare(
        `SELECT id, title FROM projects WHERE is_archived = 0 ORDER BY created_at ASC`,
      )
      .all() as Array<{ id: string; title: string }>;
    return rows;
  }

  createProject(title: string, nowMs = Date.now()): { id: string; title: string } {
    const id = createId(nowMs);
    this.db
      .prepare(
        `INSERT INTO projects (id, title, is_archived, is_done, done_on, created_at, updated_at)
         VALUES (?, ?, 0, 0, NULL, ?, ?)`,
      )
      .run(id, title, nowMs, nowMs);
    return { id, title };
  }

  listNotes(): Note[] {
    const rows = this.db
      .prepare(`SELECT * FROM notes ORDER BY updated_at DESC`)
      .all() as Array<{
      id: string;
      project_id: string | null;
      title: string;
      body_md: string;
      created_at: number;
      updated_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      title: r.title,
      bodyMd: r.body_md,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  getNote(id: string): Note | null {
    return this.listNotes().find((n) => n.id === id) ?? null;
  }

  createNote(input: {
    title?: string;
    bodyMd?: string;
    projectId?: string | null;
    nowMs?: number;
  }): Note {
    const note = createNoteDraft(input);
    this.db
      .prepare(
        `INSERT INTO notes (id, project_id, title, body_md, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        note.id,
        note.projectId,
        note.title,
        note.bodyMd,
        note.createdAt,
        note.updatedAt,
      );
    return note;
  }

  updateNote(
    id: string,
    patch: { title?: string; bodyMd?: string; projectId?: string | null },
    nowMs = Date.now(),
  ): Note {
    const current = this.getNote(id);
    if (!current) throw new DomainError(`note not found: ${id}`);
    const next = patchNote(current, patch, nowMs);
    this.db
      .prepare(
        `UPDATE notes SET project_id = ?, title = ?, body_md = ?, updated_at = ? WHERE id = ?`,
      )
      .run(next.projectId, next.title, next.bodyMd, next.updatedAt, id);
    return next;
  }

  deleteNote(id: string): void {
    this.db.prepare(`DELETE FROM notes WHERE id = ?`).run(id);
  }
}
