mod app;
mod appearance;
mod command_palette;
mod composer_text;
mod state;
mod themes;
mod timed_deliver;
mod title_bar;
mod tray;
mod views;

use gpui_kit::assets::Assets;
use gpui_kit::component::TitleBar;
use gpui_kit::*;

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let app = gpui_kit::application().with_assets(Assets);
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
            WindowBounds::centered(default_size, cx)
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
