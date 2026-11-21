use anyhow::{Context, Result, bail};
use std::fs;
use std::path::{Path, PathBuf};

pub const APP_DATA_DIR_NAME: &str = "my-workbench";
pub const STORE_FILE: &str = "workbench.json";
pub const PREFS_FILE: &str = "prefs.json";
pub const THEME_FILE: &str = "theme.json";
pub const CREDENTIALS_FILE: &str = "credentials.json";
pub const PROVIDERS_FILE: &str = "providers.json";
/// Manual backups live under `<data>/exports/`.
pub const EXPORTS_DIR: &str = "exports";
/// Written under the *default* data dir to point at a custom location.
pub const DATA_REDIRECT_FILE: &str = "data-redirect.txt";
/// Optional process override: `WB_DATA_DIR=/path/to/dir`
pub const DATA_DIR_ENV: &str = "WB_DATA_DIR";

/// OS default: `%APPDATA%/my-workbench` (or platform equivalent). Never follows redirect.
pub fn default_data_dir() -> Result<PathBuf> {
    let base = dirs::data_dir().context("无法解析系统数据目录")?;
    Ok(base.join(APP_DATA_DIR_NAME))
}

fn read_redirect_target(default_dir: &Path) -> Option<PathBuf> {
    let redirect = default_dir.join(DATA_REDIRECT_FILE);
    if !redirect.is_file() {
        return None;
    }
    let text = fs::read_to_string(&redirect).ok()?;
    let target = PathBuf::from(text.trim());
    if target.as_os_str().is_empty() {
        return None;
    }
    Some(target)
}

/// Effective data directory: `WB_DATA_DIR` → redirect file → default.
pub fn resolve_data_dir() -> Result<PathBuf> {
    if let Ok(raw) = std::env::var(DATA_DIR_ENV) {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }
    let default = default_data_dir()?;
    if let Some(target) = read_redirect_target(&default) {
        return Ok(target);
    }
    Ok(default)
}

pub fn ensure_data_dir() -> Result<PathBuf> {
    let dir = resolve_data_dir()?;
    fs::create_dir_all(&dir).with_context(|| format!("创建数据目录失败: {}", dir.display()))?;
    Ok(dir)
}

pub fn data_file_path(file_name: &str) -> Result<PathBuf> {
    Ok(ensure_data_dir()?.join(file_name))
}

pub fn store_path() -> Result<PathBuf> {
    data_file_path(STORE_FILE)
}

pub fn prefs_path() -> Result<PathBuf> {
    data_file_path(PREFS_FILE)
}

pub fn theme_path() -> Result<PathBuf> {
    data_file_path(THEME_FILE)
}

/// Whether a custom location is active (env or redirect), and the default path.
pub fn data_dir_status() -> Result<DataDirStatus> {
    let default = default_data_dir()?;
    let current = resolve_data_dir()?;
    let via_env = std::env::var(DATA_DIR_ENV)
        .ok()
        .filter(|s| !s.trim().is_empty())
        .is_some();
    let via_redirect = read_redirect_target(&default).is_some();
    Ok(DataDirStatus {
        current,
        default,
        via_env,
        via_redirect,
    })
}

#[derive(Debug, Clone)]
pub struct DataDirStatus {
    pub current: PathBuf,
    pub default: PathBuf,
    pub via_env: bool,
    pub via_redirect: bool,
}

impl DataDirStatus {
    pub fn is_custom(&self) -> bool {
        self.via_env || self.via_redirect || self.current != self.default
    }
}

/// Write / clear the redirect file under the default data directory.
pub fn write_data_redirect(target: &Path) -> Result<()> {
    let default = default_data_dir()?;
    fs::create_dir_all(&default)
        .with_context(|| format!("创建默认数据目录失败: {}", default.display()))?;
    let redirect = default.join(DATA_REDIRECT_FILE);
    let text = format!("{}\n", target.to_string_lossy().trim());
    let tmp = redirect.with_extension("txt.tmp");
    fs::write(&tmp, &text).with_context(|| format!("写入重定向临时文件失败: {}", tmp.display()))?;
    if redirect.exists() {
        let _ = fs::remove_file(&redirect);
    }
    if fs::rename(&tmp, &redirect).is_err() {
        fs::write(&redirect, &text)
            .with_context(|| format!("写入重定向失败: {}", redirect.display()))?;
        let _ = fs::remove_file(&tmp);
    }
    Ok(())
}

pub fn clear_data_redirect() -> Result<()> {
    let default = default_data_dir()?;
    let redirect = default.join(DATA_REDIRECT_FILE);
    if redirect.is_file() {
        fs::remove_file(&redirect)
            .with_context(|| format!("删除重定向失败: {}", redirect.display()))?;
    }
    Ok(())
}

pub fn paths_equal(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(ca), Ok(cb)) => ca == cb,
        _ => a == b,
    }
}

pub fn assert_safe_migrate_dest(src: &Path, dest: &Path) -> Result<()> {
    if paths_equal(src, dest) {
        bail!("目标目录与当前数据目录相同");
    }
    if let (Ok(cs), Ok(cd)) = (fs::canonicalize(src), fs::canonicalize(dest)) {
        if cd.starts_with(&cs) {
            bail!("不能迁移到当前数据目录的子目录");
        }
        if cs.starts_with(&cd) && cs != cd {
            // dest is ancestor of src — usually ok if empty-ish, but risky
            bail!("目标目录是当前数据目录的上级，请选独立文件夹");
        }
    }
    Ok(())
}
