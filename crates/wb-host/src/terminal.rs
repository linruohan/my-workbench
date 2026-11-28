//! Interactive terminal sessions backed by portable-pty (Windows ConPTY / Unix PTY).

use crate::shell::{scrubbed_agent_env, which_bin};
use anyhow::{Result, bail};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

const OUTPUT_LIMIT: usize = 400_000;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
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
    buffer: Arc<Mutex<String>>,
    writer: Option<Box<dyn Write + Send>>,
    child: Option<Box<dyn Child + Send>>,
    master: Option<Box<dyn MasterPty + Send>>,
    closed: bool,
}

#[derive(Default)]
pub struct TerminalRegistry {
    inner: Mutex<std::collections::HashMap<String, TerminalSession>>,
}

impl TerminalRegistry {
    pub fn open(&self, shell: &str, cwd: Option<&Path>) -> Result<String> {
        let cwd = cwd
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
        let shell_label = resolve_terminal_shell(shell);
        if shell_label.eq_ignore_ascii_case("alacritty") {
            return self.open_alacritty(&cwd);
        }
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 32,
                cols: 120,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| anyhow::anyhow!("无法创建 PTY：{e}"))?;
        let mut cmd = interactive_shell(&shell_label);
        cmd.cwd(cwd.as_os_str());
        cmd.env_clear();
        let cwd_s = cwd.display().to_string();
        for (k, v) in scrubbed_agent_env(Some(&cwd_s), Some(&cwd_s)) {
            cmd.env(k, v);
        }
        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| anyhow::anyhow!("无法在 PTY 中启动 shell：{e}"))?;
        drop(pair.slave);
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| anyhow::anyhow!("无法读取 PTY：{e}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| anyhow::anyhow!("无法写入 PTY：{e}"))?;
        let id = Uuid::new_v4().to_string();
        let buffer = Arc::new(Mutex::new(String::new()));
        let pump_buf = buffer.clone();
        let pump_id = id.clone();
        thread::spawn(move || pump_term(pump_id, &mut reader, pump_buf));
        thread::sleep(Duration::from_millis(120));
        let mut map = self.inner.lock().unwrap();
        map.insert(
            id.clone(),
            TerminalSession {
                shell: shell_label,
                cwd,
                buffer,
                writer: Some(writer),
                child: Some(child),
                master: Some(pair.master),
                closed: false,
            },
        );
        Ok(id)
    }

    fn open_alacritty(&self, cwd: &Path) -> Result<String> {
        let bin = which_bin("alacritty").unwrap_or_else(|| "alacritty".to_string());
        std::process::Command::new(&bin)
            .arg("--working-directory")
            .arg(cwd)
            .spawn()
            .map_err(|err| anyhow::anyhow!("无法打开 Alacritty：{err}"))?;
        let id = Uuid::new_v4().to_string();
        let buffer = Arc::new(Mutex::new(
            "已在独立的 Alacritty 窗口中打开。输入请在那个窗口里进行。\n".to_string(),
        ));
        let mut map = self.inner.lock().unwrap();
        map.insert(
            id.clone(),
            TerminalSession {
                shell: "alacritty".into(),
                cwd: cwd.to_path_buf(),
                buffer,
                writer: None,
                child: None,
                master: None,
                closed: true,
            },
        );
        Ok(id)
    }

    pub fn paste(&self, id: &str, text: &str) -> Result<()> {
        if text.len() > 32_000 || text.contains('\0') {
            bail!("输入无效");
        }
        let text = text.replace("\r\n", "\n").replace('\n', "\r");
        self.write_bytes(id, text.as_bytes())
    }

    fn write_bytes(&self, id: &str, bytes: &[u8]) -> Result<()> {
        let mut writer = {
            let mut map = self.inner.lock().unwrap();
            let Some(session) = map.get_mut(id) else {
                bail!("终端不存在");
            };
            if session.closed || session.child.is_none() {
                bail!("终端已关闭");
            }
            session
                .writer
                .take()
                .ok_or_else(|| anyhow::anyhow!("终端已关闭"))?
        };
        let write_result = (|| -> Result<()> {
            writer.write_all(bytes)?;
            writer.flush()?;
            Ok(())
        })();
        {
            let mut map = self.inner.lock().unwrap();
            if let Some(session) = map.get_mut(id) {
                if write_result.is_ok() {
                    session.writer = Some(writer);
                }
            }
        }
        write_result
    }

    pub fn send(&self, id: &str, command: &str) -> Result<String> {
        if command.len() > 32_000 || command.contains('\0') {
            bail!("输入无效");
        }
        let mut bytes = command.as_bytes().to_vec();
        bytes.push(b'\r');
        self.write_bytes(id, &bytes)?;

        let started = Instant::now();
        let timeout = Duration::from_secs(8);
        let quiet = Duration::from_millis(400);
        let baseline = self.buffer_len(id);
        let mut last_len = baseline;
        let mut last_change = Instant::now();
        loop {
            thread::sleep(Duration::from_millis(60));
            let (len, alive) = {
                let map = self.inner.lock().unwrap();
                match map.get(id) {
                    Some(session) => (
                        session.buffer.lock().unwrap().len(),
                        session.child.is_some() && !session.closed,
                    ),
                    None => bail!("终端不存在"),
                }
            };
            if len != last_len {
                last_len = len;
                last_change = Instant::now();
            }
            let grew = len > baseline;
            let quiet_enough = grew && last_change.elapsed() >= quiet;
            if started.elapsed() >= timeout || quiet_enough || !alive {
                break;
            }
        }
        self.read(id)
    }

    pub fn read(&self, id: &str) -> Result<String> {
        let map = self.inner.lock().unwrap();
        let Some(session) = map.get(id) else {
            bail!("终端不存在");
        };
        let raw = session.buffer.lock().unwrap().clone();
        Ok(strip_ansi(&raw))
    }

    pub fn list(&self) -> Vec<TerminalInfo> {
        let map = self.inner.lock().unwrap();
        let mut v: Vec<_> = map
            .iter()
            .map(|(id, s)| TerminalInfo {
                id: id.clone(),
                shell: s.shell.clone(),
                cwd: s.cwd.display().to_string(),
                closed: s.closed || s.child.is_none(),
            })
            .collect();
        v.sort_by(|a, b| a.id.cmp(&b.id));
        v
    }

    pub fn close(&self, id: &str) -> bool {
        let taken = {
            let mut map = self.inner.lock().unwrap();
            let Some(session) = map.get_mut(id) else {
                return false;
            };
            session.closed = true;
            session.writer.take();
            session.master.take();
            session.child.take()
        };
        if let Some(mut child) = taken {
            let _ = child.kill();
            let _ = child.wait();
        }
        true
    }

    pub fn signal(&self, id: &str, signal: &str) -> Result<String> {
        let kind = signal.trim().to_ascii_uppercase();
        if matches!(kind.as_str(), "SIGKILL" | "KILL" | "SIGTERM" | "TERM") {
            let child = {
                let mut map = self.inner.lock().unwrap();
                let Some(session) = map.get_mut(id) else {
                    bail!("终端不存在");
                };
                if session.closed {
                    bail!("终端已关闭");
                }
                session.closed = true;
                session.writer.take();
                session.master.take();
                session.child.take()
            };
            if let Some(mut child) = child {
                let _ = child.kill();
                let _ = child.wait();
            }
            return Ok(format!("已结束终端进程 signal={kind}"));
        }
        let mut writer = {
            let mut map = self.inner.lock().unwrap();
            let Some(session) = map.get_mut(id) else {
                bail!("终端不存在");
            };
            if session.closed {
                bail!("终端已关闭");
            }
            session
                .writer
                .take()
                .ok_or_else(|| anyhow::anyhow!("终端已关闭"))?
        };
        let result = (|| -> Result<()> {
            writer.write_all(&[0x03])?;
            writer.flush()?;
            Ok(())
        })();
        {
            let mut map = self.inner.lock().unwrap();
            if let Some(session) = map.get_mut(id) {
                if result.is_ok() {
                    session.writer = Some(writer);
                }
            }
        }
        result?;
        Ok(format!("已发送 Ctrl+C（{kind}）"))
    }

    pub fn set_cwd(&self, id: &str, cwd: &Path) -> Result<()> {
        let mut map = self.inner.lock().unwrap();
        let Some(session) = map.get_mut(id) else {
            bail!("终端不存在");
        };
        session.cwd = cwd.to_path_buf();
        let mut buf = session.buffer.lock().unwrap();
        buf.push_str(&format!("[cwd {}]\n", cwd.display()));
        Ok(())
    }

    fn buffer_len(&self, id: &str) -> usize {
        self.inner
            .lock()
            .unwrap()
            .get(id)
            .map(|s| s.buffer.lock().unwrap().len())
            .unwrap_or(0)
    }
}

fn pump_term(id: String, reader: &mut dyn Read, buffer: Arc<Mutex<String>>) {
    let _ = id;
    let mut buf = [0u8; 8 * 1024];
    let mut pending = Vec::new();
    loop {
        match reader.read(&mut buf) {
            Ok(0) => {
                let tail = take_text(&mut pending, true);
                if !tail.is_empty() {
                    append_limited(&buffer, &tail);
                }
                break;
            }
            Ok(n) => {
                pending.extend_from_slice(&buf[..n]);
                let chunk = take_text(&mut pending, false);
                if !chunk.is_empty() && !append_limited(&buffer, &chunk) {
                    break;
                }
            }
            Err(_) => {
                let tail = take_text(&mut pending, true);
                if !tail.is_empty() {
                    append_limited(&buffer, &tail);
                }
                break;
            }
        }
    }
}

fn append_limited(buffer: &Mutex<String>, chunk: &str) -> bool {
    let mut guard = buffer.lock().unwrap();
    if guard.len() >= OUTPUT_LIMIT {
        return false;
    }
    let room = OUTPUT_LIMIT - guard.len();
    let take = room.min(chunk.len());
    guard.push_str(&chunk[..take]);
    true
}

fn take_text(pending: &mut Vec<u8>, finish: bool) -> String {
    if pending.is_empty() {
        return String::new();
    }
    match std::str::from_utf8(pending) {
        Ok(s) => {
            let out = s.to_string();
            pending.clear();
            out
        }
        Err(err) => {
            let valid = err.valid_up_to();
            let out = String::from_utf8_lossy(&pending[..valid]).into_owned();
            if err.error_len().is_none() && !finish {
                pending.drain(..valid);
                out
            } else {
                let skip = valid + err.error_len().unwrap_or(1);
                let skip = skip.min(pending.len());
                pending.drain(..skip);
                out
            }
        }
    }
}

fn strip_ansi(input: &str) -> String {
    let b = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == 0x1b {
            i += 1;
            if i < b.len() && b[i] == b'[' {
                i += 1;
                while i < b.len() && !b[i].is_ascii_alphabetic() && b[i] != b'@' && b[i] != b'~' {
                    i += 1;
                }
                if i < b.len() {
                    i += 1;
                }
                continue;
            }
            if i < b.len() && b[i] == b']' {
                i += 1;
                while i < b.len() && b[i] != 0x07 && b[i] != b'\\' {
                    i += 1;
                }
                if i < b.len() {
                    i += 1;
                }
                continue;
            }
            continue;
        }
        if b[i] < 0x20 && b[i] != b'\n' && b[i] != b'\r' && b[i] != b'\t' {
            i += 1;
            continue;
        }
        let ch = input[i..].chars().next().unwrap_or('\u{FFFD}');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// Git for Windows `bash.exe`. `System32\bash.exe` is the WSL launcher and
/// exits or hangs inside ConPTY, so it is never used.
fn git_bash_exe() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    for key in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
        if let Some(root) = std::env::var_os(key) {
            candidates.push(PathBuf::from(root).join("Git").join("bin").join("bash.exe"));
        }
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(local)
                .join("Programs")
                .join("Git")
                .join("bin")
                .join("bash.exe"),
        );
    }
    candidates.push(PathBuf::from(r"C:\Program Files\Git\bin\bash.exe"));
    candidates.into_iter().find(|path| path.is_file())
}

fn default_shell() -> String {
    #[cfg(windows)]
    {
        if git_bash_exe().is_some() {
            "bash".into()
        } else if which_bin("pwsh").is_some() {
            "pwsh".into()
        } else {
            "powershell".into()
        }
    }
    #[cfg(not(windows))]
    {
        "bash".into()
    }
}

fn resolve_terminal_shell(shell: &str) -> String {
    match shell.trim().to_ascii_lowercase().as_str() {
        "" | "auto" => default_shell(),
        "psh" | "powershell" | "powershell.exe" => "powershell".into(),
        "cmd" | "cmd.exe" => "cmd".into(),
        "pwsh" | "pwsh.exe" => "pwsh".into(),
        "bash" | "sh" => "bash".into(),
        "alacritty" => "alacritty".into(),
        _ => shell.trim().to_string(),
    }
}

fn interactive_shell(shell: &str) -> CommandBuilder {
    let s = shell.to_ascii_lowercase();
    if s.contains("bash") || s == "sh" {
        // Full path to Git Bash. A bare `bash` on Windows often resolves to
        // the WSL stub. `--login -i` is what keeps the MSYS session alive in ConPTY.
        let bin = git_bash_exe()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "bash".into());
        let mut cmd = CommandBuilder::new(bin);
        cmd.arg("--login");
        cmd.arg("-i");
        cmd
    } else if s == "cmd" || s == "cmd.exe" {
        CommandBuilder::new(if cfg!(windows) { "cmd.exe" } else { "sh" })
    } else if s == "pwsh" || s.contains("pwsh") {
        let mut cmd = CommandBuilder::new("pwsh");
        cmd.arg("-NoLogo");
        cmd
    } else if s.contains("powershell") {
        let mut cmd = CommandBuilder::new("powershell");
        cmd.arg("-NoLogo");
        cmd.arg("-NoProfile");
        cmd
    } else {
        let bin = if which_bin("pwsh").is_some() {
            "pwsh"
        } else if cfg!(windows) {
            "powershell"
        } else {
            "bash"
        };
        let mut cmd = CommandBuilder::new(bin);
        if bin != "bash" {
            cmd.arg("-NoLogo");
            cmd.arg("-NoProfile");
        } else {
            cmd.arg("-i");
        }
        cmd
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_ansi_keeps_text() {
        assert_eq!(strip_ansi("a\u{1b}[31mred\u{1b}[0m"), "ared");
    }

    #[test]
    fn pty_echo_roundtrip() {
        let reg = TerminalRegistry::default();
        let id = reg.open("cmd", None).expect("open pty");
        let out = reg.send(&id, "echo wb-pty-ok").expect("send");
        assert!(
            out.contains("wb-pty-ok"),
            "pty output missing marker: {out}"
        );
        assert!(reg.close(&id));
    }
}
