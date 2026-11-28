//! 会话重命名弹窗。
//!
//! 左栏会话行点「更多」后打开：一个输入框 + 取消/保存。保存时把新的
//! `SessionName` 事件写进对应 field（活动会话写 `<repo>/.wb/field.jsonl`，
//! 归档会话写 `<repo>/.wb/sessions/<id>/field.jsonl`）。

use crate::app::WorkbenchApp;
use crate::style;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::*;
use gpui_kit::*;

/// 重命名的目标。
#[derive(Clone, Debug)]
pub(crate) struct RenameTarget {
    /// 目标工作区在宿主 `workspaces` 里的下标。
    pub workspace: usize,
    /// 会话 id；`active` 表示当前活动会话。
    pub session_id: String,
}

/// 重命名弹窗本体。
pub struct RenameDialog {
    host: WeakEntity<WorkbenchApp>,
    input: Entity<InputState>,
    target: RenameTarget,
    _subs: Vec<Subscription>,
}

impl RenameDialog {
    /// 构建弹窗；`current` 是当前名字，预填到输入框里方便直接改。
    pub fn new(
        host: WeakEntity<WorkbenchApp>,
        target: RenameTarget,
        current: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("会话名称")
                .default_value(current)
        });
        let mut this = Self {
            host,
            input: input.clone(),
            target,
            _subs: Vec::new(),
        };
        // 回车直接保存，省一次点击。
        this._subs.push(
            cx.subscribe_in(&input, window, |this, _, event, window, cx| {
                if matches!(event, InputEvent::PressEnter { .. }) {
                    this.submit(window, cx);
                }
            }),
        );
        this
    }

    /// 把焦点交给输入框（打开弹窗后立刻可输入）。
    pub fn focus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.input.focus_handle(cx).focus(window, cx);
    }

    /// 保存：名字非空才生效，然后通知宿主写盘并关闭弹窗。
    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let name = self.input.read(cx).value().trim().to_string();
        if name.is_empty() {
            self.focus(window, cx);
            return;
        }
        if let Some(host) = self.host.upgrade() {
            let target = self.target.clone();
            host.update(cx, |app, cx| {
                app.apply_session_rename(&target, name, cx);
            });
        }
    }

    /// 取消：只关掉弹窗，不写任何东西。
    fn cancel(&mut self, cx: &mut Context<Self>) {
        if let Some(host) = self.host.upgrade() {
            host.update(cx, |app, cx| app.close_session_rename(cx));
        }
    }
}

impl Render for RenameDialog {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .id("rename-session-backdrop")
            .absolute()
            .inset_0()
            .flex()
            .items_center()
            .justify_center()
            .bg(cx.theme().overlay.opacity(0.62))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, _, cx| {
                    this.cancel(cx);
                }),
            )
            .child(
                v_flex()
                    .w(px(380.))
                    .rounded(style::panel_radius(cx))
                    .bg(style::card(cx))
                    .text_color(cx.theme().popover_foreground)
                    .border_1()
                    .border_color(style::hairline(cx))
                    .p_4()
                    .gap_3()
                    // 阻断冒泡，点卡片内部不会触发遮罩的关闭。
                    .on_mouse_down(MouseButton::Left, |_, _, _| {})
                    .child(
                        div()
                            .text_sm()
                            .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                            .child("重命名会话"),
                    )
                    .child(Input::new(&self.input))
                    .child(
                        h_flex()
                            .justify_end()
                            .gap_2()
                            .child(Button::new("rename-session-cancel").label("取消").on_click(
                                cx.listener(|this, _, _, cx| {
                                    this.cancel(cx);
                                }),
                            ))
                            .child(
                                Button::new("rename-session-save")
                                    .primary()
                                    .label("保存")
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.submit(window, cx);
                                    })),
                            ),
                    ),
            )
    }
}
