/**
 * Notification hooks. They post text; they do not run shell commands.
 * Events match the workbench contract: session start, task completed, reminder due.
 */

import { createId } from "./id.js";

export type AgentHookEvent = "session_start" | "task_completed" | "reminder_due";

export type AgentHook = {
  id: string;
  event: AgentHookEvent;
  title: string;
  body: string;
  enabled: boolean;
};

export const HOOK_EVENT_LABEL: Record<AgentHookEvent, string> = {
  session_start: "会话开始",
  task_completed: "任务完成",
  reminder_due: "提醒触发",
};

const EVENT_ALIASES: Record<string, AgentHookEvent> = {
  session_start: "session_start",
  sessionstart: "session_start",
  task_completed: "task_completed",
  taskcompleted: "task_completed",
  reminder_due: "reminder_due",
  reminderdue: "reminder_due",
};

export function parseHookEvent(value: string): AgentHookEvent | null {
  const key = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return EVENT_ALIASES[key] ?? null;
}

export function addAgentHook(
  list: readonly AgentHook[],
  input: { event: AgentHookEvent; title: string; body: string },
  nowMs = Date.now(),
): { hooks: AgentHook[]; added: AgentHook | null; reason?: string } {
  const title = input.title.trim().slice(0, 80);
  const body = input.body.trim().slice(0, 500);
  if (!title) return { hooks: [...list], added: null, reason: "请写钩子标题" };
  if (!body) return { hooks: [...list], added: null, reason: "请写要投递的文字" };
  const added: AgentHook = {
    id: createId(nowMs),
    event: input.event,
    title,
    body,
    enabled: true,
  };
  return { hooks: [...list, added], added };
}

export function removeAgentHook(list: readonly AgentHook[], id: string): AgentHook[] {
  return list.filter((item) => item.id !== id);
}

export function setAgentHookEnabled(
  list: readonly AgentHook[],
  id: string,
  enabled: boolean,
): AgentHook[] {
  return list.map((item) => (item.id === id ? { ...item, enabled } : item));
}

export function hooksForEvent(
  list: readonly AgentHook[],
  event: AgentHookEvent,
): AgentHook[] {
  return list.filter((item) => item.enabled && item.event === event);
}

export function hookNotice(hook: AgentHook): string {
  const body = hook.body.trim();
  const title = hook.title.trim();
  if (title && body && !body.startsWith(title)) return `${title}：${body}`;
  return body || title;
}

export function formatHookNotices(list: readonly AgentHook[]): string {
  return list.map(hookNotice).filter(Boolean).join("\n");
}

/** Plugin hooks.json: an array, or `{ "hooks": [...] }`. */
export function parseHooksDocument(raw: string, idPrefix: string): AgentHook[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { hooks?: unknown }).hooks)
      ? (parsed as { hooks: unknown[] }).hooks
      : [];
  const out: AgentHook[] = [];
  rows.forEach((row, index) => {
    if (!row || typeof row !== "object") return;
    const record = row as Record<string, unknown>;
    const event = parseHookEvent(typeof record.event === "string" ? record.event : "");
    const title = typeof record.title === "string" ? record.title.trim() : "";
    const body = typeof record.body === "string" ? record.body.trim() : "";
    if (!event || !title || !body) return;
    out.push({
      id: `${idPrefix}:${event}:${index}`,
      event,
      title: title.slice(0, 80),
      body: body.slice(0, 500),
      enabled: record.enabled !== false,
    });
  });
  return out;
}
