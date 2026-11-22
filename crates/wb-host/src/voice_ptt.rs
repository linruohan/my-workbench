use anyhow::Result;
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;

static PTT_ENABLED: AtomicBool = AtomicBool::new(false);
static PTT_HELD: AtomicBool = AtomicBool::new(false);
/// Set when the key-down thread has finished opening the device, or failed.
/// Key-up waits on this so it cannot run before the device exists and then
/// leave the microphone open.
static OPEN_DONE: AtomicBool = AtomicBool::new(true);
static HOOK_STARTED: AtomicBool = AtomicBool::new(false);
static HOOK_HANDLE: AtomicIsize = AtomicIsize::new(0);

/// What the PTT release handler produced.
#[derive(Debug, Clone)]
pub enum VoicePending {
    /// Recognized text to insert.
    Text(String),
    /// Something failed; must be reported, never typed into the focused app.
    Error(String),
}

fn pending() -> &'static Mutex<Option<VoicePending>> {
    static PENDING: OnceLock<Mutex<Option<VoicePending>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(None))
}

pub fn voice_ptt_set_enabled(enabled: bool) {
    PTT_ENABLED.store(enabled, Ordering::SeqCst);
    if enabled {
        ensure_capslock_hook();
        warm_model();
    } else {
        let _ = thread::Builder::new()
            .name("wb-voice-stop".into())
            .spawn(|| {
                crate::voice_record_stop_silent();
                crate::speech_asr_release();
            });
    }
}

/// Load the recognizer ahead of the first release. The microphone stays closed
/// until a key press opens it.
fn warm_model() {
    let _ = thread::Builder::new()
        .name("wb-voice-warm".into())
        .spawn(|| {
            let engine = configured_engine();
            if let Err(err) = crate::speech_warm(&engine) {
                log::warn!("语音模型预热失败：{err:#}");
            }
        });
}

fn configured_engine() -> String {
    wb_store::load_prefs()
        .ok()
        .and_then(|prefs| prefs.voice.engine)
        .filter(|engine| !engine.trim().is_empty())
        .map(|engine| crate::normalize_engine(&engine))
        .filter(|engine| crate::speech_status(engine).is_ok_and(|status| status.ready))
        .unwrap_or_else(crate::speech_active_engine)
}

pub fn voice_ptt_enabled() -> bool {
    PTT_ENABLED.load(Ordering::SeqCst)
}

pub fn voice_ptt_is_held() -> bool {
    PTT_HELD.load(Ordering::SeqCst)
}

/// Take whatever the release handler produced (if anything).
pub fn voice_ptt_take_pending() -> Option<VoicePending> {
    pending().lock().ok()?.take()
}

fn push_text(text: String) {
    if let Ok(mut slot) = pending().lock() {
        *slot = Some(VoicePending::Text(text));
    }
}

fn push_error(message: String) {
    if let Ok(mut slot) = pending().lock() {
        *slot = Some(VoicePending::Error(message));
    }
}

/// Insert text into the focused app through the clipboard.
///
/// The previous clipboard content is restored afterwards, and nothing is typed
/// unless setting the clipboard actually succeeded.
pub fn voice_ptt_paste(text: &str) -> Result<()> {
    #[cfg(windows)]
    {
        if text.is_empty() {
            anyhow::bail!("没有可粘贴的文本");
        }
        let previous = read_clipboard();
        write_clipboard(text)?;
        // Let the clipboard settle before the synthetic keystroke.
        thread::sleep(Duration::from_millis(20));
        send_ctrl_v();
        thread::sleep(Duration::from_millis(150));
        // Restore what the user had copied before, so PTT is not destructive.
        if let Some(previous) = previous.filter(|text| !text.is_empty()) {
            let _ = write_clipboard(&previous);
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = text;
        anyhow::bail!("voice_ptt_paste 仅在 Windows 实现");
    }
}

#[cfg(windows)]
fn read_clipboard() -> Option<String> {
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, OpenClipboard,
    };
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalUnlock};
    use windows_sys::Win32::System::Ole::CF_UNICODETEXT;

    // Another process may hold the clipboard briefly; retry instead of failing.
    for attempt in 0..10 {
        if unsafe { OpenClipboard(std::ptr::null_mut()) } != 0 {
            let handle = unsafe { GetClipboardData(CF_UNICODETEXT as u32) };
            if handle.is_null() {
                unsafe { CloseClipboard() };
                return None;
            }
            let ptr = unsafe { GlobalLock(handle) };
            if ptr.is_null() {
                unsafe { CloseClipboard() };
                return None;
            }
            // UTF-16, NUL-terminated.
            let mut len = 0usize;
            unsafe {
                while *(ptr as *const u16).add(len) != 0 {
                    len += 1;
                    if len > 8 * 1024 * 1024 {
                        break;
                    }
                }
                let slice = std::slice::from_raw_parts(ptr as *const u16, len);
                let text = String::from_utf16_lossy(slice);
                GlobalUnlock(handle);
                CloseClipboard();
                return (!text.is_empty()).then_some(text);
            }
        }
        thread::sleep(Duration::from_millis(20 + attempt * 10));
    }
    None
}

#[cfg(windows)]
fn write_clipboard(text: &str) -> Result<()> {
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{
        GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalUnlock,
    };
    use windows_sys::Win32::System::Ole::CF_UNICODETEXT;

    let mut opened = false;
    for attempt in 0..10 {
        if unsafe { OpenClipboard(std::ptr::null_mut()) } != 0 {
            opened = true;
            break;
        }
        thread::sleep(Duration::from_millis(20 + attempt * 10));
    }
    if !opened {
        anyhow::bail!("剪贴板被其它程序占用");
    }

    // Keep the clipboard open until the data is handed over, then close.
    let result = (|| -> Result<()> {
        if unsafe { EmptyClipboard() } == 0 {
            anyhow::bail!("清空剪贴板失败");
        }
        let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        let bytes = wide.len() * 2;
        let handle = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes) };
        if handle.is_null() {
            anyhow::bail!("分配剪贴板内存失败");
        }
        let ptr = unsafe { GlobalLock(handle) };
        if ptr.is_null() {
            anyhow::bail!("锁定剪贴板内存失败");
        }
        unsafe {
            std::ptr::copy_nonoverlapping(wide.as_ptr(), ptr as *mut u16, wide.len());
            GlobalUnlock(handle);
        }
        // On success the system owns the handle; do not free it ourselves.
        if unsafe { SetClipboardData(CF_UNICODETEXT as u32, handle) }.is_null() {
            anyhow::bail!("写入剪贴板失败");
        }
        Ok(())
    })();

    unsafe { CloseClipboard() };
    result
}

#[cfg(windows)]
fn send_ctrl_v() {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        KEYEVENTF_KEYUP, VK_CONTROL, keybd_event,
    };
    const VK_V: u8 = b'V';
    unsafe {
        keybd_event(VK_CONTROL as u8, 0, 0, 0);
        keybd_event(VK_V, 0, 0, 0);
        keybd_event(VK_V, 0, KEYEVENTF_KEYUP, 0);
        keybd_event(VK_CONTROL as u8, 0, KEYEVENTF_KEYUP, 0);
    }
}

/// Read the Windows clipboard, for diagnostics and tests.
pub fn voice_clipboard_read() -> Option<String> {
    #[cfg(windows)]
    {
        read_clipboard()
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// Write the Windows clipboard, for diagnostics and tests.
pub fn voice_clipboard_write(text: &str) -> Result<()> {
    #[cfg(windows)]
    {
        write_clipboard(text)
    }
    #[cfg(not(windows))]
    {
        let _ = text;
        anyhow::bail!("仅 Windows 支持")
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
                    OPEN_DONE.store(false, Ordering::SeqCst);
                    crate::voice_level_reset();
                    let spawned = thread::Builder::new()
                        .name("wb-voice-open".into())
                        .spawn(|| {
                            let device = wb_store::load_prefs()
                                .ok()
                                .and_then(|prefs| prefs.voice.input_device);
                            open_input(device);
                        });
                    if spawned.is_err() {
                        OPEN_DONE.store(true, Ordering::SeqCst);
                        PTT_HELD.store(false, Ordering::SeqCst);
                        push_error("无法开始录音".into());
                    }
                }
                if up && voice_ptt_enabled() && PTT_HELD.swap(false, Ordering::SeqCst) {
                    let _ = thread::spawn(on_ptt_release);
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

/// Open the microphone for the press that just started.
///
/// The device is not touched until this runs. If voice input was switched off
/// while it was opening, the device is closed again and nothing is kept.
fn open_input(device: Option<String>) {
    let opened = crate::voice_record_start_with(device.as_deref());
    if let Err(err) = opened {
        PTT_HELD.store(false, Ordering::SeqCst);
        push_error(format!("无法开始录音：{err}"));
    } else if !voice_ptt_enabled() {
        crate::voice_record_stop_silent();
    }
    OPEN_DONE.store(true, Ordering::SeqCst);
}

fn wait_until_input_settled() {
    let deadline = std::time::Instant::now() + Duration::from_secs(9);
    while !OPEN_DONE.load(Ordering::SeqCst) && std::time::Instant::now() < deadline {
        thread::sleep(Duration::from_millis(5));
    }
}

fn on_ptt_release() {
    wait_until_input_settled();
    // Prefer the configured engine, but fall back to one that is actually
    // usable so a half-downloaded choice does not make dictation fail silently.
    let engine = configured_engine();
    // Stop waits if the key-down thread is still opening the device, then
    // closes it and keeps only this take.
    let wav = match crate::voice_record_stop_to_wav() {
        Ok(path) => path,
        // Opening failed on the key-down thread, which already reported it.
        Err(err) if err.to_string().contains("没有进行中的录音") => return,
        Err(err) => {
            push_error(format!("录音失败：{err}"));
            return;
        }
    };
    match crate::speech_transcribe(&engine, &wav.to_string_lossy(), None) {
        Ok(text) if !text.trim().is_empty() => {
            let text = text.trim().to_string();
            // Pasting can fail when the focused app blocks synthetic input;
            // keep the text so the UI can show it instead of losing it.
            if voice_ptt_paste(&text).is_err() {
                push_text(text);
            }
        }
        Ok(_) => push_error("（未识别到语音）".into()),
        Err(e) => push_error(format!("语音转写失败：{e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Errors must never be treated as text: they would be typed into
    /// whatever window happens to have focus.
    #[test]
    fn error_and_text_stay_separate() {
        push_error("录音失败".into());
        match voice_ptt_take_pending() {
            Some(VoicePending::Error(message)) => assert_eq!(message, "录音失败"),
            other => panic!("expected an error, got {other:?}"),
        }

        push_text("你好".into());
        match voice_ptt_take_pending() {
            Some(VoicePending::Text(text)) => assert_eq!(text, "你好"),
            other => panic!("expected text, got {other:?}"),
        }

        assert!(voice_ptt_take_pending().is_none());
    }

    #[test]
    fn empty_text_is_rejected() {
        assert!(voice_ptt_paste("").is_err());
    }

    /// The clipboard must round-trip exactly: a stray newline here would
    /// accumulate in the user's clipboard on every dictation.
    #[cfg(windows)]
    #[test]
    fn clipboard_round_trips_verbatim() {
        let original = voice_clipboard_read();
        let cases = [
            "single",
            "line1\r\nline2",
            "中文 English 123",
            "quotes ' \" ` and $var 100%",
            "trailing\n",
            "  leading space",
            "emoji 😀",
        ];
        for case in cases {
            voice_clipboard_write(case).expect("write");
            assert_eq!(
                voice_clipboard_read().as_deref(),
                Some(case),
                "clipboard changed content for {case:?}"
            );
        }
        // Leave the machine as we found it.
        if let Some(original) = original {
            let _ = voice_clipboard_write(&original);
        }
    }
}
