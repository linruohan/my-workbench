use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::Path;
use std::process::Command;
use std::sync::{Arc, Mutex};

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
pub async fn kb_pick_directory(title: Option<String>) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_title(title.unwrap_or_else(|| "选择文件夹".into()))
            .pick_folder()
            .map(|path| path.to_string_lossy().into_owned())
    })
    .await
    .unwrap_or(None)
}

#[tauri::command]
pub async fn kb_list_dir(path: String) -> Result<Vec<KbEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
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
    })
    .await
    .map_err(|err| format!("目录读取任务失败：{err}"))?
}

/// Open a local file or folder with the OS default application.
#[tauri::command]
pub async fn kb_open_path(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let target = Path::new(path.trim());
        if !target.exists() {
            return Err("路径不存在".into());
        }
        #[cfg(target_os = "windows")]
        {
            std::process::Command::new("cmd")
                .args(["/C", "start", "", &target.to_string_lossy()])
                .spawn()
                .map_err(|err| format!("无法打开：{err}"))?;
            return Ok(());
        }
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open")
                .arg(target)
                .spawn()
                .map_err(|err| format!("无法打开：{err}"))?;
            return Ok(());
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            std::process::Command::new("xdg-open")
                .arg(target)
                .spawn()
                .map_err(|err| format!("无法打开：{err}"))?;
            return Ok(());
        }
        #[allow(unreachable_code)]
        Err("当前平台不支持打开本地路径".into())
    })
    .await
    .map_err(|err| format!("打开路径任务失败：{err}"))?
}

/// Reveal a file or folder in the OS file manager.
#[tauri::command]
pub async fn kb_reveal_in_explorer(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
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
    })
    .await
    .map_err(|err| format!("定位路径任务失败：{err}"))?
}

#[tauri::command]
pub async fn kb_read_text(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = read_limited(&path)?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    })
    .await
    .map_err(|err| format!("读取文件任务失败：{err}"))?
}

#[tauri::command]
pub async fn kb_write_text(path: String, contents: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if contents.len() as u64 > MAX_BYTES {
            return Err("文件过大".into());
        }
        fs::write(&path, contents).map_err(|err| format!("无法写入文件：{err}"))
    })
    .await
    .map_err(|err| format!("写入文件任务失败：{err}"))?
}

#[tauri::command]
pub async fn kb_read_base64(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = read_limited(&path)?;
        Ok(STANDARD.encode(bytes))
    })
    .await
    .map_err(|err| format!("读取文件任务失败：{err}"))?
}

#[tauri::command]
pub async fn kb_write_base64(path: String, data: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
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
    })
    .await
    .map_err(|err| format!("写入文件任务失败：{err}"))?
}

#[tauri::command]
pub async fn kb_exists(path: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || Path::new(&path).exists())
        .await
        .unwrap_or(false)
}

#[tauri::command]
pub async fn kb_mkdir(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        fs::create_dir_all(&path).map_err(|err| format!("无法创建目录：{err}"))
    })
    .await
    .map_err(|err| format!("创建目录任务失败：{err}"))?
}

#[tauri::command]
pub async fn kb_remove(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let target = Path::new(&path);
        if !target.exists() {
            return Err("路径不存在".into());
        }
        if target.is_dir() {
            fs::remove_dir_all(target).map_err(|err| format!("无法删除目录：{err}"))
        } else {
            fs::remove_file(target).map_err(|err| format!("无法删除文件：{err}"))
        }
    })
    .await
    .map_err(|err| format!("删除路径任务失败：{err}"))?
}

#[tauri::command]
pub async fn kb_rename(from: String, to: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
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
    })
    .await
    .map_err(|err| format!("重命名任务失败：{err}"))?
}

/// Current git branch for a workspace folder, if the path is inside a repo.
/// Prefers reading `.git/HEAD` so GUI apps do not depend on `git` being on PATH.
#[tauri::command]
pub async fn kb_git_branch(path: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = Path::new(&path);
        if !root.exists() {
            return None;
        }
        if let Some(branch) = branch_from_git_dir(root) {
            return Some(branch);
        }
        branch_via_git_cli(&path)
    })
    .await
    .unwrap_or(None)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbFilePage {
    files: Vec<KbEntry>,
    cursor: Option<String>,
    truncated: bool,
}

#[tauri::command]
pub async fn kb_list_files_recursive(
    roots: Vec<String>,
    max_files: Option<usize>,
) -> Result<Vec<KbEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let limit = max_files.unwrap_or(8000);
        let mut out: Vec<KbEntry> = Vec::new();
        let mut stack: Vec<String> = Vec::new();
        for root in roots.into_iter().rev() {
            if !root.trim().is_empty() {
                stack.push(root);
            }
        }
        while let Some(dir) = stack.pop() {
            if out.len() >= limit {
                break;
            }
            let entries = match fs::read_dir(&dir) {
                Ok(entries) => entries,
                Err(_) => continue,
            };
            let mut dirs: Vec<String> = Vec::new();
            for entry in entries {
                if out.len() >= limit {
                    break;
                }
                let Ok(entry) = entry else { continue };
                let name = entry.file_name().to_string_lossy().into_owned();
                if should_skip_entry(&name) {
                    continue;
                }
                let file_path = entry.path();
                let is_dir = file_path.is_dir();
                if is_dir {
                    dirs.push(file_path.to_string_lossy().into_owned());
                    continue;
                }
                let mtime_ms = entry
                    .metadata()
                    .ok()
                    .and_then(|meta| meta.modified().ok())
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|dur| dur.as_millis() as u64);
                out.push(KbEntry {
                    name,
                    path: file_path.to_string_lossy().into_owned(),
                    is_dir: false,
                    mtime_ms,
                });
            }
            for child in dirs.into_iter().rev() {
                stack.push(child);
            }
        }
        Ok(out)
    })
    .await
    .map_err(|err| format!("文件遍历任务失败：{err}"))?
}

/// 从 `dir` 的第 `skip` 个 read_dir 条目继续遍历，本页最多产出 `budget` 个文件。
/// budget 是页内配额（与累计数量无关）：若按累计数比较，页边界恰好落在目录条目上时
/// 该目录会被跳过（丢文件），续扫页也会在配额耗尽时空转。
/// 返回 (本目录产出的文件数, 未完成的目录 token)；token 非空表示本页在此目录中途
/// 截断，下次调用需带着 skip 重新打开该目录（触发截断的那个条目不计入 consumed，
/// 会在续扫时重新处理）。
fn walk_kb_dir(
    dir: &str,
    skip: usize,
    budget: usize,
    stack: &mut Vec<String>,
    files: &mut Vec<KbEntry>,
) -> (usize, Option<(String, usize)>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return (0, None);
    };
    let mut consumed = skip;
    let mut produced = 0usize;
    let mut dirs: Vec<String> = Vec::new();
    let mut cut = false;
    for entry in entries.skip(skip) {
        if produced >= budget {
            cut = true;
            break;
        }
        consumed += 1;
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        if should_skip_entry(&name) {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            dirs.push(path.to_string_lossy().into_owned());
            continue;
        }
        let mtime_ms = entry
            .metadata()
            .ok()
            .and_then(|meta| meta.modified().ok())
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|dur| dur.as_millis() as u64);
        produced += 1;
        files.push(KbEntry {
            name,
            path: path.to_string_lossy().into_owned(),
            is_dir: false,
            mtime_ms,
        });
    }
    for child in dirs.into_iter().rev() {
        stack.push(child);
    }
    let resume = cut.then(|| (dir.to_string(), consumed));
    (produced, resume)
}

/// 分页版递归列出文件：每次返回一页（页边界按目录粒度，超大的单目录用
/// skip 位置续扫），cursor 为不透明 JSON；解析失败时返回空页（前端回退整体遍历）。
#[tauri::command]
pub async fn kb_list_files_page(
    roots: Vec<String>,
    cursor: Option<String>,
    max_files: Option<usize>,
) -> Result<KbFilePage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let limit = max_files.unwrap_or(800).clamp(1, 100_000);
        let mut stack: Vec<String> = Vec::new();
        let mut count: usize = 0;
        let mut resume: Option<(String, usize)> = None;
        if let Some(text) = cursor.as_deref() {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
                return Ok(KbFilePage {
                    files: Vec::new(),
                    cursor: None,
                    truncated: false,
                });
            };
            stack = value["stack"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(|item| item.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            count = value["count"].as_u64().unwrap_or(0) as usize;
            resume = value["dir"].as_str().map(|dir| {
                (
                    dir.to_string(),
                    value["consumed"].as_u64().unwrap_or(0) as usize,
                )
            });
        } else {
            for root in roots.into_iter().rev() {
                if !root.trim().is_empty() {
                    stack.push(root);
                }
            }
        }
        let mut files: Vec<KbEntry> = Vec::new();
        let mut resume_token: Option<(String, usize)> = None;
        if let Some((dir, consumed)) = resume {
            let (produced, token) = walk_kb_dir(&dir, consumed, limit, &mut stack, &mut files);
            count += produced;
            resume_token = token;
        }
        if resume_token.is_none() {
            while files.len() < limit {
                let Some(dir) = stack.pop() else { break };
                let (produced, token) =
                    walk_kb_dir(&dir, 0, limit - files.len(), &mut stack, &mut files);
                count += produced;
                if let Some(token) = token {
                    resume_token = Some(token);
                    break;
                }
            }
        }
        let truncated = resume_token.is_some() || !stack.is_empty();
        let cursor_out = truncated.then(|| {
            serde_json::json!({
                "stack": stack,
                "count": count,
                "dir": resume_token.as_ref().map(|(dir, _)| dir),
                "consumed": resume_token.as_ref().map(|(_, consumed)| consumed).unwrap_or(&0),
            })
            .to_string()
        });
        Ok(KbFilePage {
            files,
            cursor: cursor_out,
            truncated,
        })
    })
    .await
    .map_err(|err| format!("文件遍历任务失败：{err}"))?
}

// ---------------------------------------------------------------------------
// Ctrl+P 大仓库索引：扫描会话协议（可取消 / 分批 / 进度）。
// 前端先 kb_scan_start 建立会话，再循环 kb_scan_next 取批（每批有界、可及时停），
// 任意时刻 kb_scan_cancel 立即终结会话；每页都带回累计进度。
// ---------------------------------------------------------------------------

/// 单个扫描会话的状态；`resume` 记录上次页边界（目录内 skip 位置续扫）。
pub struct KbScanState {
    stack: Vec<String>,
    count: usize,
    dirs_scanned: usize,
    resume: Option<(String, usize)>,
    done: bool,
    cancelled: bool,
}

impl KbScanState {
    fn new(roots: Vec<String>) -> Self {
        let mut stack = Vec::new();
        for root in roots.into_iter().rev() {
            if !root.trim().is_empty() {
                stack.push(root);
            }
        }
        Self {
            stack,
            count: 0,
            dirs_scanned: 0,
            resume: None,
            done: false,
            cancelled: false,
        }
    }
}

/// 全部扫描会话；按启动顺序淘汰旧会话，避免前端遗漏 cancel 时泄漏。
pub struct KbScanRegistry {
    sessions: Mutex<KbScanSessions>,
}

struct KbScanSessions {
    map: HashMap<u64, KbScanState>,
    order: VecDeque<u64>,
    next_id: u64,
}

const KB_SCAN_MAX_SESSIONS: usize = 8;

impl KbScanRegistry {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(KbScanSessions {
                map: HashMap::new(),
                order: VecDeque::new(),
                next_id: 1,
            }),
        }
    }

    fn start(&self, roots: Vec<String>) -> u64 {
        let mut sessions = self.sessions.lock().expect("kb scan registry poisoned");
        while sessions.map.len() >= KB_SCAN_MAX_SESSIONS {
            // 优先淘汰已结束/已取消的会话；否则淘汰最旧的。
            let victim = sessions
                .order
                .iter()
                .copied()
                .find(|id| {
                    sessions
                        .map
                        .get(id)
                        .map(|state| state.done || state.cancelled)
                        .unwrap_or(true)
                })
                .or_else(|| sessions.order.front().copied());
            let Some(victim) = victim else { break };
            sessions.map.remove(&victim);
            sessions.order.retain(|item| *item != victim);
        }
        let id = sessions.next_id;
        sessions.next_id += 1;
        sessions.map.insert(id, KbScanState::new(roots));
        sessions.order.push_back(id);
        id
    }

    /// 每取一页走一次有界遍历（页大小限制单次持锁时长，cancel 最迟在页边界生效）；
    /// 结束/取消后清理会话。
    fn next_page(&self, id: u64, limit: usize) -> KbScanPage {
        let mut sessions = self.sessions.lock().expect("kb scan registry poisoned");
        let (files, progress, finished) = match sessions.map.get_mut(&id) {
            None => (Vec::new(), KbScanProgress { files: 0, dirs: 0, done: true }, true),
            Some(state) => {
                if state.cancelled || state.done {
                    let progress = KbScanProgress {
                        files: state.count,
                        dirs: state.dirs_scanned,
                        done: true,
                    };
                    (Vec::new(), progress, true)
                } else {
                    let files = scan_page(state, limit);
                    let progress = KbScanProgress {
                        files: state.count,
                        dirs: state.dirs_scanned,
                        done: state.done,
                    };
                    (files, progress, state.done)
                }
            }
        };
        if finished {
            sessions.map.remove(&id);
            sessions.order.retain(|item| *item != id);
        }
        KbScanPage { files, progress }
    }

    fn cancel(&self, id: u64) -> bool {
        let mut sessions = self.sessions.lock().expect("kb scan registry poisoned");
        if sessions.map.remove(&id).is_none() {
            return false;
        }
        sessions.order.retain(|item| *item != id);
        true
    }
}

/// 从会话当前位置继续遍历，最多产出 `limit` 个文件（页边界按目录粒度）。
/// 空目录连续出栈也不会卡页：只要页内文件未满就继续取目录，保证每页都有进展。
fn scan_page(state: &mut KbScanState, limit: usize) -> Vec<KbEntry> {
    let mut files: Vec<KbEntry> = Vec::new();
    if state.cancelled || state.done {
        return files;
    }
    if let Some((dir, consumed)) = state.resume.take() {
        let (produced, token) =
            walk_kb_dir(&dir, consumed, limit, &mut state.stack, &mut files);
        state.count += produced;
        state.resume = token;
    }
    while files.len() < limit {
        let Some(dir) = state.stack.pop() else {
            state.done = true;
            break;
        };
        state.dirs_scanned += 1;
        let (produced, token) =
            walk_kb_dir(&dir, 0, limit - files.len(), &mut state.stack, &mut files);
        state.count += produced;
        if let Some(token) = token {
            state.resume = Some(token);
            break;
        }
    }
    files
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbScanProgress {
    files: usize,
    dirs: usize,
    done: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbScanPage {
    files: Vec<KbEntry>,
    progress: KbScanProgress,
}

#[tauri::command]
pub async fn kb_scan_start(
    registry: tauri::State<'_, Arc<KbScanRegistry>>,
    roots: Vec<String>,
) -> Result<u64, String> {
    Ok(registry.start(roots))
}

#[tauri::command]
pub async fn kb_scan_next(
    registry: tauri::State<'_, Arc<KbScanRegistry>>,
    scan_id: u64,
    page_size: Option<usize>,
) -> Result<KbScanPage, String> {
    let limit = page_size.unwrap_or(800).clamp(1, 100_000);
    let registry = Arc::clone(&registry);
    tauri::async_runtime::spawn_blocking(move || registry.next_page(scan_id, limit))
        .await
        .map_err(|err| format!("扫描任务失败：{err}"))
}

#[tauri::command]
pub async fn kb_scan_cancel(
    registry: tauri::State<'_, Arc<KbScanRegistry>>,
    scan_id: u64,
) -> Result<bool, String> {
    Ok(registry.cancel(scan_id))
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

    /// 建一个临时目录树：root/a1.txt a2.txt sub/b1.txt sub/deep/c1.txt
    fn seed_tree(tag: &str) -> String {
        let root = std::env::temp_dir().join(format!("wb-kb-scan-test-{tag}-{}", std::process::id()));
        let sub = root.join("sub");
        let deep = sub.join("deep");
        fs::create_dir_all(&deep).expect("create dirs");
        for path in [
            root.join("a1.txt"),
            root.join("a2.txt"),
            sub.join("b1.txt"),
            deep.join("c1.txt"),
        ] {
            fs::write(&path, "x").expect("write seed file");
        }
        root.to_string_lossy().into_owned()
    }

    #[test]
    fn scan_session_batches_with_progress_and_finishes() {
        let root = seed_tree("batch");
        let registry = KbScanRegistry::new();
        let id = registry.start(vec![root.clone()]);
        let mut seen: Vec<String> = Vec::new();
        let mut last_progress: Option<KbScanProgress> = None;
        for _ in 0..50 {
            let page = registry.next_page(id, 2);
            seen.extend(page.files.iter().map(|entry| entry.path.clone()));
            let done = page.progress.done;
            last_progress = Some(page.progress);
            if done {
                break;
            }
        }
        assert_eq!(seen.len(), 4, "all four files visited once: {seen:?}");
        let mut sorted = seen.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), 4, "no duplicates");
        let progress = last_progress.expect("progress reported");
        assert!(progress.done, "session finished");
        assert_eq!(progress.files, 4);
        assert!(progress.dirs >= 3, "scanned root/sub/deep: {}", progress.dirs);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_session_cancel_stops_future_pages() {
        let root = seed_tree("cancel");
        let registry = KbScanRegistry::new();
        let id = registry.start(vec![root.clone()]);
        let first = registry.next_page(id, 1);
        assert_eq!(first.files.len(), 1);
        assert!(!first.progress.done);
        assert!(registry.cancel(id), "cancel reported");
        let next = registry.next_page(id, 1);
        assert!(next.files.is_empty(), "cancelled session returns no files");
        assert!(next.progress.done, "cancelled session is done");
        assert!(!registry.cancel(id), "second cancel reports miss");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_registry_evicts_stale_sessions() {
        let registry = KbScanRegistry::new();
        let mut ids = Vec::new();
        for index in 0..KB_SCAN_MAX_SESSIONS {
            ids.push(registry.start(vec![format!("root-{index}")]));
        }
        // 全部未结束：新一轮启动会淘汰最旧会话，但保证仍然成功分配。
        let fresh = registry.start(vec![format!("root-fresh")]);
        assert!(!ids.contains(&fresh));
        assert_ne!(ids.first(), Some(&fresh));
        let page = registry.next_page(fresh, 800);
        assert!(page.progress.done, "missing roots finish immediately");
    }
}
