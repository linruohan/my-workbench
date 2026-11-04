import type Database from "better-sqlite3";
import { INBOX_PROJECT_ID } from "@wb/domain";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";

export function migrate(db: Database.Database): void {
  db.exec(SCHEMA_SQL);

  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    { value: string } | undefined;

  const threadColumns = db.prepare(`PRAGMA table_info(agent_threads)`).all() as Array<{
    name: string;
  }>;
  if (!threadColumns.some((column) => column.name === "web_url")) {
    db.exec(`ALTER TABLE agent_threads ADD COLUMN web_url TEXT`);
  }
  if (!threadColumns.some((column) => column.name === "pinned_at")) {
    db.exec(`ALTER TABLE agent_threads ADD COLUMN pinned_at INTEGER`);
  }

  if (!row) {
    const now = Date.now();
    db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`).run(
      SCHEMA_VERSION,
    );
    db.prepare(
      `INSERT INTO projects (id, title, is_archived, is_done, done_on, created_at, updated_at)
       VALUES (?, '收件箱', 0, 0, NULL, ?, ?)`,
    ).run(INBOX_PROJECT_ID, now, now);
  }
}

export function openMigratedDatabase(
  DatabaseCtor: typeof import("better-sqlite3"),
  path: string,
): Database.Database {
  const db = new DatabaseCtor(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}
