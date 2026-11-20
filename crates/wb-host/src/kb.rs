use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use walkdir::WalkDir;
use wb_domain::is_kb_extension;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KbEntry {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub relative: String,
}

pub fn pick_directory() -> Option<PathBuf> {
    rfd::FileDialog::new().pick_folder()
}

pub fn pick_file() -> Option<PathBuf> {
    rfd::FileDialog::new().pick_file()
}

pub fn list_dir(path: &Path) -> Result<Vec<KbEntry>> {
    let mut out = Vec::new();
    for entry in fs::read_dir(path).with_context(|| format!("读取目录失败: {}", path.display()))?
    {
        let entry = entry?;
        let meta = entry.metadata()?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        out.push(KbEntry {
            path: entry.path().to_string_lossy().to_string(),
            name,
            is_dir: meta.is_dir(),
            relative: entry
                .path()
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default(),
        });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(out)
}

pub fn read_text(path: &Path) -> Result<String> {
    fs::read_to_string(path).with_context(|| format!("读取失败: {}", path.display()))
}

pub fn write_text(path: &Path, contents: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, contents).with_context(|| format!("写入失败: {}", path.display()))
}

pub fn read_base64(path: &Path) -> Result<String> {
    let bytes = fs::read(path)?;
    Ok(B64.encode(bytes))
}

pub fn write_base64(path: &Path, b64: &str) -> Result<()> {
    let bytes = B64.decode(b64).context("base64 解码失败")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, bytes)?;
    Ok(())
}

pub fn exists(path: &Path) -> bool {
    path.exists()
}

pub fn mkdir(path: &Path) -> Result<()> {
    fs::create_dir_all(path)?;
    Ok(())
}

pub fn remove_path(path: &Path) -> Result<()> {
    if path.is_dir() {
        fs::remove_dir_all(path)?;
    } else if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

pub fn rename_path(from: &Path, to: &Path) -> Result<()> {
    fs::rename(from, to)?;
    Ok(())
}

pub fn reveal_in_explorer(path: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        Command::new("explorer")
            .arg(if path.is_dir() {
                path.as_os_str().to_owned()
            } else {
                // /select,path
                let arg = format!("/select,{}", path.display());
                std::ffi::OsString::from(arg)
            })
            .spawn()?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        bail!("当前平台未实现 reveal_in_explorer");
    }
}

pub fn git_branch(root: &Path) -> Option<String> {
    let out = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(root)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

pub fn list_files_recursive(root: &Path, max: usize) -> Result<Vec<KbEntry>> {
    let mut out = Vec::new();
    for entry in WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
        if out.len() >= max {
            break;
        }
        let path = entry.path();
        if path == root {
            continue;
        }
        let meta = entry.metadata()?;
        if meta.is_dir() {
            continue;
        }
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if !is_kb_extension(ext) {
            continue;
        }
        let name = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let relative = path
            .strip_prefix(root)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| name.clone());
        out.push(KbEntry {
            path: path.to_string_lossy().to_string(),
            name,
            is_dir: false,
            relative,
        });
    }
    Ok(out)
}

pub fn create_markdown(dir: &Path, name: &str) -> Result<PathBuf> {
    let file = if name.ends_with(".md") {
        dir.join(name)
    } else {
        dir.join(format!("{name}.md"))
    };
    if file.exists() {
        bail!("文件已存在: {}", file.display());
    }
    write_text(&file, "# \n")?;
    Ok(file)
}
