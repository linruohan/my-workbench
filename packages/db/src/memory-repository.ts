import {
  applySchedulePatch,
  assertNoRepeatOnSubtask,
  assertTagIdAllowed,
  clearPlanFields,
  collectDueReminders,
  createId,
  createNoteDraft,
  coerceTimedTask,
  createTimedTaskDraft,
  DomainError,
  INBOX_PROJECT_ID,
  isPlannerMember,
  isScheduleMember,
  markTaskComplete,
  markTaskIncomplete,
  patchNote,
  patchTaskContent,
  patchTimedTask,
  selectTodayTasks,
  settleTimerSegment,
  sumTimeSpentOnDay,
  type Note,
  type ProjectBucket,
  type ReminderOptionId,
  type SchedulePatch,
  type Task,
  type TimedSchedule,
  type TimedTask,
  remindOptionToMilliseconds,
  shiftRemindAt,
} from "@wb/domain";

/**
 * Fully local in-memory repository for UI / browser tests.
 * Same behavioral surface as WorkbenchRepository (SQLite).
 */
export class MemoryWorkbenchRepository {
  private tasks = new Map<string, Task>();
  private projects = new Map<string, { id: string; title: string }>([
    [INBOX_PROJECT_ID, { id: INBOX_PROJECT_ID, title: "收件箱" }],
  ]);
  private buckets = new Map<string, ProjectBucket>();
  private todayOrder: string[] = [];
  private notes = new Map<string, Note>();
  private timedTasks = new Map<string, TimedTask>();
  private notifications: Array<{
    id: string;
    kind: string;
    title: string;
    status: string;
    fireAt: number;
    refId: string | null;
  }> = [];

  listTasks(): Task[] {
    return [...this.tasks.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  getTask(id: string): Task | null {
    return this.tasks.get(id) ?? null;
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
    const projectId = input.projectId ?? INBOX_PROJECT_ID;
    if (!this.projects.has(projectId)) {
      throw new DomainError(`unknown project: ${projectId}`);
    }
    const task: Task = {
      id: createId(now),
      projectId,
      parentId: input.parentId ?? null,
      title: input.title,
      notes: input.notes ?? "",
      isDone: false,
      doneOn: null,
      dueDay: null,
      dueWithTime: null,
      deadlineDay: null,
      deadlineWithTime: null,
      remindAt: null,
      deadlineRemindAt: null,
      timeEstimate: 0,
      timeSpent: 0,
      timeSpentOnDay: {},
      repeatCfgId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    this.buckets.set(task.id, input.bucket ?? "active");
    return task;
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
    const next: Task = {
      ...task,
      ...scheduled,
      dueDay: scheduled.dueDay ?? null,
      dueWithTime: scheduled.dueWithTime ?? null,
      deadlineDay: scheduled.deadlineDay ?? null,
      deadlineWithTime: scheduled.deadlineWithTime ?? null,
      remindAt: scheduled.remindAt ?? null,
      deadlineRemindAt: scheduled.deadlineRemindAt ?? null,
      updatedAt: nowMs,
    };
    this.tasks.set(taskId, next);
    return next;
  }

  getTaskBucket(taskId: string): ProjectBucket {
    return this.buckets.get(taskId) ?? "active";
  }

  setTaskBucket(
    taskId: string,
    bucket: ProjectBucket,
    nowMs = Date.now(),
  ): Task {
    const task = this.getTask(taskId);
    if (!task) throw new DomainError(`task not found: ${taskId}`);
    if (bucket === "backlog") {
      return this.moveToBacklog(taskId, nowMs);
    }
    const next = { ...task, updatedAt: nowMs };
    this.tasks.set(taskId, next);
    this.buckets.set(taskId, "active");
    return next;
  }

  moveToBacklog(taskId: string, nowMs = Date.now()): Task {
    const task = this.getTask(taskId);
    if (!task) throw new DomainError(`task not found: ${taskId}`);
    const cleared = clearPlanFields({
      dueDay: task.dueDay,
      dueWithTime: task.dueWithTime,
      remindAt: task.remindAt,
    });
    const next = {
      ...task,
      dueDay: cleared.dueDay ?? null,
      dueWithTime: cleared.dueWithTime ?? null,
      remindAt: cleared.remindAt ?? null,
      updatedAt: nowMs,
    };
    this.tasks.set(taskId, next);
    this.buckets.set(taskId, "backlog");
    return next;
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
    if (patch.projectId !== undefined && !this.projects.has(patch.projectId)) {
      throw new DomainError(`unknown project: ${patch.projectId}`);
    }
    const next = patchTaskContent(task, patch, nowMs);
    this.tasks.set(taskId, next);
    return next;
  }

  deleteTask(taskId: string): void {
    if (!this.tasks.has(taskId)) {
      throw new DomainError(`task not found: ${taskId}`);
    }
    this.tasks.delete(taskId);
    this.buckets.delete(taskId);
    this.todayOrder = this.todayOrder.filter((id) => id !== taskId);
    for (const child of this.listTasks().filter((t) => t.parentId === taskId)) {
      this.tasks.set(child.id, {
        ...child,
        parentId: null,
        updatedAt: Date.now(),
      });
    }
  }

  completeTask(taskId: string, nowMs = Date.now()): Task {
    const task = this.getTask(taskId);
    if (!task) throw new DomainError(`task not found: ${taskId}`);
    const next = markTaskComplete(task, nowMs);
    this.tasks.set(taskId, next);
    return next;
  }

  uncompleteTask(taskId: string, nowMs = Date.now()): Task {
    const task = this.getTask(taskId);
    if (!task) throw new DomainError(`task not found: ${taskId}`);
    const next = markTaskIncomplete(task, nowMs);
    this.tasks.set(taskId, next);
    if (!this.buckets.has(taskId)) this.buckets.set(taskId, "active");
    return next;
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
        throw new DomainError("nested subtasks deeper than one level are not supported");
      }
    }
    const next = { ...task, parentId, updatedAt: nowMs };
    this.tasks.set(taskId, next);
    return next;
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
    const children = this.listTasks().filter((t) => t.parentId === taskId);
    if (!task.parentId && children.length > 0) {
      throw new DomainError("parent with subtasks cannot be timed directly");
    }
    const { map } = settleTimerSegment(task.timeSpentOnDay, startedAt, endedAt);
    const next = {
      ...task,
      timeSpentOnDay: map,
      timeSpent: sumTimeSpentOnDay(map),
      updatedAt: endedAt,
    };
    this.tasks.set(taskId, next);
    return next;
  }

  setRepeatCfg(taskId: string, repeatCfgId: string | null, nowMs = Date.now()): Task {
    const task = this.getTask(taskId);
    if (!task) throw new DomainError(`task not found: ${taskId}`);
    assertNoRepeatOnSubtask(task.parentId, repeatCfgId);
    const next = { ...task, repeatCfgId, updatedAt: nowMs };
    this.tasks.set(taskId, next);
    return next;
  }

  createTag(title: string, id?: string): { id: string; title: string } {
    const tagId = id ?? createId();
    assertTagIdAllowed(tagId);
    return { id: tagId, title };
  }

  setTodayOrder(taskIds: string[]): void {
    this.todayOrder = [...taskIds];
  }

  getTodayOrder(): string[] {
    return [...this.todayOrder];
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

  deliverDueReminders(nowMs: number) {
    const due = collectDueReminders(this.listTasks(), nowMs);
    const created = [];
    for (const item of due) {
      if (
        this.notifications.some(
          (n) => n.refId === item.taskId && n.fireAt === item.remindAt,
        )
      ) {
        continue;
      }
      const row = {
        id: createId(nowMs),
        kind: item.isDeadline ? "deadline_remind" : "task_remind",
        title: item.title,
        status: "delivered",
        fireAt: item.remindAt,
        refId: item.taskId,
      };
      this.notifications.push(row);
      created.push({
        id: row.id,
        taskId: item.taskId,
        title: item.title,
        isDeadline: item.isDeadline,
        remindAt: item.remindAt,
      });
    }
    return created;
  }

  listNotifications() {
    return [...this.notifications].sort((a, b) => b.fireAt - a.fireAt);
  }

  listProjects(): Array<{ id: string; title: string }> {
    return [...this.projects.values()];
  }

  createProject(title: string, nowMs = Date.now()) {
    const id = createId(nowMs);
    this.projects.set(id, { id, title });
    return { id, title };
  }

  listNotes(): Note[] {
    return [...this.notes.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getNote(id: string): Note | null {
    return this.notes.get(id) ?? null;
  }

  createNote(input: {
    title?: string;
    bodyMd?: string;
    projectId?: string | null;
    nowMs?: number;
  }): Note {
    const note = createNoteDraft(input);
    this.notes.set(note.id, note);
    return note;
  }

  updateNote(
    id: string,
    patch: { title?: string; bodyMd?: string; projectId?: string | null },
    nowMs = Date.now(),
  ): Note {
    const current = this.notes.get(id);
    if (!current) throw new DomainError(`note not found: ${id}`);
    const next = patchNote(current, patch, nowMs);
    this.notes.set(id, next);
    return next;
  }

  deleteNote(id: string): void {
    this.notes.delete(id);
  }

  listTimedTasks(): TimedTask[] {
    return [...this.timedTasks.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getTimedTask(id: string): TimedTask | null {
    return this.timedTasks.get(id) ?? null;
  }

  createTimedTask(input: {
    title?: string;
    command?: string;
    schedule?: TimedSchedule | null;
    /** @deprecated use schedule */
    schedules?: TimedSchedule[];
    nowMs?: number;
  }): TimedTask {
    const task = createTimedTaskDraft(input);
    this.timedTasks.set(task.id, task);
    return task;
  }

  updateTimedTask(
    id: string,
    patch: {
      title?: string;
      command?: string;
      schedule?: TimedSchedule | null;
      /** @deprecated use schedule */
      schedules?: TimedSchedule[];
      enabled?: boolean;
    },
    nowMs = Date.now(),
  ): TimedTask {
    const current = this.timedTasks.get(id);
    if (!current) throw new DomainError(`timed task not found: ${id}`);
    const next = patchTimedTask(current, patch, nowMs);
    this.timedTasks.set(id, next);
    return next;
  }

  deleteTimedTask(id: string): void {
    this.timedTasks.delete(id);
  }

  /** Persist snapshot to a local JSON string (for localStorage). */
  exportSnapshot(): string {
    return JSON.stringify({
      tasks: [...this.tasks.values()],
      projects: [...this.projects.values()],
      buckets: [...this.buckets.entries()],
      todayOrder: this.todayOrder,
      notifications: this.notifications,
      notes: [...this.notes.values()],
      timedTasks: [...this.timedTasks.values()],
    });
  }

  importSnapshot(json: string): void {
    const data = JSON.parse(json) as {
      tasks: Task[];
      projects: Array<{ id: string; title: string }>;
      buckets: Array<[string, ProjectBucket]>;
      todayOrder: string[];
      notifications: Array<{
        id: string;
        kind: string;
        title: string;
        status: string;
        fireAt: number;
        refId: string | null;
      }>;
      notes?: Note[];
      timedTasks?: Array<
        TimedTask & { schedule?: TimedSchedule | null; schedules?: TimedSchedule[] }
      >;
    };
    this.tasks = new Map(data.tasks.map((t) => [t.id, t]));
    this.projects = new Map(data.projects.map((p) => [p.id, p]));
    this.buckets = new Map(data.buckets);
    this.todayOrder = data.todayOrder ?? [];
    this.notifications = data.notifications ?? [];
    this.notes = new Map((data.notes ?? []).map((n) => [n.id, n]));
    this.timedTasks = new Map(
      (data.timedTasks ?? []).map((t) => {
        const next = coerceTimedTask(t);
        return [next.id, next];
      }),
    );
  }
}
