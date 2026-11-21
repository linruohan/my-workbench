use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellResult {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

pub fn run_shell(command: &str, cwd: Option<&str>, timeout_secs: u64) -> Result<ShellResult> {
    run_shell_in(command, cwd, cwd, timeout_secs)
}

pub fn run_shell_in(
    command: &str,
    cwd: Option<&str>,
    workspace_root: Option<&str>,
    timeout_secs: u64,
) -> Result<ShellResult> {
    #[cfg(windows)]
    {
        run_shell_kind("cmd", command, cwd, workspace_root, timeout_secs)
    }
    #[cfg(not(windows))]
    {
        run_shell_kind("bash", command, cwd, workspace_root, timeout_secs)
    }
}

/// Run with an explicit shell kind: `bash` / `pwsh` / `cmd`.
pub fn run_shell_kind(
    kind: &str,
    command: &str,
    cwd: Option<&str>,
    workspace_root: Option<&str>,
    timeout_secs: u64,
) -> Result<ShellResult> {
    let mut cmd = match kind.to_lowercase().as_str() {
        "bash" | "sh" => {
            let mut c = Command::new("bash");
            c.args(["-lc", command]);
            c
        }
        "pwsh" | "powershell" => {
            let mut c = Command::new("pwsh");
            c.args(["-NoProfile", "-NonInteractive", "-Command", command]);
            c
        }
        _ => {
            #[cfg(windows)]
            {
                let mut c = Command::new("cmd");
                c.args(["/C", command]);
                c
            }
            #[cfg(not(windows))]
            {
                let mut c = Command::new("sh");
                c.args(["-lc", command]);
                c
            }
        }
    };
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    apply_agent_shell_env(&mut cmd, workspace_root.or(cwd), cwd);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().context("启动 shell 失败")?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out_buf = Arc::new(Mutex::new(Vec::new()));
    let err_buf = Arc::new(Mutex::new(Vec::new()));
    if let Some(mut out) = stdout {
        let buf = out_buf.clone();
        thread::spawn(move || {
            let mut local = Vec::new();
            let _ = out.read_to_end(&mut local);
            *buf.lock().unwrap() = local;
        });
    }
    if let Some(mut err) = stderr {
        let buf = err_buf.clone();
        thread::spawn(move || {
            let mut local = Vec::new();
            let _ = err.read_to_end(&mut local);
            *buf.lock().unwrap() = local;
        });
    }
    let started = std::time::Instant::now();
    loop {
        match child.try_wait()? {
            Some(status) => {
                thread::sleep(Duration::from_millis(20));
                let stdout = String::from_utf8_lossy(&out_buf.lock().unwrap()).to_string();
                let stderr = String::from_utf8_lossy(&err_buf.lock().unwrap()).to_string();
                return Ok(ShellResult {
                    code: status.code().unwrap_or(-1),
                    stdout,
                    stderr,
                });
            }
            None if started.elapsed() > Duration::from_secs(timeout_secs) => {
                let _ = child.kill();
                anyhow::bail!("命令超时（{timeout_secs}s）");
            }
            None => thread::sleep(Duration::from_millis(50)),
        }
    }
}

/// Scrub inherited secrets / host `WB_*`, then inject managed agent facts.
pub fn apply_agent_shell_env(cmd: &mut Command, workspace_root: Option<&str>, cwd: Option<&str>) {
    cmd.env_clear();
    for (key, value) in scrubbed_agent_env(workspace_root, cwd) {
        cmd.env(key, value);
    }
}

/// Allowlisted environment for agent shells and PTY sessions.
pub fn scrubbed_agent_env(
    workspace_root: Option<&str>,
    cwd: Option<&str>,
) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for (key, value) in std::env::vars() {
        if is_allowed_env_key(&key) {
            out.push((key, value));
        }
    }
    out.push(("WB_AGENT_SHELL".into(), "1".into()));
    if let Some(home) = dirs::home_dir() {
        out.push(("WB_HOME".into(), home.display().to_string()));
    }
    if let Some(root) = workspace_root.filter(|s| !s.is_empty()) {
        out.push(("WB_WORKSPACE_ROOT".into(), root.to_string()));
    }
    if let Some(cwd) = cwd.filter(|s| !s.is_empty()) {
        out.push(("WB_CWD".into(), cwd.to_string()));
    } else if let Some(root) = workspace_root.filter(|s| !s.is_empty()) {
        out.push(("WB_CWD".into(), root.to_string()));
    }
    out.push(("TERM".into(), "xterm-256color".into()));
    out
}

fn is_allowed_env_key(key: &str) -> bool {
    if key.starts_with("WB_") {
        return false;
    }
    let upper = key.to_ascii_uppercase();
    if upper.contains("SECRET")
        || upper.contains("PASSWORD")
        || upper.contains("TOKEN")
        || upper.contains("API_KEY")
        || upper.contains("ACCESS_KEY")
    {
        return false;
    }
    const ALLOW: &[&str] = &[
        "PATH",
        "PATHEXT",
        "SystemRoot",
        "SYSTEMROOT",
        "WINDIR",
        "COMSPEC",
        "HOME",
        "USERPROFILE",
        "USERNAME",
        "USER",
        "TEMP",
        "TMP",
        "TMPDIR",
        "LANG",
        "LC_ALL",
        "TERM",
        "COLORTERM",
        "NUMBER_OF_PROCESSORS",
        "PROCESSOR_ARCHITECTURE",
        "OS",
        "HOMEDRIVE",
        "HOMEPATH",
        "APPDATA",
        "LOCALAPPDATA",
        "ProgramData",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "PSModulePath",
        "PROMPT",
        "SHELL",
        "SHLVL",
    ];
    ALLOW.iter().any(|k| k.eq_ignore_ascii_case(key))
}

/// Probe common workspace toolchain binaries on PATH.
pub fn probe_workspace_dependencies() -> Vec<(String, Option<String>)> {
    const NAMES: &[&str] = &[
        "node", "npm", "pnpm", "yarn", "python", "python3", "pip", "cargo", "rustc", "git", "rg",
    ];
    NAMES
        .iter()
        .map(|name| ((*name).to_string(), which_bin(name)))
        .collect()
}

pub fn which_bin(name: &str) -> Option<String> {
    #[cfg(windows)]
    {
        let out = Command::new("where")
            .arg(name)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .next()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }
    #[cfg(not(windows))]
    {
        let out = Command::new("which")
            .arg(name)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .next()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobInfo {
    pub id: String,
    pub command: String,
    pub done: bool,
    pub code: Option<i32>,
}

#[derive(Default)]
pub struct JobRegistry {
    inner: Mutex<HashMap<String, JobState>>,
}

struct JobState {
    command: String,
    pid: Arc<Mutex<Option<u32>>>,
    output: Arc<Mutex<String>>,
    done: Arc<Mutex<Option<i32>>>,
}

impl JobRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn start(
        &self,
        command: &str,
        cwd: Option<&str>,
        workspace_root: Option<&str>,
    ) -> Result<String> {
        let id = Uuid::new_v4().to_string();
        let output = Arc::new(Mutex::new(String::new()));
        let done = Arc::new(Mutex::new(None));
        let pid = Arc::new(Mutex::new(None));
        {
            let mut map = self.inner.lock().unwrap();
            map.insert(
                id.clone(),
                JobState {
                    command: command.to_string(),
                    pid: pid.clone(),
                    output: output.clone(),
                    done: done.clone(),
                },
            );
        }
        let command = command.to_string();
        let cwd = cwd.map(|s| s.to_string());
        let workspace_root = workspace_root.map(|s| s.to_string());
        thread::spawn(move || {
            #[cfg(windows)]
            let mut cmd = {
                let mut c = Command::new("cmd");
                c.args(["/C", &command]);
                c
            };
            #[cfg(not(windows))]
            let mut cmd = {
                let mut c = Command::new("sh");
                c.args(["-lc", &command]);
                c
            };
            if let Some(ref cwd) = cwd {
                cmd.current_dir(cwd);
            }
            apply_agent_shell_env(
                &mut cmd,
                workspace_root.as_deref().or(cwd.as_deref()),
                cwd.as_deref(),
            );
            cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
            match cmd.spawn() {
                Ok(mut child) => {
                    *pid.lock().unwrap() = Some(child.id());
                    let mut out = String::new();
                    if let Some(mut s) = child.stdout.take() {
                        let mut buf = Vec::new();
                        let _ = s.read_to_end(&mut buf);
                        out.push_str(&String::from_utf8_lossy(&buf));
                    }
                    if let Some(mut s) = child.stderr.take() {
                        let mut buf = Vec::new();
                        let _ = s.read_to_end(&mut buf);
                        if !out.is_empty() && !buf.is_empty() {
                            out.push('\n');
                        }
                        out.push_str(&String::from_utf8_lossy(&buf));
                    }
                    let code = child.wait().ok().and_then(|s| s.code()).unwrap_or(-1);
                    *output.lock().unwrap() = out;
                    *done.lock().unwrap() = Some(code);
                    *pid.lock().unwrap() = None;
                }
                Err(e) => {
                    *output.lock().unwrap() = e.to_string();
                    *done.lock().unwrap() = Some(-1);
                }
            }
        });
        Ok(id)
    }

    pub fn output(&self, id: &str) -> Option<(String, Option<i32>)> {
        let map = self.inner.lock().unwrap();
        let job = map.get(id)?;
        Some((
            job.output.lock().unwrap().clone(),
            *job.done.lock().unwrap(),
        ))
    }

    pub fn list(&self) -> Vec<JobInfo> {
        let map = self.inner.lock().unwrap();
        let mut v: Vec<_> = map
            .iter()
            .map(|(id, j)| {
                let code = *j.done.lock().unwrap();
                JobInfo {
                    id: id.clone(),
                    command: j.command.clone(),
                    done: code.is_some(),
                    code,
                }
            })
            .collect();
        v.sort_by(|a, b| a.id.cmp(&b.id));
        v
    }

    pub fn kill(&self, id: &str) -> bool {
        let map = self.inner.lock().unwrap();
        let Some(job) = map.get(id) else {
            return false;
        };
        if let Some(pid) = *job.pid.lock().unwrap() {
            kill_pid(pid);
        }
        if job.done.lock().unwrap().is_none() {
            *job.done.lock().unwrap() = Some(-9);
            let mut out = job.output.lock().unwrap();
            if out.is_empty() {
                *out = "[killed]".into();
            } else {
                out.push_str("\n[killed]");
            }
        }
        true
    }
}

fn kill_pid(pid: u32) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status();
    }
}

static GLOBAL_JOBS: OnceLock<JobRegistry> = OnceLock::new();

pub fn global_jobs() -> &'static JobRegistry {
    GLOBAL_JOBS.get_or_init(JobRegistry::new)
}

pub fn write_stdin_line(child_stdin: &mut impl Write, line: &str) -> Result<()> {
    writeln!(child_stdin, "{line}")?;
    Ok(())
}

#[cfg(test)]
mod env_tests {
    use super::*;

    #[test]
    fn allowlist_keeps_path_drops_secrets_and_wb() {
        assert!(is_allowed_env_key("PATH"));
        assert!(is_allowed_env_key("Path"));
        assert!(!is_allowed_env_key("WB_HOME"));
        assert!(!is_allowed_env_key("OPENAI_API_KEY"));
        assert!(!is_allowed_env_key("MY_SECRET"));
    }
}
