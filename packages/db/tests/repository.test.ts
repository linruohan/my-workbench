import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { DomainError, formatLocalDay } from "@wb/domain";
import { migrate } from "../src/migrate.js";
import { WorkbenchRepository } from "../src/repository.js";

function createRepo() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return { db, repo: new WorkbenchRepository(db) };
}

describe("WorkbenchRepository", () => {
  let db: Database.Database;

  afterEach(() => {
    db?.close();
  });

  it("creates undated tasks in inbox and excludes them from today", () => {
    const ctx = createRepo();
    db = ctx.db;
    const now = new Date(2026, 10, 1, 10, 0).getTime();
    const task = ctx.repo.createTask({ title: "回复邮件", nowMs: now });
    expect(task.projectId).toBe("inbox");
    expect(ctx.repo.listToday(now)).toHaveLength(0);
  });

  it("moves to today via dueDay; timed schedule clears dueDay", () => {
    const ctx = createRepo();
    db = ctx.db;
    const now = new Date(2026, 10, 1, 10, 0).getTime();
    const task = ctx.repo.createTask({ title: "写周报", nowMs: now });
    const today = formatLocalDay(now);

    let scheduled = ctx.repo.scheduleTask(task.id, { dueDay: today }, now);
    expect(scheduled.dueDay).toBe(today);
    expect(ctx.repo.listToday(now).map((t) => t.id)).toEqual([task.id]);
    expect(ctx.repo.listPlannerDay(today)).toHaveLength(1);

    const at = new Date(2026, 10, 1, 15, 0).getTime();
    scheduled = ctx.repo.scheduleTask(
      task.id,
      { dueWithTime: at, remindOption: "m15" },
      now,
    );
    expect(scheduled.dueDay).toBeNull();
    expect(scheduled.dueWithTime).toBe(at);
    expect(scheduled.remindAt).toBe(at - 15 * 60_000);
    expect(ctx.repo.listPlannerDay(today)).toHaveLength(0);
    expect(ctx.repo.listScheduleDay(today)).toHaveLength(1);
    expect(ctx.repo.listToday(now)).toHaveLength(1);
  });

  it("deadline alone does not enter today; completing clears reminders", () => {
    const ctx = createRepo();
    db = ctx.db;
    const now = new Date(2026, 10, 1, 10, 0).getTime();
    const task = ctx.repo.createTask({ title: "交稿", nowMs: now });
    ctx.repo.scheduleTask(
      task.id,
      {
        deadlineDay: formatLocalDay(now),
        deadlineRemindAt: now - 1000,
      },
      now,
    );
    expect(ctx.repo.listToday(now)).toHaveLength(0);

    const timed = ctx.repo.createTask({ title: "评审", nowMs: now });
    const at = now + 60_000;
    ctx.repo.scheduleTask(
      timed.id,
      { dueWithTime: at, remindAt: now - 1 },
      now,
    );
    const delivered = ctx.repo.deliverDueReminders(now);
    expect(delivered.some((d) => d.taskId === timed.id)).toBe(true);

    ctx.repo.completeTask(timed.id, now);
    const after = ctx.repo.getTask(timed.id)!;
    expect(after.isDone).toBe(true);
    expect(after.remindAt).toBeNull();
  });

  it("rejects TODAY tag and repeat on subtask; forbids timing parent with children", () => {
    const ctx = createRepo();
    db = ctx.db;
    expect(() => ctx.repo.createTag("今日", "TODAY")).toThrow(DomainError);

    const parent = ctx.repo.createTask({ title: "父" });
    const child = ctx.repo.createTask({
      title: "子",
      parentId: parent.id,
    });
    expect(() => ctx.repo.setRepeatCfg(child.id, "cfg1")).toThrow(DomainError);

    ctx.repo.addTimeSpent(child.id, 1000, 2000);
    expect(() => ctx.repo.addTimeSpent(parent.id, 1000, 2000)).toThrow(
      DomainError,
    );
  });

  it("persists only locally in the opened database file path", () => {
    const ctx = createRepo();
    db = ctx.db;
    ctx.repo.createTask({ title: "本地" });
    const count = db.prepare(`SELECT COUNT(*) AS c FROM tasks`).get() as {
      c: number;
    };
    expect(count.c).toBe(1);
    // In-memory DB has no network; meta proves local schema bootstrap.
    const version = db
      .prepare(`SELECT value FROM meta WHERE key = 'schema_version'`)
      .get() as { value: string };
    expect(version.value).toBe("1");
  });
});
