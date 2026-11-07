import { fileNameOf } from "./kb.js";
import { formatLocalDay, parseLocalDay } from "./date.js";
import { stripAnsiEscapes } from "./agent-workspace-tools.js";

const LIST_LIMIT = 12;

/** Collapse trailing separators and unify slashes for workspace root matching. */
export function normalizeAgentRootPath(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  if (!trimmed) return "";
  // Keep drive-letter form; compare case-insensitively on Windows-style paths.
  const unified = trimmed.replace(/\//g, "\\");
  return /^[a-zA-Z]:/.test(unified) ? unified.toLowerCase() : trimmed;
}

/** Display title for a newly opened folder workspace. */
export function agentWorkspaceTitleFromPath(path: string): string {
  const name = fileNameOf(path.trim());
  return name || "工作区";
}

/**
 * Turn a typed address into an http(s) URL.
 * A bare host gets https. Loopback hosts stay on http. Other schemes are rejected.
 */
export function normalizeAgentWebUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
    ? trimmed
    : `${loopbackScheme(trimmed)}://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  return url.toString();
}

/** Local tools such as dsh web listen on http, not https. */
function loopbackScheme(input: string): "http" | "https" {
  const host = input
    .split("/")[0]
    ?.split(":")[0]
    ?.replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return "http";
  return "https";
}

/**
 * Pinned sessions stay on top, newest pin first.
 * When requested, web sessions stay above other chats. Within each group, newer sessions come first.
 */
export function orderAgentWorkspaceThreads<
  T extends { updatedAt: number; webUrl?: string | null; pinnedAt?: number | null },
>(threads: readonly T[], pinWebSessions: boolean): T[] {
  const next = [...threads];
  const hasPin = next.some((item) => item.pinnedAt != null);
  if (!pinWebSessions && !hasPin) return next;
  next.sort((a, b) => {
    const aPin = a.pinnedAt != null ? 1 : 0;
    const bPin = b.pinnedAt != null ? 1 : 0;
    if (aPin !== bPin) return bPin - aPin;
    if (aPin && bPin && a.pinnedAt !== b.pinnedAt) {
      return (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0);
    }
    if (!pinWebSessions) return 0;
    const aWeb = a.webUrl ? 1 : 0;
    const bWeb = b.webUrl ? 1 : 0;
    if (aWeb !== bWeb) return bWeb - aWeb;
    return b.updatedAt - a.updatedAt;
  });
  return next;
}

export function agentRootsMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  return normalizeAgentRootPath(a) === normalizeAgentRootPath(b);
}

/** Active sessions only (archivedAt is null/undefined). */
export function isAgentThreadActive<T extends { archivedAt?: number | null }>(
  thread: T,
): boolean {
  return thread.archivedAt == null;
}

/**
 * Chat marker for a real model change. The same ref is not a change.
 * Callers supply the visible name so this stays free of provider storage.
 */
export function modelSwitchText(
  fromRef: string,
  toRef: string,
  label: (ref: string) => string,
): string | null {
  if (!fromRef || !toRef || fromRef === toRef) return null;
  const from = label(fromRef).trim() || fromRef;
  const to = label(toRef).trim() || toRef;
  return `模型已切换 ${from} → ${to}`;
}

/** Keep threads whose title contains the query. An empty query keeps the original list. */
export function filterAgentThreads<T extends { title: string }>(
  threads: readonly T[],
  query: string,
): readonly T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return threads;
  return threads.filter((thread) => thread.title.toLowerCase().includes(needle));
}

/**
 * Sessions under each workspace, newest workspace and newest session first.
 * Threads that lost their workspace still appear under that id only if a
 * matching workspace is present; callers should migrate orphans first.
 */
export function groupAgentThreadsByWorkspace<
  W extends { id: string; updatedAt: number },
  T extends { workspaceId: string; updatedAt: number },
>(
  workspaces: readonly W[],
  threads: readonly T[],
): Array<{ workspace: W; threads: T[] }> {
  const buckets = new Map<string, T[]>();
  for (const workspace of workspaces) buckets.set(workspace.id, []);
  for (const thread of threads) {
    const list = buckets.get(thread.workspaceId);
    if (list) list.push(thread);
  }
  return [...workspaces]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((workspace) => ({
      workspace,
      threads: (buckets.get(workspace.id) ?? []).sort(
        (a, b) => b.updatedAt - a.updatedAt,
      ),
    }));
}

/** First-message session title, cut on a clause boundary. */
export function agentThreadTitle(content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  if (!flat) return "新会话";
  const clause = flat.split(/(?:[，,。！？!?]|然后|接着)/)[0]?.trim() || flat;
  if (clause.length <= 18) return clause;
  return `${clause.slice(0, 18).trim()}…`;
}

const VIEW_LABEL: Record<string, string> = {
  today: "今日",
  planner: "计划",
  schedule: "计划",
  knowledge: "知识库",
  timed: "定时任务",
  projects: "任务",
  notifications: "通知",
  task: "任务",
  note: "笔记",
};

const REMIND_LABEL: Record<string, string> = {
  none: "不提醒",
  at_start: "准时",
  m5: "提前 5 分钟",
  m10: "提前 10 分钟",
  m15: "提前 15 分钟",
  m30: "提前 30 分钟",
  h1: "提前 1 小时",
};

const ARG_LABEL: Record<string, string> = {
  title: "标题",
  dueDay: "计划",
  dueWithTime: "计划",
  deadlineDay: "截止",
  deadlineWithTime: "截止",
  remindOption: "提醒",
  notes: "备注",
  bodyMd: "正文",
  body: "内容",
  text: "内容",
  name: "名称",
  description: "说明",
  projectTitle: "项目",
  view: "打开",
  query: "关键词",
  displayName: "显示名",
  event: "时机",
  endpoint: "地址",
  command: "命令",
  url: "地址",
  path: "路径",
  file_path: "路径",
  old_string: "原文",
  new_string: "替换为",
  replace_all: "全部替换",
  pattern: "模式",
  include: "文件过滤",
  workdir: "工作目录",
  timeout: "超时",
  content: "内容",
  offset: "起始行",
  limit: "行数",
  patch: "补丁",
  queries: "查询",
  job_id: "任务",
  session_id: "终端",
  background: "后台",
  wait: "等待",
  reason: "原因",
  cd: "目录",
  submit: "回车",
  signal: "信号",
  modelRef: "模型",
  timeEstimateMinutes: "预计",
  version: "版本",
  usage: "用法",
  color: "颜色",
  status: "状态",
};

const ARG_SKIP = new Set([
  "taskId",
  "noteId",
  "projectId",
  "id",
  "tagId",
  "skillId",
  "hookId",
  "serverId",
]);

export function remindOptionLabel(option: string): string {
  return REMIND_LABEL[option] ?? option;
}

export function viewLabel(view: string): string {
  return VIEW_LABEL[view] ?? view;
}

/** Calendar day as 今天 / 明天 / 后天 / 昨天, otherwise the original YYYY-MM-DD. */
export function formatAgentDay(day: string, nowMs: number): string {
  const offset = dayOffset(day, nowMs);
  if (offset === 0) return "今天";
  if (offset === 1) return "明天";
  if (offset === 2) return "后天";
  if (offset === -1) return "昨天";
  return day;
}

export function formatAgentMoment(ms: number, nowMs: number): string {
  return `${formatAgentDay(formatLocalDay(ms), nowMs)} ${formatAgentClock(ms)}`;
}

/** Compact sidebar age, matching ZCode-style session rows (1m / 7d). */
export function formatAgentRelativeShort(ms: number, nowMs: number): string {
  const diff = Math.max(0, nowMs - ms);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
}

/** Clock on a bubble. Today's messages omit the day; other days keep 昨天 / 明天 / the date. */
export function formatAgentBubbleTime(ms: number, nowMs: number): string {
  const day = formatAgentDay(formatLocalDay(ms), nowMs);
  const clock = formatAgentClock(ms);
  return day === "今天" ? clock : `${day} ${clock}`;
}

/** How long a reply took, from the user message to the last part of the answer. */
export function formatReplyElapsed(startMs: number, endMs: number): string {
  const ms = Math.max(0, endMs - startMs);
  if (ms < 1000) return "耗时 <1 秒";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `耗时 ${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) {
    return rest === 0 ? `耗时 ${minutes} 分` : `耗时 ${minutes} 分 ${rest} 秒`;
  }
  const hours = Math.floor(minutes / 60);
  const minuteRest = minutes % 60;
  return minuteRest === 0 ? `耗时 ${hours} 小时` : `耗时 ${hours} 小时 ${minuteRest} 分`;
}

function formatAgentClock(ms: number): string {
  const date = new Date(ms);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** Empty-thread greeting from the device's local hour. 23:00–04:59 is late night. */
export function agentEmptyGreeting(hour: number): string {
  const h = Math.floor(hour);
  if (h >= 5 && h < 9) return "早上好呀，新的一天开始啦";
  if (h >= 9 && h < 12) return "上午好呀，有什么想让我帮忙的吗";
  if (h >= 12 && h < 14) return "中午好呀，要不要先休息一下";
  if (h >= 14 && h < 18) return "下午好呀，接下来交给我吧";
  if (h >= 18 && h < 23) return "晚上好呀，今天辛苦啦";
  return "夜深啦，别忘了照顾好自己哦";
}

/** Rewrite stored YYYY-MM-DD times for the current day. Stored text stays absolute. */
export function relativizeScheduleText(text: string, nowMs: number): string {
  return text.replace(
    /(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/g,
    (_full, day: string, clock?: string) => {
      const label = formatAgentDay(day, nowMs);
      if (!clock) return label;
      return label === day ? `${day} ${clock}` : `${label} ${clock}`;
    },
  );
}

/** Readable lines for an approval card. Internal ids stay hidden. */
export function describeToolArgs(args: Record<string, unknown>, nowMs: number): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (ARG_SKIP.has(key) || value == null || value === "") continue;
    const shown = presentArg(key, value, nowMs);
    if (!shown) continue;
    lines.push(`${ARG_LABEL[key] ?? key}：${shown}`);
  }
  return lines.join("\n");
}

/**
 * Approval card lines with old → new when a before snapshot is available.
 * Unchanged fields are omitted. Falls back to describeToolArgs without a before map.
 */
export function describeToolArgDiff(
  args: Record<string, unknown>,
  before: Record<string, unknown> | null | undefined,
  nowMs: number,
): string {
  if (!before) return describeToolArgs(args, nowMs);
  const lines: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (ARG_SKIP.has(key) || value == null || value === "") continue;
    const next = presentArg(key, value, nowMs);
    if (!next) continue;
    const prevRaw = before[key];
    const prev = prevRaw == null || prevRaw === "" ? "" : presentArg(key, prevRaw, nowMs);
    if (prev && prev === next) continue;
    const label = ARG_LABEL[key] ?? key;
    lines.push(prev ? `${label}：${prev} → ${next}` : `${label}：${next}`);
  }
  return lines.join("\n");
}

function presentArg(key: string, value: unknown, nowMs: number): string {
  if (key === "dueWithTime" || key === "deadlineWithTime") {
    return typeof value === "number" ? formatAgentMoment(value, nowMs) : "";
  }
  if (key === "dueDay" || key === "deadlineDay") {
    return typeof value === "string" ? formatAgentDay(value, nowMs) : "";
  }
  if (key === "remindOption") {
    if (typeof value !== "string" || value === "none") return "";
    return remindOptionLabel(value);
  }
  if (key === "view" && typeof value === "string") return viewLabel(value);
  if (key === "timeEstimateMinutes" && typeof value === "number") return `${value} 分钟`;
  if (key === "bodyMd" && typeof value === "string") {
    const body = value.trim();
    return body.length > 160 ? `${body.slice(0, 160)}…` : body;
  }
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "string" || typeof value === "number") return String(value);
  return "";
}

function dayOffset(day: string, nowMs: number): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const delta = parseLocalDay(day) - parseLocalDay(formatLocalDay(nowMs));
  return Math.round(delta / 86_400_000);
}

/** Short caption for a tool result, so a multi-step reply can be scanned. */
export function toolResultLabel(name: string): string {
  if (name.startsWith("timer_")) return "计时";
  if (name.startsWith("task_")) return "任务";
  if (name.startsWith("project_")) return "项目";
  if (name.startsWith("note_")) return "笔记";
  if (name === "search") return "搜索";
  if (name.startsWith("notification_")) return "通知";
  if (name.startsWith("memory_")) return "记忆";
  if (name.startsWith("skill_")) return "技能";
  if (name.startsWith("subagent") || name === "subagent") return "子智能体";
  if (name === "get_goal" || name === "create_goal" || name === "update_goal") {
    return "Goal";
  }
  if (
    name === "session_search" ||
    name === "session_trace" ||
    name === "session_event_search" ||
    name === "session_event_read" ||
    name === "session_event_trace"
  ) {
    return "会话检索";
  }
  if (name.startsWith("schedule_")) return "定时任务";
  if (name.startsWith("hook_")) return "钩子";
  if (name.startsWith("mcp_")) return "MCP";
  if (name.startsWith("plugin_")) return "插件";
  if (name.startsWith("tag_")) return "标签";
  if (name.startsWith("host_tool")) return "本机工具";
  if (name.startsWith("settings_") || name.startsWith("session_")) return "设置";
  if (name === "ui_open") return "打开";
  if (
    name === "read" ||
    name === "read_image" ||
    name === "write" ||
    name === "edit" ||
    name === "apply_patch" ||
    name === "str_replace_editor"
  ) {
    return "工作区文件";
  }
  if (name === "glob" || name === "grep") return "工作区搜索";
  if (name === "pwsh" || name === "bash" || name === "shell") return "终端";
  if (name === "web_fetch" || name === "web_search") return "网页";
  if (name === "todo_write") return "待办";
  if (name.startsWith("job_")) return "后台任务";
  if (name === "ask_user_question") return "提问";
  if (name === "working_directory") return "工作目录";
  if (name.startsWith("terminal_")) return "终端";
  if (name === "present") return "交付";
  if (name === "office_to_pdf") return "文档转换";
  return "";
}

/** One-line peek used when a tool result is collapsed. */
export function toolResultPreview(text: string, max = 80): string {
  const line = stripAnsiEscapes(text)
    .split(/\r?\n/)
    .map((part) => part.trim().replace(/^[-·•]\s*/, ""))
    .find(Boolean);
  if (!line) return "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** Turn a tool payload into text a person can read. Raw JSON stays out of the transcript. */
export function describeToolResult(name: string, data: unknown, summary: string): string {
  const record = asRecord(data);
  if (!record) return summary;
  if (typeof record.error === "string" && record.error) return record.error;

  if (record.task) {
    const lines = [taskLine(record.task)];
    for (const sub of asArray(record.subtasks) ?? []) {
      const line = taskLine(sub);
      if (line) lines.push(`  ${line}`);
    }
    return join(summary, lines);
  }

  const tasks = asArray(record.tasks);
  const notes = asArray(record.notes);
  if (tasks || (notes && name !== "note_get")) {
    const lines = [...(tasks ?? []).map(taskLine), ...(notes ?? []).map(noteLine)];
    return joinList(summary, lines);
  }

  const projects = asArray(record.projects);
  if (projects) {
    return joinList(
      summary,
      projects.map((item) => {
        const project = asRecord(item);
        return project && typeof project.title === "string" ? `· ${project.title}` : "";
      }),
    );
  }

  const notifications = asArray(record.notifications);
  if (notifications) {
    const open = notifications.filter((item) => asRecord(item)?.status !== "dismissed");
    return joinList(
      open.length ? `未关闭通知 ${open.length} 条` : "没有未关闭的通知。",
      open.map((item) => {
        const note = asRecord(item);
        return note && typeof note.title === "string" ? `· ${note.title}` : "";
      }),
    );
  }

  if (record.note) {
    const note = asRecord(record.note);
    const body =
      note && typeof note.bodyMd === "string" ? note.bodyMd.trim().slice(0, 280) : "";
    return [summary, body].filter(Boolean).join("\n");
  }

  const listed = firstListed(summary, record);
  if (listed) return listed;

  if (typeof record.body === "string" && typeof record.name === "string") {
    const description =
      typeof record.description === "string" ? record.description.trim() : "";
    return [summary, description, clipOutput(record.body)].filter(Boolean).join("\n\n");
  }

  if (typeof record.displayName === "string") {
    return `${summary}\n显示名称：${record.displayName}`;
  }

  if (name === "host_tool_list") {
    const tools = asArray(record.tools) ?? [];
    return joinList(
      summary,
      tools.map((item) => {
        const tool = asRecord(item);
        if (!tool || typeof tool.id !== "string") return "";
        const version =
          typeof tool.version === "string" && tool.version ? ` ${tool.version}` : "";
        return `· ${tool.id}${version}`;
      }),
    );
  }

  if (
    name === "host_tool_run" ||
    name === "pwsh" ||
    name === "bash" ||
    name === "shell"
  ) {
    const stdout = clipOutput(record.stdout);
    const stderr = clipOutput(record.stderr);
    const truncated = record.truncated === true ? "输出已截断" : "";
    return [summary, stdout, stderr, truncated].filter(Boolean).join("\n");
  }

  if (name.startsWith("terminal_")) {
    if (typeof record.output === "string" && record.output.trim()) {
      return [summary, clipOutput(record.output)].filter(Boolean).join("\n");
    }
    const terminals = asArray(record.terminals) ?? [];
    if (terminals.length) {
      return joinList(
        summary,
        terminals.map((item) => {
          const term = asRecord(item);
          if (!term || typeof term.id !== "string") return "";
          const nameLabel = typeof term.name === "string" ? term.name : "";
          const alive = term.alive === false ? "已结束" : "运行中";
          return `· ${term.id}${nameLabel ? ` (${nameLabel})` : ""} · ${alive}`;
        }),
      );
    }
    return summary;
  }

  if (name === "ask_user_question") {
    if (record.timedOut === true) return summary;
    const answers = asRecord(record.answers);
    if (!answers) return summary;
    return joinList(
      summary,
      Object.entries(answers).map(([id, value]) => {
        const text = Array.isArray(value) ? value.join("、") : String(value ?? "");
        return `· ${id}: ${text}`;
      }),
    );
  }

  if (name === "present") {
    const files = asArray(record.files) ?? [];
    return joinList(
      summary,
      files.map((item) => {
        const file = asRecord(item);
        if (!file || typeof file.path !== "string") return "";
        const desc =
          typeof file.description === "string" && file.description
            ? ` — ${file.description}`
            : "";
        return `· ${file.path}${desc}`;
      }),
    );
  }

  if (name === "read_image") {
    const path = typeof record.path === "string" ? record.path : "";
    const mediaType = typeof record.mediaType === "string" ? record.mediaType : "";
    const image = asRecord(record.image);
    const attachmentId =
      image && typeof image.attachmentId === "string" ? image.attachmentId : "";
    const dims =
      image &&
      typeof image.width === "number" &&
      typeof image.height === "number" &&
      image.width > 0 &&
      image.height > 0
        ? `${image.width}×${image.height}`
        : "";
    return [
      summary,
      path && mediaType ? `${path} (${mediaType}${dims ? ` · ${dims}` : ""})` : path,
      attachmentId ? `attachment ${attachmentId}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (name === "office_to_pdf") {
    const output = typeof record.output === "string" ? record.output : "";
    return output ? `${summary}\n${output}` : summary;
  }

  if (name === "subagent" && typeof record.text === "string") {
    return [summary, clipOutput(record.text)].filter(Boolean).join("\n");
  }

  if (name === "get_goal" || name === "create_goal" || name === "update_goal") {
    const goal = asRecord(record.goal);
    if (!goal) return summary;
    const objective = typeof goal.objective === "string" ? goal.objective : "";
    const phase = typeof goal.phase === "string" ? goal.phase : "";
    return [summary, phase && objective ? `${phase} · ${objective}` : objective]
      .filter(Boolean)
      .join("\n");
  }

  if (name === "session_search") {
    const hits = asArray(record.hits) ?? [];
    return joinList(
      summary,
      hits.slice(0, 40).map((item) => {
        const hit = asRecord(item);
        if (!hit || typeof hit.snippet !== "string") return "";
        const title = typeof hit.title === "string" ? hit.title : "";
        return `· ${title}: ${hit.snippet}`;
      }),
    );
  }

  if (name === "session_trace") {
    const events = asArray(record.events) ?? [];
    return joinList(
      summary,
      events.slice(0, 40).map((item) => {
        const row = asRecord(item);
        if (!row || typeof row.snippet !== "string") return "";
        const role = typeof row.role === "string" ? row.role : "";
        return `· ${role}: ${row.snippet}`;
      }),
    );
  }

  if (name === "session_event_search") {
    const hits = asArray(record.hits) ?? [];
    return joinList(
      summary,
      hits.slice(0, 40).map((item) => {
        const hit = asRecord(item);
        if (!hit || typeof hit.snippet !== "string") return "";
        const seq = typeof hit.seq === "number" ? hit.seq : "?";
        const type = typeof hit.type === "string" ? hit.type : "";
        return `· #${seq} ${type}: ${hit.snippet}`;
      }),
    );
  }

  if (name === "session_event_read") {
    const event = asRecord(record.event);
    if (!event) return summary;
    const seq = typeof event.seq === "number" ? event.seq : "?";
    const type = typeof event.type === "string" ? event.type : "";
    const content = typeof event.content === "string" ? clipOutput(event.content) : "";
    return [summary, `#${seq} ${type}`, content].filter(Boolean).join("\n");
  }

  if (name === "session_event_trace") {
    const event = asRecord(record.event);
    const related = asArray(record.related) ?? [];
    const seq = event && typeof event.seq === "number" ? event.seq : "?";
    return joinList(
      `${summary}（#${seq}）`,
      related.slice(0, 20).map((item) => {
        const row = asRecord(item);
        if (!row) return "";
        const rSeq = typeof row.seq === "number" ? row.seq : "?";
        const type = typeof row.type === "string" ? row.type : "";
        return `· #${rSeq} ${type}`;
      }),
    );
  }

  if (name.startsWith("schedule_")) {
    if (record.code === "schedule_not_found" || record.code === "schedule_conflict") {
      return summary;
    }
    const one = asRecord(record.schedule);
    if (one && typeof one.title === "string") {
      return `${summary}\n${one.title}${typeof one.id === "string" ? ` (${one.id})` : ""}`;
    }
    const schedules = asArray(record.schedules) ?? [];
    return joinList(
      summary,
      schedules.map((item) => {
        const row = asRecord(item);
        if (!row || typeof row.title !== "string") return "";
        const id = typeof row.id === "string" ? row.id : "";
        const active = row.active === false ? "paused" : "active";
        return `· ${id} [${active}] ${row.title}`;
      }),
    );
  }

  if (name === "working_directory" && typeof record.cwd === "string") {
    return `${summary}\n${record.cwd}`;
  }

  if (name === "read" || name === "web_fetch") {
    const body = typeof record.text === "string" ? clipOutput(record.text) : "";
    return [summary, body].filter(Boolean).join("\n");
  }

  if (
    name === "write" ||
    name === "edit" ||
    name === "apply_patch" ||
    name === "str_replace_editor"
  ) {
    if (typeof record.text === "string" && record.text.trim()) {
      return [summary, clipOutput(record.text)].filter(Boolean).join("\n");
    }
    return summary;
  }

  if (name === "web_search") {
    const hits = asArray(record.results) ?? [];
    return joinList(
      summary,
      hits.map((item) => {
        const hit = asRecord(item);
        if (!hit || typeof hit.title !== "string") return "";
        const url = typeof hit.url === "string" ? hit.url : "";
        return `· ${hit.title}${url ? ` — ${url}` : ""}`;
      }),
    );
  }

  if (name === "job_list" || name === "job_output" || name === "job_kill") {
    if (typeof record.output === "string" && record.output.trim()) {
      return [summary, clipOutput(record.output)].filter(Boolean).join("\n");
    }
    const jobs = asArray(record.jobs) ?? [];
    if (jobs.length) {
      return joinList(
        summary,
        jobs.map((item) => {
          const job = asRecord(item);
          if (!job || typeof job.id !== "string") return "";
          const status = typeof job.status === "string" ? job.status : "";
          const desc = typeof job.description === "string" ? job.description : "";
          return `· ${job.id} [${status}] ${desc}`.trim();
        }),
      );
    }
    return summary;
  }

  if (name === "glob" || name === "grep") {
    const hits = asArray(record.paths) ?? asArray(record.matches) ?? [];
    return joinList(
      summary,
      hits.slice(0, 40).map((item) => {
        if (typeof item === "string") return `· ${item}`;
        const row = asRecord(item);
        if (!row) return "";
        if (typeof row.path === "string" && typeof row.line === "number") {
          return `· ${row.path}:${row.line} ${typeof row.text === "string" ? row.text : ""}`.trim();
        }
        return typeof row.path === "string" ? `· ${row.path}` : "";
      }),
    );
  }

  if (name === "todo_write") {
    const todos = asArray(record.todos) ?? [];
    return joinList(
      summary,
      todos.map((item) => {
        const todo = asRecord(item);
        if (!todo || typeof todo.content !== "string") return "";
        const status = typeof todo.status === "string" ? todo.status : "";
        return `· [${status}] ${todo.content}`;
      }),
    );
  }

  return summary;
}

function titledLines(
  summary: string,
  items: unknown[] | null,
  line: (item: Record<string, unknown>) => string,
): string | null {
  if (!items) return null;
  return joinList(
    summary,
    items.map((item) => {
      const record = asRecord(item);
      return record ? line(record) : "";
    }),
  );
}

function firstListed(summary: string, record: Record<string, unknown>): string | null {
  return (
    titledLines(summary, asArray(record.memories), (item) =>
      typeof item.text === "string" ? `· ${item.text}` : "",
    ) ??
    titledLines(summary, asArray(record.skills), (item) => {
      if (typeof item.name !== "string") return "";
      const description =
        typeof item.description === "string" && item.description.trim()
          ? `：${item.description.trim()}`
          : "";
      return `· /${item.name}${description}`;
    }) ??
    titledLines(summary, asArray(record.subagents), (item) => {
      if (typeof item.name !== "string") return "";
      const description =
        typeof item.description === "string" && item.description.trim()
          ? `：${item.description.trim()}`
          : "";
      return `· ${item.name}${description}`;
    }) ??
    titledLines(summary, asArray(record.hooks), (item) => {
      const title = typeof item.title === "string" ? item.title : "";
      const event = typeof item.event === "string" ? item.event : "";
      if (!title && !event) return "";
      return `· ${[event, title].filter(Boolean).join(" ")}`;
    }) ??
    titledLines(summary, asArray(record.servers), (item) => {
      if (typeof item.name !== "string") return "";
      const endpoint = typeof item.endpoint === "string" ? item.endpoint : "";
      return `· ${item.name}${endpoint ? ` · ${endpoint}` : ""} · 尚未连接`;
    }) ??
    titledLines(summary, asArray(record.plugins), (item) => {
      if (typeof item.name !== "string") return "";
      const version =
        typeof item.version === "string" && item.version ? ` ${item.version}` : "";
      const description =
        typeof item.description === "string" && item.description.trim()
          ? `：${item.description.trim()}`
          : "";
      return `· ${item.name}${version}${description}`;
    }) ??
    titledLines(summary, asArray(record.tags), (item) =>
      typeof item.title === "string" ? `· ${item.title}` : "",
    )
  );
}

function clipOutput(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = stripAnsiEscapes(value).trim();
  if (!text) return "";
  return text.length > 8000 ? `${text.slice(0, 8000)}…` : text;
}

function join(summary: string, lines: string[]): string {
  const body = lines.filter(Boolean);
  if (!body.length) return summary;
  return [summary, ...body].join("\n");
}

function joinList(summary: string, lines: string[]): string {
  const body = lines.filter(Boolean);
  if (!body.length) return summary;
  const shown = body.slice(0, LIST_LIMIT);
  if (body.length > LIST_LIMIT) {
    shown.push(`· …其余 ${body.length - LIST_LIMIT} 项`);
  }
  return [summary, ...shown].join("\n");
}

function taskLine(value: unknown): string {
  const task = asRecord(value);
  if (!task || typeof task.title !== "string") return "";
  const bits: string[] = [];
  if (task.isDone === true) bits.push("已完成");
  if (typeof task.dueDay === "string") bits.push(task.dueDay);
  if (typeof task.dueWithTime === "number") bits.push(formatStamp(task.dueWithTime));
  if (typeof task.remindAt === "number") bits.push(`提醒 ${formatStamp(task.remindAt)}`);
  if (typeof task.timeEstimate === "number" && task.timeEstimate >= 60_000) {
    bits.push(`预计 ${Math.round(task.timeEstimate / 60_000)} 分钟`);
  }
  if (typeof task.projectTitle === "string" && task.projectTitle.trim()) {
    bits.push(task.projectTitle.trim());
  }
  return `· ${task.title}${bits.length ? ` · ${bits.join(" · ")}` : ""}`;
}

function noteLine(value: unknown): string {
  const note = asRecord(value);
  if (!note || typeof note.title !== "string") return "";
  return `· ${note.title}`;
}

function formatStamp(ms: number): string {
  const date = new Date(ms);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${formatLocalDay(ms)} ${hh}:${mm}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}
