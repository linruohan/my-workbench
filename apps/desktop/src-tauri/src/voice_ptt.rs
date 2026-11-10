//! CapsWriter-style Caps Lock push-to-talk + clipboard paste injection (Windows).
//!
//! Uses GetAsyncKeyState polling (no permanent CapsLock swallow), and restores
//! the CapsLock toggle LED after each hold so the key never stays "stuck".

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

const EVENT_DOWN: &str = "voice-ptt-down";
const EVENT_UP: &str = "voice-ptt-up";

static ENABLED: AtomicBool = AtomicBool::new(false);
static WORKER_GENERATION: AtomicU32 = AtomicU32::new(0);
static APP: Mutex<Option<AppHandle>> = Mutex::new(None);

#[cfg(windows)]
mod win {
    use super::*;
    use std::ptr;
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardData, OpenClipboard, SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, GetKeyState, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT,
        KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, SendInput, VK_CAPITAL, VK_CONTROL, VK_V,
    };

    const CF_UNICODETEXT: u32 = 13;

    fn emit_ptt(event: &str) {
        if !ENABLED.load(Ordering::SeqCst) {
            return;
        }
        if let Ok(guard) = APP.lock() {
            if let Some(app) = guard.as_ref() {
                let _ = app.emit(event, ());
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.emit(event, ());
                }
            }
        }
    }

    fn caps_physically_down() -> bool {
        unsafe { GetAsyncKeyState(VK_CAPITAL as i32) as u16 & 0x8000 != 0 }
    }

    fn caps_toggle_on() -> bool {
        unsafe { GetKeyState(VK_CAPITAL as i32) as u16 & 0x0001 != 0 }
    }

    /// Injected CapsLock tap (not blocked — we no longer install a swallow hook).
    fn tap_caps_lock() {
        unsafe {
            let mut inputs = [
                INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: VK_CAPITAL as u16,
                            wScan: 0,
                            dwFlags: 0,
                            time: 0,
                            dwExtraInfo: 0,
                        },
                    },
                },
                INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: VK_CAPITAL as u16,
                            wScan: 0,
                            dwFlags: KEYEVENTF_KEYUP,
                            time: 0,
                            dwExtraInfo: 0,
                        },
                    },
                },
            ];
            SendInput(
                inputs.len() as u32,
                inputs.as_mut_ptr(),
                std::mem::size_of::<INPUT>() as i32,
            );
        }
    }

    fn restore_caps_toggle(desired_on: bool) {
        // Wait for the physical key to fully release before correcting LED/state.
        for _ in 0..40 {
            if !caps_physically_down() {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        thread::sleep(Duration::from_millis(20));
        if caps_toggle_on() != desired_on {
            tap_caps_lock();
        }
    }

    fn poller_thread(generation: u32) {
        let mut was_down = false;
        let mut armed = false;
        let mut toggle_before_hold = false;

        while WORKER_GENERATION.load(Ordering::SeqCst) == generation {
            if !ENABLED.load(Ordering::SeqCst) {
                if was_down {
                    restore_caps_toggle(toggle_before_hold);
                    emit_ptt(EVENT_UP);
                }
                was_down = false;
                armed = false;
                thread::sleep(Duration::from_millis(30));
                continue;
            }

            let down = caps_physically_down();
            if !armed {
                // Arm only after CapsLock is up, so enabling mid-hold won't sticky-fire.
                if !down {
                    armed = true;
                }
                thread::sleep(Duration::from_millis(15));
                continue;
            }

            if down && !was_down {
                // CapsLock toggles on keydown, so after the down edge the LED is
                // already flipped — invert to recover the pre-press state.
                toggle_before_hold = !caps_toggle_on();
                emit_ptt(EVENT_DOWN);
            } else if !down && was_down {
                emit_ptt(EVENT_UP);
                restore_caps_toggle(toggle_before_hold);
            }
            was_down = down;
            thread::sleep(Duration::from_millis(15));
        }

        if was_down {
            emit_ptt(EVENT_UP);
            restore_caps_toggle(toggle_before_hold);
        }
    }

    pub fn set_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
        {
            let mut slot = APP.lock().map_err(|_| "语音热键状态不可用".to_string())?;
            *slot = Some(app);
        }

        if enabled {
            if ENABLED.swap(true, Ordering::SeqCst) {
                return Ok(());
            }
            let generation = WORKER_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
            // Ensure we don't leave the user stuck in Caps ON when starting.
            if caps_toggle_on() {
                tap_caps_lock();
            }
            thread::Builder::new()
                .name("voice-caps-poll".into())
                .spawn(move || poller_thread(generation))
                .map_err(|_| "CapsLock 监听线程启动失败".to_string())?;
            Ok(())
        } else {
            ENABLED.store(false, Ordering::SeqCst);
            let _ = WORKER_GENERATION.fetch_add(1, Ordering::SeqCst);
            // Best-effort: clear stuck Caps ON when turning the feature off.
            thread::spawn(|| {
                thread::sleep(Duration::from_millis(50));
                if caps_toggle_on() {
                    tap_caps_lock();
                }
            });
            Ok(())
        }
    }

    /// 带重试地打开剪贴板：其它进程可能短暂占用，直接失败会导致应用外粘贴丢字。
    fn open_clipboard_retry() -> bool {
        for _ in 0..12 {
            if unsafe { OpenClipboard(ptr::null_mut()) } != 0 {
                return true;
            }
            thread::sleep(Duration::from_millis(15));
        }
        false
    }

    fn read_clipboard_unicode() -> Option<String> {
        unsafe {
            if !open_clipboard_retry() {
                return None;
            }
            let handle = GetClipboardData(CF_UNICODETEXT);
            if handle.is_null() {
                CloseClipboard();
                return None;
            }
            let locked = GlobalLock(handle) as *const u16;
            if locked.is_null() {
                CloseClipboard();
                return None;
            }
            let mut len = 0usize;
            while *locked.add(len) != 0 {
                len += 1;
                if len > 4 * 1024 * 1024 {
                    break;
                }
            }
            let slice = std::slice::from_raw_parts(locked, len);
            let text = String::from_utf16_lossy(slice);
            GlobalUnlock(handle);
            CloseClipboard();
            Some(text)
        }
    }

    fn set_clipboard_unicode(text: &str) -> Result<(), String> {
        let mut wide: Vec<u16> = text.encode_utf16().collect();
        wide.push(0);
        let bytes = wide.len() * 2;
        unsafe {
            if !open_clipboard_retry() {
                return Err("无法打开剪贴板".into());
            }
            EmptyClipboard();
            let handle = GlobalAlloc(GMEM_MOVEABLE, bytes);
            if handle.is_null() {
                CloseClipboard();
                return Err("无法分配剪贴板内存".into());
            }
            let locked = GlobalLock(handle) as *mut u16;
            if locked.is_null() {
                CloseClipboard();
                return Err("无法写入剪贴板".into());
            }
            ptr::copy_nonoverlapping(wide.as_ptr(), locked, wide.len());
            GlobalUnlock(handle);
            if SetClipboardData(CF_UNICODETEXT, handle).is_null() {
                CloseClipboard();
                return Err("无法设置剪贴板".into());
            }
            CloseClipboard();
        }
        Ok(())
    }

    fn send_ctrl_v() {
        unsafe {
            let mut inputs = [
                INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: VK_CONTROL,
                            wScan: 0,
                            dwFlags: 0,
                            time: 0,
                            dwExtraInfo: 0,
                        },
                    },
                },
                INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: VK_V as u16,
                            wScan: 0,
                            dwFlags: 0,
                            time: 0,
                            dwExtraInfo: 0,
                        },
                    },
                },
                INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: VK_V as u16,
                            wScan: 0,
                            dwFlags: KEYEVENTF_KEYUP,
                            time: 0,
                            dwExtraInfo: 0,
                        },
                    },
                },
                INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: VK_CONTROL,
                            wScan: 0,
                            dwFlags: KEYEVENTF_KEYUP,
                            time: 0,
                            dwExtraInfo: 0,
                        },
                    },
                },
            ];
            SendInput(
                inputs.len() as u32,
                inputs.as_mut_ptr(),
                std::mem::size_of::<INPUT>() as i32,
            );
        }
    }

    /// 剪贴板不可用时的兜底：把文字作为 Unicode 键盘事件直接打进当前焦点。
    fn type_unicode(text: &str) -> Result<(), String> {
        let mut inputs: Vec<INPUT> = Vec::with_capacity(text.len() * 2);
        for unit in text.encode_utf16() {
            for flags in [KEYEVENTF_UNICODE, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP] {
                inputs.push(INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: 0,
                            wScan: unit,
                            dwFlags: flags,
                            time: 0,
                            dwExtraInfo: 0,
                        },
                    },
                });
            }
        }
        let sent = unsafe {
            SendInput(
                inputs.len() as u32,
                inputs.as_mut_ptr(),
                std::mem::size_of::<INPUT>() as i32,
            )
        };
        if sent as usize != inputs.len() {
            return Err("无法写入当前输入焦点".into());
        }
        Ok(())
    }

    /// 把转写结果粘贴到系统当前焦点（应用外的任意输入框）。
    pub fn paste_text(text: String) -> Result<(), String> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Ok(());
        }
        let spoken = trimmed.to_string();
        let previous = read_clipboard_unicode();
        if set_clipboard_unicode(&spoken).is_err() {
            // 剪贴板被占用时直接退化为 Unicode 直输，避免应用外「没反应」。
            return type_unicode(&spoken);
        }
        // 留出一点时间让目标窗口完成焦点切换，再发 Ctrl+V。
        thread::sleep(Duration::from_millis(80));
        send_ctrl_v();
        // 延后恢复剪贴板：Electron/Office 等程序会异步读取剪贴板，
        // 过早恢复会粘出旧内容或什么都不粘。
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(900));
            if read_clipboard_unicode().as_deref() != Some(spoken.as_str()) {
                return; // 用户已经复制了新内容，不覆盖
            }
            if let Some(prev) = previous {
                let _ = set_clipboard_unicode(&prev);
            }
        });
        Ok(())
    }
}

#[cfg(not(windows))]
mod win {
    use super::*;
    pub fn set_enabled(_app: AppHandle, _enabled: bool) -> Result<(), String> {
        Err("全局 CapsLock 语音热键仅支持 Windows".into())
    }
    pub fn paste_text(_text: String) -> Result<(), String> {
        Err("全局粘贴回写仅支持 Windows".into())
    }
}

/// Enable or disable Caps Lock push-to-talk.
#[tauri::command]
pub fn voice_ptt_set_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    win::set_enabled(app, enabled)
}

/// Paste text into the current OS focus via clipboard + Ctrl+V.
///
/// 异步执行：剪贴板重试与粘贴延时不能阻塞 WebView 的主线程。
#[tauri::command]
pub async fn voice_ptt_paste(text: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || win::paste_text(text))
        .await
        .map_err(|_| "粘贴任务执行失败".to_string())?
}
