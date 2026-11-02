use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::Serialize;
use std::fs;
use std::path::Path;
use std::process::Command;

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

/// Current git branch for a workspace folder, if the path is inside a repo.
/// Prefers reading `.git/HEAD` so GUI apps do not depend on `git` being on PATH.
#[tauri::command]
pub fn kb_git_branch(path: String) -> Option<String> {
    let root = Path::new(&path);
    if !root.exists() {
        return None;
    }
    if let Some(branch) = branch_from_git_dir(root) {
        return Some(branch);
    }
    branch_via_git_cli(&path)
}

fn branch_from_git_dir(start: &Path) -> Option<String> {
    let git_dir = find_git_dir(start)?;
    let head = fs::read_to_string(git_dir.join("HEAD")).ok()?;
    let head = head.trim();
    if let Some(refer) = head.strip_prefix("ref:") {
        let name = refer.trim();
        if let Some(branch) = name.strip_prefix("refs/heads/") {
            return (!branch.is_empty()).then(|| branch.to_string());
        }
        let short = name.rsplit('/').next().unwrap_or(name);
        return (!short.is_empty()).then(|| short.to_string());
    }
    // Detached HEAD stores a raw object id.
    if head.len() >= 7 && head.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Some(head[..7].to_string());
    }
    None
}

fn find_git_dir(start: &Path) -> Option<std::path::PathBuf> {
    let mut cur = if start.is_file() {
        start.parent()?.to_path_buf()
    } else {
        start.to_path_buf()
    };
    loop {
        let marker = cur.join(".git");
        if marker.is_dir() {
            return Some(marker);
        }
        if marker.is_file() {
            let text = fs::read_to_string(&marker).ok()?;
            for line in text.lines() {
                let line = line.trim();
                let Some(rest) = line.strip_prefix("gitdir:") else {
                    continue;
                };
                let target = rest.trim();
                let path = {
                    let candidate = Path::new(target);
                    if candidate.is_absolute() {
                        candidate.to_path_buf()
                    } else {
                        cur.join(candidate)
                    }
                };
                return path.is_dir().then_some(path);
            }
            return None;
        }
        if !cur.pop() {
            return None;
        }
    }
}

fn branch_via_git_cli(path: &str) -> Option<String> {
    let mut inside = Command::new("git");
    inside.args(["-C", path, "rev-parse", "--is-inside-work-tree"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        inside.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let inside = inside.output().ok()?;
    if !inside.status.success() {
        return None;
    }
    if String::from_utf8_lossy(&inside.stdout).trim() != "true" {
        return None;
    }

    let mut output = Command::new("git");
    output.args(["-C", path, "rev-parse", "--abbrev-ref", "HEAD"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        output.creation_flags(0x0800_0000);
    }
    let output = output.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if branch.is_empty() {
        return None;
    }
    if branch == "HEAD" {
        let mut sha = Command::new("git");
        sha.args(["-C", path, "rev-parse", "--short", "HEAD"]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            sha.creation_flags(0x0800_0000);
        }
        let sha = sha.output().ok()?;
        if !sha.status.success() {
            return None;
        }
        let short = String::from_utf8_lossy(&sha.stdout).trim().to_string();
        return (!short.is_empty()).then_some(short);
    }
    Some(branch)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_branch_from_this_repo() {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        // apps/desktop/src-tauri → repo root
        let repo = manifest
            .ancestors()
            .nth(3)
            .expect("repo root from src-tauri");
        let branch = branch_from_git_dir(repo);
        assert!(
            branch.as_deref().is_some_and(|b| !b.is_empty()),
            "expected a branch for {repo:?}, got {branch:?}"
        );
    }
}
