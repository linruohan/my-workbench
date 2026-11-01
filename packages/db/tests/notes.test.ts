import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.js";
import { MemoryWorkbenchRepository } from "../src/memory-repository.js";
import { WorkbenchRepository } from "../src/repository.js";

describe("notes repository", () => {
  let db: Database.Database;

  afterEach(() => {
    db?.close();
  });

  it("persists notes in sqlite", () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);
    const repo = new WorkbenchRepository(db);
    const note = repo.createNote({
      title: "架构",
      bodyMd: "# 架构\n本地优先",
      nowMs: 1000,
    });
    expect(repo.listNotes()).toHaveLength(1);
    const updated = repo.updateNote(note.id, { bodyMd: "更新正文" }, 2000);
    expect(updated.bodyMd).toBe("更新正文");
    expect(repo.getNote(note.id)?.updatedAt).toBe(2000);
    repo.deleteNote(note.id);
    expect(repo.listNotes()).toHaveLength(0);
  });

  it("round-trips notes in memory snapshot", () => {
    const store = new MemoryWorkbenchRepository();
    store.createNote({ title: "A", bodyMd: "hello", nowMs: 1 });
    const json = store.exportSnapshot();
    const restored = new MemoryWorkbenchRepository();
    restored.importSnapshot(json);
    expect(restored.listNotes()[0]?.title).toBe("A");
  });
});
