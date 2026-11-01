import { formatLocalDay } from "@wb/domain";
import type { MemoryWorkbenchRepository } from "@wb/db/memory";

export function seedDemo(store: MemoryWorkbenchRepository, nowMs: number) {
  const t = store.createTask({ title: "演示任务", nowMs });
  store.scheduleTask(t.id, { dueDay: formatLocalDay(nowMs) }, nowMs);
  return t;
}
