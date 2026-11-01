import {
  applySchedulePatch,
  assertNoRepeatOnSubtask,
  assertTagIdAllowed,
  agentThreadTitle,
  BUILTIN_MODEL_REF,
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
  ensureTagColor,
  pickTagColor,
  selectTodayTasks,
  settleTimerSegment,
  sumTimeSpentOnDay,
  type AgentApproval,
  type AgentMessage,
  type AgentPermissionMode,
  type AgentRole,
  type AgentThread,
  type Note,
  type ProjectBucket,
  type ReminderOptionId,
  type SchedulePatch,
  type Tag,
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
type MemProject = { id: string; title: string; isArchived?: boolean };

type MemNotification = {
  id: string;
  kind: string;
  title: string;
  status: string;
  fireAt: number;
  refId: string | null;
  snoozeUntil?: number | null;
};

export class MemoryWorkbenchRepository {
  private tasks = new Map<string, Task>();
  private projects = new Map<string, MemProject>([
    [INBOX_PROJECT_ID, { id: INBOX_PROJECT_ID, title: "收件箱" }],
  ]);
  private buckets = new Map<string, ProjectBucket>();
  private todayOrder: string[] = [];
  private notes = new Map<string, Note>();
  private timedTasks = new Map<string, TimedTask>();
  private tags = new Map<string, Tag>();
  private taskTags = new Map<string, Set<string>>();
  private notifications: MemNotification[] = [];
  private agentThreads = new Map<string, AgentThread>();
  private agentMessages: AgentMessage[] = [];
  private agentApprovals: AgentApproval[] = [];

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

  setTaskBucket(taskId: string, bucket: ProjectBucket, nowMs = Date.now()): Task {
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
    this.taskTags.delete(taskId);
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

  setTaskParent(taskId: string, parentId: string | null, nowMs = Date.now()): Task {
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
    return this.updateTask(copy.id, { timeEstimate: task.timeEstimate }, nowMs);
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

  createTag(title: string, id?: string): Tag {
    const trimmed = title.trim();
    if (!trimmed) throw new DomainError("tag title is required");
    const tagId = id ?? createId();
    assertTagIdAllowed(tagId);
    if (this.tags.has(tagId)) throw new DomainError(`tag exists: ${tagId}`);
    const tag: Tag = {
      id: tagId,
      title: trimmed,
      color: pickTagColor(trimmed),
    };
    this.tags.set(tagId, tag);
    return tag;
  }

  listTags(): Tag[] {
    return [...this.tags.values()]
      .map((tag) => this.withTagColor(tag))
      .sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
  }

  deleteTag(tagId: string): void {
    if (!this.tags.has(tagId)) throw new DomainError(`tag not found: ${tagId}`);
    this.tags.delete(tagId);
    for (const [taskId, set] of this.taskTags) {
      set.delete(tagId);
      if (set.size === 0) this.taskTags.delete(taskId);
    }
  }

  assignTag(taskId: string, tagId: string): void {
    assertTagIdAllowed(tagId);
    if (!this.tasks.has(taskId)) throw new DomainError(`task not found: ${taskId}`);
    if (!this.tags.has(tagId)) throw new DomainError(`tag not found: ${tagId}`);
    const set = this.taskTags.get(taskId) ?? new Set<string>();
    set.add(tagId);
    this.taskTags.set(taskId, set);
  }

  unassignTag(taskId: string, tagId: string): void {
    const set = this.taskTags.get(taskId);
    if (!set) return;
    set.delete(tagId);
    if (set.size === 0) this.taskTags.delete(taskId);
  }

  listTagsForTask(taskId: string): Tag[] {
    const ids = this.taskTags.get(taskId);
    if (!ids) return [];
    return [...ids]
      .map((id) => this.tags.get(id))
      .filter((t): t is Tag => t != null)
      .map((tag) => this.withTagColor(tag))
      .sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
  }

  private withTagColor(tag: Tag): Tag {
    const color = ensureTagColor(tag);
    if (tag.color === color) return tag;
    const next = { ...tag, color };
    this.tags.set(tag.id, next);
    return next;
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

  listProjects(opts?: { includeArchived?: boolean }): MemProject[] {
    const all = [...this.projects.values()];
    if (opts?.includeArchived) return all;
    return all.filter((project) => !project.isArchived);
  }

  createProject(title: string, nowMs = Date.now()) {
    const id = createId(nowMs);
    const project = { id, title, isArchived: false };
    this.projects.set(id, project);
    return project;
  }

  archiveProject(projectId: string): MemProject {
    if (projectId === INBOX_PROJECT_ID) {
      throw new DomainError("inbox cannot be archived");
    }
    const project = this.projects.get(projectId);
    if (!project) throw new DomainError(`unknown project: ${projectId}`);
    const next = { ...project, isArchived: true };
    this.projects.set(projectId, next);
    return next;
  }

  dismissNotification(id: string): void {
    const row = this.notifications.find((item) => item.id === id);
    if (!row) throw new DomainError(`notification not found: ${id}`);
    row.status = "dismissed";
  }

  snoozeNotification(id: string, untilMs: number): void {
    const row = this.notifications.find((item) => item.id === id);
    if (!row) throw new DomainError(`notification not found: ${id}`);
    row.status = "snoozed";
    row.snoozeUntil = untilMs;
  }

  createAgentThread(input?: {
    title?: string;
    projectId?: string | null;
    modelRef?: string;
    permissionMode?: AgentPermissionMode;
    nowMs?: number;
  }): AgentThread {
    const now = input?.nowMs ?? Date.now();
    const thread: AgentThread = {
      id: createId(now),
      projectId: input?.projectId ?? null,
      title: input?.title?.trim() || "新会话",
      modelRef: input?.modelRef || BUILTIN_MODEL_REF,
      permissionMode: input?.permissionMode ?? "confirm",
      queueJson: null,
      createdAt: now,
      updatedAt: now,
    };
    this.agentThreads.set(thread.id, thread);
    return thread;
  }

  listAgentThreads(): AgentThread[] {
    return [...this.agentThreads.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getAgentThread(id: string): AgentThread | null {
    return this.agentThreads.get(id) ?? null;
  }

  updateAgentThread(
    id: string,
    patch: Partial<
      Pick<
        AgentThread,
        "title" | "modelRef" | "permissionMode" | "projectId" | "queueJson"
      >
    >,
    nowMs = Date.now(),
  ): AgentThread {
    const current = this.agentThreads.get(id);
    if (!current) throw new DomainError(`agent thread not found: ${id}`);
    const next = { ...current, ...patch, updatedAt: nowMs };
    this.agentThreads.set(id, next);
    return next;
  }

  deleteAgentThread(id: string): void {
    this.agentThreads.delete(id);
    this.agentMessages = this.agentMessages.filter((message) => message.threadId !== id);
    this.agentApprovals = this.agentApprovals.filter((item) => item.threadId !== id);
  }

  appendAgentMessage(input: {
    threadId: string;
    role: AgentRole;
    content: string;
    toolName?: string | null;
    toolCallId?: string | null;
    toolCallsJson?: string | null;
    nowMs?: number;
  }): AgentMessage {
    const thread = this.agentThreads.get(input.threadId);
    if (!thread) throw new DomainError(`agent thread not found: ${input.threadId}`);
    const now = input.nowMs ?? Date.now();
    const message: AgentMessage = {
      id: createId(now),
      threadId: input.threadId,
      role: input.role,
      content: input.content,
      toolName: input.toolName ?? null,
      toolCallId: input.toolCallId ?? null,
      toolCallsJson: input.toolCallsJson ?? null,
      createdAt: now,
    };
    this.agentMessages.push(message);
    const title =
      thread.title === "新会话" && input.role === "user"
        ? agentThreadTitle(input.content)
        : thread.title;
    this.agentThreads.set(thread.id, { ...thread, title, updatedAt: now });
    return message;
  }

  listAgentMessages(threadId: string): AgentMessage[] {
    return this.agentMessages.filter((message) => message.threadId === threadId);
  }

  /** Drop one message and everything after it in the same thread. */
  deleteAgentMessagesFrom(threadId: string, messageId: string, nowMs = Date.now()): void {
    const inThread = this.agentMessages.filter(
      (message) => message.threadId === threadId,
    );
    const start = inThread.findIndex((message) => message.id === messageId);
    if (start < 0) return;
    const drop = new Set(inThread.slice(start).map((message) => message.id));
    this.agentMessages = this.agentMessages.filter((message) => !drop.has(message.id));
    const thread = this.agentThreads.get(threadId);
    if (!thread) return;
    this.agentThreads.set(threadId, { ...thread, queueJson: null, updatedAt: nowMs });
  }

  addAgentApproval(input: {
    threadId: string;
    toolCallId?: string | null;
    toolName: string;
    argsJson: string;
    summary: string;
    nowMs?: number;
  }): AgentApproval {
    if (!this.agentThreads.has(input.threadId)) {
      throw new DomainError(`agent thread not found: ${input.threadId}`);
    }
    const now = input.nowMs ?? Date.now();
    const approval: AgentApproval = {
      id: createId(now),
      threadId: input.threadId,
      toolCallId: input.toolCallId ?? null,
      toolName: input.toolName,
      argsJson: input.argsJson,
      summary: input.summary,
      status: "pending",
      createdAt: now,
      resolvedAt: null,
    };
    this.agentApprovals.push(approval);
    return approval;
  }

  listAgentApprovals(threadId: string): AgentApproval[] {
    return this.agentApprovals.filter((item) => item.threadId === threadId);
  }

  resolveAgentApproval(
    id: string,
    status: "approved" | "denied",
    nowMs = Date.now(),
  ): AgentApproval {
    const index = this.agentApprovals.findIndex((item) => item.id === id);
    const current = this.agentApprovals[index];
    if (!current) throw new DomainError(`agent approval not found: ${id}`);
    const next: AgentApproval = { ...current, status, resolvedAt: nowMs };
    this.agentApprovals[index] = next;
    return next;
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
      tags: [...this.tags.values()],
      taskTags: [...this.taskTags.entries()].map(([taskId, set]) => [taskId, [...set]]),
      agentThreads: [...this.agentThreads.values()],
      agentMessages: this.agentMessages,
      agentApprovals: this.agentApprovals,
    });
  }

  importSnapshot(json: string): void {
    const data = JSON.parse(json) as {
      tasks: Task[];
      projects: MemProject[];
      buckets: Array<[string, ProjectBucket]>;
      todayOrder: string[];
      notifications: MemNotification[];
      notes?: Note[];
      timedTasks?: Array<
        TimedTask & { schedule?: TimedSchedule | null; schedules?: TimedSchedule[] }
      >;
      tags?: Tag[];
      taskTags?: Array<[string, string[]]>;
      agentThreads?: AgentThread[];
      agentMessages?: AgentMessage[];
      agentApprovals?: AgentApproval[];
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
    this.tags = new Map(
      (data.tags ?? []).map((t) => {
        const color = ensureTagColor({
          title: t.title,
          color: t.color ?? null,
        });
        return [t.id, { id: t.id, title: t.title, color }];
      }),
    );
    this.taskTags = new Map(
      (data.taskTags ?? []).map(([taskId, ids]) => [taskId, new Set(ids)]),
    );
    this.agentThreads = new Map(
      (data.agentThreads ?? []).map((thread) => [
        thread.id,
        { ...thread, queueJson: thread.queueJson ?? null },
      ]),
    );
    this.agentMessages = (data.agentMessages ?? []).map((message) => ({
      ...message,
      toolCallsJson: message.toolCallsJson ?? null,
    }));
    this.agentApprovals = (data.agentApprovals ?? []).map((approval) => ({
      ...approval,
      toolCallId: approval.toolCallId ?? null,
    }));
  }
}
