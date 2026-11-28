//! Hadron 风格共享视觉令牌。
//!
//! 设计语言只有三句话：**近黑画布、中性深灰面板、紫罗兰强调色**。
//! 层级靠“底色 → 面板 → 卡片 → 悬停”四级表面拉开，边框是一根低透明度
//! 的发丝线，阴影一律不用（模糊阴影在软件渲染下太贵，也破坏克制的质感）。
//!
//! 视图层不要自己写 `rgb(...)`：需要表面就取 [`panel`] / [`card`] / [`raised`]，
//! 需要分隔线就取 [`hairline`]，需要强调就取 [`accent`]。

use gpui_kit::component::ActiveTheme as _;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

/// 画布底色：整个窗口最底层的近黑（浅色主题为柔和灰白）。
pub fn canvas(cx: &App) -> Hsla {
    cx.theme().background
}

/// 面板底色：侧栏、主内容区这类大块表面。
///
/// 深色下带一点透明度，让角落光晕能透上来形成“玻璃”层次；
/// 浅色下保持不透明，避免文字发灰。
pub fn panel(cx: &App) -> Hsla {
    let secondary = cx.theme().secondary;
    if is_dark(cx) {
        secondary.opacity(0.94)
    } else {
        secondary
    }
}

/// 卡片底色：比面板再抬一层，用于列表项、设置卡片、消息气泡。
pub fn card(cx: &App) -> Hsla {
    let secondary = cx.theme().secondary;
    if is_dark(cx) {
        secondary.opacity(0.80)
    } else {
        secondary
    }
}

/// 抬升表面：输入框、悬停态、选中态。
pub fn raised(cx: &App) -> Hsla {
    cx.theme().secondary_hover
}

/// 发丝边框：深色主题用 7% 白，浅色主题回落到主题边框色。
pub fn hairline(cx: &App) -> Hsla {
    hairline_color(is_dark(cx), cx.theme().border)
}

/// 通用悬停底色：深色提亮、浅色加深，幅度都很克制。
pub fn hover(cx: &App) -> Hsla {
    if is_dark(cx) {
        rgba(0xffffff0d).into()
    } else {
        rgba(0x00000008).into()
    }
}

/// 强调色（默认紫罗兰），用于主按钮、选中项、焦点环。
pub fn accent(cx: &App) -> Hsla {
    cx.theme().primary
}

/// 面板圆角（对应主题的 `radius.lg`）。
pub fn panel_radius(cx: &App) -> Pixels {
    cx.theme().radius_lg
}

/// 卡片圆角（对应主题的 `radius`）。
pub fn card_radius(cx: &App) -> Pixels {
    cx.theme().radius
}

/// 画布角落的极低透明度光晕。
///
/// Hadron 用四角“耳语”保留状态色：左上orchid、右上violet、左下mint。
/// 这里只画三团，避免四角同时发亮显得花哨；浅色主题不画，保持干净。
pub fn field_wash(cx: &App) -> impl IntoElement {
    let dark = is_dark(cx);
    let accent = accent(cx);
    let info = cx.theme().info;
    let success = cx.theme().success;
    div().absolute().size_full().when(dark, |layer| {
        layer
            .child(
                div()
                    .absolute()
                    .top_0()
                    .left_0()
                    .size(px(520.))
                    .bg(linear_gradient(
                        135.,
                        linear_color_stop(info.opacity(0.10), 0.),
                        linear_color_stop(info.opacity(0.0), 1.),
                    )),
            )
            .child(
                div()
                    .absolute()
                    .top_0()
                    .right_0()
                    .size(px(460.))
                    .bg(linear_gradient(
                        225.,
                        linear_color_stop(accent.opacity(0.09), 0.),
                        linear_color_stop(accent.opacity(0.0), 1.),
                    )),
            )
            .child(
                div()
                    .absolute()
                    .bottom_0()
                    .left_0()
                    .size(px(420.))
                    .bg(linear_gradient(
                        45.,
                        linear_color_stop(success.opacity(0.07), 0.),
                        linear_color_stop(success.opacity(0.0), 1.),
                    )),
            )
    })
}

/// 当前外观是否为深色。
fn is_dark(cx: &App) -> bool {
    cx.theme().mode.is_dark()
}

/// 纯函数：根据明暗和主题边框色算出发丝边框色。
fn hairline_color(dark: bool, border: Hsla) -> Hsla {
    if dark {
        rgba(0xffffff12).into()
    } else {
        border
    }
}
