//! System tray icon: show / quit. Close-to-tray is handled in the window layer.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use tray_icon::menu::{Menu, MenuEvent, MenuItem};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder, TrayIconEvent};

static FORCE_QUIT: AtomicBool = AtomicBool::new(false);
static SHOW_ITEM_ID: Mutex<Option<tray_icon::menu::MenuId>> = Mutex::new(None);
static QUIT_ITEM_ID: Mutex<Option<tray_icon::menu::MenuId>> = Mutex::new(None);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayAction {
    Show,
    Quit,
}

pub fn request_force_quit() {
    FORCE_QUIT.store(true, Ordering::SeqCst);
}

pub fn is_force_quit() -> bool {
    FORCE_QUIT.load(Ordering::SeqCst)
}

/// Application icon embedded from `data/icons/app.svg` (Windows resource id 1).
fn make_icon() -> Option<Icon> {
    #[cfg(windows)]
    match Icon::from_resource(1, Some((32, 32))) {
        Ok(icon) => return Some(icon),
        Err(err) => log::warn!("加载应用图标失败，使用占位图标: {err}"),
    }
    solid_icon()
}

/// 32×32 solid accent-like icon (RGBA). Used when the embedded icon is unavailable.
fn solid_icon() -> Option<Icon> {
    const SIZE: u32 = 32;
    let mut rgba = vec![0u8; (SIZE * SIZE * 4) as usize];
    for y in 0..SIZE {
        for x in 0..SIZE {
            let i = ((y * SIZE + x) * 4) as usize;
            // soft blue tile with lighter border
            let border = x == 0 || y == 0 || x == SIZE - 1 || y == SIZE - 1;
            if border {
                rgba[i] = 0x2a;
                rgba[i + 1] = 0x6a;
                rgba[i + 2] = 0xc7;
                rgba[i + 3] = 0xff;
            } else {
                rgba[i] = 0x3b;
                rgba[i + 1] = 0x82;
                rgba[i + 2] = 0xf6;
                rgba[i + 3] = 0xff;
            }
        }
    }
    Icon::from_rgba(rgba, SIZE, SIZE).ok()
}

pub fn create_tray() -> Option<TrayIcon> {
    let icon = make_icon()?;
    let menu = Menu::new();
    let show = MenuItem::new("显示主窗口", true, None);
    let quit = MenuItem::new("退出", true, None);
    if menu.append(&show).is_err() || menu.append(&quit).is_err() {
        log::warn!("托盘菜单创建失败");
        return None;
    }
    *SHOW_ITEM_ID.lock().unwrap() = Some(show.id().clone());
    *QUIT_ITEM_ID.lock().unwrap() = Some(quit.id().clone());

    match TrayIconBuilder::new()
        .with_menu(Box::new(menu))
        .with_tooltip("个人工作台")
        .with_icon(icon)
        .build()
    {
        Ok(tray) => {
            log::info!("系统托盘已启用");
            Some(tray)
        }
        Err(e) => {
            log::warn!("创建系统托盘失败: {e}");
            None
        }
    }
}

/// Non-blocking poll of tray / menu events.
pub fn poll_action() -> Option<TrayAction> {
    while let Ok(event) = TrayIconEvent::receiver().try_recv() {
        if let TrayIconEvent::Click {
            button: tray_icon::MouseButton::Left,
            button_state: tray_icon::MouseButtonState::Up,
            ..
        } = event
        {
            return Some(TrayAction::Show);
        }
    }
    while let Ok(event) = MenuEvent::receiver().try_recv() {
        let show_id = SHOW_ITEM_ID.lock().unwrap().clone();
        let quit_id = QUIT_ITEM_ID.lock().unwrap().clone();
        if show_id.as_ref() == Some(&event.id) {
            return Some(TrayAction::Show);
        }
        if quit_id.as_ref() == Some(&event.id) {
            return Some(TrayAction::Quit);
        }
    }
    None
}
