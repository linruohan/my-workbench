/**
 * Agent session, tool contract, and permission gates.
 * The runtime never stores API keys; callers attach them per request.
 */

import { formatLocalDay } from "./date.js";
import { remindOptionLabel, viewLabel } from "./agent-reply.js";

export const BUILTIN_PROVIDER_ID = "builtin:workbench";
export const BUILTIN_MODEL_REF = "builtin:workbench/local";

export type AgentPermissionMode = "confirm" | "session_auto" | "readonly";
export type AgentRole = "user" | "assistant" | "tool" | "system";
export type ToolEffect = "none" | "read" | "write" | "destructive";
export type ToolGate = "run" | "ask" | "block";
export type ProviderKind =
  | "builtin"
  | "openai-chat-completions"
  | "openai-responses"
  | "anthropic-messages";

/** Folder that holds Agent sessions. Distinct from task projects. */
export interface AgentWorkspace {
  id: string;
  title: string;
  /** Absolute local directory this workspace is bound to, if any. */
  rootPath: string | null;
  createdAt: number;
  updatedAt: number;
}

export const DEFAULT_AGENT_WORKSPACE_TITLE = "默认工作区";

export interface AgentThread {
  id: string;
  /** Agent workspace this session belongs to. */
  workspaceId: string;
  projectId: string | null;
  title: string;
  modelRef: string;
  permissionMode: AgentPermissionMode;
  /** JSON array of planned calls waiting to run. Null when idle. */
  queueJson: string | null;
  /** Set when the session is archived; null while active. */
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface AgentMessage {
  id: string;
  threadId: string;
  role: AgentRole;
  content: string;
  toolName: string | null;
  toolCallId: string | null;
  /** JSON PlannedCall[] when the assistant requested tools. */
  toolCallsJson: string | null;
  createdAt: number;
}

export interface AgentApproval {
  id: string;
  threadId: string;
  toolCallId: string | null;
  toolName: string;
  argsJson: string;
  summary: string;
  status: "pending" | "approved" | "denied";
  createdAt: number;
  resolvedAt: number | null;
}

export interface ProviderConfig {
  id: string;
  name: string;
  kind: ProviderKind;
  baseURL: string;
  apiKeyRequired: boolean;
  enabled: boolean;
  models: Record<string, { context: number; output: number }>;
}

export interface ToolSpec {
  name: string;
  effect: ToolEffect;
  description: string;
  parameters: Record<string, unknown>;
}

export interface PlannedCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface AgentTurnPlan {
  text: string;
  calls: PlannedCall[];
}

const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });

function tool(
  name: string,
  effect: ToolEffect,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
): ToolSpec {
  return {
    name,
    effect,
    description,
    parameters: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  };
}

const TASK_ID = { taskId: str("任务 id"), title: str("任务标题，用于匹配") };
const WHEN = {
  dueDay: str("计划日 YYYY-MM-DD，与 dueWithTime 互斥"),
  dueWithTime: num("计划时刻的 Unix 毫秒，与 dueDay 互斥"),
  remindOption: str("none | at_start | m5 | m10 | m15 | m30 | h1"),
  deadlineDay: str("截止日 YYYY-MM-DD"),
  deadlineWithTime: num("截止时刻的 Unix 毫秒"),
};

export const AGENT_TOOLS: ToolSpec[] = [
  tool("task_list_today", "read", "列出今日任务", {}),
  tool("task_list", "read", "按项目或关键词列出任务", {
    projectId: str("项目 id"),
    query: str("标题包含的文字"),
    includeDone: { type: "boolean", description: "是否包含已完成" },
  }),
  tool("task_get", "read", "读取单条任务、子任务与提醒", {
    taskId: str("任务 id"),
    title: str("任务标题"),
  }),
  tool(
    "task_create",
    "write",
    "创建任务，可同时排期与设提醒",
    {
      title: str("标题"),
      notes: str("备注"),
      projectId: str("项目 id"),
      projectTitle: str("项目名称"),
      ...WHEN,
      timeEstimateMinutes: num("预计分钟数"),
    },
    ["title"],
  ),
  tool("task_update", "write", "修改标题、备注、项目或预计时长", {
    ...TASK_ID,
    notes: str("备注"),
    projectId: str("项目 id"),
    timeEstimateMinutes: num("预计分钟数"),
  }),
  tool("task_complete", "write", "完成任务并清除提醒", TASK_ID),
  tool("task_reopen", "write", "重新打开任务", TASK_ID),
  tool("task_schedule", "write", "设置计划日或时刻，可选提醒", {
    ...TASK_ID,
    ...WHEN,
  }),
  tool("task_move_backlog", "write", "移入待办并清空计划与提醒", TASK_ID),
  tool("task_set_deadline", "write", "设置截止日或截止时刻", {
    ...TASK_ID,
    deadlineDay: str("截止日"),
    deadlineWithTime: num("截止时刻毫秒"),
    remindOption: str("截止提醒偏移"),
  }),
  tool("task_set_reminder", "write", "只改提醒", {
    ...TASK_ID,
    remindOption: str("提醒偏移"),
    remindAt: num("提醒时刻毫秒"),
  }),
  tool(
    "task_add_subtask",
    "write",
    "添加子任务",
    {
      parentId: str("父任务 id"),
      parentTitle: str("父任务标题"),
      title: str("子任务标题"),
    },
    ["title"],
  ),
  tool("task_delete", "destructive", "删除任务", TASK_ID),
  tool("project_list", "read", "列出项目", {
    includeArchived: { type: "boolean", description: "包含已归档" },
  }),
  tool("project_create", "write", "创建项目", { title: str("项目名称") }, ["title"]),
  tool("project_archive", "destructive", "归档项目", {
    projectId: str("项目 id"),
    title: str("项目名称"),
  }),
  tool("tag_list", "read", "列出标签", {}),
  tool("tag_assign", "write", "给任务加标签，不存在则创建", {
    ...TASK_ID,
    tagId: str("标签 id"),
    tagTitle: str("标签名"),
  }),
  tool("timer_status", "read", "当前计时", {}),
  tool("timer_start", "write", "开始计时", TASK_ID),
  tool("timer_stop", "write", "停止计时", {}),
  tool("note_get", "read", "读取笔记", {
    noteId: str("笔记 id"),
    title: str("笔记标题"),
  }),
  tool(
    "note_search",
    "read",
    "在笔记标题和正文中搜索",
    {
      query: str("关键词"),
    },
    ["query"],
  ),
  tool(
    "note_create",
    "write",
    "创建笔记",
    {
      title: str("标题"),
      bodyMd: str("Markdown 正文"),
      projectId: str("项目 id"),
    },
    ["title"],
  ),
  tool("note_update", "write", "更新笔记", {
    noteId: str("笔记 id"),
    title: str("新标题或用于匹配的标题"),
    bodyMd: str("正文"),
  }),
  tool("note_delete", "destructive", "删除笔记", {
    noteId: str("笔记 id"),
    title: str("笔记标题"),
  }),
  tool("search", "read", "同时搜索任务与笔记", { query: str("关键词") }, ["query"]),
  tool("notification_list", "read", "列出通知", {}),
  tool(
    "notification_snooze",
    "write",
    "稍后提醒",
    {
      notificationId: str("通知 id"),
      minutes: num("推迟分钟数"),
    },
    ["notificationId"],
  ),
  tool(
    "notification_dismiss",
    "write",
    "关闭通知",
    {
      notificationId: str("通知 id"),
    },
    ["notificationId"],
  ),
  tool("ui_open", "none", "打开今日、计划、知识库、通知或某条任务/笔记", {
    view: str(
      "today | planner | knowledge | timed | projects | notifications | task | note",
    ),
    taskId: str("任务 id"),
    noteId: str("笔记 id"),
  }),
  tool("settings_get", "read", "读取不含密钥的设置摘要", {}),
  tool("settings_patch", "write", "修改显示名称", {
    displayName: str("显示名称"),
  }),
  tool(
    "session_set_model",
    "none",
    "切换当前会话模型",
    {
      modelRef: str("providerId/modelId"),
    },
    ["modelRef"],
  ),
  tool("plugin_list", "read", "列出已启用插件", {}),
];

export function toolByName(name: string): ToolSpec | null {
  return AGENT_TOOLS.find((item) => item.name === name) ?? null;
}

export function toolsForMode(mode: AgentPermissionMode): ToolSpec[] {
  if (mode === "readonly") {
    return AGENT_TOOLS.filter((item) => item.effect === "read" || item.effect === "none");
  }
  return AGENT_TOOLS;
}

/** Read tools run. Writes ask unless this session auto-approves. Destructive writes always ask. */
export function gateTool(mode: AgentPermissionMode, name: string): ToolGate {
  const spec = toolByName(name);
  if (!spec) return "block";
  if (spec.effect === "read" || spec.effect === "none") return "run";
  if (mode === "readonly") return "block";
  if (spec.effect === "destructive") return "ask";
  if (mode === "session_auto") return "run";
  return "ask";
}

export function permissionModeLabel(mode: AgentPermissionMode): string {
  if (mode === "confirm") return "变更前确认";
  if (mode === "session_auto") return "本会话自动";
  return "只读";
}

function clock(ms: number): string {
  const date = new Date(ms);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${formatLocalDay(ms)} ${hh}:${mm}`;
}

export function toolCallSummary(name: string, args: Record<string, unknown>): string {
  const title = typeof args.title === "string" ? args.title : "";
  const when =
    typeof args.dueDay === "string"
      ? args.dueDay
      : typeof args.dueWithTime === "number"
        ? clock(args.dueWithTime)
        : "";
  const remind =
    typeof args.remindOption === "string" && args.remindOption !== "none"
      ? `，${remindOptionLabel(args.remindOption)}提醒`
      : "";
  switch (name) {
    case "task_create":
      return `创建任务「${title || "未命名"}」${when ? `，计划 ${when}` : ""}${remind}`;
    case "task_update":
      return `修改任务${title ? `「${title}」` : ""}`;
    case "task_complete":
      return `完成任务${title ? `「${title}」` : ""}`;
    case "task_reopen":
      return `重新打开任务${title ? `「${title}」` : ""}`;
    case "task_schedule":
      return `调整计划${title ? `「${title}」` : ""}${when ? ` → ${when}` : ""}${remind}`;
    case "task_move_backlog":
      return `把任务移入待办${title ? `「${title}」` : ""}`;
    case "task_set_deadline":
      return `设置截止${title ? `「${title}」` : ""}`;
    case "task_set_reminder":
      return `设置提醒${title ? `「${title}」` : ""}`;
    case "task_add_subtask":
      return `添加子任务「${title || "未命名"}」`;
    case "task_delete":
      return `删除任务${title ? `「${title}」` : ""}`;
    case "project_create":
      return `创建项目「${title || "未命名"}」`;
    case "project_archive":
      return `归档项目${title ? `「${title}」` : ""}`;
    case "note_create":
      return `创建笔记「${title || "未命名"}」`;
    case "note_update":
      return `修改笔记${title ? `「${title}」` : ""}`;
    case "note_delete":
      return `删除笔记${title ? `「${title}」` : ""}`;
    case "task_list_today":
      return "列出今日任务";
    case "task_list":
      return "列出任务";
    case "notification_list":
      return "列出通知";
    case "ui_open":
      return `打开${typeof args.view === "string" ? viewLabel(args.view) : "视图"}`;
    default:
      return name;
  }
}

export function builtinProvider(): ProviderConfig {
  return {
    id: BUILTIN_PROVIDER_ID,
    name: "本机工作台",
    kind: "builtin",
    baseURL: "",
    apiKeyRequired: false,
    enabled: true,
    models: { local: { context: 8192, output: 2048 } },
  };
}

export function parseModelRef(
  ref: string,
): { providerId: string; modelId: string } | null {
  const index = ref.lastIndexOf("/");
  if (index <= 0 || index === ref.length - 1) return null;
  return { providerId: ref.slice(0, index), modelId: ref.slice(index + 1) };
}

export function findProvider(
  providers: ProviderConfig[],
  modelRef: string,
): { provider: ProviderConfig; modelId: string } | null {
  const parsed = parseModelRef(modelRef);
  if (!parsed) return null;
  const provider = providers.find((item) => item.id === parsed.providerId);
  if (!provider || !provider.models[parsed.modelId]) return null;
  return { provider, modelId: parsed.modelId };
}

/** Remove secret substrings. Short values are ignored so ordinary words stay intact. */
export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out;
}

export function headersForLog(
  headers: Record<string, string>,
  secrets: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === "authorization" || lower === "x-api-key" || lower === "api-key") {
      out[key] = "[redacted]";
      continue;
    }
    out[key] = redactSecrets(value, secrets);
  }
  return out;
}

export function redactPlan(plan: AgentTurnPlan, secrets: string[]): AgentTurnPlan {
  return {
    text: redactSecrets(plan.text, secrets),
    calls: plan.calls.map((call) => ({
      ...call,
      args: redactUnknown(call.args, secrets) as Record<string, unknown>,
    })),
  };
}

function redactUnknown(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item, secrets));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = redactUnknown(item, secrets);
    }
    return out;
  }
  return value;
}

export function buildAgentSystemPrompt(input: {
  todaySummary: string;
  focus: string | null;
  unread: number;
  modelRef: string;
  permissionMode: AgentPermissionMode;
  /** User rules from settings. Blank rules are omitted. */
  rules?: string;
}): string {
  const rules = input.rules?.trim() ?? "";
  return [
    "你是个人工作台里的 Agent，通过工具管理任务、日程、笔记、提醒和通知。",
    "不要编造 id。需要细节时调用 task_get、note_get 或 search。",
    "计划日 dueDay 与时刻 dueWithTime 互斥。禁止创建名为 TODAY 的标签。",
    "写操作由宿主按权限执行；不要声称已经写入，除非工具结果如此。",
    `权限：${permissionModeLabel(input.permissionMode)}。模型：${input.modelRef}。`,
    `未读通知：${input.unread}。`,
    input.focus ? `当前对象：${input.focus}` : "",
    rules ? `用户规则：\n${rules}` : "",
    `今日任务：\n${input.todaySummary || "（空）"}`,
  ]
    .filter(Boolean)
    .join("\n");
}
