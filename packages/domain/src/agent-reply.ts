import { formatLocalDay, parseLocalDay } from "./date.js";

const LIST_LIMIT = 12;

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
  schedule: "时间表",
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
  projectTitle: "项目",
  view: "打开",
  query: "关键词",
  displayName: "显示名",
};

const ARG_SKIP = new Set(["taskId", "noteId", "projectId", "id", "tagId"]);

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

/** Clock on a bubble. Today's messages omit the day; other days keep 昨天 / 明天 / the date. */
export function formatAgentBubbleTime(ms: number, nowMs: number): string {
  const day = formatAgentDay(formatLocalDay(ms), nowMs);
  const clock = formatAgentClock(ms);
  return day === "今天" ? clock : `${day} ${clock}`;
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
  if (key === "bodyMd" && typeof value === "string") {
    const body = value.trim();
    return body.length > 160 ? `${body.slice(0, 160)}…` : body;
  }
  if (typeof value === "string" || typeof value === "number") return String(value);
  return "";
}

function dayOffset(day: string, nowMs: number): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const delta = parseLocalDay(day) - parseLocalDay(formatLocalDay(nowMs));
  return Math.round(delta / 86_400_000);
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

  return summary;
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
