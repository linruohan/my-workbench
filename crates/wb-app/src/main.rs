// release 构建以 Windows GUI 子系统启动，避免弹出黑色控制台窗口；
// debug 构建保留控制台，方便开发时直接看日志。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod appearance;
mod command_palette;
mod rename_dialog;
mod session_tabs;
mod state;
mod style;
mod themes;
mod timed_deliver;
mod title_bar;
mod tray;
mod views;

// `Assets` only embeds gpui-kit's default icon subset; the app also paints
// icons outside it (Wrench, GitBranch, X), which log "could not find asset".
use gpui_kit::assets::AllAssets;
use gpui_kit::component::TitleBar;
use gpui_kit::*;

/// 日志目录：`<数据目录>/logs`，默认即 `%APPDATA%\my-workbench\logs`。
fn log_dir() -> Option<std::path::PathBuf> {
    Some(wb_store::ensure_data_dir().ok()?.join("logs"))
}

/// 初始化日志。
///
/// release 没有控制台，日志写入 `<数据目录>/logs/workbench.log`；debug 保持输出
/// 到控制台。无论哪种构建，都会设置 `WB_LOG_DIR`，让 wb-gluon 子进程把日志
/// 重定向到同一个目录。
fn init_logging() {
    let dir = log_dir();
    if let Some(dir) = &dir {
        let _ = std::fs::create_dir_all(dir);
        // SAFETY: 此时还在 main 最早期、其他线程尚未启动，不存在并发读写环境变量。
        unsafe { std::env::set_var("WB_LOG_DIR", dir) };
    }
    let mut builder =
        env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"));
    #[cfg(not(debug_assertions))]
    if let Some(dir) = &dir {
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("workbench.log"));
        if let Ok(file) = file {
            builder.target(env_logger::Target::Pipe(Box::new(file)));
        }
    }
    builder.init();
}

fn main() {
    init_logging();

    let app = gpui_kit::application().with_assets(AllAssets);
    app.run(move |cx| {
        gpui_kit::init(cx);
        themes::init(cx);
        // TextView remote images (`![…](https://…)`) stay blank without a client.
        match reqwest_client::ReqwestClient::user_agent("my-workbench") {
            Ok(client) => cx.set_http_client(std::sync::Arc::new(client)),
            Err(err) => log::warn!("无法创建图片 HTTP 客户端: {err}"),
        }

        let restore = wb_store::load_prefs()
            .ok()
            .map(|prefs| prefs.general.window_restore)
            .unwrap_or_else(|| "default".into());
        let default_size = size(px(1280.), px(800.));
        let window_bounds = if restore == "maximized" {
            WindowBounds::Maximized(Bounds::centered(None, default_size, cx))
        } else {
            WindowBounds::centered(None, default_size, cx)
        };
        let window_options = WindowOptions {
            window_bounds: Some(window_bounds),
            window_min_size: Some(size(px(960.), px(640.))),
            #[cfg(target_os = "linux")]
            window_background: WindowBackgroundAppearance::Opaque,
            #[cfg(target_os = "linux")]
            window_decorations: Some(WindowDecorations::Client),
            ..TitleBar::window_options()
        };

        gpui_kit::open_window(window_options, cx, |window, cx| {
            cx.new(|cx| app::WorkbenchApp::new(window, cx))
        })
        .expect("无法打开窗口");
    });
}
