use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

const PROMPT_LIMIT: usize = 20_000;
const RUN_TIMEOUT: Duration = Duration::from_secs(120);

/// Ask the local OpenCode CLI, using its own default free-model provider.
/// The process runs in an empty directory so the workbench repo is not attached.
#[tauri::command]
pub async fn oc_complete(
    app: AppHandle,
    model_id: String,
    prompt: String,
) -> Result<String, String> {
    let model_id = model_id.trim().to_string();
    if !valid_model_id(&model_id) {
        return Err("模型 id 无效".into());
    }
    let prompt = prompt.trim().to_string();
    if prompt.is_empty() {
        return Err("没有要发送的内容".into());
    }
    if prompt.chars().count() > PROMPT_LIMIT {
        return Err("发送给 OpenCode 的内容过长".into());
    }
    tauri::async_runtime::spawn_blocking(move || complete(&app, &model_id, &prompt))
        .await
        .map_err(|_| "OpenCode 调用中断".to_string())?
}

fn complete(app: &AppHandle, model_id: &str, prompt: &str) -> Result<String, String> {
    let binary = locate_opencode()?;
    let dir = isolated_dir(app)?;
    let stdout = run(&binary, &dir, model_id, prompt)?;
    if stdout.trim().is_empty() {
        return Err("OpenCode 没有返回内容".into());
    }
    Ok(stdout)
}

fn isolated_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| err.to_string())?
        .join("opencode-run");
    std::fs::create_dir_all(&dir).map_err(|_| "无法准备 OpenCode 目录".to_string())?;
    Ok(dir)
}

fn run(binary: &Path, dir: &Path, model_id: &str, prompt: &str) -> Result<String, String> {
    let mut command = Command::new(binary);
    command
        .arg("run")
        .arg("--standalone")
        .arg("--format")
        .arg("json")
        .arg("--model")
        .arg(format!("opencode/{model_id}"))
        .arg(prompt)
        .current_dir(dir)
        .env_clear()
        .envs(base_env())
        .env("OPENCODE_DISABLE_AUTOUPDATE", "true")
        .env("OPENCODE_DISABLE_PROJECT_CONFIG", "true")
        .env("OPENCODE_DISABLE_EXTERNAL_SKILLS", "true")
        .env("OPENCODE_DISABLE_CLAUDE_CODE", "true")
        .env(
            "OPENCODE_CONFIG_CONTENT",
            r#"{"permission":{"*":"deny"},"autoupdate":false,"share":"disabled"}"#,
        )
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|err| format!("无法启动 OpenCode：{err}"))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法读取 OpenCode 输出".to_string())?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "无法读取 OpenCode 输出".to_string())?;
    let out_thread = std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = stdout.read_to_string(&mut buf);
        buf
    });
    let err_thread = std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = stderr.read_to_string(&mut buf);
        buf
    });
    let started = Instant::now();
    loop {
        if started.elapsed() > RUN_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            let _ = out_thread.join();
            let _ = err_thread.join();
            return Err("OpenCode 超时".into());
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = out_thread.join().unwrap_or_default();
                let stderr = err_thread.join().unwrap_or_default();
                if stdout.trim().is_empty() {
                    let detail = stderr.trim();
                    if detail.is_empty() {
                        return Err(if status.success() {
                            "OpenCode 没有返回内容".into()
                        } else {
                            "OpenCode 调用失败".into()
                        });
                    }
                    return Err(clip(detail));
                }
                return Ok(stdout);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(200)),
            Err(err) => return Err(format!("OpenCode 异常：{err}")),
        }
    }
}

fn locate_opencode() -> Result<PathBuf, String> {
    if let Some(explicit) = std::env::var_os("WORKBENCH_OPENCODE") {
        let path = PathBuf::from(explicit);
        if is_launchable(&path) {
            return Ok(path);
        }
    }
    let mut candidates = Vec::new();
    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            // The npm global shim is a shell script named `opencode`. The real
            // image lives beside it; check that before the extensionless file.
            candidates.push(dir.join("opencode.exe"));
            candidates.push(
                dir.join("node_modules")
                    .join("@opencode")
                    .join("cli")
                    .join("bin")
                    .join("opencode.exe"),
            );
            candidates.push(dir.join("opencode"));
        }
    }
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        let home = PathBuf::from(home);
        candidates.push(home.join(".opencode").join("bin").join("opencode.exe"));
        candidates.push(home.join(".opencode").join("bin").join("opencode"));
    }
    first_launchable(candidates).ok_or_else(|| "未找到本机 OpenCode".to_string())
}

fn first_launchable(candidates: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    candidates.into_iter().find(|path| is_launchable(path))
}

/// `CreateProcess` only accepts a PE image. The npm shim `opencode` is a
/// `#!/bin/sh` script, and launching it fails with os error 193.
fn is_launchable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(windows)]
    {
        return is_pe_executable(path);
    }
    #[cfg(not(windows))]
    {
        true
    }
}

#[cfg(windows)]
fn is_pe_executable(path: &Path) -> bool {
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return false,
    };
    let mut header = [0u8; 2];
    matches!(file.read(&mut header), Ok(2) if header == *b"MZ")
}

fn base_env() -> Vec<(&'static str, String)> {
    [
        "PATH",
        "HOME",
        "USER",
        "LANG",
        "SystemRoot",
        "SYSTEMROOT",
        "WINDIR",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "PATHEXT",
        "COMSPEC",
    ]
    .into_iter()
    .filter_map(|key| {
        std::env::var(key)
            .ok()
            .filter(|value| !value.is_empty())
            .map(|value| (key, value))
    })
    .collect()
}

fn valid_model_id(id: &str) -> bool {
    let mut chars = id.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_alphanumeric()
        && id.len() <= 128
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-')
}

fn clip(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= 400 {
        return trimmed.to_string();
    }
    trimmed.chars().take(400).collect()
}

#[cfg(test)]
mod tests {
    use super::first_launchable;
    use std::io::Write;

    #[cfg(windows)]
    #[test]
    fn skips_shell_shim_and_keeps_pe_image() {
        let dir = std::env::temp_dir().join(format!("wb-oc-locate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let shim = dir.join("opencode");
        let exe = dir.join("opencode.exe");
        std::fs::write(&shim, "#!/bin/sh\nexec echo hi\n").unwrap();
        {
            let mut file = std::fs::File::create(&exe).unwrap();
            file.write_all(b"MZ not a real image").unwrap();
        }
        let found = first_launchable([shim, exe.clone()]).unwrap();
        assert_eq!(found, exe);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
