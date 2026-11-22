//! 添加 / 编辑模型弹窗：智能配置、上下文、输入类型、能力与推理映射。

use crate::views::settings::SettingsPane;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputState, Textarea, TextareaState};
use gpui_kit::component::switch::Switch;
use gpui_kit::component::{ActiveTheme, Icon, IconName, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use serde_json::{Value, json};

const DEFAULT_CONTEXT: &str = "8192";
const DEFAULT_OUTPUT: &str = "2048";

#[derive(Clone, Copy)]
struct ChipColors {
    border: Hsla,
    primary: Hsla,
    on_primary: Hsla,
    secondary: Hsla,
}

pub(super) struct ModelDraft {
    pane: WeakEntity<SettingsPane>,
    provider_id: String,
    smart: bool,
    advanced: bool,
    image: bool,
    video: bool,
    pdf: bool,
    structured: bool,
    web_search: bool,
    system_in_chat: bool,
    levels: Vec<String>,
    composing: bool,
    /// 正在编辑的模型 ID。为空表示这次是添加。
    editing_id: Option<String>,
    baseline: Option<Value>,
    error: SharedString,
    pub(super) model_id: Entity<InputState>,
    context: Entity<InputState>,
    output: Entity<InputState>,
    pub(super) level: Entity<InputState>,
    reasoning_map: Entity<TextareaState>,
}

impl ModelDraft {
    pub(super) fn new(
        pane: WeakEntity<SettingsPane>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let model_id = cx.new(|cx| InputState::new(window, cx).placeholder("模型 ID"));
        let context = cx.new(|cx| InputState::new(window, cx).placeholder(DEFAULT_CONTEXT));
        let output = cx.new(|cx| InputState::new(window, cx).placeholder(DEFAULT_OUTPUT));
        let level = cx.new(|cx| InputState::new(window, cx).placeholder("推理等级"));
        let reasoning_map = cx.new(|cx| TextareaState::new(window, cx).rows(4));
        let mut draft = Self {
            pane,
            provider_id: String::new(),
            smart: true,
            advanced: true,
            image: false,
            video: false,
            pdf: false,
            structured: false,
            web_search: false,
            system_in_chat: false,
            levels: Vec::new(),
            composing: false,
            editing_id: None,
            baseline: None,
            error: SharedString::default(),
            model_id,
            context,
            output,
            level,
            reasoning_map,
        };
        draft.reset(window, cx);
        draft
    }

    pub(super) fn is_editing(&self) -> bool {
        self.editing_id.is_some()
    }

    pub(super) fn prepare(
        &mut self,
        provider_id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.provider_id = provider_id;
        self.editing_id = None;
        self.baseline = None;
        self.reset(window, cx);
        self.model_id
            .update(cx, |input, cx| input.focus(window, cx));
        cx.notify();
    }

    pub(super) fn prepare_edit(
        &mut self,
        provider_id: String,
        model_id: String,
        caps: Value,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.provider_id = provider_id;
        self.editing_id = Some(model_id);
        self.baseline = Some(caps);
        self.reset(window, cx);
        self.model_id
            .update(cx, |input, cx| input.focus(window, cx));
        cx.notify();
    }

    pub(super) fn reset(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.composing = false;
        self.error = SharedString::default();
        self.level
            .update(cx, |input, cx| input.set_value("", window, cx));
        if let Some(caps) = self.baseline.clone() {
            let model_id = self.editing_id.clone().unwrap_or_default();
            self.apply_caps(&model_id, &caps, window, cx);
            return;
        }
        self.smart = true;
        self.advanced = true;
        self.image = false;
        self.video = false;
        self.pdf = false;
        self.structured = false;
        self.web_search = false;
        self.system_in_chat = false;
        self.levels.clear();
        self.model_id
            .update(cx, |input, cx| input.set_value("", window, cx));
        self.context
            .update(cx, |input, cx| input.set_value(DEFAULT_CONTEXT, window, cx));
        self.output
            .update(cx, |input, cx| input.set_value(DEFAULT_OUTPUT, window, cx));
        self.reasoning_map
            .update(cx, |input, cx| input.set_value("", window, cx));
    }

    fn apply_caps(
        &mut self,
        model_id: &str,
        caps: &Value,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.smart = caps.get("smart").and_then(Value::as_bool).unwrap_or(true);
        self.advanced = true;
        self.image = flag(caps, "/input/image");
        self.video = flag(caps, "/input/video");
        self.pdf = flag(caps, "/input/pdf");
        self.structured = flag(caps, "/capabilities/jsonSchema");
        self.web_search = flag(caps, "/capabilities/webSearch");
        self.system_in_chat = flag(caps, "/capabilities/systemMessage");
        self.levels = caps
            .pointer("/reasoning/levels")
            .and_then(Value::as_array)
            .map(|levels| {
                levels
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|level| !level.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let context = caps
            .get("context")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_CONTEXT.parse().unwrap_or(8192));
        let output = caps
            .get("output")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_OUTPUT.parse().unwrap_or(2048));
        let map = caps
            .pointer("/reasoning/map")
            .and_then(Value::as_str)
            .unwrap_or("");
        self.model_id
            .update(cx, |input, cx| input.set_value(model_id, window, cx));
        self.context.update(cx, |input, cx| {
            input.set_value(context.to_string(), window, cx)
        });
        self.output.update(cx, |input, cx| {
            input.set_value(output.to_string(), window, cx)
        });
        self.reasoning_map
            .update(cx, |input, cx| input.set_value(map, window, cx));
    }

    pub(super) fn commit_level(&mut self, cx: &mut Context<Self>) -> bool {
        if !self.composing {
            return true;
        }
        let value = self.level.read(cx).value().trim().to_string();
        if value.is_empty() {
            self.composing = false;
            cx.notify();
            return true;
        }
        if self.levels.iter().any(|item| item == &value) {
            self.error = "推理等级不能重复".into();
            cx.notify();
            return false;
        }
        self.levels.push(value);
        self.composing = false;
        self.error = SharedString::default();
        cx.notify();
        true
    }

    /// 校验通过后写入当前供应商。失败时把原因留在弹窗里。
    pub(super) fn save(&mut self, cx: &mut Context<Self>) -> bool {
        if !self.commit_level(cx) {
            return false;
        }
        let model_id = self.model_id.read(cx).value().trim().to_string();
        if model_id.is_empty() {
            self.error = "模型 ID 不能为空".into();
            cx.notify();
            return false;
        }
        let Some(context) = positive_u32(&self.context.read(cx).value()) else {
            self.error = "上下文窗口必须是正整数".into();
            cx.notify();
            return false;
        };
        let Some(output) = positive_u32(&self.output.read(cx).value()) else {
            self.error = "最大输出 Token 必须是正整数".into();
            cx.notify();
            return false;
        };
        if self.levels.iter().any(|level| level.trim().is_empty())
            || self.levels.len()
                != self
                    .levels
                    .iter()
                    .collect::<std::collections::HashSet<_>>()
                    .len()
        {
            self.error = "推理等级不能为空或重复".into();
            cx.notify();
            return false;
        }
        let map = self.reasoning_map.read(cx).value().to_string();
        let caps = json!({
            "context": context,
            "output": output,
            "title": model_id,
            "smart": self.smart,
            "input": {
                "text": true,
                "image": self.image,
                "video": self.video,
                "pdf": self.pdf,
            },
            "capabilities": {
                "jsonSchema": self.structured,
                "webSearch": self.web_search,
                "systemMessage": self.system_in_chat,
            },
            "reasoning": {
                "levels": self.levels,
                "map": map.trim(),
            }
        });
        let provider_id = self.provider_id.clone();
        let previous_id = self.editing_id.clone();
        let saved = self.pane.update(cx, |pane, cx| {
            pane.model_editor
                .write_model(&provider_id, previous_id, model_id, caps, cx)
        });
        match saved {
            Ok(Ok(())) => true,
            Ok(Err(message)) => {
                self.error = message.into();
                cx.notify();
                false
            }
            Err(_) => {
                self.error = "设置已关闭".into();
                cx.notify();
                false
            }
        }
    }
}

impl Render for ModelDraft {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let muted = cx.theme().muted_foreground;
        let danger = cx.theme().danger;
        let colors = ChipColors {
            border: cx.theme().border,
            primary: cx.theme().primary,
            on_primary: cx.theme().primary_foreground,
            secondary: cx.theme().secondary,
        };
        let success = cx.theme().success;
        let entity = cx.entity().downgrade();
        let advanced = self.advanced;

        v_flex()
            .w_full()
            .gap_4()
            .child(smart_row(self.smart, success, muted, entity.clone()))
            .child(field(
                "模型 ID",
                None,
                muted,
                Input::new(&self.model_id).w_full(),
            ))
            .child(field(
                "上下文窗口",
                Some("模型一次可处理的上下文容量，单位为 Token。请勿超过模型的实际上限。"),
                muted,
                Input::new(&self.context).w_full(),
            ))
            .child(field(
                "最大输出 Token",
                Some("单次模型请求允许生成的最大 Token 数。请勿超过模型的实际上限。"),
                muted,
                Input::new(&self.output).w_full(),
            ))
            .child(advanced_toggle(advanced, entity.clone()))
            .when(advanced, |col| {
                let entity = entity.clone();
                col.child(
                    v_flex()
                        .w_full()
                        .gap_4()
                        .child(field(
                            "输入类型",
                            Some("文本为必选。图片、视频、PDF 表示模型还能接收这些内容。"),
                            muted,
                            h_flex()
                                .flex_wrap()
                                .gap_2()
                                .child(modality_chip(
                                    "文本",
                                    true,
                                    true,
                                    colors,
                                    entity.clone(),
                                    |_| {},
                                ))
                                .child(modality_chip(
                                    "图片",
                                    self.image,
                                    false,
                                    colors,
                                    entity.clone(),
                                    |draft| draft.image = !draft.image,
                                ))
                                .child(modality_chip(
                                    "视频",
                                    self.video,
                                    false,
                                    colors,
                                    entity.clone(),
                                    |draft| draft.video = !draft.video,
                                ))
                                .child(modality_chip(
                                    "PDF",
                                    self.pdf,
                                    false,
                                    colors,
                                    entity.clone(),
                                    |draft| draft.pdf = !draft.pdf,
                                )),
                        ))
                        .child(field(
                            "模型能力",
                            Some("结构化输出、原生联网搜索、对话中系统消息。请勿勾选模型不支持的能力。"),
                            muted,
                            h_flex()
                                .flex_wrap()
                                .gap_2()
                                .child(modality_chip(
                                    "结构化输出",
                                    self.structured,
                                    false,
                                    colors,
                                    entity.clone(),
                                    |draft| draft.structured = !draft.structured,
                                ))
                                .child(modality_chip(
                                    "原生联网搜索",
                                    self.web_search,
                                    false,
                                    colors,
                                    entity.clone(),
                                    |draft| draft.web_search = !draft.web_search,
                                ))
                                .child(modality_chip(
                                    "对话中系统消息",
                                    self.system_in_chat,
                                    false,
                                    colors,
                                    entity.clone(),
                                    |draft| draft.system_in_chat = !draft.system_in_chat,
                                )),
                        ))
                        .child(field(
                            "推理等级（从低到高）",
                            Some("聊天时可选择的推理等级，必须从低到高排列。"),
                            muted,
                            reasoning_levels(self, colors.border, entity.clone()),
                        ))
                        .child(field(
                            "推理参数映射",
                            Some("将当前推理等级映射为模型接口的请求字段。留空表示不映射。"),
                            muted,
                            Textarea::new(&self.reasoning_map).w_full().h(px(96.)),
                        )),
                )
            })
            .when(!self.error.is_empty(), |col| {
                col.child(div().text_sm().text_color(danger).child(self.error.clone()))
            })
    }
}

fn smart_row(
    smart: bool,
    success: Hsla,
    muted: Hsla,
    entity: WeakEntity<ModelDraft>,
) -> impl IntoElement {
    h_flex()
        .w_full()
        .items_center()
        .justify_between()
        .child(
            h_flex()
                .items_center()
                .gap_1()
                .child(div().text_sm().text_color(muted).child("智能配置"))
                .child(help_button(
                    "model-help-smart",
                    "根据模型 ID、Base URL 和 API 格式匹配推荐配置。手动改过的项不再跟随推荐。",
                )),
        )
        .child(
            Switch::new("model-smart")
                .small()
                .checked(smart)
                .color(success)
                .on_change(move |checked, _, cx| {
                    let enabled = *checked;
                    entity
                        .update(cx, |draft, cx| {
                            draft.smart = enabled;
                            cx.notify();
                        })
                        .ok();
                }),
        )
}

fn advanced_toggle(open: bool, entity: WeakEntity<ModelDraft>) -> impl IntoElement {
    let icon = if open {
        IconName::ChevronDown
    } else {
        IconName::ChevronRight
    };
    Button::new("model-advanced")
        .ghost()
        .small()
        .icon(icon)
        .label("高级配置")
        .on_click(move |_, _, cx| {
            entity
                .update(cx, |draft, cx| {
                    draft.advanced = !draft.advanced;
                    cx.notify();
                })
                .ok();
        })
}

fn field(
    label: &'static str,
    help: Option<&'static str>,
    muted: impl Into<Hsla>,
    control: impl IntoElement,
) -> impl IntoElement {
    let muted = muted.into();
    v_flex()
        .w_full()
        .gap_1()
        .child(
            h_flex()
                .items_center()
                .gap_1()
                .child(div().text_sm().text_color(muted).child(label))
                .when_some(help, |row, help| {
                    row.child(help_button(format!("model-help-{label}"), help))
                }),
        )
        .child(control)
}

fn help_button(id: impl Into<SharedString>, tip: &'static str) -> impl IntoElement {
    Button::new(id.into())
        .ghost()
        .xsmall()
        .icon(gpui_kit::assets::IconName::Info)
        .tooltip(tip)
}

fn modality_chip(
    label: &'static str,
    selected: bool,
    locked: bool,
    colors: ChipColors,
    entity: WeakEntity<ModelDraft>,
    toggle: impl Fn(&mut ModelDraft) + 'static,
) -> impl IntoElement {
    let ChipColors {
        border,
        primary,
        on_primary,
        secondary,
    } = colors;
    let id = SharedString::from(format!("model-chip-{label}"));
    h_flex()
        .id(id)
        .items_center()
        .gap_2()
        .px_3()
        .h(px(34.))
        .rounded_md()
        .border_1()
        .border_color(border)
        .when(selected, |chip| chip.bg(secondary))
        .cursor_pointer()
        .child(check_box(selected, primary, on_primary, border))
        .child(div().text_sm().child(label))
        .on_click(move |_, _, cx| {
            if locked {
                return;
            }
            entity
                .update(cx, |draft, cx| {
                    toggle(draft);
                    cx.notify();
                })
                .ok();
        })
}

fn check_box(selected: bool, primary: Hsla, on_primary: Hsla, border: Hsla) -> impl IntoElement {
    div()
        .size(px(14.))
        .flex_shrink_0()
        .rounded_sm()
        .border_1()
        .flex()
        .items_center()
        .justify_center()
        .when(selected, |box_| {
            box_.bg(primary)
                .border_color(primary)
                .text_color(on_primary)
                .child(Icon::new(gpui_kit::assets::IconName::Check).size(px(10.)))
        })
        .when(!selected, |box_| box_.border_color(border))
}

fn reasoning_levels(
    draft: &ModelDraft,
    border: Hsla,
    entity: WeakEntity<ModelDraft>,
) -> impl IntoElement {
    let composing = draft.composing;
    h_flex()
        .flex_wrap()
        .items_center()
        .gap_2()
        .children(
            draft
                .levels
                .iter()
                .cloned()
                .enumerate()
                .map(|(index, level)| {
                    let entity = entity.clone();
                    let remove_label = level.clone();
                    h_flex()
                        .items_center()
                        .gap_1()
                        .px_2()
                        .h(px(32.))
                        .rounded_md()
                        .border_1()
                        .border_color(border)
                        .child(div().text_sm().child(level))
                        .child(
                            Button::new(SharedString::from(format!("model-level-remove-{index}")))
                                .ghost()
                                .xsmall()
                                .icon(gpui_kit::assets::IconName::X)
                                .tooltip(format!("删除推理等级：{remove_label}"))
                                .on_click(move |_, _, cx| {
                                    entity
                                        .update(cx, |draft, cx| {
                                            if index < draft.levels.len() {
                                                draft.levels.remove(index);
                                            }
                                            cx.notify();
                                        })
                                        .ok();
                                }),
                        )
                }),
        )
        .when(composing, |row| {
            row.child(Input::new(&draft.level).w(px(120.)))
        })
        .child({
            let entity = entity.clone();
            Button::new("model-level-add")
                .outline()
                .small()
                .icon(IconName::Plus)
                .tooltip("添加推理等级")
                .on_click(move |_, window, cx| {
                    entity
                        .update(cx, |draft, cx| {
                            if draft.composing && !draft.commit_level(cx) {
                                return;
                            }
                            draft.composing = true;
                            draft
                                .level
                                .update(cx, |input, cx| input.set_value("", window, cx));
                            draft.level.update(cx, |input, cx| input.focus(window, cx));
                            cx.notify();
                        })
                        .ok();
                })
        })
}

fn flag(caps: &Value, pointer: &str) -> bool {
    caps.pointer(pointer)
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn positive_u32(raw: &str) -> Option<u32> {
    let parsed: u64 = raw.trim().parse().ok()?;
    if parsed == 0 || parsed > u32::MAX as u64 {
        None
    } else {
        Some(parsed as u32)
    }
}

pub(super) fn fetched_model_caps(id: &str) -> Value {
    json!({
        "context": 8192,
        "output": 2048,
        "title": id,
        "smart": true,
        "input": { "text": true, "image": false, "video": false, "pdf": false },
        "capabilities": { "jsonSchema": false, "webSearch": false, "systemMessage": false },
        "reasoning": { "levels": [], "map": "" }
    })
}
