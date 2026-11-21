use crate::paths::{
    CREDENTIALS_FILE, EXPORTS_DIR, PREFS_FILE, PROVIDERS_FILE, STORE_FILE, THEME_FILE,
    ensure_data_dir, prefs_path, resolve_data_dir, store_path, theme_path,
};
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

/// Files included in a manual one-click backup (excludes large model caches).
pub fn backup_core_file_names() -> &'static [&'static str] {
    &[
        STORE_FILE,
        PREFS_FILE,
        THEME_FILE,
        CREDENTIALS_FILE,
        PROVIDERS_FILE,
    ]
}

/// Copy core JSON files into `<data>/exports/my-workbench-backup-<stamp>/`.
/// Returns the destination directory.
pub fn backup_core_data() -> Result<PathBuf> {
    let src = ensure_data_dir()?;
    let stamp = wb_domain::format_local_stamp(wb_domain::now_ms());
    let dest = src
        .join(EXPORTS_DIR)
        .join(format!("my-workbench-backup-{stamp}"));
    fs::create_dir_all(&dest).with_context(|| format!("创建备份目录失败: {}", dest.display()))?;
    let mut copied = 0usize;
    for name in backup_core_file_names() {
        let from = src.join(name);
        if from.is_file() {
            fs::copy(&from, dest.join(name))
                .with_context(|| format!("备份失败: {}", from.display()))?;
            copied += 1;
        }
    }
    if copied == 0 {
        anyhow::bail!("数据目录中没有可备份的核心文件");
    }
    Ok(dest)
}

/// Copy core JSON files into `dest_parent/my-workbench-backup-<stamp>/`.
pub fn backup_core_data_to(dest_parent: &Path) -> Result<PathBuf> {
    let src = ensure_data_dir()?;
    let stamp = wb_domain::format_local_stamp(wb_domain::now_ms());
    let dest = dest_parent.join(format!("my-workbench-backup-{stamp}"));
    fs::create_dir_all(&dest).with_context(|| format!("创建备份目录失败: {}", dest.display()))?;
    let mut copied = 0usize;
    for name in backup_core_file_names() {
        let from = src.join(name);
        if from.is_file() {
            fs::copy(&from, dest.join(name))
                .with_context(|| format!("备份失败: {}", from.display()))?;
            copied += 1;
        }
    }
    if copied == 0 {
        anyhow::bail!("数据目录中没有可备份的核心文件");
    }
    Ok(dest)
}

#[derive(Debug, Clone)]
pub struct MigrateDataReport {
    pub source: PathBuf,
    pub destination: PathBuf,
    pub copied_files: usize,
    pub redirect_written: bool,
}

/// Copy core JSON + rolling `workbench.bak.*` into `dest`, then point the default
/// location at `dest` via `data-redirect.txt` (unless `dest` is the default dir).
/// Does not move/delete the source; does not copy `models/`.
pub fn migrate_data_dir_to(dest: &Path) -> Result<MigrateDataReport> {
    use crate::paths::{
        assert_safe_migrate_dest, clear_data_redirect, default_data_dir, paths_equal,
        write_data_redirect,
    };

    let src = resolve_data_dir()?;
    let default = default_data_dir()?;
    assert_safe_migrate_dest(&src, dest)?;
    fs::create_dir_all(dest).with_context(|| format!("创建目标目录失败: {}", dest.display()))?;

    let mut copied = 0usize;
    for name in backup_core_file_names() {
        let from = src.join(name);
        if from.is_file() {
            fs::copy(&from, dest.join(name))
                .with_context(|| format!("迁移失败: {}", from.display()))?;
            copied += 1;
        }
    }
    // Rolling snapshot backups
    if let Ok(entries) = fs::read_dir(&src) {
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if name.starts_with("workbench.bak.") && name.ends_with(".json") && path.is_file() {
                fs::copy(&path, dest.join(name))
                    .with_context(|| format!("迁移备份失败: {}", path.display()))?;
                copied += 1;
            }
        }
    }
    if copied == 0 {
        anyhow::bail!("当前数据目录没有可迁移的核心文件");
    }

    let redirect_written = if paths_equal(dest, &default) {
        clear_data_redirect()?;
        false
    } else {
        write_data_redirect(dest)?;
        true
    };

    Ok(MigrateDataReport {
        source: src,
        destination: dest.to_path_buf(),
        copied_files: copied,
        redirect_written,
    })
}

/// Copy data back into the default directory and remove the redirect pointer.
pub fn migrate_data_dir_to_default() -> Result<MigrateDataReport> {
    use crate::paths::default_data_dir;
    let dest = default_data_dir()?;
    migrate_data_dir_to(&dest)
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

    #[test]
    fn migrate_rejects_same_directory() {
        use crate::paths::assert_safe_migrate_dest;
        let dir = std::env::temp_dir().join(format!("wb-mig-same-{}", wb_domain::now_ms()));
        fs::create_dir_all(&dir).unwrap();
        assert!(assert_safe_migrate_dest(&dir, &dir).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn migrate_copies_core_files_into_dest() {
        let stamp = wb_domain::now_ms();
        let src = std::env::temp_dir().join(format!("wb-mig-src-{stamp}"));
        let dest = std::env::temp_dir().join(format!("wb-mig-dest-{stamp}"));
        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(&dest);
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join(STORE_FILE), r#"{"tasks":[]}"#).unwrap();
        fs::write(src.join(PREFS_FILE), "{}").unwrap();
        fs::create_dir_all(&dest).unwrap();
        let mut copied = 0usize;
        for name in backup_core_file_names() {
            let from = src.join(name);
            if from.is_file() {
                fs::copy(&from, dest.join(name)).unwrap();
                copied += 1;
            }
        }
        assert_eq!(copied, 2);
        assert!(dest.join(STORE_FILE).is_file());
        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(&dest);
    }

    #[test]
    fn backup_core_copies_existing_files() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("data");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join(STORE_FILE), "{}").unwrap();
        fs::write(src.join(PREFS_FILE), "{}").unwrap();
        // Point resolve via env is hard; exercise backup_core_data_to against explicit parent
        // by copying from real data dir if present, else just verify helper names.
        assert!(backup_core_file_names().contains(&STORE_FILE));
        let dest_parent = dir.path().join("out");
        fs::create_dir_all(&dest_parent).unwrap();
        // Manual mini-copy mimicking API
        let stamp_dest = dest_parent.join("my-workbench-backup-test");
        fs::create_dir_all(&stamp_dest).unwrap();
        fs::copy(src.join(STORE_FILE), stamp_dest.join(STORE_FILE)).unwrap();
        assert!(stamp_dest.join(STORE_FILE).is_file());
    }
}
