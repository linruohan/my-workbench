mod kb;
mod model_http;
mod ocr;
mod open_ext;
mod tools;
mod web_session;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            kb::kb_pick_directory,
            kb::kb_list_dir,
            kb::kb_read_text,
            kb::kb_write_text,
            kb::kb_read_base64,
            kb::kb_write_base64,
            kb::kb_exists,
            kb::kb_mkdir,
            kb::kb_rename,
            kb::kb_reveal_in_explorer,
            kb::kb_git_branch,
            open_ext::open_external,
            model_http::model_http,
            ocr::ocr_ensure_models,
            ocr::ocr_read_model,
            tools::tools_probe,
            tools::tools_pick_path,
            tools::tools_check,
            tools::tools_install,
            tools::tools_run,
            web_session::web_session_show,
            web_session::web_session_reload,
            web_session::web_session_hide,
            web_session::web_session_close,
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // Tauri only assigns the small title-bar icon. Windows then keeps the
            // taskbar icon from the first exe it cached, so set the large icon too.
            #[cfg(windows)]
            apply_taskbar_icon(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}

#[cfg(windows)]
fn apply_taskbar_icon(app: &tauri::AppHandle) {
    use tauri::Manager;

    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    set_module_icon(hwnd.0);
}

#[cfg(windows)]
fn set_module_icon(hwnd: *mut std::ffi::c_void) {
    const IMAGE_ICON: u32 = 1;
    const WM_SETICON: u32 = 0x0080;
    const ICON_SMALL: usize = 0;
    const ICON_BIG: usize = 1;
    // tauri-build embeds icon.ico under this resource id.
    const APP_ICON_ID: usize = 32512;

    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetModuleHandleW(module: *const u16) -> *mut std::ffi::c_void;
        fn LoadImageW(
            instance: *mut std::ffi::c_void,
            name: *const u16,
            kind: u32,
            width: i32,
            height: i32,
            flags: u32,
        ) -> *mut std::ffi::c_void;
        fn SendMessageW(
            hwnd: *mut std::ffi::c_void,
            msg: u32,
            wparam: usize,
            lparam: isize,
        ) -> isize;
    }

    unsafe {
        let module = GetModuleHandleW(std::ptr::null());
        let name = APP_ICON_ID as *const u16;
        let small = LoadImageW(module, name, IMAGE_ICON, 32, 32, 0);
        let big = LoadImageW(module, name, IMAGE_ICON, 256, 256, 0);
        if !small.is_null() {
            SendMessageW(hwnd, WM_SETICON, ICON_SMALL, small as isize);
        }
        if !big.is_null() {
            SendMessageW(hwnd, WM_SETICON, ICON_BIG, big as isize);
        }
    }
}
