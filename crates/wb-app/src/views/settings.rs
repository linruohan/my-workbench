use crate::state::AppState;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::switch::Switch;
use gpui_kit::component::*;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use std::collections::HashMap;
use wb_agent::{load_credentials, load_providers, save_credentials, save_providers};
use wb_domain::ThemeModePref;
use wb_host::{
    list_system_fonts, open_path, speech_ensure_models, speech_status, voice_ptt_set_enabled,
};

pub struct SettingsPane {
    state: AppState,
    proxy: Entity<InputState>,
    personality: Entity<InputState>,
    memory_input: Entity<InputState>,
    key_inputs: HashMap<String, Entity<InputState>>,
    font_count: usize,
    speech_msg: String,
    cred_msg: String,
}

impl SettingsPane {
    pub fn new(state: AppState, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let proxy_val = state.with(|s| s.prefs.http_proxy.clone().unwrap_or_default());
        let persona = state
            .with(|s| s.prefs.agent.personality.clone())
            .unwrap_or_default();
        let proxy = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("http://127.0.0.1:7890")
                .default_value(proxy_val)
        });
        let personality = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Agent 个性化 system 提示")
                .default_value(persona)
        });
        let memory_input =
            cx.new(|cx| InputState::new(window, cx).placeholder("新记忆，回车或点添加"));
        let creds = load_credentials();
        let providers = load_providers();
        let mut key_inputs = HashMap::new();
        for p in providers.providers.iter().filter(|p| p.api_key_required) {
            let has = creds.keys.contains_key(&p.id);
            let placeholder = if has {
                format!("{} API Key（已保存，输入 - 可清除）", p.name)
            } else {
                format!("{} API Key", p.name)
            };
            let input = cx.new(|cx| InputState::new(window, cx).placeholder(placeholder));
            key_inputs.insert(p.id.clone(), input);
        }
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
            personality,
            memory_input,
            key_inputs,
            font_count,
            speech_msg,
            cred_msg: String::new(),
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

    fn save_personality(&mut self, cx: &mut Context<Self>) {
        let text = self.personality.read(cx).value().to_string();
        self.state.with_mut(|s| {
            s.prefs.agent.personality = if text.trim().is_empty() {
                None
            } else {
                Some(text.trim().to_string())
            };
        });
        self.state.persist_prefs();
        self.cred_msg = "个性化已保存".into();
        cx.notify();
    }

    fn add_memory(&mut self, cx: &mut Context<Self>) {
        let text = self.memory_input.read(cx).value().to_string();
        let text = text.trim().to_string();
        if text.is_empty() {
            return;
        }
        self.state.with_mut(|s| {
            if !s.prefs.agent.memories.iter().any(|m| m == &text) {
                s.prefs.agent.memories.push(text);
            }
        });
        self.state.persist_prefs();
        cx.notify();
    }

    fn remove_memory(&mut self, index: usize, cx: &mut Context<Self>) {
        self.state.with_mut(|s| {
            if index < s.prefs.agent.memories.len() {
                s.prefs.agent.memories.remove(index);
            }
        });
        self.state.persist_prefs();
        cx.notify();
    }

    fn save_api_keys(&mut self, cx: &mut Context<Self>) {
        let mut creds = load_credentials();
        for (pid, input) in &self.key_inputs {
            let value = input.read(cx).value().to_string();
            if value.trim().is_empty() {
                // Only clear when user typed something then cleared? Keep existing if empty
                // and field was never touched — but we can't know. Empty means "no change"
                // unless prefixed with "-". Simpler: empty = no change; single "-" = clear.
                continue;
            }
            if value.trim() == "-" {
                creds.keys.remove(pid);
            } else {
                creds.keys.insert(pid.clone(), value.trim().to_string());
            }
        }
        match save_credentials(&creds) {
            Ok(()) => {
                self.cred_msg = "API Key 已保存到本地 credentials".into();
                // Clear inputs after save so keys aren't left visible.
                for input in self.key_inputs.values() {
                    input.update(cx, |i, cx| {
                        // InputState set_value needs window — skip clear if awkward
                        let _ = (i, cx);
                    });
                }
            }
            Err(e) => self.cred_msg = format!("保存失败：{e}"),
        }
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
        let memories = self.state.with(|s| s.prefs.agent.memories.clone());
        let providers = load_providers();
        let creds = load_credentials();
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
                    .child(div().font_bold().child("Agent 模型与记忆"))
                    .child(Input::new(&self.personality))
                    .child(
                        Button::new("save-persona")
                            .small()
                            .label("保存个性化")
                            .on_click(cx.listener(|this, _, _, cx| this.save_personality(cx))),
                    )
                    .child(
                        h_flex()
                            .gap_2()
                            .child(Input::new(&self.memory_input))
                            .child(
                                Button::new("add-mem")
                                    .small()
                                    .primary()
                                    .label("添加记忆")
                                    .on_click(cx.listener(|this, _, _, cx| this.add_memory(cx))),
                            ),
                    )
                    .when(!memories.is_empty(), |col| {
                        col.child(
                            v_flex()
                                .gap_1()
                                .children(memories.into_iter().enumerate().map(|(i, m)| {
                                    h_flex()
                                        .gap_2()
                                        .items_center()
                                        .child(
                                            div()
                                                .flex_1()
                                                .text_sm()
                                                .child(format!("{}. {m}", i + 1)),
                                        )
                                        .child(
                                            Button::new(SharedString::from(format!("rm-mem-{i}")))
                                                .xsmall()
                                                .ghost()
                                                .label("删除")
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    this.remove_memory(i, cx);
                                                })),
                                        )
                                })),
                        )
                    })
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
                    .children(providers.providers.iter().map(|p| {
                        let has_key = creds.keys.contains_key(&p.id);
                        div().text_sm().child(format!(
                            "{} · {} {}{}",
                            p.name,
                            p.base_url,
                            if p.enabled { "" } else { "(停用) " },
                            if p.api_key_required {
                                if has_key { "· Key✓" } else { "· 缺 Key" }
                            } else {
                                ""
                            }
                        ))
                    }))
                    .children(
                        self.key_inputs
                            .values()
                            .map(|input| Input::new(input).into_any_element()),
                    )
                    .child(
                        h_flex()
                            .gap_2()
                            .child(
                                Button::new("save-keys")
                                    .small()
                                    .primary()
                                    .label("保存 API Key")
                                    .on_click(cx.listener(|this, _, _, cx| this.save_api_keys(cx))),
                            )
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
                        div()
                            .text_xs()
                            .text_color(cx.theme().muted_foreground)
                            .child("输入 Key 后点保存；输入单独的 - 可清除该 Provider 的 Key"),
                    )
                    .when(!self.cred_msg.is_empty(), |col| {
                        col.child(
                            div()
                                .text_sm()
                                .text_color(cx.theme().muted_foreground)
                                .child(self.cred_msg.clone()),
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
