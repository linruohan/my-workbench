use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::Serialize;
use std::fs;
use std::path::Path;

const MAX_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbEntry {
    name: String,
    path: String,
    is_dir: bool,
    /// Modified time in milliseconds since Unix epoch (best-effort).
    mtime_ms: Option<u64>,
}

#[tauri::command]
pub fn kb_pick_directory(title: Option<String>) -> Option<String> {
    rfd::FileDialog::new()
        .set_title(title.unwrap_or_else(|| "选择文件夹".into()))
        .pick_folder()
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn kb_list_dir(path: String) -> Result<Vec<KbEntry>, String> {
    let mut out = Vec::new();
    let entries = fs::read_dir(&path).map_err(|err| format!("无法读取目录：{err}"))?;
    for entry in entries {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        if should_skip_entry(&name) {
            continue;
        }
        let file_path = entry.path();
        let is_dir = file_path.is_dir();
        let mtime_ms = entry
            .metadata()
            .ok()
            .and_then(|meta| meta.modified().ok())
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|dur| dur.as_millis() as u64);
        out.push(KbEntry {
            name,
            path: file_path.to_string_lossy().into_owned(),
            is_dir,
            mtime_ms,
        });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

/// Reveal a file or folder in the OS file manager.
#[tauri::command]
pub fn kb_reveal_in_explorer(path: String) -> Result<(), String> {
    let target = Path::new(&path);
    if !target.exists() {
        return Err("路径不存在".into());
    }
    #[cfg(target_os = "windows")]
    {
        let mut cmd = std::process::Command::new("explorer");
        if target.is_dir() {
            cmd.arg(target);
        } else {
            cmd.arg(format!("/select,{}", target.to_string_lossy()));
        }
        cmd.spawn()
            .map_err(|err| format!("无法打开资源管理器：{err}"))?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|err| format!("无法在访达中显示：{err}"))?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let folder = if target.is_dir() {
            target.to_path_buf()
        } else {
            target
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| target.to_path_buf())
        };
        std::process::Command::new("xdg-open")
            .arg(folder)
            .spawn()
            .map_err(|err| format!("无法打开文件管理器：{err}"))?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err("当前平台不支持在资源管理器中显示".into())
}

#[tauri::command]
pub fn kb_read_text(path: String) -> Result<String, String> {
    let bytes = read_limited(&path)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[tauri::command]
pub fn kb_write_text(path: String, contents: String) -> Result<(), String> {
    if contents.len() as u64 > MAX_BYTES {
        return Err("文件过大".into());
    }
    fs::write(&path, contents).map_err(|err| format!("无法写入文件：{err}"))
}

#[tauri::command]
pub fn kb_read_base64(path: String) -> Result<String, String> {
    let bytes = read_limited(&path)?;
    Ok(STANDARD.encode(bytes))
}

#[tauri::command]
pub fn kb_write_base64(path: String, data: String) -> Result<(), String> {
    let bytes = STANDARD
        .decode(data.trim().as_bytes())
        .map_err(|err| format!("图片数据无效：{err}"))?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("图片过大".into());
    }
    if let Some(parent) = Path::new(&path).parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|err| format!("无法创建目录：{err}"))?;
        }
    }
    fs::write(&path, bytes).map_err(|err| format!("无法保存图片：{err}"))
}

#[tauri::command]
pub fn kb_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[tauri::command]
pub fn kb_mkdir(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|err| format!("无法创建目录：{err}"))
}

#[tauri::command]
pub fn kb_rename(from: String, to: String) -> Result<(), String> {
    let src = Path::new(&from);
    let dest = Path::new(&to);
    if !src.exists() {
        return Err("源文件不存在".into());
    }
    if src == dest {
        return Ok(());
    }
    if dest.exists() {
        return Err("目标文件已存在".into());
    }
    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            fs::create_dir_all(parent).map_err(|err| format!("无法创建目录：{err}"))?;
        }
    }
    fs::rename(src, dest).map_err(|err| format!("无法重命名：{err}"))
}

fn read_limited(path: &str) -> Result<Vec<u8>, String> {
    let meta = fs::metadata(path).map_err(|err| format!("无法读取文件：{err}"))?;
    if meta.len() > MAX_BYTES {
        return Err("文件过大".into());
    }
    fs::read(path).map_err(|err| format!("无法读取文件：{err}"))
}

fn should_skip_entry(name: &str) -> bool {
    matches!(
        name,
        "" | "."
            | ".."
            | ".git"
            | ".svn"
            | ".hg"
            | ".obsidian"
            | ".trash"
            | ".DS_Store"
            | "Thumbs.db"
            | "desktop.ini"
            | "node_modules"
            | "__pycache__"
            | ".venv"
            | "venv"
            | "target"
            | "dist"
            | "build"
            | ".idea"
            | ".vscode"
    )
}
