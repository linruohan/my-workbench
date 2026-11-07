/**
 * Shared fire path for TimedTask → Agent session delivery.
 */

import {
  buildTimedTaskPrompt,
  DEFAULT_AGENT_WORKSPACE_TITLE,
  type AgentSkill,
  type TimedTask,
} from "@wb/domain";
import type { MemoryWorkbenchRepository } from "@wb/db/memory";
import { readProviderStore } from "../agent/providers";
import {
  enqueueScheduleDelivery,
  getScheduleMeta,
  setScheduleMeta,
  type ScheduleMeta,
} from "../agent/schedule-meta";

export type TimedTaskFireResult = {
  task: TimedTask;
  threadId: string | null;
  delivered: boolean;
};

function resolveDefaultWorkspace(
  store: MemoryWorkbenchRepository,
  preferredId: string | null | undefined,
  nowMs: number,
) {
  if (preferredId) {
    const preferred = store.getAgentWorkspace(preferredId);
    if (preferred) return preferred;
  }
  const named = store
    .listAgentWorkspaces()
    .find((item) => item.title === DEFAULT_AGENT_WORKSPACE_TITLE);
  if (named) return named;
  return store.ensureAgentWorkspace(nowMs);
}

function resolveSkillNames(
  skills: readonly AgentSkill[],
  skillIds: readonly string[] | undefined,
): string[] {
  if (!skillIds?.length) return [];
  const names: string[] = [];
  for (const ref of skillIds) {
    const hit =
      skills.find((skill) => skill.id === ref) ??
      skills.find((skill) => skill.name === ref);
    if (hit) names.push(hit.name);
    else if (ref.trim()) names.push(ref.trim().replace(/^\//, ""));
  }
  return names;
}

/** Ensure a session is bound; create one in the default workspace when missing. */
export function ensureTimedTaskSession(
  store: MemoryWorkbenchRepository,
  task: TimedTask,
  meta: ScheduleMeta | null,
  nowMs = Date.now(),
): { threadId: string; workspaceId: string; meta: ScheduleMeta } {
  const existing =
    meta?.threadId && store.getAgentThread(meta.threadId)
      ? store.getAgentThread(meta.threadId)
      : null;
  if (existing) {
    const next: ScheduleMeta = {
      target: meta?.target ?? "this_session",
      threadId: existing.id,
      workspaceId: existing.workspaceId,
      skillIds: meta?.skillIds ?? [],
    };
    setScheduleMeta(task.id, next);
    return {
      threadId: existing.id,
      workspaceId: existing.workspaceId,
      meta: next,
    };
  }

  const workspace = resolveDefaultWorkspace(store, meta?.workspaceId, nowMs);
  const thread = store.createAgentThread({
    workspaceId: workspace.id,
    title: task.title,
    modelRef: readProviderStore().defaultModelRef,
    nowMs,
  });
  const next: ScheduleMeta = {
    target: meta?.target ?? "this_session",
    threadId: thread.id,
    workspaceId: workspace.id,
    skillIds: meta?.skillIds ?? [],
  };
  setScheduleMeta(task.id, next);
  return { threadId: thread.id, workspaceId: workspace.id, meta: next };
}

/**
 * Mark the timed task as ran, notify, and enqueue an Agent delivery.
 * Creates a default-workspace session named after the task when unbound.
 */
export function runTimedTaskNow(
  store: MemoryWorkbenchRepository,
  task: TimedTask,
  opts?: {
    nowMs?: number;
    skills?: readonly AgentSkill[];
    /** When true, always create a fresh session (schedule target "new"). */
    forceNewSession?: boolean;
  },
): TimedTaskFireResult {
  const at = opts?.nowMs ?? Date.now();
  const skills = opts?.skills ?? [];
  const prior = getScheduleMeta(task.id);
  const forceNew = opts?.forceNewSession ?? prior?.target === "new";

  let threadId: string | null = null;
  let meta: ScheduleMeta;
  if (forceNew) {
    const workspace = resolveDefaultWorkspace(store, prior?.workspaceId, at);
    const child = store.createAgentThread({
      workspaceId: workspace.id,
      title: task.title,
      modelRef: readProviderStore().defaultModelRef,
      nowMs: at,
    });
    threadId = child.id;
    meta = {
      target: prior?.target ?? "new",
      // Keep "new" unbound so the next fire creates another session.
      threadId: null,
      workspaceId: workspace.id,
      skillIds: prior?.skillIds ?? [],
    };
    setScheduleMeta(task.id, meta);
  } else {
    const ensured = ensureTimedTaskSession(store, task, prior, at);
    threadId = ensured.threadId;
    meta = ensured.meta;
  }

  const updated = store.markTimedTaskRan(task.id, at);
  store.pushNotification({
    kind: "system",
    title: `定时任务 · ${task.title}`,
    body: task.command.trim().slice(0, 240) || "已到期",
    nowMs: at,
  });

  const prompt = buildTimedTaskPrompt(
    task.command,
    resolveSkillNames(skills, meta.skillIds),
  );
  let delivered = false;
  if (threadId && prompt.trim()) {
    enqueueScheduleDelivery({
      scheduleId: task.id,
      threadId,
      prompt,
      title: task.title,
      at,
    });
    delivered = true;
  }

  return { task: updated, threadId, delivered };
}

/** Advance past a missed occurrence without delivering to an Agent session. */
export function skipTimedTaskOccurrence(
  store: MemoryWorkbenchRepository,
  task: TimedTask,
  nowMs = Date.now(),
): TimedTask {
  return store.markTimedTaskRan(task.id, nowMs);
}

/** True when the task has a command and/or bound skills to deliver. */
export function timedTaskHasPayload(
  task: Pick<TimedTask, "command">,
  skillIds?: readonly string[] | null,
): boolean {
  return Boolean(task.command.trim()) || Boolean(skillIds?.length);
}
