use std::process::Command;

/// Open an http(s)/mailto URL with the OS default handler.
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("链接为空".into());
    }
    let lower = trimmed.to_ascii_lowercase();
    if !(lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("mailto:"))
    {
        return Err("只能打开 http(s) 或 mailto 链接".into());
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", trimmed])
            .spawn()
            .map_err(|err| format!("无法打开链接：{err}"))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(trimmed)
            .spawn()
            .map_err(|err| format!("无法打开链接：{err}"))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(trimmed)
            .spawn()
            .map_err(|err| format!("无法打开链接：{err}"))?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err("当前平台不支持打开外部链接".into())
}
