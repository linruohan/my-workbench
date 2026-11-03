import type { MemoryWorkbenchRepository } from "@wb/db/memory";
import {
  addAgentMemory,
  DomainError,
  findSkill,
  forgetAgentMemory,
  listEnabledSkillSummaries,
  mcpEndpointLabel,
  parseLocalDay,
  parseModelRef,
  remindOptionToMilliseconds,
  type AgentHook,
  type AgentMemory,
  type AgentSkill,
  type AgentSubagent,
  type HostToolSnapshot,
  type McpServer,
  type ReminderOptionId,
  type SchedulePatch,
  type Task,
} from "@wb/domain";

export type AgentUiEffect =
  | {
      type: "navigate";
      nav: "today" | "planner" | "knowledge" | "timed" | "projects";
    }
  | { type: "open-task"; taskId: string }
  | { type: "open-note"; noteId: string }
  | { type: "notifications" }
  | { type: "timer-start"; taskId: string }
  | { type: "timer-stop" }
  | { type: "rename"; displayName: string };

export type AgentToolResult = {
  ok: boolean;
  summary: string;
  data: unknown;
  effects: AgentUiEffect[];
};

export type AgentRuntimeContext = {
  nowMs: number;
  threadId: string;
  displayName: string;
  timer: { taskId: string | null; startedAt: number | null };
  /** Enabled skills discovered from Settings → 技能 directories. */
  skills?: AgentSkill[];
  memories?: {
    list: () => AgentMemory[];
    replace: (next: AgentMemory[]) => void;
  };
  subagents?: AgentSubagent[];
  hooks?: AgentHook[];
  plugins?: Array<{ name: string; version: string; description: string }>;
  mcpServers?: McpServer[];
  /** Detected local tools from Settings → 工具. */
  hostTools?: HostToolSnapshot[];
  /** Subagent turns may only call these tools. */
  toolAllowlist?: readonly string[];
};

const REMIND: ReminderOptionId[] = ["none", "at_start", "m5", "m10", "m15", "m30", "h1"];

export function executeAgentTool(
  store: MemoryWorkbenchRepository,
  name: string,
  args: Record<string, unknown>,
  ctx: AgentRuntimeContext,
): AgentToolResult {
  try {
    return runTool(store, name, args, ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : "工具执行失败";
    return { ok: false, summary: message, data: { error: message }, effects: [] };
  }
}

function runTool(
  store: MemoryWorkbenchRepository,
  name: string,
  args: Record<string, unknown>,
  ctx: AgentRuntimeContext,
): AgentToolResult {
  if (ctx.toolAllowlist && !ctx.toolAllowlist.includes(name)) {
    return {
      ok: false,
      summary: `当前子智能体不能使用 ${name}`,
      data: { error: "tool not allowed" },
      effects: [],
    };
  }
  switch (name) {
    case "task_list_today": {
      const tasks = store.listToday(ctx.nowMs).map((task) => taskView(store, task));
      return ok(tasks.length ? `今日有 ${tasks.length} 项` : "今日没有任务", { tasks });
    }
    case "task_list": {
      const projectId = str(args, "projectId");
      const query = str(args, "query");
      const includeDone = args.includeDone === true;
      const tasks = store
        .listTasks()
        .filter((task) => includeDone || !task.isDone)
        .filter((task) => !projectId || task.projectId === projectId)
        .filter((task) => !query || task.title.includes(query))
        .slice(0, 30)
        .map((task) => taskView(store, task));
      return ok(`找到 ${tasks.length} 项任务`, { tasks });
    }
    case "task_get": {
      const task = resolveTask(store, args, true);
      return ok(`任务「${task.title}」`, {
        task: taskView(store, task),
        subtasks: store.listSubtasks(task.id).map((item) => taskView(store, item)),
      });
    }
    case "task_create": {
      const title = str(args, "title");
      if (!title) throw new DomainError("任务标题不能为空");
      const projectId = resolveProjectId(store, args);
      const created = store.createTask({
        title,
        notes: str(args, "notes") ?? "",
        projectId,
        nowMs: ctx.nowMs,
      });
      const minutes = num(args, "timeEstimateMinutes");
      if (minutes != null) {
        store.updateTask(
          created.id,
          { timeEstimate: Math.round(minutes * 60_000) },
          ctx.nowMs,
        );
      }
      const task = applyWhen(store, created.id, args, ctx.nowMs);
      return ok(`已创建任务「${task.title}」`, { task: taskView(store, task) });
    }
    case "task_update": {
      const task = resolveTask(store, args, true);
      const title = str(args, "title");
      const patch: {
        title?: string;
        notes?: string;
        projectId?: string;
        timeEstimate?: number;
      } = {};
      if (title && title !== task.title) patch.title = title;
      if (typeof args.notes === "string") patch.notes = args.notes;
      const projectId = resolveProjectId(store, args);
      if (projectId) patch.projectId = projectId;
      const minutes = num(args, "timeEstimateMinutes");
      if (minutes != null) patch.timeEstimate = Math.round(minutes * 60_000);
      const next = store.updateTask(task.id, patch, ctx.nowMs);
      return ok(`已修改任务「${next.title}」`, { task: taskView(store, next) });
    }
    case "task_complete": {
      const task = resolveTask(store, args, false);
      const next = store.completeTask(task.id, ctx.nowMs);
      return ok(`已完成「${next.title}」`, { task: taskView(store, next) });
    }
    case "task_reopen": {
      const task = resolveTask(store, args, true);
      const next = store.uncompleteTask(task.id, ctx.nowMs);
      return ok(`已重新打开「${next.title}」`, { task: taskView(store, next) });
    }
    case "task_schedule":
    case "task_set_deadline": {
      const task = resolveTask(store, args, true);
      const next = applyWhen(store, task.id, args, ctx.nowMs);
      return ok(`已更新「${next.title}」的时间`, { task: taskView(store, next) });
    }
    case "task_set_reminder": {
      const task = resolveTask(store, args, true);
      const option = asRemind(args.remindOption);
      const explicit = num(args, "remindAt");
      let next = task;
      if (explicit != null) {
        next = store.scheduleTask(task.id, { remindAt: explicit }, ctx.nowMs);
      } else if (option === "none") {
        next = store.scheduleTask(task.id, { remindAt: null }, ctx.nowMs);
      } else if (option) {
        const due = task.dueWithTime ?? task.deadlineWithTime;
        if (due == null) throw new DomainError("设置提醒需要任务已有具体时刻");
        const at = remindOptionToMilliseconds(due, option);
        next =
          task.dueWithTime != null
            ? store.scheduleTask(task.id, { remindAt: at }, ctx.nowMs)
            : store.scheduleTask(task.id, { deadlineRemindAt: at }, ctx.nowMs);
      } else {
        throw new DomainError("请提供 remindOption 或 remindAt");
      }
      return ok(`已更新「${next.title}」的提醒`, { task: taskView(store, next) });
    }
    case "task_move_backlog": {
      const task = resolveTask(store, args, true);
      const next = store.moveToBacklog(task.id, ctx.nowMs);
      return ok(`已把「${next.title}」移入待办`, { task: taskView(store, next) });
    }
    case "task_add_subtask": {
      const title = str(args, "title");
      if (!title) throw new DomainError("子任务标题不能为空");
      const parent = resolveTask(
        store,
        { taskId: args.parentId, title: args.parentTitle },
        true,
      );
      const child = store.createTask({
        title,
        parentId: parent.id,
        projectId: parent.projectId,
        nowMs: ctx.nowMs,
      });
      return ok(`已添加子任务「${child.title}」`, { task: taskView(store, child) });
    }
    case "task_delete": {
      const task = resolveTask(store, args, true);
      store.deleteTask(task.id);
      return ok(`已删除任务「${task.title}」`, { id: task.id });
    }
    case "project_list": {
      const projects = store.listProjects({
        includeArchived: args.includeArchived === true,
      });
      return ok(`共 ${projects.length} 个项目`, { projects });
    }
    case "project_create": {
      const title = str(args, "title");
      if (!title) throw new DomainError("项目名称不能为空");
      const project = store.createProject(title, ctx.nowMs);
      return ok(`已创建项目「${project.title}」`, { project });
    }
    case "project_archive": {
      const id = str(args, "projectId");
      const title = str(args, "title");
      const project =
        (id
          ? store.listProjects({ includeArchived: true }).find((item) => item.id === id)
          : null) ?? store.listProjects().find((item) => item.title === title);
      if (!project) throw new DomainError("找不到项目");
      const next = store.archiveProject(project.id);
      return ok(`已归档项目「${next.title}」`, { project: next });
    }
    case "tag_list":
      return ok("标签", { tags: store.listTags() });
    case "tag_assign": {
      const task = resolveTask(store, args, true);
      const tagId = str(args, "tagId");
      const tagTitle = str(args, "tagTitle") ?? str(args, "title");
      const tag = tagId
        ? store.listTags().find((item) => item.id === tagId)
        : (store.listTags().find((item) => item.title === tagTitle) ??
          (tagTitle ? store.createTag(tagTitle) : null));
      if (!tag) throw new DomainError("请提供标签");
      store.assignTag(task.id, tag.id);
      return ok(`已为「${task.title}」加上标签「${tag.title}」`, { tag });
    }
    case "timer_status":
      return ok(ctx.timer.taskId ? "计时进行中" : "没有正在进行的计时", {
        timer: ctx.timer,
      });
    case "timer_start": {
      const task = resolveTask(store, args, false);
      if (!task.parentId && store.listSubtasks(task.id).length > 0) {
        throw new DomainError("有子任务的父任务不能直接计时");
      }
      return {
        ok: true,
        summary: `开始为「${task.title}」计时`,
        data: { taskId: task.id },
        effects: [{ type: "timer-start", taskId: task.id }],
      };
    }
    case "timer_stop":
      return {
        ok: true,
        summary: "停止计时",
        data: {},
        effects: [{ type: "timer-stop" }],
      };
    case "note_get": {
      const note = resolveNote(store, args);
      return ok(`笔记「${note.title}」`, { note });
    }
    case "note_search":
    case "search": {
      const query = str(args, "query");
      if (!query) throw new DomainError("请提供搜索词");
      const notes =
        name === "search" || name === "note_search"
          ? store
              .listNotes()
              .filter((note) => note.title.includes(query) || note.bodyMd.includes(query))
              .slice(0, 20)
              .map((note) => ({ id: note.id, title: note.title }))
          : [];
      const tasks =
        name === "search"
          ? store
              .listTasks()
              .filter((task) => task.title.includes(query) || task.notes.includes(query))
              .slice(0, 20)
              .map((task) => ({ id: task.id, title: task.title }))
          : [];
      return ok(`搜索「${query}」`, { tasks, notes });
    }
    case "note_create": {
      const title = str(args, "title");
      if (!title) throw new DomainError("笔记标题不能为空");
      const note = store.createNote({
        title,
        bodyMd: typeof args.bodyMd === "string" ? args.bodyMd : "",
        projectId: str(args, "projectId"),
        nowMs: ctx.nowMs,
      });
      return ok(`已创建笔记「${note.title}」`, { note });
    }
    case "note_update": {
      const note = resolveNote(store, args);
      const next = store.updateNote(
        note.id,
        {
          title: str(args, "title") ?? undefined,
          bodyMd: typeof args.bodyMd === "string" ? args.bodyMd : undefined,
        },
        ctx.nowMs,
      );
      return ok(`已更新笔记「${next.title}」`, { note: next });
    }
    case "note_delete": {
      const note = resolveNote(store, args);
      store.deleteNote(note.id);
      return ok(`已删除笔记「${note.title}」`, { id: note.id });
    }
    case "notification_list":
      return ok("通知", { notifications: store.listNotifications().slice(0, 20) });
    case "notification_dismiss": {
      const id = str(args, "notificationId");
      if (!id) throw new DomainError("需要 notificationId");
      store.dismissNotification(id);
      return ok("已关闭通知", { id });
    }
    case "notification_snooze": {
      const id = str(args, "notificationId");
      if (!id) throw new DomainError("需要 notificationId");
      const minutes = num(args, "minutes") ?? 10;
      store.snoozeNotification(id, ctx.nowMs + minutes * 60_000);
      return ok(`已推迟通知 ${minutes} 分钟`, { id });
    }
    case "ui_open":
      return openView(args);
    case "settings_get":
      return ok("设置", { displayName: ctx.displayName });
    case "settings_patch": {
      const displayName = str(args, "displayName");
      if (!displayName) throw new DomainError("请提供显示名称");
      return {
        ok: true,
        summary: `显示名称改为「${displayName}」`,
        data: { displayName },
        effects: [{ type: "rename", displayName }],
      };
    }
    case "session_set_model": {
      const modelRef = str(args, "modelRef");
      if (!modelRef || !parseModelRef(modelRef)) throw new DomainError("模型引用无效");
      store.updateAgentThread(ctx.threadId, { modelRef }, ctx.nowMs);
      return ok(`已切换模型 ${modelRef}`, { modelRef });
    }
    case "memory_list": {
      const memories = ctx.memories?.list() ?? [];
      return ok(memories.length ? `有 ${memories.length} 条记忆` : "还没有记忆", {
        memories,
      });
    }
    case "memory_save": {
      if (!ctx.memories) throw new DomainError("记忆还没有接到本机会话");
      const text = str(args, "text");
      if (!text) throw new DomainError("请写出要记住的内容");
      const result = addAgentMemory(ctx.memories.list(), text, ctx.nowMs);
      if (!result.added) throw new DomainError(result.reason ?? "无法记下");
      ctx.memories.replace(result.memories);
      return ok(`已记住「${result.added.text}」`, { memory: result.added });
    }
    case "memory_forget": {
      if (!ctx.memories) throw new DomainError("记忆还没有接到本机会话");
      const text = str(args, "text");
      if (!text) throw new DomainError("请提供要删除的记忆");
      const result = forgetAgentMemory(ctx.memories.list(), text);
      if (!result.removed) throw new DomainError(`没有匹配「${text}」的记忆`);
      ctx.memories.replace(result.memories);
      return ok(`已删除 ${result.removed} 条记忆`, { removed: result.removed });
    }
    case "subagent_list": {
      const subagents = (ctx.subagents ?? []).map((item) => ({
        name: item.name,
        description: item.description,
      }));
      return ok(
        subagents.length ? `有 ${subagents.length} 个子智能体` : "还没有子智能体",
        { subagents },
      );
    }
    case "hook_list": {
      const hooks = (ctx.hooks ?? [])
        .filter((item) => item.enabled)
        .map((item) => ({ event: item.event, title: item.title, body: item.body }));
      return ok(hooks.length ? `有 ${hooks.length} 个钩子` : "还没有钩子", { hooks });
    }
    case "mcp_list": {
      const servers = (ctx.mcpServers ?? []).map((item) => ({
        name: item.name,
        endpoint: mcpEndpointLabel(item),
        enabled: item.enabled,
        connected: false,
      }));
      return ok(
        servers.length
          ? `已登记 ${servers.length} 个 MCP 服务器，尚未连接`
          : "还没有 MCP 服务器",
        { servers },
      );
    }
    case "plugin_list": {
      const plugins = ctx.plugins ?? [];
      return ok(
        plugins.length ? `已启用 ${plugins.length} 个插件` : "当前没有启用的插件",
        {
          plugins,
        },
      );
    }
    case "host_tool_list": {
      const tools = (ctx.hostTools ?? [])
        .filter((item) => item.enabled && item.status === "ready")
        .map((item) => ({
          id: item.id,
          name: item.name,
          path: item.path,
          version: item.version,
          usage: item.usage,
        }));
      return ok(
        tools.length ? `有 ${tools.length} 个本机工具可用` : "还没有可用的本机工具",
        {
          tools,
        },
      );
    }
    case "host_tool_run":
      throw new DomainError("本机工具要由桌面宿主运行");
    case "skill_list": {
      const skills = listEnabledSkillSummaries(ctx.skills ?? []);
      return ok(skills.length ? `已启用 ${skills.length} 个技能` : "还没有启用的技能", {
        skills,
      });
    }
    case "skill_load": {
      const name = str(args, "name");
      const skillId = str(args, "skillId");
      const query = name || skillId;
      if (!query) throw new DomainError("请提供技能 name 或 skillId");
      const skill = findSkill(ctx.skills ?? [], query);
      if (!skill) throw new DomainError(`未找到技能「${query}」`);
      return ok(`已加载技能「${skill.name}」`, {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        dirPath: skill.dirPath,
        body: skill.body,
      });
    }
    default:
      return {
        ok: false,
        summary: `未知工具 ${name}`,
        data: { error: "unknown tool" },
        effects: [],
      };
  }
}

function openView(args: Record<string, unknown>): AgentToolResult {
  const view = str(args, "view") ?? "today";
  const taskId = str(args, "taskId");
  const noteId = str(args, "noteId");
  if (view === "task" && taskId) {
    return {
      ok: true,
      summary: "打开任务",
      data: { view },
      effects: [{ type: "open-task", taskId }],
    };
  }
  if (view === "note" && noteId) {
    return {
      ok: true,
      summary: "打开笔记",
      data: { view },
      effects: [{ type: "open-note", noteId }],
    };
  }
  if (view === "notifications") {
    return {
      ok: true,
      summary: "打开通知",
      data: { view },
      effects: [{ type: "notifications" }],
    };
  }
  // 「时间表」入口已并入「计划」；旧指令仍可打开计划视图。
  const resolved = view === "schedule" ? "planner" : view;
  const nav = (["today", "planner", "knowledge", "timed", "projects"] as const).find(
    (item) => item === resolved,
  );
  if (!nav) throw new DomainError(`未知视图 ${view}`);
  return {
    ok: true,
    summary: `打开${nav}`,
    data: { view: nav },
    effects: [{ type: "navigate", nav }],
  };
}

function applyWhen(
  store: MemoryWorkbenchRepository,
  taskId: string,
  args: Record<string, unknown>,
  nowMs: number,
): Task {
  const dueWithTime = num(args, "dueWithTime");
  const dueDay = str(args, "dueDay");
  const deadlineWithTime = num(args, "deadlineWithTime");
  const deadlineDay = str(args, "deadlineDay");
  const remindOption = asRemind(args.remindOption);
  const patch: SchedulePatch = {};
  let timed = dueWithTime;
  if (timed == null && dueDay && remindOption && remindOption !== "none") {
    const at = new Date(parseLocalDay(dueDay));
    at.setHours(9, 0, 0, 0);
    timed = at.getTime();
  }
  if (timed != null) patch.dueWithTime = timed;
  else if (dueDay) patch.dueDay = dueDay;
  if (deadlineWithTime != null) patch.deadlineWithTime = deadlineWithTime;
  else if (deadlineDay) patch.deadlineDay = deadlineDay;
  if (remindOption === "none") {
    if (timed != null || dueDay) patch.remindAt = null;
  } else if (remindOption && timed != null) {
    patch.remindAt = remindOptionToMilliseconds(timed, remindOption);
  } else if (remindOption && deadlineWithTime != null) {
    patch.deadlineRemindAt = remindOptionToMilliseconds(deadlineWithTime, remindOption);
  }
  if (Object.keys(patch).length === 0) {
    const current = store.getTask(taskId);
    if (!current) throw new DomainError(`找不到任务 ${taskId}`);
    return current;
  }
  return store.scheduleTask(taskId, patch, nowMs);
}

function taskView(store: MemoryWorkbenchRepository, task: Task) {
  return {
    id: task.id,
    title: task.title,
    projectId: task.projectId,
    isDone: task.isDone,
    dueDay: task.dueDay,
    dueWithTime: task.dueWithTime,
    remindAt: task.remindAt,
    deadlineDay: task.deadlineDay,
    deadlineWithTime: task.deadlineWithTime,
    notes: task.notes,
    parentId: task.parentId,
    bucket: store.getTaskBucket(task.id),
  };
}

function resolveTask(
  store: MemoryWorkbenchRepository,
  args: Record<string, unknown>,
  includeDone: boolean,
): Task {
  const id = str(args, "taskId");
  if (id) {
    const task = store.getTask(id);
    if (!task) throw new DomainError(`找不到任务 ${id}`);
    return task;
  }
  const title = str(args, "title");
  if (!title) throw new DomainError("需要 taskId 或 title");
  const pool = store.listTasks().filter((task) => includeDone || !task.isDone);
  const exact = pool.filter((task) => task.title === title);
  if (exact.length === 1) return exact[0]!;
  const fuzzy = pool.filter((task) => task.title.includes(title));
  if (fuzzy.length === 1) return fuzzy[0]!;
  if (exact.length > 1 || fuzzy.length > 1) {
    throw new DomainError("匹配到多条任务，请改用 taskId");
  }
  throw new DomainError(`找不到任务「${title}」`);
}

function resolveProjectId(
  store: MemoryWorkbenchRepository,
  args: Record<string, unknown>,
): string | undefined {
  const id = str(args, "projectId");
  if (id) return id;
  const title = str(args, "projectTitle");
  if (!title) return undefined;
  const found = store
    .listProjects({ includeArchived: true })
    .find((project) => project.title === title);
  if (!found) throw new DomainError(`未知项目：${title}`);
  return found.id;
}

function resolveNote(store: MemoryWorkbenchRepository, args: Record<string, unknown>) {
  const id = str(args, "noteId");
  if (id) {
    const note = store.getNote(id);
    if (!note) throw new DomainError(`找不到笔记 ${id}`);
    return note;
  }
  const title = str(args, "title");
  if (!title) throw new DomainError("需要 noteId 或 title");
  const matches = store.listNotes().filter((note) => note.title === title);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new DomainError("匹配到多条笔记，请改用 noteId");
  throw new DomainError(`找不到笔记「${title}」`);
}

function ok(summary: string, data: unknown): AgentToolResult {
  return { ok: true, summary, data, effects: [] };
}

function str(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function num(args: Record<string, unknown>, key: string): number | null {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRemind(value: unknown): ReminderOptionId | null {
  return typeof value === "string" && (REMIND as string[]).includes(value)
    ? (value as ReminderOptionId)
    : null;
}
