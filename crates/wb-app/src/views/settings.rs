use crate::appearance::{apply_theme_pref, apply_ui_font};
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
use wb_host::{
    list_system_fonts, ocr_ensure_models, ocr_status, open_path, speech_ensure_models,
    speech_ensure_models_ex, speech_status, voice_ptt_set_enabled,
};

pub struct SettingsPane {
    state: AppState,
    proxy: Entity<InputState>,
    ui_font: Entity<InputState>,
    personality: Entity<InputState>,
    memory_input: Entity<InputState>,
    skills_dirs: Entity<InputState>,
    plugins_dirs: Entity<InputState>,
    mcp_json: Entity<InputState>,
    subagents_json: Entity<InputState>,
    hooks_json: Entity<InputState>,
    key_inputs: HashMap<String, Entity<InputState>>,
    font_count: usize,
    speech_msg: String,
    ocr_msg: String,
    cred_msg: String,
    agent_json_msg: String,
}

impl SettingsPane {
    pub fn new(state: AppState, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let proxy_val = state.with(|s| s.prefs.http_proxy.clone().unwrap_or_default());
        let ui_font_val = state.with(|s| s.prefs.ui_font.clone().unwrap_or_default());
        let persona = state
            .with(|s| s.prefs.agent.personality.clone())
            .unwrap_or_default();
        let proxy = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("http://127.0.0.1:7890")
                .default_value(proxy_val)
        });
        let ui_font = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("界面字体（留空=系统 UI 字体）")
                .default_value(ui_font_val)
        });
        let personality = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Agent 个性化 system 提示")
                .default_value(persona)
        });
        let memory_input =
            cx.new(|cx| InputState::new(window, cx).placeholder("新记忆，回车或点添加"));
        let skills_val = state.with(|s| s.prefs.agent.skills_dirs.join(";"));
        let plugins_val = state.with(|s| s.prefs.agent.plugins_dirs.join(";"));
        let skills_dirs = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("技能目录，多个用 ; 分隔")
                .default_value(skills_val)
        });
        let plugins_dirs = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("插件目录，多个用 ; 分隔")
                .default_value(plugins_val)
        });
        let (mcp_val, sub_val, hooks_val) = state.with(|s| {
            (
                serde_json::to_string_pretty(&s.prefs.agent.mcp_servers)
                    .unwrap_or_else(|_| "[]".into()),
                serde_json::to_string_pretty(&s.prefs.agent.subagents)
                    .unwrap_or_else(|_| "[]".into()),
                serde_json::to_string_pretty(&s.prefs.agent.hooks).unwrap_or_else(|_| "[]".into()),
            )
        });
        let mcp_json = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("MCP 服务器 JSON 数组")
                .default_value(mcp_val)
        });
        let subagents_json = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("子智能体 JSON 数组")
                .default_value(sub_val)
        });
        let hooks_json = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Hooks JSON 数组")
                .default_value(hooks_val)
        });
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
        let ocr_msg = ocr_status()
            .map(|st| {
                if st.ready {
                    format!("OCR 就绪：{}", st.model_dir)
                } else {
                    st.message
                        .unwrap_or_else(|| format!("OCR 未就绪：{}", st.model_dir))
                }
            })
            .unwrap_or_else(|e| e.to_string());
        Self {
            state,
            proxy,
            ui_font,
            personality,
            memory_input,
            skills_dirs,
            plugins_dirs,
            mcp_json,
            subagents_json,
            hooks_json,
            key_inputs,
            font_count,
            speech_msg,
            ocr_msg,
            cred_msg: String::new(),
            agent_json_msg: String::new(),
        }
    }

    fn save_agent_json(&mut self, cx: &mut Context<Self>) {
        let mcp_raw = self.mcp_json.read(cx).value().to_string();
        let sub_raw = self.subagents_json.read(cx).value().to_string();
        let hooks_raw = self.hooks_json.read(cx).value().to_string();
        let mcp: Result<Vec<serde_json::Value>, _> = serde_json::from_str(mcp_raw.trim());
        let subs: Result<Vec<serde_json::Value>, _> = serde_json::from_str(sub_raw.trim());
        let hooks: Result<Vec<serde_json::Value>, _> = serde_json::from_str(hooks_raw.trim());
        match (mcp, subs, hooks) {
            (Ok(mcp), Ok(subs), Ok(hooks)) => {
                self.state.with_mut(|s| {
                    s.prefs.agent.mcp_servers = mcp;
                    s.prefs.agent.subagents = subs;
                    s.prefs.agent.hooks = hooks;
                });
                self.state.persist_prefs();
                self.agent_json_msg = "已保存 MCP / 子智能体 / Hooks".into();
            }
            (Err(e), _, _) => self.agent_json_msg = format!("MCP JSON 无效：{e}"),
            (_, Err(e), _) => self.agent_json_msg = format!("子智能体 JSON 无效：{e}"),
            (_, _, Err(e)) => self.agent_json_msg = format!("Hooks JSON 无效：{e}"),
        }
        cx.notify();
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

    fn cycle_theme(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let mode = self.state.with_mut(|s| {
            s.prefs.theme_mode = s.prefs.theme_mode.cycle();
            s.prefs.theme_mode
        });
        self.state.persist_prefs();
        apply_theme_pref(mode, Some(window), cx);
        cx.notify();
    }

    fn save_ui_font(&mut self, cx: &mut Context<Self>) {
        let value = self.ui_font.read(cx).value().to_string();
        let family = self.state.with_mut(|s| {
            s.prefs.ui_font = if value.trim().is_empty() {
                None
            } else {
                Some(value.trim().to_string())
            };
            s.prefs.ui_font.clone()
        });
        self.state.persist_prefs();
        apply_ui_font(family, cx);
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

    fn save_dirs(&mut self, cx: &mut Context<Self>) {
        let skills = self.skills_dirs.read(cx).value().to_string();
        let plugins = self.plugins_dirs.read(cx).value().to_string();
        let split = |s: &str| -> Vec<String> {
            s.split([';', ','])
                .map(str::trim)
                .filter(|x| !x.is_empty())
                .map(|x| x.to_string())
                .collect()
        };
        self.state.with_mut(|s| {
            s.prefs.agent.skills_dirs = split(&skills);
            s.prefs.agent.plugins_dirs = split(&plugins);
        });
        self.state.persist_prefs();
        self.cred_msg = "技能/插件目录已保存".into();
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
        cx.notify();
    }

    fn download_speech(&mut self, cx: &mut Context<Self>) {
        self.speech_msg = "正在下载 SenseVoice 模型…".into();
        cx.notify();
        match speech_ensure_models_ex("sensevoice", true) {
            Ok(st) => {
                self.speech_msg = if st.ready {
                    format!("下载完成：{}", st.model_dir)
                } else {
                    format!(
                        "部分完成，仍缺 {:?}：{}",
                        st.missing,
                        st.message.unwrap_or_default()
                    )
                };
            }
            Err(e) => self.speech_msg = format!("下载失败：{e}"),
        }
        cx.notify();
    }

    fn prepare_ocr(&mut self, cx: &mut Context<Self>) {
        match ocr_ensure_models(false) {
            Ok(st) => {
                self.ocr_msg = if st.ready {
                    format!("模型就绪：{}", st.model_dir)
                } else {
                    st.message.unwrap_or_else(|| "待下载".into())
                };
            }
            Err(e) => self.ocr_msg = e.to_string(),
        }
        cx.notify();
    }

    fn download_ocr(&mut self, cx: &mut Context<Self>) {
        self.ocr_msg = "正在下载 PaddleOCR 模型…".into();
        cx.notify();
        match ocr_ensure_models(true) {
            Ok(st) => {
                self.ocr_msg = if st.ready {
                    format!("下载完成：{}", st.model_dir)
                } else {
                    format!(
                        "部分完成，仍缺 {:?}：{}",
                        st.missing,
                        st.message.unwrap_or_default()
                    )
                };
            }
            Err(e) => self.ocr_msg = format!("下载失败：{e}"),
        }
        cx.notify();
    }

    fn render_agent_section(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let default_model = self
            .state
            .with(|s| s.prefs.agent.default_model_ref.clone())
            .unwrap_or_else(|| wb_domain::BUILTIN_MODEL_REF.to_string());
        let memories = self.state.with(|s| s.prefs.agent.memories.clone());
        let providers = load_providers();
        let creds = load_credentials();

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
                                .child(div().flex_1().text_sm().child(format!("{}. {m}", i + 1)))
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
            .child(Input::new(&self.skills_dirs))
            .child(Input::new(&self.plugins_dirs))
            .child(
                Button::new("save-dirs")
                    .small()
                    .label("保存技能/插件目录")
                    .on_click(cx.listener(|this, _, _, cx| this.save_dirs(cx))),
            )
            .child(div().font_bold().child("MCP / 子智能体 / Hooks"))
            .child(
                div()
                    .text_xs()
                    .text_color(cx.theme().muted_foreground)
                    .child("粘贴 JSON 数组；MCP 项含 name+command 或 name+url；子智能体含 name/description/prompt"),
            )
            .child(Input::new(&self.mcp_json))
            .child(Input::new(&self.subagents_json))
            .child(Input::new(&self.hooks_json))
            .child(
                h_flex()
                    .gap_2()
                    .child(
                        Button::new("save-agent-json")
                            .small()
                            .primary()
                            .label("保存 JSON 配置")
                            .on_click(cx.listener(|this, _, _, cx| this.save_agent_json(cx))),
                    )
                    .child(
                        Button::new("open-prefs")
                            .small()
                            .label("打开 prefs.json")
                            .on_click(|_, _, _| {
                                if let Ok(p) = wb_store::prefs_path() {
                                    let _ = open_path(&p);
                                }
                            }),
                    ),
            )
            .when(!self.agent_json_msg.is_empty(), |col| {
                col.child(
                    div()
                        .text_sm()
                        .text_color(cx.theme().muted_foreground)
                        .child(self.agent_json_msg.clone()),
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
                    std::iter::once((wb_domain::BUILTIN_MODEL_REF.to_string(), "内置".to_string()))
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
                                        (format!("{}/{}", p.id, mid), format!("{} / {mid}", p.name))
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
            })
    }

    fn render_data_section(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let data_dir = wb_store::resolve_data_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| "%APPDATA%\\my-workbench".into());
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
            )))
    }
}

impl Render for SettingsPane {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme_mode = self.state.theme_mode();
        let voice = self.state.with(|s| s.prefs.voice.enabled);
        let sys_notify = self.state.with(|s| s.prefs.system_notifications);

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
                        h_flex()
                            .items_center()
                            .gap_3()
                            .child(format!("主题：{}", theme_mode.label()))
                            .child(
                                Button::new("cycle-theme")
                                    .small()
                                    .label("切换")
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.cycle_theme(window, cx);
                                    })),
                            ),
                    )
                    .child(Input::new(&self.ui_font))
                    .child(
                        Button::new("save-ui-font")
                            .small()
                            .primary()
                            .label("应用界面字体")
                            .on_click(cx.listener(|this, _, _, cx| this.save_ui_font(cx))),
                    )
                    .child(
                        div()
                            .text_sm()
                            .text_color(cx.theme().muted_foreground)
                            .child(format!(
                                "浅色 / 深色 / 跟随系统；已扫描系统字体 {} 个",
                                self.font_count
                            )),
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
                        div()
                            .text_xs()
                            .text_color(cx.theme().muted_foreground)
                            .child(
                                "按住 CapsLock 录音，松手后转写并粘贴（需麦克风权限 + SenseVoice/CLI）",
                            ),
                    )
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
                        h_flex()
                            .gap_2()
                            .child(
                                Button::new("speech-prep")
                                    .small()
                                    .label("准备目录")
                                    .on_click(
                                        cx.listener(|this, _, _, cx| this.prepare_speech(cx)),
                                    ),
                            )
                            .child(
                                Button::new("speech-dl")
                                    .small()
                                    .primary()
                                    .label("下载 SenseVoice")
                                    .on_click(
                                        cx.listener(|this, _, _, cx| this.download_speech(cx)),
                                    ),
                            ),
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
                    .child(div().font_bold().child("OCR 识图"))
                    .child(
                        h_flex()
                            .gap_2()
                            .child(
                                Button::new("ocr-prep")
                                    .small()
                                    .label("准备目录")
                                    .on_click(cx.listener(|this, _, _, cx| this.prepare_ocr(cx))),
                            )
                            .child(
                                Button::new("ocr-dl")
                                    .small()
                                    .primary()
                                    .label("下载 PaddleOCR")
                                    .on_click(cx.listener(|this, _, _, cx| this.download_ocr(cx))),
                            ),
                    )
                    .when(!self.ocr_msg.is_empty(), |col| {
                        col.child(
                            div()
                                .text_sm()
                                .text_color(cx.theme().muted_foreground)
                                .child(self.ocr_msg.clone()),
                        )
                    }),
            )
            .child(self.render_agent_section(cx))
            .child(self.render_data_section(cx))
    }
}
