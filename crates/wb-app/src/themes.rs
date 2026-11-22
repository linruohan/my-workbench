//! Theme registry loading and appearance persistence.
//!
//! Follows the story gallery: watch a themes directory, apply a named theme
//! through [`ThemeRegistry`], and keep radius, font size and scrollbar mode
//! on top of that theme.

use crate::appearance::{apply_theme_pref, apply_ui_font};
use crate::state::AppState;
use gpui_kit::component::scroll::ScrollbarMode;
use gpui_kit::component::{ActiveTheme as _, Theme, ThemeRegistry};
use gpui_kit::{App, SharedString, Window};
use std::path::{Path, PathBuf};
use wb_domain::{AppPrefs, ThemeModePref};

pub fn init(cx: &mut App) {
    let dir = resolve_themes_dir();
    log::info!("主题目录: {}", dir.display());
    if let Err(err) = ThemeRegistry::watch_dir(dir, cx, |cx| {
        apply_saved_appearance(None, cx);
    }) {
        log::error!("监听主题目录失败: {err}");
    }
}

/// Apply the prefs file: named theme, light/dark/system, then local overrides.
pub fn apply_saved_appearance(window: Option<&mut Window>, cx: &mut App) {
    let prefs = wb_store::load_prefs().unwrap_or_else(|err| {
        log::warn!("读取外观设置失败: {err}");
        AppPrefs::default()
    });
    apply_named_theme(prefs.theme_name.as_deref(), cx);
    apply_theme_pref(prefs.theme_mode, window, cx);
    apply_overrides_from(&prefs, cx);
}

pub fn select_theme(name: &str, state: &AppState, cx: &mut App) {
    if !apply_named_theme(Some(name), cx) {
        log::warn!("未找到主题: {name}");
        return;
    }
    let mode = if cx.theme().is_dark() {
        ThemeModePref::Dark
    } else {
        ThemeModePref::Light
    };
    state.with_mut(|prefs| {
        prefs.prefs.theme_name = Some(name.to_string());
        prefs.prefs.theme_mode = mode;
    });
    state.persist_prefs();
    reapply_overrides(state, cx);
}

pub fn set_theme_mode(
    mode: ThemeModePref,
    state: &AppState,
    window: Option<&mut Window>,
    cx: &mut App,
) {
    state.with_mut(|prefs| prefs.prefs.theme_mode = mode);
    state.persist_prefs();
    apply_theme_pref(mode, window, cx);
    reapply_overrides(state, cx);
}

pub fn set_font_size(size: f32, state: &AppState, cx: &mut App) {
    state.with_mut(|prefs| prefs.prefs.font_size = Some(size));
    state.persist_prefs();
    Theme::update(cx, |theme| theme.font_size = gpui_kit::px(size));
}

pub fn set_radius(radius: f32, state: &AppState, cx: &mut App) {
    state.with_mut(|prefs| prefs.prefs.ui_radius = Some(radius));
    state.persist_prefs();
    Theme::update(cx, |theme| apply_radius(theme, radius));
}

pub fn set_scrollbar_mode(mode: ScrollbarMode, state: &AppState, cx: &mut App) {
    state.with_mut(|prefs| prefs.prefs.scrollbar_mode = Some(scrollbar_id(mode).to_string()));
    state.persist_prefs();
    Theme::set_scrollbar_mode(mode, cx);
}

/// Put saved radius, font and scrollbar back after a theme or mode switch.
pub fn reapply_overrides(state: &AppState, cx: &mut App) {
    let prefs = state.with(|prefs| prefs.prefs.clone());
    apply_overrides_from(&prefs, cx);
}

fn apply_named_theme(name: Option<&str>, cx: &mut App) -> bool {
    let Some(name) = name.map(str::trim).filter(|name| !name.is_empty()) else {
        return false;
    };
    let key = SharedString::from(name.to_string());
    let Some(config) = ThemeRegistry::global(cx).themes().get(&key).cloned() else {
        return false;
    };
    Theme::update(cx, |theme| theme.apply_config(&config));
    true
}

fn apply_overrides_from(prefs: &AppPrefs, cx: &mut App) {
    let radius = prefs.ui_radius;
    let font_size = prefs.font_size;
    if radius.is_some() || font_size.is_some() {
        Theme::update(cx, |theme| {
            if let Some(radius) = radius {
                apply_radius(theme, radius);
            }
            if let Some(size) = font_size {
                theme.font_size = gpui_kit::px(size);
            }
        });
    }
    apply_ui_font(prefs.ui_font.clone(), cx);
    if let Some(mode) = prefs.scrollbar_mode.as_deref().and_then(parse_scrollbar) {
        Theme::set_scrollbar_mode(mode, cx);
    }
}

fn apply_radius(theme: &mut Theme, radius: f32) {
    theme.radius = gpui_kit::px(radius);
    theme.radius_lg = if radius > 0. {
        gpui_kit::px(radius + 2.)
    } else {
        gpui_kit::px(0.)
    };
}

fn scrollbar_id(mode: ScrollbarMode) -> &'static str {
    match mode {
        ScrollbarMode::Scrolling => "scrolling",
        ScrollbarMode::Hover => "hover",
        ScrollbarMode::Always => "always",
    }
}

fn parse_scrollbar(raw: &str) -> Option<ScrollbarMode> {
    match raw.trim() {
        "scrolling" => Some(ScrollbarMode::Scrolling),
        "hover" => Some(ScrollbarMode::Hover),
        "always" => Some(ScrollbarMode::Always),
        _ => None,
    }
}

fn resolve_themes_dir() -> PathBuf {
    if let Ok(raw) = std::env::var("WB_THEMES_DIR") {
        let path = PathBuf::from(raw.trim());
        if dir_has_themes(&path) {
            return path;
        }
    }

    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("themes"));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("themes"));
        candidates.push(cwd.join("../gpui-kit/themes"));
    }
    if let Ok(data) = wb_store::resolve_data_dir() {
        candidates.push(data.join("themes"));
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../gpui-kit/themes"));

    for path in &candidates {
        if dir_has_themes(path) {
            return path.clone();
        }
    }

    candidates
        .into_iter()
        .next()
        .unwrap_or_else(|| PathBuf::from("themes"))
}

fn dir_has_themes(path: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(path) else {
        return false;
    };
    entries.filter_map(|entry| entry.ok()).any(|entry| {
        entry
            .path()
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrollbar_mode_round_trips() {
        for mode in [
            ScrollbarMode::Scrolling,
            ScrollbarMode::Hover,
            ScrollbarMode::Always,
        ] {
            assert_eq!(parse_scrollbar(scrollbar_id(mode)), Some(mode));
        }
        assert_eq!(parse_scrollbar("nope"), None);
    }
}
