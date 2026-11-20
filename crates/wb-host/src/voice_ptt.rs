use anyhow::Result;
use std::sync::atomic::{AtomicBool, Ordering};

static PTT_ENABLED: AtomicBool = AtomicBool::new(false);

pub fn voice_ptt_set_enabled(enabled: bool) {
    PTT_ENABLED.store(enabled, Ordering::SeqCst);
}

pub fn voice_ptt_enabled() -> bool {
    PTT_ENABLED.load(Ordering::SeqCst)
}

/// Paste text via clipboard helper. On Windows uses PowerShell Set-Clipboard + Ctrl+V.
pub fn voice_ptt_paste(text: &str) -> Result<()> {
    #[cfg(windows)]
    {
        use std::process::Command;
        // Escape for PowerShell single-quoted string
        let escaped = text.replace('\'', "''");
        Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!("Set-Clipboard -Value '{escaped}'"),
            ])
            .output()?;
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
            KEYEVENTF_KEYUP, VK_CONTROL, keybd_event,
        };
        unsafe {
            keybd_event(VK_CONTROL as u8, 0, 0, 0);
            keybd_event(b'V', 0, 0, 0);
            keybd_event(b'V', 0, KEYEVENTF_KEYUP, 0);
            keybd_event(VK_CONTROL as u8, 0, KEYEVENTF_KEYUP, 0);
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = text;
        anyhow::bail!("voice_ptt_paste 仅在 Windows 实现");
    }
}
