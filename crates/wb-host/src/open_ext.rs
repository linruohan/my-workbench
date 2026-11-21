use anyhow::{Context, Result};
use std::path::Path;
use std::process::Command;

pub fn open_external(target: &str) -> Result<()> {
    #[cfg(windows)]
    {
        Command::new("cmd")
            .args(["/C", "start", "", target])
            .spawn()
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
        let target = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        Command::new("explorer")
            .arg(format!("/select,{}", target.display()))
            .spawn()
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
