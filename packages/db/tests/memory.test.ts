import { describe, expect, it } from "vitest";
import { formatLocalDay } from "@wb/domain";
import { MemoryWorkbenchRepository } from "../src/memory-repository.js";

describe("MemoryWorkbenchRepository", () => {
  it("round-trips local snapshot without network", () => {
    const store = new MemoryWorkbenchRepository();
    const now = new Date(2026, 10, 1, 10, 0).getTime();
    const task = store.createTask({ title: "本地快照", nowMs: now });
    store.scheduleTask(task.id, { dueDay: formatLocalDay(now) }, now);
    const json = store.exportSnapshot();
    const restored = new MemoryWorkbenchRepository();
    restored.importSnapshot(json);
    expect(restored.listToday(now).map((t) => t.title)).toEqual(["本地快照"]);
  });
});
