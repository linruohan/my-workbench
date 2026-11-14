//! 工作台 SQLite 实体仓（增量持久化的宿主侧）。
//!
//! 前端内存仓储把变更汇成逐实体 upsert / delete（外加需整集合替换的 kind），
//! 通过 `wb_db_apply` 在一个事务里落到 `workbench.db`；启动时 `wb_db_open`
//! 打开数据库并回读全部行。实体以 (kind, id) 主键 + JSON 正文存储，加载顺序
//! 由 seq 列保证（如会话消息按创建时间）。

use rusqlite::params;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::{Arc, Mutex};

pub struct WorkbenchDb(Mutex<Option<Connection>>);

impl WorkbenchDb {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WbDbRow {
    pub kind: String,
    pub id: String,
    #[serde(default)]
    pub seq: i64,
    pub data: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WbDbKey {
    pub kind: String,
    pub id: String,
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct WbDbApply {
    #[serde(default)]
    pub upserts: Vec<WbDbRow>,
    #[serde(default)]
    pub deletes: Vec<WbDbKey>,
    /// 先清空再写入的 kind（小集合全量替换语义）。
    #[serde(default)]
    pub replaced: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct WbDbDump {
    pub rows: Vec<WbDbRow>,
}

pub const WB_DB_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS entities (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS entities_kind_seq ON entities(kind, seq);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"#;

/// 打开（或创建）数据库并确保 schema；同一时刻只保留一个连接。
pub fn open_conn(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|err| format!("无法创建数据目录：{err}"))?;
        }
    }
    let conn = Connection::open(path).map_err(|err| format!("无法打开 workbench.db：{err}"))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|err| format!("无法设置 WAL：{err}"))?;
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(|err| format!("无法设置 synchronous：{err}"))?;
    conn.execute_batch(WB_DB_SCHEMA_SQL)
        .map_err(|err| format!("无法初始化 schema：{err}"))?;
    Ok(conn)
}

/// 单事务应用增量变更：replaced 清空 → upsert → delete（显式删除最后生效）。
pub fn apply_changes(conn: &mut Connection, changes: &WbDbApply) -> Result<usize, String> {
    let tx = conn
        .transaction()
        .map_err(|err| format!("无法开启事务：{err}"))?;
    let mut applied = 0usize;
    for kind in &changes.replaced {
        tx.execute("DELETE FROM entities WHERE kind = ?1", params![kind])
            .map_err(|err| format!("无法清空集合 {kind}：{err}"))?;
    }
    for row in &changes.upserts {
        tx.execute(
            "INSERT INTO entities (kind, id, seq, data) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(kind, id) DO UPDATE SET seq = excluded.seq, data = excluded.data",
            params![row.kind, row.id, row.seq, row.data],
        )
        .map_err(|err| format!("无法写入实体 {}/{}：{err}", row.kind, row.id))?;
        applied += 1;
    }
    for key in &changes.deletes {
        tx.execute(
            "DELETE FROM entities WHERE kind = ?1 AND id = ?2",
            params![key.kind, key.id],
        )
        .map_err(|err| format!("无法删除实体 {}/{}：{err}", key.kind, key.id))?;
        applied += 1;
    }
    tx.commit().map_err(|err| format!("无法提交事务：{err}"))?;
    Ok(applied)
}

/// 回读全部实体行（seq 升序、id 升序，保证会话消息等顺序稳定）。
pub fn dump_conn(conn: &Connection) -> Result<WbDbDump, String> {
    let mut stmt = conn
        .prepare("SELECT kind, id, seq, data FROM entities ORDER BY kind ASC, seq ASC, id ASC")
        .map_err(|err| format!("无法读取实体：{err}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(WbDbRow {
                kind: row.get(0)?,
                id: row.get(1)?,
                seq: row.get(2)?,
                data: row.get(3)?,
            })
        })
        .map_err(|err| format!("无法读取实体：{err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("无法读取实体：{err}"))?;
    Ok(WbDbDump { rows })
}

#[tauri::command]
pub async fn wb_db_open(
    state: tauri::State<'_, Arc<WorkbenchDb>>,
    path: String,
) -> Result<WbDbDump, String> {
    let state = Arc::clone(&state);
    let dump = tauri::async_runtime::spawn_blocking(move || {
        let conn = open_conn(Path::new(&path))?;
        let dump = dump_conn(&conn)?;
        let mut guard = state.0.lock().expect("workbench db lock poisoned");
        *guard = Some(conn);
        Ok(dump)
    })
    .await
    .map_err(|err| format!("打开数据库任务失败：{err}"))?;
    dump
}

#[tauri::command]
pub async fn wb_db_apply(
    state: tauri::State<'_, Arc<WorkbenchDb>>,
    changes: WbDbApply,
) -> Result<usize, String> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = state.0.lock().expect("workbench db lock poisoned");
        let Some(conn) = guard.as_mut() else {
            return Err("数据库尚未打开".into());
        };
        apply_changes(conn, &changes)
    })
    .await
    .map_err(|err| format!("写库任务失败：{err}"))?
}

#[tauri::command]
pub async fn wb_db_close(state: tauri::State<'_, Arc<WorkbenchDb>>) -> Result<bool, String> {
    let mut guard = state.0.lock().expect("workbench db lock poisoned");
    Ok(guard.take().is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("wb-wbdb-test-{}-{}", tag, std::process::id()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        dir.join("workbench.db")
    }

    #[test]
    fn open_creates_schema_and_dumps_empty() {
        let path = temp_db("open");
        let _ = std::fs::remove_file(&path);
        let conn = open_conn(&path).expect("open");
        let dump = dump_conn(&conn).expect("dump");
        assert!(dump.rows.is_empty());
        // 重复打开（幂等 schema）
        drop(conn);
        let conn = open_conn(&path).expect("reopen");
        assert!(dump_conn(&conn).expect("dump").rows.is_empty());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn apply_upsert_delete_and_replace() {
        let path = temp_db("apply");
        let _ = std::fs::remove_file(&path);
        let mut conn = open_conn(&path).expect("open");

        let changes = WbDbApply {
            upserts: vec![
                WbDbRow {
                    kind: "task".into(),
                    id: "t1".into(),
                    seq: 0,
                    data: r#"{"id":"t1","title":"a"}"#.into(),
                },
                WbDbRow {
                    kind: "agent_message".into(),
                    id: "m2".into(),
                    seq: 20,
                    data: r#"{"id":"m2"}"#.into(),
                },
                WbDbRow {
                    kind: "agent_message".into(),
                    id: "m1".into(),
                    seq: 10,
                    data: r#"{"id":"m1"}"#.into(),
                },
            ],
            deletes: vec![],
            replaced: vec![],
        };
        assert_eq!(apply_changes(&mut conn, &changes).expect("apply"), 3);

        let dump = dump_conn(&conn).expect("dump");
        let messages: Vec<&WbDbRow> = dump
            .rows
            .iter()
            .filter(|row| row.kind == "agent_message")
            .collect();
        assert_eq!(
            messages.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            vec!["m1", "m2"],
            "ordered by seq"
        );

        // upsert 覆盖 + 删除
        let changes = WbDbApply {
            upserts: vec![WbDbRow {
                kind: "task".into(),
                id: "t1".into(),
                seq: 0,
                data: r#"{"id":"t1","title":"b"}"#.into(),
            }],
            deletes: vec![WbDbKey {
                kind: "agent_message".into(),
                id: "m1".into(),
            }],
            replaced: vec![],
        };
        assert_eq!(apply_changes(&mut conn, &changes).expect("apply2"), 2);
        let dump = dump_conn(&conn).expect("dump2");
        let task = dump
            .rows
            .iter()
            .find(|row| row.kind == "task" && row.id == "t1")
            .expect("task row");
        assert!(task.data.contains("\"b\""));
        assert!(!dump.rows.iter().any(|row| row.id == "m1"));

        // replaced：整集合清空后写入
        let changes = WbDbApply {
            upserts: vec![WbDbRow {
                kind: "tag".into(),
                id: "tag2".into(),
                seq: 0,
                data: r#"{"id":"tag2"}"#.into(),
            }],
            deletes: vec![],
            replaced: vec!["tag".into()],
        };
        apply_changes(&mut conn, &changes).expect("apply3");
        let dump = dump_conn(&conn).expect("dump3");
        let tags: Vec<&WbDbRow> = dump
            .rows
            .iter()
            .filter(|row| row.kind == "tag")
            .collect();
        assert_eq!(tags.len(), 1, "replace clears previous rows");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
