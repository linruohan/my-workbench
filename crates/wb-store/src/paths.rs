use anyhow::{Context, Result};
use std::fs;
use std::path::PathBuf;

pub const APP_DATA_DIR_NAME: &str = "my-workbench";
pub const STORE_FILE: &str = "workbench.json";
pub const PREFS_FILE: &str = "prefs.json";
pub const THEME_FILE: &str = "theme.json";
pub const CREDENTIALS_FILE: &str = "credentials.json";
pub const PROVIDERS_FILE: &str = "providers.json";
/// Manual backups live under `<data>/exports/`.
pub const EXPORTS_DIR: &str = "exports";

pub fn resolve_data_dir() -> Result<PathBuf> {
    let base = dirs::data_dir().context("无法解析系统数据目录")?;
    Ok(base.join(APP_DATA_DIR_NAME))
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
