//! Client-drawn window title bar.
//!
//! Same shape as the story gallery title bar: the bar owns dragging, and the
//! trailing cluster holds window actions that must not start a drag.

use crate::app::WorkbenchApp;
use crate::state::AppState;
use crate::themes;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::menu::{DropdownMenu as _, PopupMenu, PopupMenuItem};
use gpui_kit::component::scroll::ScrollbarMode;
use gpui_kit::component::*;
use gpui_kit::*;
use wb_domain::{NotificationStatus, ThemeModePref};

pub fn workbench_title_bar(
    state: AppState,
    host: WeakEntity<WorkbenchApp>,
    cx: &mut App,
) -> impl IntoElement {
    let pending = state.with(|inner| {
        inner
            .repo
            .list_notifications()
            .into_iter()
            .filter(|note| {
                matches!(
                    note.status,
                    NotificationStatus::Pending | NotificationStatus::Delivered
                )
            })
            .count()
    });
    let save_ok = state.with(|inner| inner.save_status.ok);
    let bell_state = state.clone();
    let bell_host = host.clone();
    let menu_state = state;
    let menu_host = host;

    TitleBar::new()
        .child(
            div()
                .flex()
                .items_center()
                .text_sm()
                .font_weight(FontWeight::MEDIUM)
                .child("个人工作台"),
        )
        .child(
            div()
                .flex()
                .items_center()
                .justify_end()
                .px_2()
                .gap_2()
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .child(
                    div()
                        .text_xs()
                        .text_color(if save_ok {
                            cx.theme().muted_foreground
                        } else {
                            cx.theme().danger
                        })
                        .child(if save_ok { "已保存" } else { "保存失败" }),
                )
                .child(
                    Button::new("bell")
                        .small()
                        .ghost()
                        .icon(IconName::Bell)
                        .label(if pending > 0 {
                            pending.to_string()
                        } else {
                            String::new()
                        })
                        .on_click(move |_, _, cx| {
                            bell_state.with_mut(|inner| {
                                inner.notifications_open = !inner.notifications_open;
                            });
                            notify_host(&bell_host, cx);
                        }),
                )
                .child(
                    Button::new("appearance")
                        .small()
                        .ghost()
                        .icon(IconName::Settings2)
                        .dropdown_menu(move |menu, window, cx| {
                            appearance_menu(menu, window, cx, menu_state.clone(), menu_host.clone())
                        })
                        .anchor(Anchor::TopRight),
                ),
        )
}

fn appearance_menu(
    menu: PopupMenu,
    window: &mut Window,
    cx: &mut Context<PopupMenu>,
    state: AppState,
    host: WeakEntity<WorkbenchApp>,
) -> PopupMenu {
    let font_size = cx.theme().font_size.as_f32().round() as i32;
    let radius = cx.theme().radius.as_f32().round() as i32;
    let scrollbar = cx.theme().scrollbar_mode;
    let theme_mode = state.theme_mode();
    let active_theme = cx.theme().theme_name().clone();

    menu.check_side(Side::Right)
        .submenu("字号", window, cx, {
            let state = state.clone();
            let host = host.clone();
            move |menu, _, _| {
                numbered_menu(
                    menu,
                    &[(18, "大"), (16, "标准"), (14, "小")],
                    font_size,
                    state.clone(),
                    host.clone(),
                    |size, state, cx| themes::set_font_size(size as f32, state, cx),
                )
            }
        })
        .submenu("圆角", window, cx, {
            let state = state.clone();
            let host = host.clone();
            move |menu, _, _| {
                numbered_menu(
                    menu,
                    &[(8, "8px"), (6, "6px"), (4, "4px"), (0, "0px")],
                    radius,
                    state.clone(),
                    host.clone(),
                    |value, state, cx| themes::set_radius(value as f32, state, cx),
                )
            }
        })
        .submenu("滚动条", window, cx, {
            let state = state.clone();
            let host = host.clone();
            move |menu, _, _| {
                menu.check_side(Side::Right)
                    .item(pick(
                        "滚动时显示",
                        scrollbar == ScrollbarMode::Scrolling,
                        {
                            let state = state.clone();
                            let host = host.clone();
                            move |_, cx| {
                                themes::set_scrollbar_mode(ScrollbarMode::Scrolling, &state, cx);
                                notify_host(&host, cx);
                            }
                        },
                    ))
                    .item(pick("悬停显示", scrollbar == ScrollbarMode::Hover, {
                        let state = state.clone();
                        let host = host.clone();
                        move |_, cx| {
                            themes::set_scrollbar_mode(ScrollbarMode::Hover, &state, cx);
                            notify_host(&host, cx);
                        }
                    }))
                    .item(pick("始终显示", scrollbar == ScrollbarMode::Always, {
                        let state = state.clone();
                        let host = host.clone();
                        move |_, cx| {
                            themes::set_scrollbar_mode(ScrollbarMode::Always, &state, cx);
                            notify_host(&host, cx);
                        }
                    }))
            }
        })
        .separator()
        .submenu("外观", window, cx, {
            let state = state.clone();
            let host = host.clone();
            move |menu, _, _| {
                menu.check_side(Side::Right)
                    .item(pick("浅色", theme_mode == ThemeModePref::Light, {
                        let state = state.clone();
                        let host = host.clone();
                        move |window, cx| {
                            themes::set_theme_mode(ThemeModePref::Light, &state, Some(window), cx);
                            notify_host(&host, cx);
                        }
                    }))
                    .item(pick("深色", theme_mode == ThemeModePref::Dark, {
                        let state = state.clone();
                        let host = host.clone();
                        move |window, cx| {
                            themes::set_theme_mode(ThemeModePref::Dark, &state, Some(window), cx);
                            notify_host(&host, cx);
                        }
                    }))
                    .item(pick("跟随系统", theme_mode == ThemeModePref::System, {
                        let state = state.clone();
                        let host = host.clone();
                        move |window, cx| {
                            themes::set_theme_mode(ThemeModePref::System, &state, Some(window), cx);
                            notify_host(&host, cx);
                        }
                    }))
            }
        })
        .submenu("浅色主题", window, cx, {
            let state = state.clone();
            let host = host.clone();
            let active_theme = active_theme.clone();
            move |menu, _, cx| theme_submenu(menu, cx, &state, &host, &active_theme, false)
        })
        .submenu("深色主题", window, cx, {
            let state = state.clone();
            let host = host.clone();
            move |menu, _, cx| theme_submenu(menu, cx, &state, &host, &active_theme, true)
        })
}

fn numbered_menu(
    menu: PopupMenu,
    options: &[(i32, &str)],
    current: i32,
    state: AppState,
    host: WeakEntity<WorkbenchApp>,
    apply: fn(i32, &AppState, &mut App),
) -> PopupMenu {
    let mut menu = menu.check_side(Side::Right);
    for &(value, label) in options {
        let state = state.clone();
        let host = host.clone();
        menu = menu.item(pick(label, current == value, move |_, cx| {
            apply(value, &state, cx);
            notify_host(&host, cx);
        }));
    }
    menu
}

fn theme_submenu(
    menu: PopupMenu,
    cx: &mut Context<PopupMenu>,
    state: &AppState,
    host: &WeakEntity<WorkbenchApp>,
    active_theme: &SharedString,
    dark: bool,
) -> PopupMenu {
    let names: Vec<SharedString> = ThemeRegistry::global(cx)
        .sorted_themes()
        .into_iter()
        .filter(|theme| theme.mode.is_dark() == dark)
        .map(|theme| theme.name.clone())
        .collect();

    let mut menu = menu
        .check_side(Side::Right)
        .scrollable(true)
        .max_h(px(420.));
    if names.is_empty() {
        return menu.label("未找到主题文件");
    }
    for name in names {
        let state = state.clone();
        let host = host.clone();
        let label = name.clone();
        menu = menu.item(
            PopupMenuItem::new(label)
                .checked(name == *active_theme)
                .on_click(move |_, _, cx| {
                    themes::select_theme(&name, &state, cx);
                    notify_host(&host, cx);
                }),
        );
    }
    menu
}

fn pick(
    label: impl Into<SharedString>,
    checked: bool,
    on_select: impl Fn(&mut Window, &mut App) + 'static,
) -> PopupMenuItem {
    PopupMenuItem::new(label)
        .checked(checked)
        .on_click(move |_, window, cx| on_select(window, cx))
}

fn notify_host(host: &WeakEntity<WorkbenchApp>, cx: &mut App) {
    host.update(cx, |_, cx| cx.notify()).ok();
}
