use crate::paths::{prefs_path, store_path, theme_path};
use crate::repository::MemoryWorkbenchRepository;
use crate::snapshot::WorkbenchSnapshot;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use wb_domain::{AppPrefs, ThemeModePref};

fn prefs_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

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
    let _guard = prefs_lock().lock().unwrap_or_else(|e| e.into_inner());
    load_prefs_unlocked()
}

pub fn save_prefs(prefs: &AppPrefs) -> Result<()> {
    let _guard = prefs_lock().lock().unwrap_or_else(|e| e.into_inner());
    save_prefs_unlocked(prefs)
}

/// Read-modify-write under the prefs lock so concurrent tools/tests don't clobber each other.
pub fn update_prefs<F, T>(f: F) -> Result<T>
where
    F: FnOnce(&mut AppPrefs) -> Result<T>,
{
    let _guard = prefs_lock().lock().unwrap_or_else(|e| e.into_inner());
    let mut prefs = load_prefs_unlocked()?;
    let out = f(&mut prefs)?;
    save_prefs_unlocked(&prefs)?;
    Ok(out)
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct ThemeFile {
    /// `"light"` | `"dark"` — 与旧 Tauri `theme.json` 对齐
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    theme: Option<String>,
}

fn parse_theme_mode(raw: &str) -> Option<ThemeModePref> {
    ThemeModePref::parse(raw)
}

fn load_theme_file_mode() -> Option<ThemeModePref> {
    let path = theme_path().ok()?;
    if !path.is_file() {
        return None;
    }
    let text = fs::read_to_string(&path).ok()?;
    let file: ThemeFile = serde_json::from_str(&text).ok()?;
    file.mode
        .as_deref()
        .or(file.theme.as_deref())
        .and_then(parse_theme_mode)
}

fn save_theme_file(mode: ThemeModePref) -> Result<()> {
    let path = theme_path()?;
    let mode = match mode {
        ThemeModePref::Dark => "dark",
        ThemeModePref::Light => "light",
        ThemeModePref::System => "system",
    };
    let json = serde_json::to_string_pretty(&ThemeFile {
        mode: Some(mode.into()),
        theme: None,
    })?;
    write_text_atomic(&path, &json)
}

fn load_prefs_unlocked() -> Result<AppPrefs> {
    let path = prefs_path()?;
    let prefs_existed = path.is_file();
    let mut prefs = if !prefs_existed {
        AppPrefs::default()
    } else {
        let text = fs::read_to_string(&path)?;
        if text.trim().is_empty() {
            AppPrefs::default()
        } else {
            serde_json::from_str(&text).unwrap_or_default()
        }
    };
    // 仅在尚无 prefs.json 时用 theme.json 补齐（兼容旧 Tauri 数据）
    if !prefs_existed && let Some(mode) = load_theme_file_mode() {
        prefs.theme_mode = mode;
    }
    Ok(prefs)
}

fn save_prefs_unlocked(prefs: &AppPrefs) -> Result<()> {
    let path = prefs_path()?;
    let json = serde_json::to_string_pretty(prefs)?;
    write_text_atomic(&path, &json)?;
    let _ = save_theme_file(prefs.theme_mode);
    Ok(())
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
    fn theme_file_parses_mode_and_theme_alias() {
        let a: ThemeFile = serde_json::from_str(r#"{"mode":"dark"}"#).unwrap();
        assert_eq!(
            parse_theme_mode(a.mode.as_deref().unwrap()),
            Some(ThemeModePref::Dark)
        );
        let b: ThemeFile = serde_json::from_str(r#"{"theme":"Light"}"#).unwrap();
        assert_eq!(
            parse_theme_mode(b.theme.as_deref().unwrap()),
            Some(ThemeModePref::Light)
        );
        assert_eq!(parse_theme_mode("system"), Some(ThemeModePref::System));
    }

    #[test]
    fn data_dir_resolves() {
        let _ = ensure_data_dir();
    }
}
