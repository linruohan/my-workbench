//! Workspace-bound shell and background jobs for agent tools.
//! Working directories must stay under the session workspace root.

use crate::process_tree::ProcessTree;
use portable_pty::{native_pty_system, Child as PtyChild, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

const OUTPUT_LIMIT: usize = 64 * 1024;
const DEFAULT_TIMEOUT_MS: u64 = 120_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellHit {
    ok: bool,
    code: i32,
    stdout: String,
    stderr: String,
    truncated: bool,
    /// Workspace-relative spill when stdout/stderr exceeded the inline limit.
    spill_path: Option<String>,
    spill_bytes: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobInfo {
    id: String,
    description: String,
    status: String,
    code: Option<i32>,
    truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobStartHit {
    id: String,
    description: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobOutputHit {
    id: String,
    status: String,
    code: Option<i32>,
    output: String,
    stderr: String,
    truncated: bool,
    done: bool,
    spill_path: Option<String>,
    spill_bytes: Option<u64>,
}

struct JobState {
    id: String,
    description: String,
    status: String,
    code: Option<i32>,
    stdout: String,
    stderr: String,
    stdout_cursor: usize,
    truncated: bool,
    child: Option<Child>,
    /// Kill-on-close Job (Windows) or process group (Unix).
    tree: Option<ProcessTree>,
    root: PathBuf,
    spill_path: Option<PathBuf>,
    spill_rel: Option<String>,
    spill_bytes: u64,
}

fn jobs() -> &'static Mutex<HashMap<String, JobState>> {
    static JOBS: OnceLock<Mutex<HashMap<String, JobState>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_job_id() -> String {
    static SEQ: AtomicU64 = AtomicU64::new(1);
    format!("job_{}", SEQ.fetch_add(1, Ordering::Relaxed))
}

fn normalize_managed_env(
    managed_env: Option<std::collections::HashMap<String, String>>,
) -> std::collections::BTreeMap<String, String> {
    let mut out = crate::shell_env::default_managed_env();
    if let Some(map) = managed_env {
        for (key, value) in map {
            let key = key.trim();
            let value = value.trim();
            if key.starts_with("WB_") && !value.is_empty() {
                out.insert(key.to_string(), value.to_string());
            }
        }
    }
    out
}

#[tauri::command]
pub async fn agent_workspace_shell(
    root: String,
    command: String,
    workdir: Option<String>,
    timeout_ms: Option<u64>,
    shell: Option<String>,
    managed_env: Option<std::collections::HashMap<String, String>>,
) -> Result<ShellHit, String> {
    let root = root.trim().to_string();
    let command = command.trim().to_string();
    if root.is_empty() {
        return Err("未绑定工作区".into());
    }
    if command.is_empty() {
        return Err("命令不能为空".into());
    }
    if command.len() > 32_000 || command.contains('\0') {
        return Err("命令无效".into());
    }
    let workdir = workdir.unwrap_or_default();
    let timeout = timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
    let shell_kind = normalize_shell(shell.as_deref());
    let managed = normalize_managed_env(managed_env);
    tauri::async_runtime::spawn_blocking(move || {
        run_shell(
            &root,
            &command,
            workdir.trim(),
            timeout,
            shell_kind,
            &managed,
        )
    })
    .await
    .map_err(|err| format!("执行失败：{err}"))?
}

#[tauri::command]
pub async fn agent_workspace_job_start(
    root: String,
    command: String,
    workdir: Option<String>,
    description: Option<String>,
    shell: Option<String>,
    managed_env: Option<std::collections::HashMap<String, String>>,
) -> Result<JobStartHit, String> {
    let root = root.trim().to_string();
    let command = command.trim().to_string();
    if root.is_empty() {
        return Err("未绑定工作区".into());
    }
    if command.is_empty() {
        return Err("命令不能为空".into());
    }
    if command.len() > 32_000 || command.contains('\0') {
        return Err("命令无效".into());
    }
    let workdir = workdir.unwrap_or_default();
    let description = description
        .unwrap_or_default()
        .trim()
        .chars()
        .take(80)
        .collect::<String>();
    let label = if description.is_empty() {
        "后台命令".into()
    } else {
        description
    };
    let shell_kind = normalize_shell(shell.as_deref());
    let managed = normalize_managed_env(managed_env);
    tauri::async_runtime::spawn_blocking(move || {
        start_job(
            &root,
            &command,
            workdir.trim(),
            &label,
            shell_kind,
            &managed,
        )
    })
    .await
    .map_err(|err| format!("启动失败：{err}"))?
}

#[tauri::command]
pub fn agent_workspace_job_list() -> Vec<JobInfo> {
    let mut map = jobs().lock().expect("jobs lock");
    reap_finished(&mut map);
    let mut out: Vec<JobInfo> = map
        .values()
        .map(|job| JobInfo {
            id: job.id.clone(),
            description: job.description.clone(),
            status: job.status.clone(),
            code: job.code,
            truncated: job.truncated,
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

#[tauri::command]
pub async fn agent_workspace_job_output(
    job_id: String,
    wait: Option<bool>,
    timeout_ms: Option<u64>,
) -> Result<JobOutputHit, String> {
    let id = job_id.trim().to_string();
    if id.is_empty() {
        return Err("请提供 job_id".into());
    }
    let wait = wait.unwrap_or(false);
    let timeout = timeout_ms.unwrap_or(30_000);
    tauri::async_runtime::spawn_blocking(move || read_job_output(&id, wait, timeout))
        .await
        .map_err(|err| format!("读取失败：{err}"))?
}

#[tauri::command]
pub fn agent_workspace_job_kill(job_id: String, reason: Option<String>) -> Result<JobInfo, String> {
    let id = job_id.trim();
    if id.is_empty() {
        return Err("请提供 job_id".into());
    }
    let mut map = jobs().lock().expect("jobs lock");
    reap_finished(&mut map);
    let job = map.get_mut(id).ok_or_else(|| format!("未知任务 {id}"))?;
    if job.status == "running" {
        if let Some(mut child) = job.child.take() {
            if let Some(mut tree) = job.tree.take() {
                tree.kill_tree(&mut child);
            } else {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        job.status = "killed".into();
        job.code = Some(-1);
        if let Some(text) = reason {
            let note = text.trim();
            if !note.is_empty() {
                job.stderr.push_str(&format!("\n[killed] {note}"));
            }
        }
    }
    Ok(JobInfo {
        id: job.id.clone(),
        description: job.description.clone(),
        status: job.status.clone(),
        code: job.code,
        truncated: job.truncated,
    })
}

fn start_job(
    root: &str,
    command: &str,
    workdir: &str,
    description: &str,
    shell: ShellKind,
    managed: &std::collections::BTreeMap<String, String>,
) -> Result<JobStartHit, String> {
    let root_path = canonicalize_existing(Path::new(root))?;
    let cwd = resolve_workdir(&root_path, workdir)?;
    let (mut child, tree) = spawn_shell(shell, command, &cwd, true, managed)
        .map_err(|err| format!("无法启动 shell：{err}"))?;

    let id = next_job_id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    {
        let mut map = jobs().lock().expect("jobs lock");
        map.insert(
            id.clone(),
            JobState {
                id: id.clone(),
                description: description.to_string(),
                status: "running".into(),
                code: None,
                stdout: String::new(),
                stderr: String::new(),
                stdout_cursor: 0,
                truncated: false,
                child: Some(child),
                tree: Some(tree),
                root: root_path,
                spill_path: None,
                spill_rel: None,
                spill_bytes: 0,
            },
        );
    }

    let out_id = id.clone();
    if let Some(mut pipe) = stdout {
        thread::spawn(move || pump_pipe(out_id, true, &mut pipe));
    }
    let err_id = id.clone();
    if let Some(mut pipe) = stderr {
        thread::spawn(move || pump_pipe(err_id, false, &mut pipe));
    }

    Ok(JobStartHit {
        id,
        description: description.to_string(),
    })
}

fn pump_pipe(id: String, is_stdout: bool, reader: &mut impl Read) {
    let mut buf = [0u8; 8 * 1024];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let chunk = String::from_utf8_lossy(&buf[..n]);
                if let Ok(mut map) = jobs().lock() {
                    if let Some(job) = map.get_mut(&id) {
                        append_job_output(job, is_stdout, &chunk);
                    }
                }
            }
            Err(_) => break,
        }
    }
}

fn append_job_output(job: &mut JobState, is_stdout: bool, chunk: &str) {
    let target = if is_stdout {
        &mut job.stdout
    } else {
        &mut job.stderr
    };
    if target.len() < OUTPUT_LIMIT {
        let room = OUTPUT_LIMIT - target.len();
        let take = room.min(chunk.len());
        target.push_str(&chunk[..take]);
        if take < chunk.len() {
            job.truncated = true;
            let overflow = &chunk[take..];
            let _ = spill_job_bytes(job, overflow);
        }
        return;
    }
    job.truncated = true;
    let _ = spill_job_bytes(job, chunk);
}

fn spill_job_bytes(job: &mut JobState, chunk: &str) -> Result<(), String> {
    if chunk.is_empty() {
        return Ok(());
    }
    if job.spill_path.is_none() {
        let dir = job.root.join(".wb").join("spill");
        fs::create_dir_all(&dir).map_err(|err| format!("无法创建 spill 目录：{err}"))?;
        let name = format!("{}-output.txt", job.id);
        let path = dir.join(&name);
        // Seed spill with the inline buffers so the file is the full stream.
        let mut seed = String::new();
        seed.push_str(&job.stdout);
        if !job.stderr.is_empty() {
            if !seed.is_empty() {
                seed.push('\n');
            }
            seed.push_str("--- stderr ---\n");
            seed.push_str(&job.stderr);
        }
        fs::write(&path, seed.as_bytes()).map_err(|err| format!("无法写入 spill：{err}"))?;
        job.spill_bytes = seed.len() as u64;
        let rel = format!(".wb/spill/{name}").replace('\\', "/");
        job.spill_rel = Some(rel);
        job.spill_path = Some(path);
    }
    if let Some(path) = job.spill_path.as_ref() {
        use std::fs::OpenOptions;
        use std::io::Write;
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|err| format!("无法追加 spill：{err}"))?;
        file.write_all(chunk.as_bytes())
            .map_err(|err| format!("无法追加 spill：{err}"))?;
        job.spill_bytes = job.spill_bytes.saturating_add(chunk.len() as u64);
    }
    Ok(())
}

fn read_job_output(id: &str, wait: bool, timeout_ms: u64) -> Result<JobOutputHit, String> {
    let started = Instant::now();
    loop {
        {
            let mut map = jobs().lock().expect("jobs lock");
            reap_finished(&mut map);
            let job = map.get_mut(id).ok_or_else(|| format!("未知任务 {id}"))?;
            let done = job.status != "running";
            if done || !wait {
                let output = job.stdout[job.stdout_cursor.min(job.stdout.len())..].to_string();
                job.stdout_cursor = job.stdout.len();
                return Ok(JobOutputHit {
                    id: job.id.clone(),
                    status: job.status.clone(),
                    code: job.code,
                    output,
                    stderr: job.stderr.clone(),
                    truncated: job.truncated,
                    done,
                    spill_path: job.spill_rel.clone(),
                    spill_bytes: if job.spill_bytes > 0 {
                        Some(job.spill_bytes)
                    } else {
                        None
                    },
                });
            }
        }
        if timeout_ms > 0 && started.elapsed() >= Duration::from_millis(timeout_ms) {
            let mut map = jobs().lock().expect("jobs lock");
            reap_finished(&mut map);
            let job = map.get_mut(id).ok_or_else(|| format!("未知任务 {id}"))?;
            let output = job.stdout[job.stdout_cursor.min(job.stdout.len())..].to_string();
            job.stdout_cursor = job.stdout.len();
            return Ok(JobOutputHit {
                id: job.id.clone(),
                status: job.status.clone(),
                code: job.code,
                output,
                stderr: job.stderr.clone(),
                truncated: job.truncated,
                done: job.status != "running",
                spill_path: job.spill_rel.clone(),
                spill_bytes: if job.spill_bytes > 0 {
                    Some(job.spill_bytes)
                } else {
                    None
                },
            });
        }
        thread::sleep(Duration::from_millis(80));
    }
}

fn reap_finished(map: &mut HashMap<String, JobState>) {
    for job in map.values_mut() {
        if job.status != "running" {
            continue;
        }
        let Some(child) = job.child.as_mut() else {
            continue;
        };
        match child.try_wait() {
            Ok(Some(status)) => {
                job.code = Some(status.code().unwrap_or(-1));
                job.status = if status.success() {
                    "completed".into()
                } else {
                    "failed".into()
                };
                job.child = None;
                // Drop tree: kill-on-close Job reaps leftover grandchildren.
                job.tree = None;
            }
            Ok(None) => {}
            Err(_) => {
                job.status = "failed".into();
                job.code = Some(-1);
                job.child = None;
                job.tree = None;
            }
        }
    }
}

#[derive(Clone, Copy)]
enum ShellKind {
    Pwsh,
    Bash,
}

fn normalize_shell(raw: Option<&str>) -> ShellKind {
    match raw.map(str::trim).unwrap_or("").to_ascii_lowercase().as_str() {
        "bash" | "sh" => ShellKind::Bash,
        _ => ShellKind::Pwsh,
    }
}

fn spawn_shell(
    shell: ShellKind,
    command: &str,
    cwd: &Path,
    null_stdin: bool,
    managed: &std::collections::BTreeMap<String, String>,
) -> Result<(Child, ProcessTree), String> {
    let stdin = if null_stdin {
        Stdio::null()
    } else {
        Stdio::piped()
    };
    let mut cmd = match shell {
        ShellKind::Pwsh => {
            let mut cmd = pwsh_command();
            cmd.args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                command,
            ])
            .current_dir(cwd)
            .stdin(stdin)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
            cmd
        }
        ShellKind::Bash => {
            let mut cmd = Command::new("bash");
            cmd.args(["-lc", command])
                .current_dir(cwd)
                .stdin(stdin)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            cmd
        }
    };
    crate::shell_env::apply_scrubbed_env(&mut cmd, managed);
    ProcessTree::prepare(&mut cmd);
    let child = cmd.spawn().map_err(|err| match shell {
        ShellKind::Pwsh => format!("无法启动 PowerShell：{err}"),
        ShellKind::Bash => format!("无法启动 bash：{err}"),
    })?;
    let tree = ProcessTree::bind(&child);
    Ok((child, tree))
}

fn pwsh_command() -> Command {
    // Prefer modern pwsh when present; fall back to Windows PowerShell.
    if which_exists("pwsh") {
        Command::new("pwsh")
    } else {
        Command::new("powershell")
    }
}

fn which_exists(bin: &str) -> bool {
    let Ok(path) = std::env::var("PATH") else {
        return false;
    };
    let exts: Vec<&str> = if cfg!(windows) {
        vec![".exe", ".cmd", ".bat", ""]
    } else {
        vec![""]
    };
    for dir in std::env::split_paths(&path) {
        for ext in &exts {
            let candidate = dir.join(format!("{bin}{ext}"));
            if candidate.is_file() {
                return true;
            }
        }
    }
    false
}

fn default_interactive_shell() -> ShellKind {
    if cfg!(windows) {
        ShellKind::Pwsh
    } else {
        ShellKind::Bash
    }
}

fn run_shell(
    root: &str,
    command: &str,
    workdir: &str,
    timeout_ms: u64,
    shell: ShellKind,
    managed: &std::collections::BTreeMap<String, String>,
) -> Result<ShellHit, String> {
    let root_path = canonicalize_existing(Path::new(root))?;
    let cwd = resolve_workdir(&root_path, workdir)?;

    let (mut child, mut tree) = spawn_shell(shell, command, &cwd, true, managed)
        .map_err(|err| format!("无法启动 shell：{err}"))?;

    let started = Instant::now();
    let timeout = if timeout_ms == 0 {
        None
    } else {
        Some(Duration::from_millis(timeout_ms))
    };

    // Drain pipes on background threads into shared buffers (+ optional spill).
    let stdout_buf = std::sync::Arc::new(Mutex::new(String::new()));
    let stderr_buf = std::sync::Arc::new(Mutex::new(String::new()));
    let spill_meta = std::sync::Arc::new(Mutex::new(ShellSpill::default()));
    let truncated = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

    if let Some(mut out) = child.stdout.take() {
        let buf = Arc::clone(&stdout_buf);
        let peer = Arc::clone(&stderr_buf);
        let spill = Arc::clone(&spill_meta);
        let flag = Arc::clone(&truncated);
        let root = root_path.clone();
        thread::spawn(move || pump_shell_stream(&mut out, buf, peer, spill, flag, root, true));
    }
    if let Some(mut err) = child.stderr.take() {
        let buf = Arc::clone(&stderr_buf);
        let peer = Arc::clone(&stdout_buf);
        let spill = Arc::clone(&spill_meta);
        let flag = Arc::clone(&truncated);
        let root = root_path.clone();
        thread::spawn(move || pump_shell_stream(&mut err, buf, peer, spill, flag, root, false));
    }

    loop {
        if let Some(limit) = timeout {
            if started.elapsed() >= limit {
                tree.kill_tree(&mut child);
                return Err(format!("命令超时（{timeout_ms} ms）"));
            }
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                // Give pipe threads a brief moment to finish draining.
                thread::sleep(Duration::from_millis(30));
                drop(tree);
                let stdout = stdout_buf.lock().expect("stdout").clone();
                let stderr = stderr_buf.lock().expect("stderr").clone();
                let spill = spill_meta.lock().expect("spill").clone();
                let code = status.code().unwrap_or(-1);
                return Ok(ShellHit {
                    ok: status.success(),
                    code,
                    stdout,
                    stderr,
                    truncated: truncated.load(Ordering::Relaxed),
                    spill_path: spill.rel,
                    spill_bytes: spill.bytes,
                });
            }
            Ok(None) => thread::sleep(Duration::from_millis(40)),
            Err(err) => {
                drop(tree);
                return Err(format!("等待进程失败：{err}"));
            }
        }
    }
}

#[derive(Default, Clone)]
struct ShellSpill {
    rel: Option<String>,
    path: Option<PathBuf>,
    bytes: Option<u64>,
}

fn pump_shell_stream(
    reader: &mut impl Read,
    buf: Arc<Mutex<String>>,
    peer: Arc<Mutex<String>>,
    spill: Arc<Mutex<ShellSpill>>,
    truncated: Arc<std::sync::atomic::AtomicBool>,
    root: PathBuf,
    is_stdout: bool,
) {
    let mut bytes = [0u8; 8 * 1024];
    loop {
        match reader.read(&mut bytes) {
            Ok(0) => break,
            Ok(n) => {
                let chunk = String::from_utf8_lossy(&bytes[..n]);
                let mut target = buf.lock().expect("buf");
                if target.len() < OUTPUT_LIMIT {
                    let room = OUTPUT_LIMIT - target.len();
                    let take = room.min(chunk.len());
                    target.push_str(&chunk[..take]);
                    if take < chunk.len() {
                        truncated.store(true, Ordering::Relaxed);
                        let overflow = chunk[take..].to_string();
                        let self_text = format!("{}{}", target.as_str(), &overflow);
                        drop(target);
                        let peer_text = peer.lock().expect("peer").clone();
                        let seed = combine_shell_streams(is_stdout, &self_text, &peer_text);
                        if !ensure_shell_spill_seed(&spill, &root, &seed) {
                            let labeled = if is_stdout {
                                overflow
                            } else {
                                format!("\n--- stderr ---\n{overflow}")
                            };
                            let _ = append_shell_spill_bytes(&spill, &labeled);
                        }
                    }
                } else {
                    truncated.store(true, Ordering::Relaxed);
                    drop(target);
                    let labeled = if is_stdout {
                        chunk.to_string()
                    } else {
                        format!("{chunk}")
                    };
                    let _ = append_shell_spill_bytes(&spill, &labeled);
                }
            }
            Err(_) => break,
        }
    }
}

fn combine_shell_streams(is_stdout: bool, self_text: &str, peer_text: &str) -> String {
    if is_stdout {
        if peer_text.is_empty() {
            self_text.to_string()
        } else {
            format!("{self_text}\n--- stderr ---\n{peer_text}")
        }
    } else if peer_text.is_empty() {
        format!("--- stderr ---\n{self_text}")
    } else {
        format!("{peer_text}\n--- stderr ---\n{self_text}")
    }
}

/// Returns true when this call created the spill file.
fn ensure_shell_spill_seed(spill: &Arc<Mutex<ShellSpill>>, root: &Path, seed: &str) -> bool {
    let mut meta = spill.lock().expect("spill");
    if meta.path.is_some() {
        return false;
    }
    let dir = root.join(".wb").join("spill");
    if fs::create_dir_all(&dir).is_err() {
        return false;
    }
    let name = format!(
        "shell-{}-output.txt",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let path = dir.join(&name);
    if fs::write(&path, seed.as_bytes()).is_err() {
        return false;
    }
    meta.rel = Some(format!(".wb/spill/{name}").replace('\\', "/"));
    meta.path = Some(path);
    meta.bytes = Some(seed.len() as u64);
    true
}

fn append_shell_spill_bytes(spill: &Arc<Mutex<ShellSpill>>, chunk: &str) -> Result<(), String> {
    if chunk.is_empty() {
        return Ok(());
    }
    let mut meta = spill.lock().expect("spill");
    let Some(path) = meta.path.as_ref() else {
        return Ok(());
    };
    use std::fs::OpenOptions;
    use std::io::Write;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|err| format!("无法追加 spill：{err}"))?;
    file.write_all(chunk.as_bytes())
        .map_err(|err| format!("无法追加 spill：{err}"))?;
    meta.bytes = Some(meta.bytes.unwrap_or(0).saturating_add(chunk.len() as u64));
    Ok(())
}

fn resolve_workdir(root_path: &Path, workdir: &str) -> Result<PathBuf, String> {
    if workdir.is_empty() {
        return Ok(root_path.to_path_buf());
    }
    let candidate = if Path::new(workdir).is_absolute() {
        PathBuf::from(workdir)
    } else {
        root_path.join(workdir)
    };
    let resolved = if candidate.exists() {
        canonicalize_existing(&candidate)?
    } else {
        return Err("工作目录不存在".into());
    };
    if !resolved.starts_with(root_path) {
        return Err("工作目录超出工作区范围".into());
    }
    Ok(resolved)
}

fn canonicalize_existing(path: &Path) -> Result<PathBuf, String> {
    fs::canonicalize(path).map_err(|err| format!("无法解析路径：{err}"))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TermInfo {
    id: String,
    name: String,
    cwd: String,
    shell: String,
    alive: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TermOpenHit {
    id: String,
    name: String,
    cwd: String,
    shell: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TermOutputHit {
    id: String,
    output: String,
    alive: bool,
}

struct TermState {
    id: String,
    name: String,
    cwd: String,
    shell: ShellKind,
    buffer: String,
    cursor: usize,
    truncated: bool,
    writer: Option<Box<dyn Write + Send>>,
    child: Option<Box<dyn PtyChild + Send + Sync>>,
    /// Keep the master PTY alive for the session lifetime.
    _master: Option<Box<dyn MasterPty + Send>>,
}

fn terms() -> &'static Mutex<HashMap<String, TermState>> {
    static TERMS: OnceLock<Mutex<HashMap<String, TermState>>> = OnceLock::new();
    TERMS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_term_id() -> String {
    static SEQ: AtomicU64 = AtomicU64::new(1);
    format!("term_{}", SEQ.fetch_add(1, Ordering::Relaxed))
}

#[tauri::command]
pub async fn agent_terminal_open(
    root: String,
    workdir: Option<String>,
    name: Option<String>,
    shell: Option<String>,
    managed_env: Option<std::collections::HashMap<String, String>>,
) -> Result<TermOpenHit, String> {
    let root = root.trim().to_string();
    if root.is_empty() {
        return Err("未绑定工作区".into());
    }
    let workdir = workdir.unwrap_or_default();
    let name = name
        .unwrap_or_default()
        .trim()
        .chars()
        .take(40)
        .collect::<String>();
    let shell_kind = match shell
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(raw) => normalize_shell(Some(raw)),
        None => default_interactive_shell(),
    };
    let managed = normalize_managed_env(managed_env);
    tauri::async_runtime::spawn_blocking(move || {
        open_terminal(&root, workdir.trim(), &name, shell_kind, &managed)
    })
    .await
    .map_err(|err| format!("打开终端失败：{err}"))?
}

#[tauri::command]
pub async fn agent_terminal_send(
    session_id: String,
    text: String,
    submit: Option<bool>,
    timeout_ms: Option<u64>,
) -> Result<TermOutputHit, String> {
    let id = session_id.trim().to_string();
    if id.is_empty() {
        return Err("请提供 session_id".into());
    }
    if text.len() > 32_000 || text.contains('\0') {
        return Err("输入无效".into());
    }
    let submit = submit.unwrap_or(true);
    let timeout = timeout_ms.unwrap_or(15_000);
    tauri::async_runtime::spawn_blocking(move || send_terminal(&id, &text, submit, timeout))
        .await
        .map_err(|err| format!("写入失败：{err}"))?
}

#[tauri::command]
pub fn agent_terminal_read(
    session_id: String,
    offset: Option<u32>,
    limit: Option<u32>,
) -> Result<TermOutputHit, String> {
    let id = session_id.trim();
    if id.is_empty() {
        return Err("请提供 session_id".into());
    }
    let mut map = terms().lock().expect("terms lock");
    reap_terms(&mut map);
    let term = map.get_mut(id).ok_or_else(|| format!("未知终端 {id}"))?;
    let alive = term.child.is_some();
    let lines: Vec<&str> = term.buffer.split('\n').collect();
    let off = offset.unwrap_or(0) as usize;
    let lim = limit.unwrap_or(500) as usize;
    let end = lines.len().saturating_sub(off);
    let start = end.saturating_sub(lim);
    let output = lines[start..end].join("\n");
    Ok(TermOutputHit {
        id: term.id.clone(),
        output,
        alive,
    })
}

#[tauri::command]
pub fn agent_terminal_list() -> Vec<TermInfo> {
    let mut map = terms().lock().expect("terms lock");
    reap_terms(&mut map);
    let mut out: Vec<TermInfo> = map
        .values()
        .map(|term| TermInfo {
            id: term.id.clone(),
            name: term.name.clone(),
            cwd: term.cwd.clone(),
            shell: shell_label(term.shell).into(),
            alive: term.child.is_some(),
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

#[tauri::command]
pub fn agent_terminal_close(session_id: String) -> Result<TermInfo, String> {
    let id = session_id.trim();
    if id.is_empty() {
        return Err("请提供 session_id".into());
    }
    let mut map = terms().lock().expect("terms lock");
    let Some(mut term) = map.remove(id) else {
        return Err(format!("未知终端 {id}"));
    };
    if let Some(mut child) = term.child.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    term.writer = None;
    term._master = None;
    Ok(TermInfo {
        id: term.id,
        name: term.name,
        cwd: term.cwd,
        shell: shell_label(term.shell).into(),
        alive: false,
    })
}

#[tauri::command]
pub fn agent_terminal_signal(session_id: String, signal: Option<String>) -> Result<TermInfo, String> {
    let id = session_id.trim();
    if id.is_empty() {
        return Err("请提供 session_id".into());
    }
    let kind = signal
        .as_deref()
        .map(str::trim)
        .unwrap_or("SIGINT")
        .to_ascii_uppercase();
    let mut map = terms().lock().expect("terms lock");
    reap_terms(&mut map);
    let term = map.get_mut(id).ok_or_else(|| format!("未知终端 {id}"))?;
    match kind.as_str() {
        "SIGKILL" | "KILL" | "SIGTERM" | "TERM" => {
            if let Some(mut child) = term.child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
            term.writer = None;
            term._master = None;
        }
        _ => {
            // ConPTY/PTY: Ctrl-C is delivered as a real interrupt to the foreground group.
            if let Some(writer) = term.writer.as_mut() {
                let _ = writer.write_all(&[0x03]);
                let _ = writer.flush();
            }
        }
    }
    Ok(TermInfo {
        id: term.id.clone(),
        name: term.name.clone(),
        cwd: term.cwd.clone(),
        shell: shell_label(term.shell).into(),
        alive: term.child.is_some(),
    })
}

fn open_terminal(
    root: &str,
    workdir: &str,
    name: &str,
    shell: ShellKind,
    managed: &std::collections::BTreeMap<String, String>,
) -> Result<TermOpenHit, String> {
    let root_path = canonicalize_existing(Path::new(root))?;
    let cwd = resolve_workdir(&root_path, workdir)?;
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 32,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|err| format!("无法创建 PTY：{err}"))?;

    let mut cmd = interactive_shell_command(shell);
    cmd.cwd(cwd.as_os_str());
    crate::shell_env::apply_scrubbed_env_pty(&mut cmd, managed);
    // Force terminal identity after scrub (allowlist already permits these).
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|err| format!("无法在 PTY 中启动 shell：{err}"))?;
    // Drop the slave so the child owns the controlling terminal.
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|err| format!("无法读取 PTY：{err}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|err| format!("无法写入 PTY：{err}"))?;

    let id = next_term_id();
    let label = if name.is_empty() {
        id.clone()
    } else {
        name.to_string()
    };
    let shell_name = shell_label(shell);
    {
        let mut map = terms().lock().expect("terms lock");
        map.insert(
            id.clone(),
            TermState {
                id: id.clone(),
                name: label.clone(),
                cwd: cwd.display().to_string(),
                shell,
                buffer: String::new(),
                cursor: 0,
                truncated: false,
                writer: Some(writer),
                child: Some(child),
                _master: Some(pair.master),
            },
        );
    }
    let out_id = id.clone();
    thread::spawn(move || pump_term(out_id, &mut reader));
    // Give the shell a brief moment to emit its banner/prompt into the buffer.
    thread::sleep(Duration::from_millis(120));
    Ok(TermOpenHit {
        id,
        name: label,
        cwd: cwd.display().to_string(),
        shell: shell_name.into(),
    })
}

fn interactive_shell_command(shell: ShellKind) -> CommandBuilder {
    match shell {
        ShellKind::Pwsh => {
            let bin = if which_exists("pwsh") {
                "pwsh"
            } else {
                "powershell"
            };
            let mut cmd = CommandBuilder::new(bin);
            cmd.arg("-NoProfile");
            cmd.arg("-NoLogo");
            cmd.arg("-ExecutionPolicy");
            cmd.arg("Bypass");
            cmd
        }
        ShellKind::Bash => {
            let mut cmd = CommandBuilder::new("bash");
            // Login+interactive so prompts and rc files behave like a real terminal.
            cmd.arg("-il");
            cmd
        }
    }
}

fn shell_label(shell: ShellKind) -> &'static str {
    match shell {
        ShellKind::Pwsh => "pwsh",
        ShellKind::Bash => "bash",
    }
}

fn pump_term(id: String, reader: &mut impl Read) {
    let mut buf = [0u8; 8 * 1024];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let chunk = String::from_utf8_lossy(&buf[..n]);
                if let Ok(mut map) = terms().lock() {
                    if let Some(term) = map.get_mut(&id) {
                        if term.buffer.len() >= OUTPUT_LIMIT {
                            term.truncated = true;
                            continue;
                        }
                        let room = OUTPUT_LIMIT - term.buffer.len();
                        let take = room.min(chunk.len());
                        term.buffer.push_str(&chunk[..take]);
                        if take < chunk.len() {
                            term.truncated = true;
                        }
                    } else {
                        break;
                    }
                }
            }
            Err(_) => break,
        }
    }
}

fn send_terminal(
    id: &str,
    text: &str,
    submit: bool,
    timeout_ms: u64,
) -> Result<TermOutputHit, String> {
    {
        let mut map = terms().lock().expect("terms lock");
        reap_terms(&mut map);
        let term = map.get_mut(id).ok_or_else(|| format!("未知终端 {id}"))?;
        let Some(writer) = term.writer.as_mut() else {
            return Err("终端已关闭".into());
        };
        writer
            .write_all(text.as_bytes())
            .map_err(|err| format!("写入失败：{err}"))?;
        if submit {
            // PTY / ConPTY expect CR as Enter.
            writer
                .write_all(b"\r")
                .map_err(|err| format!("写入失败：{err}"))?;
        }
        writer.flush().map_err(|err| format!("写入失败：{err}"))?;
        term.cursor = term.buffer.len();
    }

    let started = Instant::now();
    let timeout = Duration::from_millis(timeout_ms.max(200));
    let quiet = Duration::from_millis(350);
    let mut last_len = {
        let map = terms().lock().expect("terms lock");
        map.get(id).map(|t| t.buffer.len()).unwrap_or(0)
    };
    let mut last_change = Instant::now();
    loop {
        thread::sleep(Duration::from_millis(60));
        let (len, alive) = {
            let mut map = terms().lock().expect("terms lock");
            reap_terms(&mut map);
            match map.get(id) {
                Some(term) => (term.buffer.len(), term.child.is_some()),
                None => return Err(format!("未知终端 {id}")),
            }
        };
        if len != last_len {
            last_len = len;
            last_change = Instant::now();
        }
        let timed_out = started.elapsed() >= timeout;
        let quiet_enough =
            last_change.elapsed() >= quiet && started.elapsed() >= Duration::from_millis(250);
        if timed_out || quiet_enough || !alive {
            break;
        }
    }

    let mut map = terms().lock().expect("terms lock");
    let term = map.get_mut(id).ok_or_else(|| format!("未知终端 {id}"))?;
    let output = term.buffer[term.cursor.min(term.buffer.len())..].to_string();
    term.cursor = term.buffer.len();
    Ok(TermOutputHit {
        id: term.id.clone(),
        output,
        alive: term.child.is_some(),
    })
}

fn reap_terms(map: &mut HashMap<String, TermState>) {
    for term in map.values_mut() {
        let Some(child) = term.child.as_mut() else {
            continue;
        };
        match child.try_wait() {
            Ok(Some(_)) => {
                term.child = None;
                term.writer = None;
                term._master = None;
            }
            Ok(None) => {}
            Err(_) => {
                term.child = None;
                term.writer = None;
                term._master = None;
            }
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeHit {
    input: String,
    output: String,
    backend: Option<String>,
}

struct OfficeOp {
    child: Option<Child>,
    tree: Option<ProcessTree>,
    /// Set when cancel wins the race against normal completion.
    cancelled: bool,
}

fn office_ops() -> &'static Mutex<HashMap<String, OfficeOp>> {
    static OPS: OnceLock<Mutex<HashMap<String, OfficeOp>>> = OnceLock::new();
    OPS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Convert an Office document to PDF via the DSH LibreOffice Kit Node bridge.
/// Pass `op_id` so the frontend can hard-cancel via `agent_office_cancel`.
#[tauri::command]
pub async fn agent_office_to_pdf(
    root: String,
    input: String,
    output: String,
    op_id: Option<String>,
) -> Result<OfficeHit, String> {
    let root = root.trim().to_string();
    let input = input.trim().to_string();
    let output = output.trim().to_string();
    let op_id = op_id
        .unwrap_or_default()
        .trim()
        .chars()
        .take(80)
        .collect::<String>();
    if root.is_empty() {
        return Err("未绑定工作区".into());
    }
    let root_path = canonicalize_existing(Path::new(&root))?;
    let input_path = resolve_workspace_file(&root_path, &input, true)?;
    let output_path = resolve_workspace_file(&root_path, &output, false)?;
    if !input_path.is_file() {
        return Err("输入文件不存在".into());
    }
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("无法创建输出目录：{err}"))?;
    }
    if output_path.exists() {
        fs::remove_file(&output_path).map_err(|err| format!("无法覆盖已有 PDF：{err}"))?;
    }
    let script = office_bridge_script()?;
    let node = find_node_bin()?;
    let input_for_cmd = input_path.clone();
    let output_for_cmd = output_path.clone();
    let track_id = op_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_office_bridge(&node, &script, &input_for_cmd, &output_for_cmd, &track_id)
    })
    .await
    .map_err(|err| format!("LibreOffice 桥接任务失败：{err}"))??;
    if !output_path.is_file() {
        return Err("转换完成但未找到输出 PDF".into());
    }
    Ok(OfficeHit {
        input: input_path.to_string_lossy().into_owned(),
        output: output_path.to_string_lossy().into_owned(),
        backend: result,
    })
}

/// Hard-kill an in-flight `agent_office_to_pdf` (Job Object / process group).
#[tauri::command]
pub fn agent_office_cancel(op_id: String) -> Result<bool, String> {
    let id = op_id.trim();
    if id.is_empty() {
        return Err("请提供 op_id".into());
    }
    let mut map = office_ops().lock().expect("office ops lock");
    let Some(op) = map.get_mut(id) else {
        return Ok(false);
    };
    op.cancelled = true;
    if let Some(mut child) = op.child.take() {
        if let Some(mut tree) = op.tree.take() {
            tree.kill_tree(&mut child);
        } else {
            let _ = child.kill();
            let _ = child.wait();
        }
        return Ok(true);
    }
    Ok(false)
}

fn run_office_bridge(
    node: &Path,
    script: &Path,
    input: &Path,
    output: &Path,
    op_id: &str,
) -> Result<Option<String>, String> {
    let mut cmd = Command::new(node);
    cmd.arg(script)
        .arg("--input")
        .arg(input)
        .arg("--output")
        .arg(output)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    ProcessTree::prepare(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|err| format!("无法启动 LibreOffice 桥接：{err}"))?;
    let tree = ProcessTree::bind(&child);
    if !op_id.is_empty() {
        let mut map = office_ops().lock().expect("office ops lock");
        map.insert(
            op_id.to_string(),
            OfficeOp {
                child: None,
                tree: None,
                cancelled: false,
            },
        );
        // Store after insert so cancel can find the slot even mid-move.
        if let Some(op) = map.get_mut(op_id) {
            if op.cancelled {
                // Cancel arrived before we registered the child.
                let mut tree = tree;
                tree.kill_tree(&mut child);
                map.remove(op_id);
                return Err("Office 转 PDF 已取消".into());
            }
            op.child = Some(child);
            op.tree = Some(tree);
        }
    } else {
        // No cancel handle: wait normally with tree cleanup on drop.
        let finished = wait_child_output(child, Some(tree))?;
        return finish_office_output(finished);
    }

    // Poll so `agent_office_cancel` can steal and kill the child.
    let finished = loop {
        let cancelled = {
            let map = office_ops().lock().expect("office ops lock");
            map.get(op_id).map(|op| op.cancelled).unwrap_or(true)
        };
        if cancelled {
            // Cancel path already killed; drain registry.
            let mut map = office_ops().lock().expect("office ops lock");
            map.remove(op_id);
            return Err("Office 转 PDF 已取消".into());
        }
        let status = {
            let mut map = office_ops().lock().expect("office ops lock");
            let op = map.get_mut(op_id).ok_or_else(|| "Office 转 PDF 已取消".to_string())?;
            match op.child.as_mut() {
                Some(child) => child.try_wait().map_err(|err| format!("等待进程失败：{err}"))?,
                None => {
                    map.remove(op_id);
                    return Err("Office 转 PDF 已取消".into());
                }
            }
        };
        if let Some(status) = status {
            let mut map = office_ops().lock().expect("office ops lock");
            let Some(mut op) = map.remove(op_id) else {
                return Err("Office 转 PDF 已取消".into());
            };
            let mut child = op.child.take().ok_or_else(|| "Office 转 PDF 已取消".to_string())?;
            let tree = op.tree.take();
            let mut stdout = Vec::new();
            let mut stderr = Vec::new();
            if let Some(mut out) = child.stdout.take() {
                let _ = out.read_to_end(&mut stdout);
            }
            if let Some(mut err) = child.stderr.take() {
                let _ = err.read_to_end(&mut stderr);
            }
            drop(tree);
            break std::process::Output {
                status,
                stdout,
                stderr,
            };
        }
        thread::sleep(Duration::from_millis(40));
    };
    finish_office_output(finished)
}

fn wait_child_output(
    child: Child,
    tree: Option<ProcessTree>,
) -> Result<std::process::Output, String> {
    let output = child
        .wait_with_output()
        .map_err(|err| format!("LibreOffice 桥接失败：{err}"))?;
    drop(tree);
    Ok(output)
}

fn finish_office_output(finished: std::process::Output) -> Result<Option<String>, String> {
    let stdout = String::from_utf8_lossy(&finished.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&finished.stderr).trim().to_string();
    if !finished.status.success() {
        let detail = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("退出码 {}", finished.status.code().unwrap_or(-1))
        };
        return Err(format!("Office 转 PDF 失败：{detail}"));
    }
    let backend = stdout
        .lines()
        .rev()
        .find_map(|line| line.strip_prefix("backend=").map(|v| v.trim().to_string()));
    Ok(backend)
}

fn resolve_workspace_file(
    root_path: &Path,
    path: &str,
    must_exist: bool,
) -> Result<PathBuf, String> {
    let candidate = if Path::new(path).is_absolute() {
        PathBuf::from(path)
    } else {
        root_path.join(path)
    };
    if must_exist {
        let resolved = canonicalize_existing(&candidate)?;
        if !resolved.starts_with(root_path) {
            return Err("路径超出工作区范围".into());
        }
        return Ok(resolved);
    }
    let parent = candidate
        .parent()
        .ok_or_else(|| "输出路径无效".to_string())?;
    if parent.exists() {
        let parent_canon = canonicalize_existing(parent)?;
        if !parent_canon.starts_with(root_path) {
            return Err("路径超出工作区范围".into());
        }
        let name = candidate
            .file_name()
            .ok_or_else(|| "输出路径无效".to_string())?;
        return Ok(parent_canon.join(name));
    }
    // Parent will be created later; require a lexical containment under root.
    if !candidate.starts_with(root_path) {
        return Err("路径超出工作区范围".into());
    }
    Ok(candidate)
}

fn office_bridge_script() -> Result<PathBuf, String> {
    if let Ok(from_env) = std::env::var("WB_OFFICE_BRIDGE") {
        let path = PathBuf::from(from_env.trim());
        if path.is_file() {
            return Ok(path);
        }
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("office-to-pdf.mjs"));
            candidates.push(dir.join("resources").join("office-to-pdf.mjs"));
            candidates.push(dir.join("scripts").join("office-to-pdf.mjs"));
        }
    }
    // Dev: apps/desktop/src-tauri → ../scripts/office-to-pdf.mjs
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts/office-to-pdf.mjs"));
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../scripts/office-to-pdf.mjs"));
    for path in candidates {
        if path.is_file() {
            return Ok(path);
        }
    }
    Err("找不到 office-to-pdf.mjs（可设 WB_OFFICE_BRIDGE）".into())
}

fn find_node_bin() -> Result<PathBuf, String> {
    if let Ok(from_env) = std::env::var("WB_NODE_BIN") {
        let path = PathBuf::from(from_env.trim());
        if path.is_file() {
            return Ok(path);
        }
    }
    #[cfg(windows)]
    {
        for name in ["node.exe", "node"] {
            if let Ok(output) = Command::new("where").arg(name).output() {
                if output.status.success() {
                    if let Some(line) = String::from_utf8_lossy(&output.stdout).lines().next() {
                        let path = PathBuf::from(line.trim());
                        if path.is_file() {
                            return Ok(path);
                        }
                    }
                }
            }
        }
        let fallback = PathBuf::from(r"C:\software\nodejs\node.exe");
        if fallback.is_file() {
            return Ok(fallback);
        }
    }
    #[cfg(not(windows))]
    {
        if let Ok(output) = Command::new("which").arg("node").output() {
            if output.status.success() {
                if let Some(line) = String::from_utf8_lossy(&output.stdout).lines().next() {
                    let path = PathBuf::from(line.trim());
                    if path.is_file() {
                        return Ok(path);
                    }
                }
            }
        }
    }
    Err("找不到 node（可设 WB_NODE_BIN）".into())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeBin {
    path: String,
    version: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePathsHit {
    node: Option<RuntimeBin>,
    python: Option<RuntimeBin>,
    pnpm: Option<RuntimeBin>,
    source: String,
}

/// Host PATH probe for `load_workspace_dependencies` (not a DSH payload install).
#[tauri::command]
pub fn agent_workspace_runtime_paths() -> RuntimePathsHit {
    RuntimePathsHit {
        node: probe_bin(
            &["node", "node.exe"],
            &["-v"],
            &[r"C:\software\nodejs\node.exe"],
        ),
        python: probe_bin(
            &["python", "python3", "python.exe"],
            &["--version"],
            &[],
        ),
        pnpm: probe_bin(&["pnpm", "pnpm.cmd"], &["--version"], &[]),
        source: "host-path".into(),
    }
}

fn probe_bin(names: &[&str], version_args: &[&str], fallbacks: &[&str]) -> Option<RuntimeBin> {
    for name in names {
        if let Some(path) = resolve_on_path(name) {
            let version = read_version(&path, version_args);
            return Some(RuntimeBin {
                path: path.display().to_string(),
                version,
            });
        }
    }
    for fallback in fallbacks {
        let path = PathBuf::from(fallback);
        if path.is_file() {
            let version = read_version(&path, version_args);
            return Some(RuntimeBin {
                path: path.display().to_string(),
                version,
            });
        }
    }
    None
}

fn resolve_on_path(name: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        if let Ok(output) = Command::new("where").arg(name).output() {
            if output.status.success() {
                if let Some(line) = String::from_utf8_lossy(&output.stdout).lines().next() {
                    let path = PathBuf::from(line.trim());
                    if path.is_file() {
                        return Some(path);
                    }
                }
            }
        }
    }
    #[cfg(not(windows))]
    {
        if let Ok(output) = Command::new("which").arg(name).output() {
            if output.status.success() {
                if let Some(line) = String::from_utf8_lossy(&output.stdout).lines().next() {
                    let path = PathBuf::from(line.trim());
                    if path.is_file() {
                        return Some(path);
                    }
                }
            }
        }
    }
    None
}

fn read_version(bin: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new(bin).args(args).output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let err = String::from_utf8_lossy(&output.stderr);
    let line = text.lines().next().or_else(|| err.lines().next())?;
    let trimmed = line.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}
