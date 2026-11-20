use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellResult {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

pub fn run_shell(command: &str, cwd: Option<&str>, timeout_secs: u64) -> Result<ShellResult> {
    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("cmd");
        c.args(["/C", command]);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new("sh");
        c.args(["-lc", command]);
        c
    };
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
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

#[derive(Default)]
pub struct JobRegistry {
    inner: Mutex<HashMap<String, JobState>>,
}

struct JobState {
    kill: Arc<Mutex<Option<u32>>>,
    output: Arc<Mutex<String>>,
    done: Arc<Mutex<Option<i32>>>,
}

impl JobRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn start(&self, id: &str, command: &str, cwd: Option<&str>) -> Result<()> {
        let output = Arc::new(Mutex::new(String::new()));
        let done = Arc::new(Mutex::new(None));
        let kill = Arc::new(Mutex::new(None));
        {
            let mut map = self.inner.lock().unwrap();
            map.insert(
                id.to_string(),
                JobState {
                    kill: kill.clone(),
                    output: output.clone(),
                    done: done.clone(),
                },
            );
        }
        let command = command.to_string();
        let cwd = cwd.map(|s| s.to_string());
        thread::spawn(move || {
            let result = run_shell(&command, cwd.as_deref(), 600);
            match result {
                Ok(r) => {
                    *output.lock().unwrap() = format!("{}{}", r.stdout, r.stderr);
                    *done.lock().unwrap() = Some(r.code);
                }
                Err(e) => {
                    *output.lock().unwrap() = e.to_string();
                    *done.lock().unwrap() = Some(-1);
                }
            }
        });
        Ok(())
    }

    pub fn output(&self, id: &str) -> Option<(String, Option<i32>)> {
        let map = self.inner.lock().unwrap();
        let job = map.get(id)?;
        Some((
            job.output.lock().unwrap().clone(),
            *job.done.lock().unwrap(),
        ))
    }

    pub fn kill(&self, id: &str) -> bool {
        let map = self.inner.lock().unwrap();
        if let Some(job) = map.get(id) {
            if let Some(pid) = *job.kill.lock().unwrap() {
                let _ = pid;
            }
            *job.done.lock().unwrap() = Some(-9);
            return true;
        }
        false
    }
}

pub fn write_stdin_line(child_stdin: &mut impl Write, line: &str) -> Result<()> {
    writeln!(child_stdin, "{line}")?;
    Ok(())
}
