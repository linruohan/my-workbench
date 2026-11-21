//! Theme / font application helpers shared by shell and settings.

use gpui_kit::component::{Theme, ThemeMode};
use gpui_kit::{App, SharedString, Window};
use wb_domain::ThemeModePref;

pub fn apply_theme_pref(mode: ThemeModePref, window: Option<&mut Window>, cx: &mut App) {
    match mode {
        ThemeModePref::Light => Theme::change(ThemeMode::Light, window, cx),
        ThemeModePref::Dark => Theme::change(ThemeMode::Dark, window, cx),
        ThemeModePref::System => Theme::sync_system_appearance(window, cx),
    }
}

pub fn apply_ui_font(family: Option<String>, cx: &mut App) {
    Theme::update(cx, |theme| {
        theme.font_family = match family {
            Some(f) if !f.trim().is_empty() => SharedString::from(f.trim().to_string()),
            _ => SharedString::from(".SystemUIFont"),
        };
    });
}
