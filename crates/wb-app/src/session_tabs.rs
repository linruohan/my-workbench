//! 会话标签栏。
//!
//! 主区顶部一排已打开的会话：点击切换，点 × 关闭。多个会话各自持有独立的
//! chamber（独立 field 与守护进程），所以切换标签就是真正的「并行多聊天」。

use crate::app::WorkbenchApp;
use crate::style;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::*;
use gpui_kit::*;

/// 渲染会话标签栏。
///
/// `tabs` 是 (标签文字, 是否前台)，下标即会话池下标；末尾固定一个「+」新建会话。
pub(crate) fn session_tab_bar(
    tabs: &[(String, bool)],
    cx: &mut Context<WorkbenchApp>,
) -> impl IntoElement + use<> {
    let mut row = h_flex()
        .flex_none()
        .h(px(38.))
        .w_full()
        .items_center()
        .gap_1()
        .px_2()
        .border_b_1()
        .border_color(style::hairline(cx))
        .overflow_x_scrollbar();

    for (index, (label, active)) in tabs.iter().enumerate() {
        row = row.child(session_tab(index, label, *active, cx));
    }

    row.child(
        Button::new("session-tab-new")
            .ghost()
            .xsmall()
            .icon(IconName::Plus)
            .tooltip("新建会话")
            .on_click(cx.listener(|this, _, window, cx| {
                this.handle_workbench_nav("new-session", window, cx);
            })),
    )
}

/// 单个会话标签：名字 + 关闭按钮；前台标签用强调色描边区分。
fn session_tab(
    index: usize,
    label: &str,
    active: bool,
    cx: &mut Context<WorkbenchApp>,
) -> impl IntoElement + use<> {
    let label = label.to_string();
    let radius = style::card_radius(cx);
    let hairline = style::hairline(cx);
    let accent = style::accent(cx);
    let hover_bg = style::hover(cx);
    let bg = if active {
        style::raised(cx)
    } else {
        style::panel(cx)
    };
    let fg = if active {
        cx.theme().foreground
    } else {
        cx.theme().muted_foreground
    };
    let border = if active {
        accent.opacity(0.45)
    } else {
        hairline
    };

    h_flex()
        .id(SharedString::from(format!("session-tab-{index}")))
        .flex_none()
        .h(px(26.))
        .max_w(px(200.))
        .items_center()
        .gap_1()
        .pl_2()
        .pr_1()
        .rounded(radius)
        .border_1()
        .border_color(border)
        .bg(bg)
        .cursor_pointer()
        .hover(move |s| s.bg(hover_bg))
        .on_click(cx.listener(move |this, _, _, cx| {
            this.activate_open_session(index, cx);
        }))
        .child(
            div()
                .min_w_0()
                .truncate()
                .text_xs()
                .text_color(fg)
                .child(label),
        )
        .child(
            div()
                .id(SharedString::from(format!("session-tab-close-{index}")))
                .flex()
                .flex_none()
                .items_center()
                .justify_center()
                .size(px(16.))
                .rounded_sm()
                .cursor_pointer()
                .hover(move |s| s.bg(hairline))
                .child(
                    Icon::new(gpui_kit::assets::IconName::X)
                        .xsmall()
                        .text_color(cx.theme().muted_foreground),
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    // 关闭按钮与标签切换互斥：阻止冒泡后再关。
                    cx.stop_propagation();
                    this.close_open_session(index, cx);
                })),
        )
}
