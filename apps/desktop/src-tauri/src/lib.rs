mod kb;

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
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
