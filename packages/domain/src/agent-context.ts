import { formatLocalDay } from "./date.js";

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
