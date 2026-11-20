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
