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

  it("duplicates tasks and manages one-level subtasks", () => {
    const store = new MemoryWorkbenchRepository();
    const parent = store.createTask({ title: "父任务", nowMs: 1000 });
    store.updateTask(parent.id, { timeEstimate: 25 * 60_000 }, 1100);
    const copy = store.duplicateTask(parent.id, 1200);
    expect(copy.title).toBe("父任务（副本）");
    expect(copy.timeEstimate).toBe(25 * 60_000);

    const child = store.createTask({
      title: "子项",
      parentId: parent.id,
      nowMs: 1300,
    });
    expect(store.listSubtasks(parent.id).map((t) => t.id)).toEqual([child.id]);
    store.setTaskParent(child.id, null, 1400);
    expect(store.listSubtasks(parent.id)).toEqual([]);
  });
});
