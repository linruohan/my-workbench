import {
  agentRootsMatch,
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
  isScheduleMember,
  selectPlannerTasks,
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
  DEFAULT_AGENT_WORKSPACE_TITLE,
  normalizeAgentWebUrl,
  type AgentApproval,
  type AgentMessage,
  type AgentPermissionMode,
  type AgentRole,
  type AgentThread,
  type AgentWorkspace,
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
  body?: string;
  status: string;
  fireAt: number;
  refId: string | null;
  snoozeUntil?: number | null;
};

/** SQLite 增量持久化的实体集合名（entities.kind）。 */
export type EntityKind =
  | "task"
  | "task_bucket"
  | "project"
  | "today_order"
  | "notification"
  | "note"
  | "timed_task"
  | "tag"
  | "task_tag"
  | "agent_workspace"
  | "agent_thread"
  | "agent_message"
  | "agent_approval";

/** 一条待写实体：upsert 携带规范化 JSON；seq 用于加载时保序（如会话消息）。 */
export type PendingEntity = {
  kind: EntityKind;
  id: string;
  seq?: number;
  data: string;
};

export type PendingKey = { kind: EntityKind; id: string };

/** collectPendingChanges() 的结果：逐实体增删 + 需整集合替换的 kind。 */
export type PendingChanges = {
  upserts: PendingEntity[];
  deletes: PendingKey[];
  /** 这些 kind 需要先清空再写入（小集合的全量替换语义）。 */
  replaced: EntityKind[];
};

const ALL_KINDS: EntityKind[] = [
  "task",
  "task_bucket",
  "project",
  "today_order",
  "notification",
  "note",
  "timed_task",
  "tag",
  "task_tag",
  "agent_workspace",
  "agent_thread",
  "agent_message",
  "agent_approval",
];

export class MemoryWorkbenchRepository {
  private tasks = new Map<string, Task>();
  /** listTasks 的缓存；任何任务变更时通过 touchTasks() 失效。 */
  private taskListCache: Task[] | null = null;
  /** listTagsForTask 的按任务缓存；标签分配/删除/导入时清空。 */
  private taskTagListCache = new Map<string, Tag[]>();
  /** 其余列表查询的稳定引用缓存（通知/项目/标签/笔记/定时任务）。 */
  private notificationsListCache: MemNotification[] | null = null;
  private projectsListCache: MemProject[] | null = null;
  private tagsListCache: Tag[] | null = null;
  private notesListCache: Note[] | null = null;
  private timedListCache: TimedTask[] | null = null;
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
  private agentWorkspaces = new Map<string, AgentWorkspace>();
  private agentThreads = new Map<string, AgentThread>();
  /** Agent 列表查询的稳定引用缓存（线程/工作区），任何 Agent 变更时失效。 */
  private agentThreadListCache: AgentThread[] | null = null;
  private agentWorkspaceListCache: AgentWorkspace[] | null = null;
  private agentMessages: AgentMessage[] = [];
  private agentMessagesByThread = new Map<string, AgentMessage[]>();
  /** listAgentMessages 的按线程克隆缓存；消息增删时失效。 */
  private agentMessagesListCache = new Map<string, AgentMessage[]>();
  private agentApprovals: AgentApproval[] = [];

  // ---- SQLite 增量持久化的变更日志 ----
  /** agent 消息逐实体日志（高频路径，避免整集合重序列化）；后写覆盖先写。 */
  private messageJournal = new Map<string, "upsert" | "delete">();
  /** 需要整集合替换的 kind（小集合；touch 即标记）。 */
  private replaceKinds = new Set<EntityKind>();
  /** importSnapshot 后置位：所有 kind 全量替换（迁移/导入场景）。 */
  private journalFull = false;

  private rebuildAgentMessageIndex(): void {
    const index = new Map<string, AgentMessage[]>();
    for (const message of this.agentMessages) {
      const list = index.get(message.threadId);
      if (list) list.push(message);
      else index.set(message.threadId, [message]);
    }
    this.agentMessagesByThread = index;
    this.agentMessagesListCache.clear();
  }

  /** 防止单会话消息无限增长导致快照/内存膨胀；超限时丢弃最早消息。
   *  裁剪边界保证上下文完整：工具结果必须与其调用方（assistant 工具调用）同进退，
   *  边界落在工具结果上时把结果一并丢弃，避免留下调用方已失踪的孤儿 tool 消息
   *  （重放到 OpenAI / Responses 等接口会被拒绝）。 */
  private trimAgentThreadMessages(threadId: string, limit = 1200): void {
    const list = this.agentMessagesByThread.get(threadId);
    if (!list || list.length <= limit) return;
    let dropCount = list.length - limit;
    while (dropCount < list.length && list[dropCount].role === "tool") {
      dropCount += 1;
    }
    if (dropCount >= list.length) return;
    const droppedList = list.slice(0, dropCount);
    const dropped = new Set(droppedList.map((message) => message.id));
    this.agentMessagesByThread.set(threadId, list.slice(dropCount));
    this.agentMessages = this.agentMessages.filter((message) => !dropped.has(message.id));
    this.touchAgentMessages(threadId);
    this.journalAgentMessages(droppedList, "delete");
  }

  // ---- 变更日志：写入 SQLite 前由 collectPendingChanges() 消费 ----

  private markReplace(kind: EntityKind): void {
    if (this.journalFull) return;
    this.replaceKinds.add(kind);
  }

  /** 会话消息逐实体日志；后写覆盖先写（先 upsert 后 delete → 删除）。 */
  private journalAgentMessages(
    messages: readonly AgentMessage[],
    op: "upsert" | "delete",
  ): void {
    if (this.journalFull) return;
    for (const message of messages) {
      this.messageJournal.set(message.id, op);
    }
  }

  /**
   * 汇出待持久化变更：会话消息逐实体增删，其余 kind 整集合替换（行数有界）。
   * 只读不改日志；写库成功后调用 markPersisted() 才清空，失败可重试。
   * 无变更时返回 null，持久化层据此跳过写库。
   */
  collectPendingChanges(): PendingChanges | null {
    if (
      !this.journalFull &&
      this.replaceKinds.size === 0 &&
      this.messageJournal.size === 0
    ) {
      return null;
    }
    const upserts: PendingEntity[] = [];
    const deletes: PendingKey[] = [];
    const replaced: EntityKind[] = [];
    if (this.journalFull) {
      for (const kind of ALL_KINDS) {
        replaced.push(kind);
        upserts.push(...this.serializeKind(kind));
      }
      return { upserts, deletes, replaced };
    }
    for (const kind of this.replaceKinds) {
      replaced.push(kind);
      upserts.push(...this.serializeKind(kind));
    }
    for (const [id, op] of this.messageJournal) {
      if (op === "delete") {
        deletes.push({ kind: "agent_message", id });
        continue;
      }
      const message = this.agentMessages.find((item) => item.id === id);
      // 日志期间又被删除：按删除处理，避免写回幽灵行。
      if (!message) {
        deletes.push({ kind: "agent_message", id });
        continue;
      }
      upserts.push({
        kind: "agent_message",
        id,
        seq: message.createdAt,
        data: JSON.stringify(message),
      });
    }
    return { upserts, deletes, replaced };
  }

  /** 落库成功后清空日志，回到干净状态（首次从 SQLite 装载后也用它复位）。 */
  markPersisted(): void {
    this.messageJournal.clear();
    this.replaceKinds.clear();
    this.journalFull = false;
  }

  /** 整集合序列化为待写行；today_order 是单行（id 固定 current）。 */
  private serializeKind(kind: EntityKind): PendingEntity[] {
    switch (kind) {
      case "task":
        return [...this.tasks.values()].map((task) => ({
          kind,
          id: task.id,
          data: JSON.stringify(task),
        }));
      case "task_bucket":
        return [...this.buckets.entries()].map(([id, bucket]) => ({
          kind,
          id,
          data: JSON.stringify(bucket),
        }));
      case "project":
        return [...this.projects.values()].map((project) => ({
          kind,
          id: project.id,
          data: JSON.stringify(project),
        }));
      case "today_order":
        return [{ kind, id: "current", data: JSON.stringify(this.todayOrder) }];
      case "notification":
        return this.notifications.map((row) => ({
          kind,
          id: row.id,
          data: JSON.stringify(row),
        }));
      case "note":
        return [...this.notes.values()].map((note) => ({
          kind,
          id: note.id,
          data: JSON.stringify(note),
        }));
      case "timed_task":
        return [...this.timedTasks.values()].map((task) => ({
          kind,
          id: task.id,
          data: JSON.stringify(task),
        }));
      case "tag":
        return [...this.tags.values()].map((tag) => ({
          kind,
          id: tag.id,
          data: JSON.stringify(tag),
        }));
      case "task_tag":
        return [...this.taskTags.entries()].map(([taskId, ids]) => ({
          kind,
          id: taskId,
          data: JSON.stringify([...ids]),
        }));
      case "agent_workspace":
        return [...this.agentWorkspaces.values()].map((workspace) => ({
          kind,
          id: workspace.id,
          data: JSON.stringify(workspace),
        }));
      case "agent_thread":
        return [...this.agentThreads.values()].map((thread) => ({
          kind,
          id: thread.id,
          data: JSON.stringify(thread),
        }));
      case "agent_message":
        return this.agentMessages.map((message) => ({
          kind,
          id: message.id,
          seq: message.createdAt,
          data: JSON.stringify(message),
        }));
      case "agent_approval":
        return this.agentApprovals.map((approval) => ({
          kind,
          id: approval.id,
          data: JSON.stringify(approval),
        }));
    }
  }

  private trimNotifications(limit = 300): void {
    if (this.notifications.length <= limit) return;
    const sorted = [...this.notifications].sort((a, b) => b.fireAt - a.fireAt);
    const keep = new Set<string>();
    for (const item of sorted) {
      if (keep.size >= limit) break;
      keep.add(item.id);
    }
    this.notifications = this.notifications.filter((item) => keep.has(item.id));
    this.touchNotifications();
  }

  listTasks(): Task[] {
    // 按需缓存：返回稳定数组引用（直到任一任务变更），上层 useMemo 可命中。
    if (this.taskListCache) return this.taskListCache;
    const list = [...this.tasks.values()].sort((a, b) => a.createdAt - b.createdAt);
    this.taskListCache = list;
    return list;
  }

  /** 任务集合/字段发生任何变更后使 listTasks 缓存失效，并标记持久化脏。 */
  private touchTasks(): void {
    this.taskListCache = null;
    this.markReplace("task");
    this.markReplace("task_bucket");
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
    this.touchTasks();
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
    this.touchTasks();
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
    this.touchTasks();
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
    this.touchTasks();
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
    this.touchTasks();
    return next;
  }

  deleteTask(taskId: string): void {
    if (!this.tasks.has(taskId)) {
      throw new DomainError(`task not found: ${taskId}`);
    }
    this.tasks.delete(taskId);
    this.buckets.delete(taskId);
    this.taskTags.delete(taskId);
    this.taskTagListCache.delete(taskId);
    this.todayOrder = this.todayOrder.filter((id) => id !== taskId);
    this.markReplace("today_order");
    this.markReplace("task_tag");
    this.touchTasks();
    for (const child of this.listTasks().filter((t) => t.parentId === taskId)) {
      this.tasks.set(child.id, {
        ...child,
        parentId: null,
        updatedAt: Date.now(),
      });
    }
    this.touchTasks();
  }

  completeTask(taskId: string, nowMs = Date.now()): Task {
    const task = this.getTask(taskId);
    if (!task) throw new DomainError(`task not found: ${taskId}`);
    const next = markTaskComplete(task, nowMs);
    this.tasks.set(taskId, next);
    this.touchTasks();
    return next;
  }

  uncompleteTask(taskId: string, nowMs = Date.now()): Task {
    const task = this.getTask(taskId);
    if (!task) throw new DomainError(`task not found: ${taskId}`);
    const next = markTaskIncomplete(task, nowMs);
    this.tasks.set(taskId, next);
    if (!this.buckets.has(taskId)) this.buckets.set(taskId, "active");
    this.touchTasks();
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
    this.touchTasks();
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
    this.touchTasks();
    return next;
  }

  setRepeatCfg(taskId: string, repeatCfgId: string | null, nowMs = Date.now()): Task {
    const task = this.getTask(taskId);
    if (!task) throw new DomainError(`task not found: ${taskId}`);
    assertNoRepeatOnSubtask(task.parentId, repeatCfgId);
    const next = { ...task, repeatCfgId, updatedAt: nowMs };
    this.tasks.set(taskId, next);
    this.touchTasks();
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
    this.touchTags();
    return tag;
  }

  listTags(): Tag[] {
    if (this.tagsListCache) return this.tagsListCache;
    const list = [...this.tags.values()]
      .map((tag) => this.withTagColor(tag))
      .sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
    this.tagsListCache = list;
    return list;
  }

  deleteTag(tagId: string): void {
    if (!this.tags.has(tagId)) throw new DomainError(`tag not found: ${tagId}`);
    this.tags.delete(tagId);
    for (const [taskId, set] of this.taskTags) {
      set.delete(tagId);
      if (set.size === 0) this.taskTags.delete(taskId);
    }
    this.touchTags();
  }

  assignTag(taskId: string, tagId: string): void {
    assertTagIdAllowed(tagId);
    if (!this.tasks.has(taskId)) throw new DomainError(`task not found: ${taskId}`);
    if (!this.tags.has(tagId)) throw new DomainError(`tag not found: ${tagId}`);
    const set = this.taskTags.get(taskId) ?? new Set<string>();
    set.add(tagId);
    this.taskTags.set(taskId, set);
    this.touchTags();
  }

  unassignTag(taskId: string, tagId: string): void {
    const set = this.taskTags.get(taskId);
    if (!set) return;
    set.delete(tagId);
    if (set.size === 0) this.taskTags.delete(taskId);
    this.touchTags();
  }

  listTagsForTask(taskId: string): Tag[] {
    const cached = this.taskTagListCache.get(taskId);
    if (cached) return cached;
    const ids = this.taskTags.get(taskId);
    const list: Tag[] = ids
      ? [...ids]
          .map((id) => this.tags.get(id))
          .filter((t): t is Tag => t != null)
          .map((tag) => this.withTagColor(tag))
          .sort((a, b) => a.title.localeCompare(b.title, "zh-CN"))
      : [];
    this.taskTagListCache.set(taskId, list);
    return list;
  }

  /** 标签分配关系变更后清空 listTagsForTask 缓存，并标记持久化脏。 */
  private touchTags(): void {
    this.taskTagListCache.clear();
    this.tagsListCache = null;
    this.markReplace("tag");
    this.markReplace("task_tag");
  }

  private touchNotes(): void {
    this.notesListCache = null;
    this.markReplace("note");
  }

  private touchProjects(): void {
    this.projectsListCache = null;
    this.markReplace("project");
  }

  private touchTimed(): void {
    this.timedListCache = null;
    this.markReplace("timed_task");
  }

  private touchNotifications(): void {
    this.notificationsListCache = null;
    this.markReplace("notification");
  }

  private withTagColor(tag: Tag): Tag {
    const color = ensureTagColor(tag);
    if (tag.color === color) return tag;
    const next = { ...tag, color };
    this.tags.set(tag.id, next);
    this.markReplace("tag");
    return next;
  }

  setTodayOrder(taskIds: string[]): void {
    this.todayOrder = [...taskIds];
    this.markReplace("today_order");
  }

  getTodayOrder(): string[] {
    return [...this.todayOrder];
  }

  listToday(nowMs: number): Task[] {
    return selectTodayTasks(this.listTasks(), this.getTodayOrder(), { nowMs });
  }

  listPlannerDay(day?: string | null): Task[] {
    return selectPlannerTasks(this.listTasks(), day);
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
    if (created.length) {
      this.trimNotifications();
      this.touchNotifications();
    }
    return created;
  }

  listNotifications() {
    if (this.notificationsListCache) return this.notificationsListCache;
    const list = [...this.notifications].sort((a, b) => b.fireAt - a.fireAt);
    this.notificationsListCache = list;
    return list;
  }

  listProjects(opts?: { includeArchived?: boolean }): MemProject[] {
    if (opts?.includeArchived) return [...this.projects.values()];
    if (this.projectsListCache) return this.projectsListCache;
    const list = [...this.projects.values()].filter((project) => !project.isArchived);
    this.projectsListCache = list;
    return list;
  }

  createProject(title: string, nowMs = Date.now()) {
    const id = createId(nowMs);
    const project = { id, title, isArchived: false };
    this.projects.set(id, project);
    this.touchProjects();
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
    this.touchProjects();
    return next;
  }

  dismissNotification(id: string): void {
    const row = this.notifications.find((item) => item.id === id);
    if (!row) throw new DomainError(`notification not found: ${id}`);
    row.status = "dismissed";
    this.touchNotifications();
  }

  pushNotification(input: {
    title: string;
    body?: string;
    kind?: string;
    nowMs?: number;
  }): MemNotification {
    const now = input.nowMs ?? Date.now();
    const title = input.title.trim() || "通知";
    const body = input.body?.trim() ?? "";
    const kind = input.kind?.trim() || "system";
    const existing = this.notifications.find(
      (item) => item.kind === kind && item.title === title && item.status !== "dismissed",
    );
    if (existing) {
      existing.body = body;
      existing.fireAt = now;
      existing.status = "delivered";
      this.touchNotifications();
      return existing;
    }
    const row: MemNotification = {
      id: createId(now),
      kind,
      title,
      body,
      status: "delivered",
      fireAt: now,
      refId: null,
    };
    this.notifications.push(row);
    this.trimNotifications();
    this.touchNotifications();
    return row;
  }

  snoozeNotification(id: string, untilMs: number): void {
    const row = this.notifications.find((item) => item.id === id);
    if (!row) throw new DomainError(`notification not found: ${id}`);
    row.status = "snoozed";
    row.snoozeUntil = untilMs;
    this.touchNotifications();
  }

  createAgentWorkspace(input?: {
    title?: string;
    rootPath?: string | null;
    nowMs?: number;
  }): AgentWorkspace {
    const now = input?.nowMs ?? Date.now();
    const title = input?.title?.trim() || DEFAULT_AGENT_WORKSPACE_TITLE;
    const rootPath = input?.rootPath?.trim() || null;
    const workspace: AgentWorkspace = {
      id: createId(now),
      title,
      rootPath,
      createdAt: now,
      updatedAt: now,
    };
    this.agentWorkspaces.set(workspace.id, workspace);
    this.agentWorkspaceListCache = null;
    this.markReplace("agent_workspace");
    return workspace;
  }

  ensureAgentWorkspace(nowMs = Date.now()): AgentWorkspace {
    const existing = this.listAgentWorkspaces()[0];
    if (existing) return existing;
    return this.createAgentWorkspace({ title: DEFAULT_AGENT_WORKSPACE_TITLE, nowMs });
  }

  listAgentWorkspaces(): AgentWorkspace[] {
    if (this.agentWorkspaceListCache) return this.agentWorkspaceListCache;
    const list = [...this.agentWorkspaces.values()].sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
    this.agentWorkspaceListCache = list;
    return list;
  }

  getAgentWorkspace(id: string): AgentWorkspace | null {
    return this.agentWorkspaces.get(id) ?? null;
  }

  findAgentWorkspaceByRootPath(rootPath: string): AgentWorkspace | null {
    return (
      this.listAgentWorkspaces().find((workspace) =>
        agentRootsMatch(workspace.rootPath, rootPath),
      ) ?? null
    );
  }

  updateAgentWorkspace(
    id: string,
    patch: Partial<Pick<AgentWorkspace, "title" | "rootPath">>,
    nowMs = Date.now(),
  ): AgentWorkspace {
    const current = this.agentWorkspaces.get(id);
    if (!current) throw new DomainError(`agent workspace not found: ${id}`);
    const title = patch.title?.trim();
    const rootPath =
      patch.rootPath === undefined
        ? undefined
        : patch.rootPath?.trim()
          ? patch.rootPath.trim()
          : null;
    const next = {
      ...current,
      ...(title ? { title } : {}),
      ...(rootPath !== undefined ? { rootPath } : {}),
      updatedAt: nowMs,
    };
    this.agentWorkspaces.set(id, next);
    this.agentWorkspaceListCache = null;
    this.markReplace("agent_workspace");
    return next;
  }

  /** Removes the workspace and every session inside it. */
  deleteAgentWorkspace(id: string): void {
    if (!this.agentWorkspaces.has(id)) return;
    for (const thread of this.listAgentThreads({ includeArchived: true })) {
      if (thread.workspaceId === id) this.deleteAgentThread(thread.id);
    }
    this.agentWorkspaces.delete(id);
    this.agentWorkspaceListCache = null;
    this.markReplace("agent_workspace");
  }

  createAgentThread(input?: {
    title?: string;
    workspaceId?: string;
    projectId?: string | null;
    modelRef?: string;
    permissionMode?: AgentPermissionMode;
    webUrl?: string | null;
    nowMs?: number;
  }): AgentThread {
    const now = input?.nowMs ?? Date.now();
    const workspaceId =
      input?.workspaceId && this.agentWorkspaces.has(input.workspaceId)
        ? input.workspaceId
        : this.ensureAgentWorkspace(now).id;
    const rawWebUrl = input?.webUrl?.trim() ?? "";
    const webUrl = rawWebUrl ? normalizeAgentWebUrl(rawWebUrl) : null;
    if (rawWebUrl && !webUrl) throw new DomainError("网页地址无效");
    const thread: AgentThread = {
      id: createId(now),
      workspaceId,
      projectId: input?.projectId ?? null,
      title: input?.title?.trim() || "新会话",
      modelRef: input?.modelRef || BUILTIN_MODEL_REF,
      permissionMode: input?.permissionMode ?? "confirm",
      queueJson: null,
      webUrl,
      archivedAt: null,
      pinnedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.agentThreads.set(thread.id, thread);
    this.touchAgentThreads();
    this.touchAgentWorkspace(workspaceId, now);
    return thread;
  }

  listAgentThreads(opts?: {
    workspaceId?: string;
    includeArchived?: boolean;
  }): AgentThread[] {
    if (this.agentThreadListCache) {
      const cached = this.agentThreadListCache;
      const workspaceId = opts?.workspaceId;
      const includeArchived = opts?.includeArchived === true;
      if (!workspaceId && includeArchived) return cached;
      return cached.filter((thread) => {
        if (workspaceId && thread.workspaceId !== workspaceId) return false;
        if (!includeArchived && thread.archivedAt != null) return false;
        return true;
      });
    }
    const workspaceId = opts?.workspaceId;
    const includeArchived = opts?.includeArchived === true;
    const list = [...this.agentThreads.values()]
      .filter((thread) => {
        if (workspaceId && thread.workspaceId !== workspaceId) return false;
        if (!includeArchived && thread.archivedAt != null) return false;
        return true;
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
    if (!workspaceId && includeArchived) this.agentThreadListCache = list;
    return list;
  }

  getAgentThread(id: string): AgentThread | null {
    return this.agentThreads.get(id) ?? null;
  }

  updateAgentThread(
    id: string,
    patch: Partial<
      Pick<
        AgentThread,
        | "title"
        | "modelRef"
        | "permissionMode"
        | "projectId"
        | "workspaceId"
        | "queueJson"
        | "webUrl"
        | "archivedAt"
        | "pinnedAt"
      >
    >,
    nowMs = Date.now(),
  ): AgentThread {
    const current = this.agentThreads.get(id);
    if (!current) throw new DomainError(`agent thread not found: ${id}`);
    if (patch.workspaceId && !this.agentWorkspaces.has(patch.workspaceId)) {
      throw new DomainError(`agent workspace not found: ${patch.workspaceId}`);
    }
    const rawWebUrl = patch.webUrl === undefined ? null : (patch.webUrl?.trim() ?? "");
    const webUrl =
      patch.webUrl === undefined
        ? current.webUrl
        : rawWebUrl
          ? normalizeAgentWebUrl(rawWebUrl)
          : null;
    if (patch.webUrl !== undefined && rawWebUrl && !webUrl) {
      throw new DomainError("网页地址无效");
    }
    const next = { ...current, ...patch, webUrl, updatedAt: nowMs };
    this.agentThreads.set(id, next);
    this.touchAgentThreads();
    this.touchAgentWorkspace(next.workspaceId, nowMs);
    return next;
  }

  archiveAgentThread(id: string, nowMs = Date.now()): AgentThread {
    return this.updateAgentThread(id, { archivedAt: nowMs }, nowMs);
  }

  unarchiveAgentThread(id: string, nowMs = Date.now()): AgentThread {
    return this.updateAgentThread(id, { archivedAt: null }, nowMs);
  }

  pinAgentThread(id: string, nowMs = Date.now()): AgentThread {
    return this.updateAgentThread(id, { pinnedAt: nowMs }, nowMs);
  }

  unpinAgentThread(id: string, nowMs = Date.now()): AgentThread {
    return this.updateAgentThread(id, { pinnedAt: null }, nowMs);
  }

  deleteAgentThread(id: string): void {
    this.agentThreads.delete(id);
    const removed = this.agentMessagesByThread.get(id) ?? [];
    this.journalAgentMessages(removed, "delete");
    this.agentMessages = this.agentMessages.filter((message) => message.threadId !== id);
    this.agentMessagesByThread.delete(id);
    this.agentMessagesListCache.delete(id);
    this.agentApprovals = this.agentApprovals.filter((item) => item.threadId !== id);
    this.markReplace("agent_approval");
    this.touchAgentThreads();
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
    const byThread = this.agentMessagesByThread.get(message.threadId);
    if (byThread) byThread.push(message);
    else this.agentMessagesByThread.set(message.threadId, [message]);
    this.trimAgentThreadMessages(message.threadId);
    this.touchAgentMessages(message.threadId);
    // 裁剪可能连带丢弃该消息（极端时序），只有仍存在时才记为待写。
    if (this.agentMessagesByThread.get(message.threadId)?.includes(message)) {
      this.journalAgentMessages([message], "upsert");
    }
    const title =
      thread.title === "新会话" && input.role === "user"
        ? agentThreadTitle(input.content)
        : thread.title;
    this.agentThreads.set(thread.id, { ...thread, title, updatedAt: now });
    this.touchAgentThreads();
    this.touchAgentWorkspace(thread.workspaceId, now);
    return message;
  }

  listAgentMessages(threadId: string): AgentMessage[] {
    const cached = this.agentMessagesListCache.get(threadId);
    if (cached) return cached;
    const list = [...(this.agentMessagesByThread.get(threadId) ?? [])];
    this.agentMessagesListCache.set(threadId, list);
    return list;
  }

  /** 指定线程消息集合变更后使克隆缓存失效。 */
  private touchAgentMessages(threadId: string): void {
    this.agentMessagesListCache.delete(threadId);
  }

  /** Drop one message and everything after it in the same thread. */
  deleteAgentMessagesFrom(threadId: string, messageId: string, nowMs = Date.now()): void {
    const inThread = this.agentMessagesByThread.get(threadId) ?? [];
    const start = inThread.findIndex((message) => message.id === messageId);
    if (start < 0) return;
    const droppedList = inThread.slice(start);
    const drop = new Set(droppedList.map((message) => message.id));
    this.agentMessages = this.agentMessages.filter((message) => !drop.has(message.id));
    this.agentMessagesByThread.set(threadId, inThread.slice(0, start));
    this.touchAgentMessages(threadId);
    this.journalAgentMessages(droppedList, "delete");
    const thread = this.agentThreads.get(threadId);
    if (!thread) return;
    this.agentThreads.set(threadId, { ...thread, queueJson: null, updatedAt: nowMs });
    this.touchAgentThreads();
    this.touchAgentWorkspace(thread.workspaceId, nowMs);
  }

  private touchAgentWorkspace(id: string, nowMs: number): void {
    const workspace = this.agentWorkspaces.get(id);
    if (!workspace) return;
    this.agentWorkspaces.set(id, { ...workspace, updatedAt: nowMs });
    this.agentWorkspaceListCache = null;
    this.markReplace("agent_workspace");
  }

  /** Agent 线程集合/字段变更后清空线程列表缓存，并标记持久化脏。 */
  private touchAgentThreads(): void {
    this.agentThreadListCache = null;
    this.markReplace("agent_thread");
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
    this.markReplace("agent_approval");
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
    this.markReplace("agent_approval");
    return next;
  }

  listNotes(): Note[] {
    if (this.notesListCache) return this.notesListCache;
    const list = [...this.notes.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    this.notesListCache = list;
    return list;
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
    this.touchNotes();
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
    this.touchNotes();
    return next;
  }

  deleteNote(id: string): void {
    this.notes.delete(id);
    this.touchNotes();
  }

  listTimedTasks(): TimedTask[] {
    if (this.timedListCache) return this.timedListCache;
    const list = [...this.timedTasks.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    this.timedListCache = list;
    return list;
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
    this.touchTimed();
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
      lastRunAt?: number | null;
    },
    nowMs = Date.now(),
  ): TimedTask {
    const current = this.timedTasks.get(id);
    if (!current) throw new DomainError(`timed task not found: ${id}`);
    const next = patchTimedTask(current, patch, nowMs);
    this.timedTasks.set(id, next);
    this.touchTimed();
    return next;
  }

  markTimedTaskRan(id: string, nowMs = Date.now()): TimedTask {
    return this.updateTimedTask(id, { lastRunAt: nowMs }, nowMs);
  }

  deleteTimedTask(id: string): void {
    this.timedTasks.delete(id);
    this.touchTimed();
  }

  /** Enabled timed tasks whose nextRunAt is due. */
  listDueTimedTasks(nowMs = Date.now()): TimedTask[] {
    return this.listTimedTasks().filter(
      (task) => task.enabled && task.nextRunAt != null && task.nextRunAt <= nowMs,
    );
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
      agentWorkspaces: [...this.agentWorkspaces.values()],
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
      agentWorkspaces?: Array<AgentWorkspace & { rootPath?: string | null }>;
      agentThreads?: Array<
        AgentThread & { workspaceId?: string; archivedAt?: number | null }
      >;
      agentMessages?: AgentMessage[];
      agentApprovals?: AgentApproval[];
    };
    this.tasks = new Map(data.tasks.map((t) => [t.id, t]));
    this.touchTasks();
    this.projects = new Map(data.projects.map((p) => [p.id, p]));
    this.buckets = new Map(data.buckets);
    this.todayOrder = data.todayOrder ?? [];
    this.notifications = data.notifications ?? [];
    this.trimNotifications();
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
    this.touchTags();
    this.touchProjects();
    this.touchNotes();
    this.touchTimed();
    this.touchNotifications();
    this.agentWorkspaces = new Map(
      (data.agentWorkspaces ?? []).map((workspace) => [
        workspace.id,
        {
          ...workspace,
          rootPath: workspace.rootPath ?? null,
        },
      ]),
    );
    const fallbackWorkspace =
      this.listAgentWorkspaces()[0] ??
      ((data.agentThreads ?? []).length > 0
        ? this.createAgentWorkspace({
            title: DEFAULT_AGENT_WORKSPACE_TITLE,
            nowMs: Math.min(
              ...(data.agentThreads ?? []).map((thread) => thread.createdAt),
              Date.now(),
            ),
          })
        : null);
    this.agentThreads = new Map(
      (data.agentThreads ?? []).map((thread) => {
        const workspaceId =
          thread.workspaceId && this.agentWorkspaces.has(thread.workspaceId)
            ? thread.workspaceId
            : (fallbackWorkspace?.id ?? this.ensureAgentWorkspace(thread.createdAt).id);
        return [
          thread.id,
          {
            ...thread,
            workspaceId,
            queueJson: thread.queueJson ?? null,
            webUrl: thread.webUrl ?? null,
            archivedAt: thread.archivedAt ?? null,
            pinnedAt: thread.pinnedAt ?? null,
          },
        ];
      }),
    );
    this.agentMessages = (data.agentMessages ?? []).map((message) => ({
      ...message,
      toolCallsJson: message.toolCallsJson ?? null,
    }));
    this.rebuildAgentMessageIndex();
    for (const threadId of this.agentMessagesByThread.keys()) {
      this.trimAgentThreadMessages(threadId);
    }
    this.agentApprovals = (data.agentApprovals ?? []).map((approval) => ({
      ...approval,
      toolCallId: approval.toolCallId ?? null,
    }));
    this.agentThreadListCache = null;
    this.agentWorkspaceListCache = null;
    // 导入即全量替换持久化内容（迁移/恢复场景）。
    this.journalFull = true;
    this.messageJournal.clear();
    this.replaceKinds.clear();
  }
}
