import { formatLocalClock, formatLocalDay, formatRelativeMoment } from "./date.js";

const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"] as const;

/** Host facts for one model turn. Blank fields are omitted. */
export type AgentSessionContext = {
  nowMs: number;
  workspaceTitle?: string;
  workspacePath?: string;
  gitBranch?: string | null;
  focus?: string | null;
};

/** Date, workspace, branch, and whatever the user currently has open. */
export function formatSessionContext(input: AgentSessionContext): string {
  const date = new Date(input.nowMs);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const lines = [
    `现在是 ${formatLocalDay(input.nowMs)} 周${WEEKDAY[date.getDay()] ?? ""} ${hours}:${minutes}。`,
  ];
  const title = input.workspaceTitle?.trim() ?? "";
  const path = input.workspacePath?.trim() ?? "";
  if (path) {
    const base = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
    const same = title.length > 0 && base.toLowerCase() === title.toLowerCase();
    lines.push(same || !title ? `工作区：${path}` : `工作区：${title} · ${path}`);
  } else if (title) {
    lines.push(`工作区：${title}`);
  }
  const branch = input.gitBranch?.trim();
  if (branch) lines.push(`当前分支：${branch}`);
  const focus = input.focus?.trim();
  if (focus) lines.push(`当前对象：${focus}`);
  return lines.join("\n");
}

export type TodayPromptTask = {
  title: string;
  dueDay?: string | null;
  dueWithTime?: number | null;
  remindAt?: number | null;
  /** Stored as milliseconds. */
  timeEstimate?: number | null;
  projectTitle?: string | null;
};

/** One today row: title, when it is planned, reminder, estimate, project. */
export function formatTodayTaskLine(task: TodayPromptTask, nowMs: number): string {
  const bits: string[] = [];
  if (typeof task.dueWithTime === "number") {
    bits.push(formatRelativeMoment(task.dueWithTime, nowMs));
  } else if (task.dueDay) {
    bits.push(task.dueDay < formatLocalDay(nowMs) ? `逾 ${task.dueDay}` : "全天");
  }
  if (typeof task.remindAt === "number") {
    bits.push(`提醒 ${formatLocalClock(task.remindAt)}`);
  }
  if (typeof task.timeEstimate === "number" && task.timeEstimate >= 60_000) {
    bits.push(`预计 ${Math.round(task.timeEstimate / 60_000)} 分钟`);
  }
  const project = task.projectTitle?.trim();
  if (project) bits.push(project);
  return `· ${task.title}${bits.length ? ` · ${bits.join(" · ")}` : ""}`;
}

/** Up to 12 today tasks for the system prompt. Empty when there is nothing planned. */
export function formatTodayForPrompt(
  tasks: readonly TodayPromptTask[],
  nowMs: number,
): string {
  return tasks
    .slice(0, 12)
    .map((task) => formatTodayTaskLine(task, nowMs))
    .join("\n");
}
