export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  is_archived INTEGER NOT NULL DEFAULT 0,
  is_done INTEGER NOT NULL DEFAULT 0,
  done_on INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  parent_id TEXT REFERENCES tasks(id),
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  is_done INTEGER NOT NULL DEFAULT 0,
  done_on INTEGER,
  due_day TEXT,
  due_with_time INTEGER,
  deadline_day TEXT,
  deadline_with_time INTEGER,
  remind_at INTEGER,
  deadline_remind_at INTEGER,
  time_estimate INTEGER NOT NULL DEFAULT 0,
  time_spent INTEGER NOT NULL DEFAULT 0,
  time_spent_on_day TEXT NOT NULL DEFAULT '{}',
  repeat_cfg_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (due_day IS NULL OR due_with_time IS NULL),
  CHECK (deadline_day IS NULL OR deadline_with_time IS NULL),
  CHECK (parent_id IS NULL OR repeat_cfg_id IS NULL)
);

CREATE TABLE IF NOT EXISTS project_tasks (
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  bucket TEXT NOT NULL CHECK (bucket IN ('active', 'backlog')),
  position INTEGER NOT NULL,
  PRIMARY KEY (project_id, task_id)
);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  color TEXT,
  CHECK (upper(id) != 'TODAY')
);

CREATE TABLE IF NOT EXISTS task_tags (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (task_id, tag_id),
  CHECK (upper(tag_id) != 'TODAY')
);

CREATE TABLE IF NOT EXISTS today_order (
  task_id TEXT PRIMARY KEY NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  position INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  remind_at INTEGER,
  notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  ref_type TEXT,
  ref_id TEXT,
  fire_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  snooze_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT REFERENCES projects(id),
  title TEXT NOT NULL,
  body_md TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_due_day ON tasks(due_day);
CREATE INDEX IF NOT EXISTS idx_tasks_due_with_time ON tasks(due_with_time);
CREATE INDEX IF NOT EXISTS idx_tasks_remind_at ON tasks(remind_at);
CREATE INDEX IF NOT EXISTS idx_notifications_fire ON notifications(fire_at, status);
`;

export const SCHEMA_VERSION = "1";
