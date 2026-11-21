use crate::state::AppState;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::switch::Switch;
use gpui_kit::component::*;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use wb_agent::{load_providers, save_providers};
use wb_domain::ThemeModePref;
use wb_host::{
    list_system_fonts, open_path, speech_ensure_models, speech_status, voice_ptt_set_enabled,
};

pub struct SettingsPane {
    state: AppState,
    proxy: Entity<InputState>,
    font_count: usize,
    speech_msg: String,
}

impl SettingsPane {
    pub fn new(state: AppState, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let proxy_val = state.with(|s| s.prefs.http_proxy.clone().unwrap_or_default());
        let proxy = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("http://127.0.0.1:7890")
                .default_value(proxy_val)
        });
        let font_count = list_system_fonts().map(|f| f.len()).unwrap_or(0);
        let speech_msg = speech_status("sensevoice")
            .map(|st| {
                if st.ready {
                    format!("SenseVoice 就绪：{}", st.model_dir)
                } else {
                    st.message
                        .unwrap_or_else(|| format!("SenseVoice 未就绪：{}", st.model_dir))
                }
            })
            .unwrap_or_else(|e| e.to_string());
        Self {
            state,
            proxy,
            font_count,
            speech_msg,
        }
    }

    fn save_proxy(&mut self, cx: &mut Context<Self>) {
        let value = self.proxy.read(cx).value().to_string();
        self.state.with_mut(|s| {
            s.prefs.http_proxy = if value.trim().is_empty() {
                None
            } else {
                Some(value.trim().to_string())
            };
        });
        self.state.persist_prefs();
        cx.notify();
    }

    fn toggle_theme(&mut self, cx: &mut Context<Self>) {
        let dark = self.state.with_mut(|s| {
            s.prefs.theme_mode = match s.prefs.theme_mode {
                ThemeModePref::Light => ThemeModePref::Dark,
                ThemeModePref::Dark => ThemeModePref::Light,
            };
            matches!(s.prefs.theme_mode, ThemeModePref::Dark)
        });
        self.state.persist_prefs();
        Theme::change(
            if dark {
                ThemeMode::Dark
            } else {
                ThemeMode::Light
            },
            None,
            cx,
        );
        cx.notify();
    }

    fn toggle_voice(&mut self, enabled: bool, cx: &mut Context<Self>) {
        self.state.with_mut(|s| {
            s.prefs.voice.enabled = enabled;
            s.prefs.voice.caps_lock_ptt = enabled;
        });
        voice_ptt_set_enabled(enabled);
        self.state.persist_prefs();
        cx.notify();
    }

    fn toggle_system_notifications(&mut self, enabled: bool, cx: &mut Context<Self>) {
        self.state
            .with_mut(|s| s.prefs.system_notifications = enabled);
        self.state.persist_prefs();
        if enabled {
            let _ = wb_host::show_system_notification("my-workbench", "系统通知已开启");
        }
        cx.notify();
    }

    fn set_default_model(&mut self, model_ref: &str, cx: &mut Context<Self>) {
        self.state.with_mut(|s| {
            s.prefs.agent.default_model_ref = Some(model_ref.to_string());
        });
        self.state.persist_prefs();
        cx.notify();
    }

    fn prepare_speech(&mut self, cx: &mut Context<Self>) {
        match speech_ensure_models("sensevoice") {
            Ok(st) => {
                self.speech_msg = if st.ready {
                    format!("模型就绪：{}", st.model_dir)
                } else {
                    st.message.unwrap_or_else(|| "待下载".into())
                };
            }
            Err(e) => self.speech_msg = e.to_string(),
        }
        let _ = speech_status("sensevoice");
        cx.notify();
    }
}

impl Render for SettingsPane {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let dark = self.state.theme_is_dark();
        let voice = self.state.with(|s| s.prefs.voice.enabled);
        let sys_notify = self.state.with(|s| s.prefs.system_notifications);
        let default_model = self
            .state
            .with(|s| s.prefs.agent.default_model_ref.clone())
            .unwrap_or_else(|| wb_domain::BUILTIN_MODEL_REF.to_string());
        let providers = load_providers();
        let data_dir = wb_store::resolve_data_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| "%APPDATA%\\my-workbench".into());

        v_flex()
            .size_full()
            .gap_4()
            .p_4()
            .overflow_y_scrollbar()
            .child(div().text_xl().font_bold().child("设置"))
            .child(
                v_flex()
                    .gap_2()
                    .p_3()
                    .rounded(cx.theme().radius)
                    .border_1()
                    .border_color(cx.theme().border)
                    .child(div().font_bold().child("外观"))
                    .child(
                        h_flex().items_center().gap_3().child("深色模式").child(
                            Switch::new("theme-dark")
                                .checked(dark)
                                .on_change(cx.listener(|this, _, _, cx| this.toggle_theme(cx))),
                        ),
                    )
                    .child(
                        div()
                            .text_sm()
                            .text_color(cx.theme().muted_foreground)
                            .child(format!("已扫描系统字体 {} 个", self.font_count)),
                    ),
            )
            .child(
                v_flex()
                    .gap_2()
                    .p_3()
                    .rounded(cx.theme().radius)
                    .border_1()
                    .border_color(cx.theme().border)
                    .child(div().font_bold().child("通知"))
                    .child(
                        h_flex().items_center().gap_3().child("系统桌面通知").child(
                            Switch::new("sys-notify")
                                .checked(sys_notify)
                                .on_change(cx.listener(|this, checked, _, cx| {
                                    this.toggle_system_notifications(*checked, cx);
                                })),
                        ),
                    )
                    .child(
                        div()
                            .text_sm()
                            .text_color(cx.theme().muted_foreground)
                            .child("开启后，任务提醒与定时投递会尝试弹出系统 Toast"),
                    ),
            )
            .child(
                v_flex()
                    .gap_2()
                    .p_3()
                    .rounded(cx.theme().radius)
                    .border_1()
                    .border_color(cx.theme().border)
                    .child(div().font_bold().child("网络"))
                    .child(Input::new(&self.proxy))
                    .child(
                        Button::new("save-proxy")
                            .small()
                            .primary()
                            .label("保存代理")
                            .on_click(cx.listener(|this, _, _, cx| this.save_proxy(cx))),
                    ),
            )
            .child(
                v_flex()
                    .gap_2()
                    .p_3()
                    .rounded(cx.theme().radius)
                    .border_1()
                    .border_color(cx.theme().border)
                    .child(div().font_bold().child("语音输入"))
                    .child(
                        h_flex()
                            .items_center()
                            .gap_3()
                            .child("启用 CapsLock 说话")
                            .child(Switch::new("voice").checked(voice).on_change(cx.listener(
                                |this, checked, _, cx| {
                                    this.toggle_voice(*checked, cx);
                                },
                            ))),
                    )
                    .child(
                        Button::new("speech-prep")
                            .small()
                            .label("准备 SenseVoice 模型目录")
                            .on_click(cx.listener(|this, _, _, cx| this.prepare_speech(cx))),
                    )
                    .when(!self.speech_msg.is_empty(), |col| {
                        col.child(
                            div()
                                .text_sm()
                                .text_color(cx.theme().muted_foreground)
                                .child(self.speech_msg.clone()),
                        )
                    }),
            )
            .child(
                v_flex()
                    .gap_2()
                    .p_3()
                    .rounded(cx.theme().radius)
                    .border_1()
                    .border_color(cx.theme().border)
                    .child(div().font_bold().child("Agent 模型"))
                    .child(
                        div()
                            .text_sm()
                            .text_color(cx.theme().muted_foreground)
                            .child(format!("新会话默认模型：{default_model}")),
                    )
                    .child(
                        h_flex().gap_2().flex_wrap().children(
                            std::iter::once((
                                wb_domain::BUILTIN_MODEL_REF.to_string(),
                                "内置".to_string(),
                            ))
                            .chain(providers.providers.iter().flat_map(|p| {
                                if p.id.starts_with("builtin") {
                                    return Vec::new().into_iter();
                                }
                                let items: Vec<(String, String)> = if p.models.is_empty() {
                                    vec![(format!("{}/default", p.id), p.name.clone())]
                                } else {
                                    p.models
                                        .keys()
                                        .map(|mid| {
                                            (
                                                format!("{}/{}", p.id, mid),
                                                format!("{} / {mid}", p.name),
                                            )
                                        })
                                        .collect()
                                };
                                items.into_iter()
                            }))
                            .map(|(model_ref, label)| {
                                let selected = model_ref == default_model;
                                let mr = model_ref.clone();
                                Button::new(SharedString::from(format!("model-{model_ref}")))
                                    .xsmall()
                                    .when(selected, |b| b.primary())
                                    .when(!selected, |b| b.ghost())
                                    .label(label)
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.set_default_model(&mr, cx);
                                    }))
                            }),
                        ),
                    )
                    .children(providers.providers.into_iter().map(|p| {
                        div().text_sm().child(format!(
                            "{} · {} {}",
                            p.name,
                            p.base_url,
                            if p.enabled { "" } else { "(停用)" }
                        ))
                    }))
                    .child(
                        Button::new("save-providers")
                            .small()
                            .label("写入默认 Provider 配置")
                            .on_click(|_, _, _| {
                                let _ = save_providers(&load_providers());
                            }),
                    ),
            )
            .child(
                v_flex()
                    .gap_2()
                    .p_3()
                    .rounded(cx.theme().radius)
                    .border_1()
                    .border_color(cx.theme().border)
                    .child(div().font_bold().child("数据与关于"))
                    .child(
                        div()
                            .text_sm()
                            .text_color(cx.theme().muted_foreground)
                            .child(format!("数据目录：{data_dir}")),
                    )
                    .child(
                        Button::new("open-data-dir")
                            .small()
                            .label("打开数据目录")
                            .on_click(|_, _, _| {
                                if let Ok(dir) = wb_store::resolve_data_dir() {
                                    let _ = open_path(&dir);
                                }
                            }),
                    )
                    .child(div().text_sm().child(format!(
                        "版本 {} · GPUI + gpui-kit",
                        env!("CARGO_PKG_VERSION")
                    ))),
            )
    }
}
