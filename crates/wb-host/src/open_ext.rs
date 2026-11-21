use anyhow::{Context, Result};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;

pub fn open_external(target: &str) -> Result<()> {
    #[cfg(windows)]
    {
        // `cmd /C start` is a console process in this process group. When it
        // exits, Windows delivers CTRL_C_EVENT and the GUI process disappears
        // (exit 0xC000013A) with no panic. ShellExecute does not attach a console.
        let owned = target.to_owned();
        std::thread::Builder::new()
            .name("wb-open".into())
            .spawn(move || {
                if let Err(err) = shell_execute(&owned) {
                    log::warn!("{err}");
                }
            })
            .with_context(|| format!("打开失败: {target}"))?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(target).spawn()?;
        Ok(())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open").arg(target).spawn()?;
        Ok(())
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = target;
        anyhow::bail!("unsupported platform");
    }
}

pub fn open_path(path: &Path) -> Result<()> {
    open_external(&path.to_string_lossy())
}

/// Open with the system default app; optionally select the file in the file manager.
pub fn present_path(path: &Path, reveal: bool) -> Result<()> {
    if !path.exists() {
        anyhow::bail!("路径不存在: {}", path.display());
    }
    if reveal {
        reveal_in_file_manager(path)?;
    }
    // Directories: reveal already opened the folder; files always open in default app.
    if path.is_file() || !reveal {
        open_path(path)?;
    }
    Ok(())
}

pub fn reveal_in_file_manager(path: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        let target = shell_path(path);
        let mut arg = OsString::from("/select,");
        arg.push(&target);
        spawn_detached("explorer.exe", &arg)
            .with_context(|| format!("资源管理器选中失败: {}", path.display()))?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .args(["-R", &path.to_string_lossy()])
            .spawn()
            .with_context(|| format!("Finder 选中失败: {}", path.display()))?;
        Ok(())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let parent = path.parent().unwrap_or(path);
        Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .with_context(|| format!("打开目录失败: {}", parent.display()))?;
        Ok(())
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = path;
        anyhow::bail!("unsupported platform");
    }
}

/// `canonicalize` yields `\\?\` paths, which Explorer treats as a bad location.
fn strip_verbatim(path: &Path) -> PathBuf {
    let text = path.as_os_str().to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path.to_path_buf()
}

#[cfg(windows)]
fn shell_path(path: &Path) -> PathBuf {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    strip_verbatim(&canonical)
}

#[cfg(windows)]
fn shell_execute(target: &str) -> Result<()> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::System::Com::{
        COINIT_APARTMENTTHREADED, CoInitializeEx, CoUninitialize,
    };
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    fn wide(text: &str) -> Vec<u16> {
        OsStr::new(text)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    let file = wide(target);
    let verb = wide("open");
    let code = unsafe {
        let hr = CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32);
        let code = ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        );
        // S_OK = 0, S_FALSE = 1 (this thread was already initialized).
        if hr == 0 || hr == 1 {
            CoUninitialize();
        }
        code as isize
    };
    if code <= 32 {
        anyhow::bail!("打开失败 ({code}): {target}");
    }
    Ok(())
}

#[cfg(windows)]
fn spawn_detached(program: &str, arg: &OsString) -> Result<()> {
    use std::os::windows::process::CommandExt;
    use std::process::Stdio;

    const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    const DETACHED_PROCESS: u32 = 0x00000008;

    Command::new(program)
        .arg(arg)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // Keep Explorer out of this console process group so its exit cannot
        // deliver CTRL_C_EVENT back to the workbench.
        .creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW | DETACHED_PROCESS)
        .spawn()
        .map(|_| ())
        .context("启动进程失败")
}

#[cfg(test)]
mod tests {
    use super::strip_verbatim;
    use std::path::Path;

    #[test]
    fn strips_verbatim_local_prefix() {
        let path = Path::new(r"\\?\C:\notes\today.md");
        assert_eq!(strip_verbatim(path), Path::new(r"C:\notes\today.md"));
    }

    #[test]
    fn strips_verbatim_unc_prefix() {
        let path = Path::new(r"\\?\UNC\server\share\note.md");
        assert_eq!(strip_verbatim(path), Path::new(r"\\server\share\note.md"));
    }

    #[test]
    fn leaves_normal_path_unchanged() {
        let path = Path::new(r"D:\kb\note.md");
        assert_eq!(strip_verbatim(path), Path::new(r"D:\kb\note.md"));
    }
}
