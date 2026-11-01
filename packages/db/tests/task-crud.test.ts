import { describe, expect, it } from "vitest";
import { MemoryWorkbenchRepository } from "../src/memory-repository.js";

describe("task CRUD on memory repository", () => {
  it("updates deletes and moves buckets", () => {
    const store = new MemoryWorkbenchRepository();
    const task = store.createTask({ title: "草稿", nowMs: 1000 });
    expect(store.getTaskBucket(task.id)).toBe("active");

    store.updateTask(task.id, { title: "定稿", notes: "细节" }, 2000);
    expect(store.getTask(task.id)?.title).toBe("定稿");
    expect(store.getTask(task.id)?.notes).toBe("细节");

    store.moveToBacklog(task.id, 3000);
    expect(store.getTaskBucket(task.id)).toBe("backlog");
    expect(store.getTask(task.id)?.dueDay).toBeNull();

    store.moveToActive(task.id, 4000);
    expect(store.getTaskBucket(task.id)).toBe("active");

    store.completeTask(task.id, 5000);
    expect(store.getTask(task.id)?.isDone).toBe(true);
    store.uncompleteTask(task.id, 6000);
    expect(store.getTask(task.id)?.isDone).toBe(false);

    store.deleteTask(task.id);
    expect(store.getTask(task.id)).toBeNull();
  });
});
