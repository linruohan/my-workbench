//! Lightweight terminal sessions (command log + cwd). Not a real PTY/ConPTY.

use crate::shell::run_shell;
use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub id: String,
    pub shell: String,
    pub cwd: String,
    pub closed: bool,
}

struct TerminalSession {
    shell: String,
    cwd: PathBuf,
    buffer: String,
    closed: bool,
}

#[derive(Default)]
pub struct TerminalRegistry {
    inner: Mutex<HashMap<String, TerminalSession>>,
}

impl TerminalRegistry {
    pub fn open(&self, shell: &str, cwd: Option<&Path>) -> Result<String> {
        let cwd = cwd
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
        let id = Uuid::new_v4().to_string();
        let shell = if shell.trim().is_empty() {
            default_shell().to_string()
        } else {
            shell.trim().to_string()
        };
        let mut map = self.inner.lock().unwrap();
        map.insert(
            id.clone(),
            TerminalSession {
                shell,
                cwd,
                buffer: String::new(),
                closed: false,
            },
        );
        Ok(id)
    }

    pub fn send(&self, id: &str, command: &str) -> Result<String> {
        let mut map = self.inner.lock().unwrap();
        let Some(session) = map.get_mut(id) else {
            bail!("终端不存在");
        };
        if session.closed {
            bail!("终端已关闭");
        }
        let cwd = session.cwd.to_string_lossy().to_string();
        let line = format!("$ {command}\n");
        session.buffer.push_str(&line);
        // Drop lock while running shell.
        let shell = session.shell.clone();
        drop(map);

        let wrapped = wrap_command(&shell, command);
        let result = run_shell(&wrapped, Some(&cwd), 120);
        let mut map = self.inner.lock().unwrap();
        let Some(session) = map.get_mut(id) else {
            bail!("终端不存在");
        };
        match result {
            Ok(r) => {
                if !r.stdout.is_empty() {
                    session.buffer.push_str(&r.stdout);
                    if !r.stdout.ends_with('\n') {
                        session.buffer.push('\n');
                    }
                }
                if !r.stderr.is_empty() {
                    session.buffer.push_str(&r.stderr);
                    if !r.stderr.ends_with('\n') {
                        session.buffer.push('\n');
                    }
                }
                session.buffer.push_str(&format!("[exit {}]\n", r.code));
                Ok(session.buffer.clone())
            }
            Err(e) => {
                session.buffer.push_str(&format!("[error] {e}\n"));
                Err(e)
            }
        }
    }

    pub fn read(&self, id: &str) -> Result<String> {
        let map = self.inner.lock().unwrap();
        let Some(session) = map.get(id) else {
            bail!("终端不存在");
        };
        Ok(session.buffer.clone())
    }

    pub fn list(&self) -> Vec<TerminalInfo> {
        let map = self.inner.lock().unwrap();
        let mut v: Vec<_> = map
            .iter()
            .map(|(id, s)| TerminalInfo {
                id: id.clone(),
                shell: s.shell.clone(),
                cwd: s.cwd.display().to_string(),
                closed: s.closed,
            })
            .collect();
        v.sort_by(|a, b| a.id.cmp(&b.id));
        v
    }

    pub fn close(&self, id: &str) -> bool {
        let mut map = self.inner.lock().unwrap();
        if let Some(session) = map.get_mut(id) {
            session.closed = true;
            true
        } else {
            false
        }
    }

    pub fn signal(&self, id: &str, signal: &str) -> Result<String> {
        let map = self.inner.lock().unwrap();
        let Some(session) = map.get(id) else {
            bail!("终端不存在");
        };
        if session.closed {
            bail!("终端已关闭");
        }
        // Non-PTY: record a signal marker; next command is independent.
        drop(map);
        let mut map = self.inner.lock().unwrap();
        if let Some(session) = map.get_mut(id) {
            session
                .buffer
                .push_str(&format!("[signal {signal} — 轻量终端无进程组，仅记录]\n"));
        }
        Ok(format!("已记录 signal={signal}"))
    }

    pub fn set_cwd(&self, id: &str, cwd: &Path) -> Result<()> {
        let mut map = self.inner.lock().unwrap();
        let Some(session) = map.get_mut(id) else {
            bail!("终端不存在");
        };
        session.cwd = cwd.to_path_buf();
        session
            .buffer
            .push_str(&format!("[cwd {}]\n", cwd.display()));
        Ok(())
    }
}

fn default_shell() -> &'static str {
    #[cfg(windows)]
    {
        "pwsh"
    }
    #[cfg(not(windows))]
    {
        "bash"
    }
}

fn wrap_command(shell: &str, command: &str) -> String {
    match shell.to_lowercase().as_str() {
        "bash" | "sh" => command.to_string(),
        "cmd" => command.to_string(),
        _ => command.to_string(), // pwsh / powershell: still via cmd /C or sh -lc wrapper in run_shell
    }
}

static GLOBAL_TERMINALS: OnceLock<TerminalRegistry> = OnceLock::new();

pub fn global_terminals() -> &'static TerminalRegistry {
    GLOBAL_TERMINALS.get_or_init(TerminalRegistry::default)
}

/// Session working directory override for agent file/shell tools.
static AGENT_CWD: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

fn agent_cwd_slot() -> &'static Mutex<Option<PathBuf>> {
    AGENT_CWD.get_or_init(|| Mutex::new(None))
}

pub fn get_agent_cwd() -> Option<PathBuf> {
    agent_cwd_slot().lock().unwrap().clone()
}

pub fn set_agent_cwd(path: Option<PathBuf>) {
    *agent_cwd_slot().lock().unwrap() = path;
}

fn path_under(path: &Path, root: &Path) -> bool {
    match (path.canonicalize(), root.canonicalize()) {
        (Ok(p), Ok(r)) => p.starts_with(r),
        _ => path.starts_with(root),
    }
}

/// Resolve session cwd. If an override exists but is missing or outside `workspace_root`,
/// it is ignored (and cleared when missing) so callers fall back to the workspace.
pub fn resolve_agent_cwd(workspace_root: Option<&str>) -> Option<PathBuf> {
    if let Some(cwd) = get_agent_cwd() {
        if !cwd.is_dir() {
            set_agent_cwd(None);
        } else if let Some(ws) = workspace_root {
            if path_under(&cwd, Path::new(ws)) {
                return Some(cwd);
            }
        } else {
            return Some(cwd);
        }
    }
    workspace_root.map(PathBuf::from)
}
