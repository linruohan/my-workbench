use anyhow::Result;
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;

static PTT_ENABLED: AtomicBool = AtomicBool::new(false);
static PTT_HELD: AtomicBool = AtomicBool::new(false);
static HOOK_STARTED: AtomicBool = AtomicBool::new(false);
static HOOK_HANDLE: AtomicIsize = AtomicIsize::new(0);

fn pending_text() -> &'static Mutex<Option<String>> {
    static PENDING: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(None))
}

pub fn voice_ptt_set_enabled(enabled: bool) {
    PTT_ENABLED.store(enabled, Ordering::SeqCst);
    if enabled {
        ensure_capslock_hook();
    }
}

pub fn voice_ptt_enabled() -> bool {
    PTT_ENABLED.load(Ordering::SeqCst)
}

pub fn voice_ptt_is_held() -> bool {
    PTT_HELD.load(Ordering::SeqCst)
}

/// Take text produced by the CapsLock PTT release handler (if any).
pub fn voice_ptt_take_pending() -> Option<String> {
    pending_text().lock().ok()?.take()
}

fn push_pending(text: String) {
    if let Ok(mut g) = pending_text().lock() {
        *g = Some(text);
    }
}

/// Paste text via clipboard helper. On Windows uses PowerShell Set-Clipboard + Ctrl+V.
pub fn voice_ptt_paste(text: &str) -> Result<()> {
    #[cfg(windows)]
    {
        use std::process::Command;
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

fn ensure_capslock_hook() {
    if HOOK_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    #[cfg(windows)]
    {
        let _ = thread::Builder::new().name("wb-ptt-hook".into()).spawn(|| {
            if let Err(e) = run_capslock_hook() {
                log::warn!("CapsLock PTT hook failed: {e}");
                HOOK_STARTED.store(false, Ordering::SeqCst);
            }
        });
    }
}

#[cfg(windows)]
fn run_capslock_hook() -> Result<()> {
    use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_CAPITAL;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetMessageW, HC_ACTION, KBDLLHOOKSTRUCT, SetWindowsHookExW, WH_KEYBOARD_LL,
        WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 {
            let info = unsafe { &*(lparam as *const KBDLLHOOKSTRUCT) };
            if info.vkCode == VK_CAPITAL as u32 {
                let down = wparam == WM_KEYDOWN as usize || wparam == WM_SYSKEYDOWN as usize;
                let up = wparam == WM_KEYUP as usize || wparam == WM_SYSKEYUP as usize;
                if down && voice_ptt_enabled() && !PTT_HELD.load(Ordering::SeqCst) {
                    PTT_HELD.store(true, Ordering::SeqCst);
                    let _ = thread::spawn(|| {
                        if let Err(e) = crate::voice_record_start() {
                            push_pending(format!("无法开始录音：{e}"));
                            PTT_HELD.store(false, Ordering::SeqCst);
                        }
                    });
                }
                if up && voice_ptt_enabled() && PTT_HELD.swap(false, Ordering::SeqCst) {
                    let _ = thread::spawn(|| {
                        thread::sleep(Duration::from_millis(40));
                        on_ptt_release();
                    });
                }
                return 1;
            }
        }
        let hook = HOOK_HANDLE.load(Ordering::SeqCst) as *mut std::ffi::c_void;
        unsafe { CallNextHookEx(hook, code, wparam, lparam) }
    }

    let hook =
        unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), std::ptr::null_mut(), 0) };
    if hook.is_null() {
        anyhow::bail!("SetWindowsHookExW failed");
    }
    HOOK_HANDLE.store(hook as isize, Ordering::SeqCst);
    unsafe {
        let mut msg = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {}
    }
    Ok(())
}

fn on_ptt_release() {
    let engine = wb_store::load_prefs()
        .ok()
        .and_then(|p| p.voice.engine)
        .unwrap_or_else(|| "sensevoice".into());
    let wav = match crate::voice_record_stop_to_wav() {
        Ok(p) => p,
        Err(e) => {
            if let Ok(path) = crate::voice_wav_path() {
                if path.is_file() {
                    path
                } else {
                    push_pending(format!("录音失败：{e}"));
                    return;
                }
            } else {
                push_pending(format!("录音失败：{e}"));
                return;
            }
        }
    };
    match crate::speech_transcribe(&engine, &wav.to_string_lossy(), None) {
        Ok(text) if !text.trim().is_empty() => {
            let text = text.trim().to_string();
            if voice_ptt_paste(&text).is_err() {
                push_pending(text);
            }
        }
        Ok(_) => push_pending("（未识别到语音）".into()),
        Err(e) => push_pending(format!("语音转写失败：{e}")),
    }
}
