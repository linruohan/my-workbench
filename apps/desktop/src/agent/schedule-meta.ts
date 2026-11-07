/**
 * Side metadata for DSH schedule_* mapped onto TimedTask (target + owning thread).
 */

import type { ScheduleTarget } from "@wb/domain";

export type ScheduleMeta = {
  target: ScheduleTarget;
  /** Session that receives deliveries for this_session / new_once. */
  threadId: string | null;
  workspaceId: string | null;
};

export type ScheduleDelivery = {
  scheduleId: string;
  threadId: string;
  prompt: string;
  title: string;
  at: number;
};

const META_KEY = "wb.agent.schedule-meta.v1";
const DELIVERY_KEY = "wb.agent.schedule-deliveries.v1";

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore quota
  }
}

export function getScheduleMeta(id: string): ScheduleMeta | null {
  const all = readJson<Record<string, ScheduleMeta>>(META_KEY, {});
  return all[id] ?? null;
}

export function setScheduleMeta(id: string, meta: ScheduleMeta): void {
  const all = readJson<Record<string, ScheduleMeta>>(META_KEY, {});
  all[id] = meta;
  writeJson(META_KEY, all);
}

export function deleteScheduleMeta(id: string): void {
  const all = readJson<Record<string, ScheduleMeta>>(META_KEY, {});
  delete all[id];
  writeJson(META_KEY, all);
}

export function enqueueScheduleDelivery(delivery: ScheduleDelivery): void {
  const list = readJson<ScheduleDelivery[]>(DELIVERY_KEY, []);
  list.push(delivery);
  writeJson(DELIVERY_KEY, list.slice(-40));
}

export function takeScheduleDeliveries(threadId?: string): ScheduleDelivery[] {
  const list = readJson<ScheduleDelivery[]>(DELIVERY_KEY, []);
  if (!threadId) {
    writeJson(DELIVERY_KEY, []);
    return list;
  }
  const mine = list.filter((item) => item.threadId === threadId);
  const rest = list.filter((item) => item.threadId !== threadId);
  writeJson(DELIVERY_KEY, rest);
  return mine;
}
