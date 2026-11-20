use crate::paths::{prefs_path, store_path};
use crate::repository::MemoryWorkbenchRepository;
use crate::snapshot::WorkbenchSnapshot;
use anyhow::{Context, Result};
use std::fs;
use std::path::{Path, PathBuf};
use wb_domain::AppPrefs;

pub const SAVE_DEBOUNCE_MS: u64 = 400;
pub const MAX_ROLLING_BACKUPS: usize = 7;

#[derive(Debug, Clone)]
pub struct SaveStatus {
    pub ok: bool,
    pub message: Option<String>,
    pub at: i64,
    pub bytes: Option<usize>,
    pub warning: Option<String>,
}

impl Default for SaveStatus {
    fn default() -> Self {
        Self {
            ok: true,
            message: None,
            at: 0,
            bytes: None,
            warning: None,
        }
    }
}

pub fn load_store() -> Result<MemoryWorkbenchRepository> {
    let path = store_path()?;
    let mut repo = MemoryWorkbenchRepository::new();
    if path.exists() {
        let text = fs::read_to_string(&path)
            .with_context(|| format!("读取快照失败: {}", path.display()))?;
        if !text.trim().is_empty() {
            let snap: WorkbenchSnapshot =
                serde_json::from_str(&text).context("解析 workbench.json 失败")?;
            repo.import_snapshot(snap);
        }
    }
    Ok(repo)
}

pub fn save_store(repo: &mut MemoryWorkbenchRepository) -> Result<SaveStatus> {
    let path = store_path()?;
    maybe_rolling_backup(&path)?;
    let snap = repo.export_snapshot();
    let json = serde_json::to_string_pretty(&snap).context("序列化快照失败")?;
    let bytes = json.len();
    write_text_atomic(&path, &json)?;
    repo.clear_dirty();
    let warning = if bytes > 6 * 1024 * 1024 {
        Some("快照体积偏大，建议整理历史会话或附件".into())
    } else {
        None
    };
    Ok(SaveStatus {
        ok: true,
        message: None,
        at: wb_domain::now_ms(),
        bytes: Some(bytes),
        warning,
    })
}

pub fn load_prefs() -> Result<AppPrefs> {
    let path = prefs_path()?;
    if !path.exists() {
        return Ok(AppPrefs::default());
    }
    let text = fs::read_to_string(&path)?;
    if text.trim().is_empty() {
        return Ok(AppPrefs::default());
    }
    Ok(serde_json::from_str(&text).unwrap_or_default())
}

pub fn save_prefs(prefs: &AppPrefs) -> Result<()> {
    let path = prefs_path()?;
    let json = serde_json::to_string_pretty(prefs)?;
    write_text_atomic(&path, &json)
}

fn write_text_atomic(path: &Path, contents: &str) -> Result<()> {
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, contents).with_context(|| format!("写入临时文件失败: {}", tmp.display()))?;
    if path.exists() {
        let _ = fs::remove_file(path);
    }
    fs::rename(&tmp, path).or_else(|_| {
        fs::write(path, contents)?;
        let _ = fs::remove_file(&tmp);
        Ok(())
    })
}

fn maybe_rolling_backup(path: &Path) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let stamp = wb_domain::format_local_day(wb_domain::now_ms());
    let backup = dir.join(format!("workbench.bak.{stamp}.json"));
    if backup.exists() {
        return Ok(());
    }
    fs::copy(path, &backup)?;
    prune_backups(dir)?;
    Ok(())
}

fn prune_backups(dir: &Path) -> Result<()> {
    let mut backups: Vec<PathBuf> = fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("workbench.bak.") && n.ends_with(".json"))
                .unwrap_or(false)
        })
        .collect();
    backups.sort();
    while backups.len() > MAX_ROLLING_BACKUPS {
        if let Some(old) = backups.first().cloned() {
            let _ = fs::remove_file(&old);
            backups.remove(0);
        } else {
            break;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::ensure_data_dir;

    #[test]
    fn prefs_default_round_trip_in_memory() {
        let p = AppPrefs::default();
        let json = serde_json::to_string(&p).unwrap();
        let q: AppPrefs = serde_json::from_str(&json).unwrap();
        assert_eq!(p.sidebar_width, q.sidebar_width);
    }

    #[test]
    fn data_dir_resolves() {
        let _ = ensure_data_dir();
    }
}
