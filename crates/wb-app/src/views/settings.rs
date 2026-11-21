use crate::appearance::apply_ui_font;
use crate::state::{AppNav, AppState};
use crate::themes;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::group_box::GroupBoxVariant;
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::scroll::ScrollbarMode;
use gpui_kit::component::setting::{
    SettingField, SettingGroup, SettingItem, SettingPage, Settings,
};
use gpui_kit::component::*;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use std::collections::HashMap;
use wb_agent::{load_credentials, load_providers, save_credentials, save_providers};
use wb_domain::ThemeModePref;
use wb_host::{
    list_system_fonts, ocr_ensure_models, ocr_status, speech_ensure_models,
    speech_ensure_models_ex, speech_status, voice_ptt_set_enabled,
};

pub struct SettingsPane {
    state: AppState,
    memory_input: Entity<InputState>,
    skills_dirs: Entity<InputState>,
    plugins_dirs: Entity<InputState>,
    personality: Entity<InputState>,
    mcp_json: Entity<InputState>,
    subagents_json: Entity<InputState>,
    hooks_json: Entity<InputState>,
    key_inputs: HashMap<String, Entity<InputState>>,
    font_count: usize,
    speech_msg: String,
    ocr_msg: String,
    cred_msg: String,
    agent_json_msg: String,
    data_msg: String,
}

impl SettingsPane {
    pub fn new(state: AppState, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let persona = state
            .with(|s| s.prefs.agent.personality.clone())
            .unwrap_or_default();
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
            memory_input,
            skills_dirs,
            plugins_dirs,
            personality,
            mcp_json,
            subagents_json,
            hooks_json,
            key_inputs,
            font_count,
            speech_msg,
            ocr_msg,
            cred_msg: String::new(),
            agent_json_msg: String::new(),
            data_msg: String::new(),
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

    fn backup_data_here(&mut self, cx: &mut Context<Self>) {
        self.data_msg = match wb_store::backup_core_data() {
            Ok(dest) => {
                cx.open_with_system(&dest);
                format!("已备份到 {}", dest.display())
            }
            Err(e) => format!("备份失败：{e}"),
        };
        cx.notify();
    }

    fn backup_data_pick(&mut self, cx: &mut Context<Self>) {
        super::prompt_directory(cx, |this, parent, cx| {
            this.data_msg = match parent {
                Some(parent) => match wb_store::backup_core_data_to(&parent) {
                    Ok(dest) => {
                        cx.open_with_system(&dest);
                        format!("已备份到 {}", dest.display())
                    }
                    Err(e) => format!("备份失败：{e}"),
                },
                None => "已取消选择备份目录".into(),
            };
            cx.notify();
        });
    }

    fn migrate_data_pick(&mut self, cx: &mut Context<Self>) {
        super::prompt_directory(cx, |this, dest, cx| {
            this.data_msg = match dest {
                Some(dest) => match wb_store::migrate_data_dir_to(&dest) {
                    Ok(report) => {
                        cx.open_with_system(&report.destination);
                        format!(
                            "已迁移 {} 个文件到 {}{}",
                            report.copied_files,
                            report.destination.display(),
                            if report.redirect_written {
                                "；下次启动将使用新目录（原目录未删除）"
                            } else {
                                "；已恢复为默认目录"
                            }
                        )
                    }
                    Err(e) => format!("迁移失败：{e}"),
                },
                None => "已取消选择迁移目标".into(),
            };
            cx.notify();
        });
    }

    fn migrate_data_default(&mut self, cx: &mut Context<Self>) {
        self.data_msg = match wb_store::migrate_data_dir_to_default() {
            Ok(report) => format!(
                "已迁回默认目录（{} 个文件）：{}",
                report.copied_files,
                report.destination.display()
            ),
            Err(e) => format!("迁回默认失败：{e}"),
        };
        cx.notify();
    }

    fn pages(&self, cx: &mut Context<Self>) -> Vec<SettingPage> {
        let state = self.state.clone();
        let entity = cx.weak_entity();
        let theme_name = cx.theme().theme_name().clone();
        let font_count = self.font_count;
        let speech_msg = self.speech_msg.clone();
        let ocr_msg = self.ocr_msg.clone();
        let data_msg = self.data_msg.clone();
        let agent = AgentForm {
            personality: self.personality.clone(),
            memory_input: self.memory_input.clone(),
            skills_dirs: self.skills_dirs.clone(),
            plugins_dirs: self.plugins_dirs.clone(),
            mcp_json: self.mcp_json.clone(),
            subagents_json: self.subagents_json.clone(),
            hooks_json: self.hooks_json.clone(),
            key_inputs: self
                .key_inputs
                .iter()
                .map(|(id, input)| (id.clone(), input.clone()))
                .collect(),
            cred_msg: self.cred_msg.clone(),
            agent_json_msg: self.agent_json_msg.clone(),
        };

        let mut pages = vec![
            general_page(state.clone(), entity.clone()),
            appearance_page(state.clone(), entity.clone(), theme_name, font_count)
                .section("基础设置"),
            notify_page(state.clone(), entity.clone()).section("基础设置"),
            voice_page(state.clone(), entity.clone(), speech_msg).section("基础设置"),
        ];
        pages.extend(agent_pages(state.clone(), entity.clone(), agent));
        pages.push(ocr_page(entity.clone(), ocr_msg).section("Agent"));
        pages.push(data_page(state, entity.clone(), data_msg).section("数据与关于"));
        pages.push(about_page().section("数据与关于"));
        pages
    }
}

struct AgentForm {
    personality: Entity<InputState>,
    memory_input: Entity<InputState>,
    skills_dirs: Entity<InputState>,
    plugins_dirs: Entity<InputState>,
    mcp_json: Entity<InputState>,
    subagents_json: Entity<InputState>,
    hooks_json: Entity<InputState>,
    key_inputs: Vec<(String, Entity<InputState>)>,
    cred_msg: String,
    agent_json_msg: String,
}

fn poke(entity: &WeakEntity<SettingsPane>, cx: &mut App) {
    entity.update(cx, |_, cx| cx.notify()).ok();
}

fn set_general(
    state: &AppState,
    entity: &WeakEntity<SettingsPane>,
    cx: &mut App,
    write: impl FnOnce(&mut wb_domain::GeneralPrefs),
) {
    state.with_mut(|inner| write(&mut inner.prefs.general));
    state.persist_prefs();
    poke(entity, cx);
}

fn remind_choices() -> Vec<(SharedString, SharedString)> {
    use wb_domain::{ReminderOptionId, remind_option_label};
    [
        ReminderOptionId::None,
        ReminderOptionId::AtStart,
        ReminderOptionId::M5,
        ReminderOptionId::M10,
        ReminderOptionId::M15,
        ReminderOptionId::M30,
        ReminderOptionId::H1,
    ]
    .into_iter()
    .map(|option| (option.as_str().into(), remind_option_label(option).into()))
    .collect()
}

fn agent_nav(page: SettingPage) -> SettingPage {
    page.section("Agent").resettable(false)
}

fn general_page(state: AppState, entity: WeakEntity<SettingsPane>) -> SettingPage {
    let office = state.with(|inner| inner.prefs.general.interface_mode != "focus");
    let name_state = state.clone();
    let name_write = state.clone();
    let name_entity = entity.clone();
    let locale_state = state.clone();
    let locale_write = state.clone();
    let locale_entity = entity.clone();
    let mode_state = state.clone();
    let mode_write = state.clone();
    let mode_entity = entity.clone();
    let suggest_state = state.clone();
    let suggest_write = state.clone();
    let suggest_entity = entity.clone();
    let startup_state = state.clone();
    let startup_write = state.clone();
    let startup_entity = entity.clone();
    let window_state = state.clone();
    let window_write = state.clone();
    let window_entity = entity.clone();
    let hints_state = state.clone();
    let hints_write = state.clone();
    let hints_entity = entity.clone();
    let confirm_state = state.clone();
    let confirm_write = state.clone();
    let confirm_entity = entity.clone();
    let week_state = state.clone();
    let week_write = state.clone();
    let week_entity = entity.clone();
    let remind_state = state.clone();
    let remind_write = state.clone();
    let remind_entity = entity.clone();
    let note_state = state.clone();
    let note_write = state;
    let note_entity = entity;

    SettingPage::new("常规")
        .section("基础设置")
        .icon(Icon::new(IconName::Settings2))
        .default_open(true)
        .resettable(false)
        .title_suffix(|_, cx| {
            div()
                .px_2()
                .py(px(2.))
                .rounded_full()
                .text_xs()
                .border_1()
                .border_color(cx.theme().border)
                .bg(cx.theme().secondary)
                .text_color(cx.theme().muted_foreground)
                .child("系统默认")
        })
        .group(
            SettingGroup::new()
                .item(
                    SettingItem::new(
                        "本地账号",
                        SettingField::input(
                            move |_| {
                                name_state
                                    .with(|inner| inner.prefs.general.display_name.clone())
                                    .into()
                            },
                            move |value: SharedString, cx: &mut App| {
                                let value = value.to_string();
                                set_general(&name_write, &name_entity, cx, |prefs| {
                                    prefs.display_name = if value.trim().is_empty() {
                                        "本地用户".into()
                                    } else {
                                        value.trim().to_string()
                                    };
                                });
                            },
                        ),
                    )
                    .description("仅保存在本机的显示名称，无云端登录"),
                )
                .item(
                    SettingItem::new(
                        "界面语言",
                        SettingField::dropdown(
                            vec![
                                ("system".into(), "系统默认".into()),
                                ("zh-CN".into(), "简体中文".into()),
                                ("en-US".into(), "English".into()),
                            ],
                            move |_| {
                                locale_state
                                    .with(|inner| inner.prefs.general.locale.clone())
                                    .into()
                            },
                            move |value: SharedString, cx: &mut App| {
                                let value = value.to_string();
                                set_general(&locale_write, &locale_entity, cx, |prefs| {
                                    prefs.locale = value;
                                });
                            },
                        ),
                    )
                    .description("选择应用界面的显示语言（文案国际化将逐步接入）"),
                )
                .item(
                    SettingItem::new(
                        "界面模式",
                        SettingField::dropdown(
                            vec![
                                ("office".into(), "办公模式".into()),
                                ("focus".into(), "专注模式".into()),
                            ],
                            move |_| {
                                mode_state
                                    .with(|inner| inner.prefs.general.interface_mode.clone())
                                    .into()
                            },
                            move |value: SharedString, cx: &mut App| {
                                let value = value.to_string();
                                set_general(&mode_write, &mode_entity, cx, |prefs| {
                                    prefs.interface_mode = value;
                                });
                            },
                        ),
                    )
                    .description("办公模式侧重今日与结果；专注模式展示更多计划细节与元信息"),
                )
                .item(
                    SettingItem::new(
                        "主动任务推荐",
                        SettingField::switch(
                            move |_| {
                                suggest_state.with(|inner| {
                                    inner.prefs.general.interface_mode != "focus"
                                        && inner.prefs.general.proactive_suggestions
                                })
                            },
                            move |enabled, cx: &mut App| {
                                set_general(&suggest_write, &suggest_entity, cx, |prefs| {
                                    prefs.proactive_suggestions = enabled;
                                });
                            },
                        ),
                    )
                    .description("根据计划与未排期任务给出今日建议（仅办公模式）")
                    .disabled(!office),
                ),
        )
        .group(
            SettingGroup::new()
                .title("启动与工作区")
                .in_nav(false)
                .item(
                    SettingItem::new(
                        "启动打开",
                        SettingField::dropdown(
                            vec![
                                ("today".into(), "今日".into()),
                                ("inbox".into(), "收件箱".into()),
                                ("planner".into(), "计划".into()),
                                ("timed".into(), "定时任务".into()),
                                ("knowledge".into(), "知识库".into()),
                                ("agent".into(), "Agent".into()),
                            ],
                            move |_| {
                                startup_state
                                    .with(|inner| inner.prefs.general.startup_view.clone())
                                    .into()
                            },
                            move |value: SharedString, cx: &mut App| {
                                let value = value.to_string();
                                set_general(&startup_write, &startup_entity, cx, |prefs| {
                                    prefs.startup_view = value;
                                });
                            },
                        ),
                    )
                    .description("启动应用后默认进入的视图"),
                )
                .item(
                    SettingItem::new(
                        "窗口恢复",
                        SettingField::dropdown(
                            vec![
                                ("default".into(), "默认".into()),
                                ("maximized".into(), "最大化".into()),
                                ("remember".into(), "记住上次".into()),
                            ],
                            move |_| {
                                window_state
                                    .with(|inner| inner.prefs.general.window_restore.clone())
                                    .into()
                            },
                            move |value: SharedString, cx: &mut App| {
                                let value = value.to_string();
                                set_general(&window_write, &window_entity, cx, |prefs| {
                                    prefs.window_restore = value;
                                });
                            },
                        ),
                    )
                    .description("下次启动时的窗口状态（宿主接线后生效）"),
                )
                .item(SettingItem::new(
                    "显示操作提示",
                    SettingField::switch(
                        move |_| hints_state.with(|inner| inner.prefs.general.show_empty_hints),
                        move |enabled, cx: &mut App| {
                            set_general(&hints_write, &hints_entity, cx, |prefs| {
                                prefs.show_empty_hints = enabled;
                            });
                        },
                    ),
                ))
                .item(SettingItem::new(
                    "删除前确认",
                    SettingField::switch(
                        move |_| {
                            confirm_state.with(|inner| inner.prefs.general.confirm_before_delete)
                        },
                        move |enabled, cx: &mut App| {
                            set_general(&confirm_write, &confirm_entity, cx, |prefs| {
                                prefs.confirm_before_delete = enabled;
                            });
                        },
                    ),
                )),
        )
        .group(
            SettingGroup::new()
                .title("日程与提醒")
                .in_nav(false)
                .item(SettingItem::new(
                    "一周起始日",
                    SettingField::dropdown(
                        vec![
                            ("monday".into(), "周一".into()),
                            ("sunday".into(), "周日".into()),
                        ],
                        move |_| {
                            week_state
                                .with(|inner| inner.prefs.general.week_starts_on.clone())
                                .into()
                        },
                        move |value: SharedString, cx: &mut App| {
                            let value = value.to_string();
                            set_general(&week_write, &week_entity, cx, |prefs| {
                                prefs.week_starts_on = value;
                            });
                        },
                    ),
                ))
                .item(SettingItem::new(
                    "默认提醒偏移",
                    SettingField::dropdown(
                        remind_choices(),
                        move |_| {
                            let raw = remind_state
                                .with(|inner| inner.prefs.general.default_remind.clone());
                            if wb_domain::ReminderOptionId::parse(&raw).is_some() {
                                raw.into()
                            } else {
                                "m15".into()
                            }
                        },
                        move |value: SharedString, cx: &mut App| {
                            let value = value.to_string();
                            set_general(&remind_write, &remind_entity, cx, |prefs| {
                                prefs.default_remind = value;
                            });
                        },
                    ),
                )),
        )
        .group(
            SettingGroup::new().title("知识库").in_nav(false).item(
                SettingItem::new(
                    "记住上次笔记",
                    SettingField::switch(
                        move |_| note_state.with(|inner| inner.prefs.general.remember_last_note),
                        move |enabled, cx: &mut App| {
                            set_general(&note_write, &note_entity, cx, |prefs| {
                                prefs.remember_last_note = enabled;
                            });
                        },
                    ),
                )
                .description("进入知识库时优先打开最近编辑的笔记"),
            ),
        )
}

fn appearance_page(
    state: AppState,
    entity: WeakEntity<SettingsPane>,
    theme_name: SharedString,
    font_count: usize,
) -> SettingPage {
    let mode_state = state.clone();
    let mode_write = state.clone();
    let mode_entity = entity.clone();
    let font_state = state.clone();
    let font_write = state.clone();
    let font_entity = entity.clone();
    let size_state = state.clone();
    let size_entity = entity.clone();
    let radius_state = state.clone();
    let radius_entity = entity.clone();
    let bar_state = state.clone();
    let bar_entity = entity.clone();

    SettingPage::new("外观")
        .icon(Icon::new(IconName::Sun))
        .resettable(false)
        .group(
            SettingGroup::new()
                .title("主题")
                .in_nav(false)
                .item(
                    SettingItem::new(
                        "主题模式",
                        SettingField::dropdown(
                            vec![
                                ("light".into(), "浅色".into()),
                                ("dark".into(), "深色".into()),
                                ("system".into(), "跟随系统".into()),
                            ],
                            move |_| match mode_state.theme_mode() {
                                ThemeModePref::Light => "light".into(),
                                ThemeModePref::Dark => "dark".into(),
                                ThemeModePref::System => "system".into(),
                            },
                            move |value: SharedString, cx: &mut App| {
                                if let Some(mode) = ThemeModePref::parse(value.as_ref()) {
                                    themes::set_theme_mode(mode, &mode_write, None, cx);
                                    poke(&mode_entity, cx);
                                }
                            },
                        ),
                    )
                    .description(format!("当前配色：{theme_name}")),
                )
                .item(
                    SettingItem::new(
                        "界面字体",
                        SettingField::input(
                            {
                                let font_state = font_state.clone();
                                move |_| {
                                    font_state
                                        .with(|s| s.prefs.ui_font.clone().unwrap_or_default())
                                        .into()
                                }
                            },
                            move |value: SharedString, cx: &mut App| {
                                let family = font_write.with_mut(|s| {
                                    s.prefs.ui_font = if value.trim().is_empty() {
                                        None
                                    } else {
                                        Some(value.trim().to_string())
                                    };
                                    s.prefs.ui_font.clone()
                                });
                                font_write.persist_prefs();
                                apply_ui_font(family, cx);
                                poke(&font_entity, cx);
                            },
                        ),
                    )
                    .description(format!(
                        "留空使用系统界面字体。已扫描系统字体 {font_count} 个。"
                    )),
                ),
        )
        .group(
            SettingGroup::new()
                .title("密度")
                .in_nav(false)
                .item(
                    SettingItem::new(
                        "字号",
                        SettingField::dropdown(
                            vec![
                                ("18".into(), "大".into()),
                                ("16".into(), "标准".into()),
                                ("14".into(), "小".into()),
                            ],
                            |cx: &App| {
                                SharedString::from(
                                    cx.theme().font_size.as_f32().round().to_string(),
                                )
                            },
                            move |value: SharedString, cx: &mut App| {
                                if let Ok(size) = value.parse::<f32>() {
                                    themes::set_font_size(size, &size_state, cx);
                                    poke(&size_entity, cx);
                                }
                            },
                        ),
                    )
                    .description("标题栏齿轮里也可以改。"),
                )
                .item(
                    SettingItem::new(
                        "圆角",
                        SettingField::dropdown(
                            vec![
                                ("8".into(), "8px".into()),
                                ("6".into(), "6px".into()),
                                ("4".into(), "4px".into()),
                                ("0".into(), "0px".into()),
                            ],
                            |cx: &App| {
                                SharedString::from(cx.theme().radius.as_f32().round().to_string())
                            },
                            move |value: SharedString, cx: &mut App| {
                                if let Ok(radius) = value.parse::<f32>() {
                                    themes::set_radius(radius, &radius_state, cx);
                                    poke(&radius_entity, cx);
                                }
                            },
                        ),
                    )
                    .description("卡片和按钮的圆角。"),
                )
                .item(
                    SettingItem::new(
                        "滚动条",
                        SettingField::dropdown(
                            vec![
                                ("scrolling".into(), "滚动时显示".into()),
                                ("hover".into(), "悬停显示".into()),
                                ("always".into(), "始终显示".into()),
                            ],
                            |cx: &App| match cx.theme().scrollbar_mode {
                                ScrollbarMode::Scrolling => "scrolling".into(),
                                ScrollbarMode::Hover => "hover".into(),
                                ScrollbarMode::Always => "always".into(),
                            },
                            move |value: SharedString, cx: &mut App| {
                                let mode = match value.as_ref() {
                                    "hover" => ScrollbarMode::Hover,
                                    "always" => ScrollbarMode::Always,
                                    _ => ScrollbarMode::Scrolling,
                                };
                                themes::set_scrollbar_mode(mode, &bar_state, cx);
                                poke(&bar_entity, cx);
                            },
                        ),
                    )
                    .description("列表滚动条什么时候出现。"),
                ),
        )
}

fn notify_page(state: AppState, entity: WeakEntity<SettingsPane>) -> SettingPage {
    let read = state.clone();
    SettingPage::new("通知")
        .icon(Icon::new(IconName::Bell))
        .resettable(false)
        .group(
            SettingGroup::new().title("提醒").item(
                SettingItem::new(
                    "系统桌面通知",
                    SettingField::switch(
                        move |_| read.with(|s| s.prefs.system_notifications),
                        move |enabled, cx: &mut App| {
                            state.with_mut(|s| s.prefs.system_notifications = enabled);
                            state.persist_prefs();
                            if enabled {
                                let _ = wb_host::show_system_notification(
                                    "my-workbench",
                                    "系统通知已开启",
                                );
                            }
                            poke(&entity, cx);
                        },
                    ),
                )
                .description("任务提醒和定时投递会尝试弹出系统 Toast。"),
            ),
        )
}

fn voice_page(
    state: AppState,
    entity: WeakEntity<SettingsPane>,
    speech_msg: String,
) -> SettingPage {
    let read = state.clone();
    let prep = entity.clone();
    let download = entity.clone();
    SettingPage::new("语音输入")
        .icon(Icon::new(IconName::Mic))
        .resettable(false)
        .group(
            SettingGroup::new()
                .title("CapsLock 说话")
                .description("按住 CapsLock 录音，松手后转写并粘贴。需要麦克风权限和 SenseVoice。")
                .item(
                    SettingItem::new(
                        "启用语音输入",
                        SettingField::switch(
                            move |_| read.with(|s| s.prefs.voice.enabled),
                            move |enabled, cx: &mut App| {
                                state.with_mut(|s| {
                                    s.prefs.voice.enabled = enabled;
                                    s.prefs.voice.caps_lock_ptt = enabled;
                                });
                                voice_ptt_set_enabled(enabled);
                                state.persist_prefs();
                                poke(&entity, cx);
                            },
                        ),
                    )
                    .description("开启后按住 CapsLock 说话，松手结束。"),
                )
                .item(
                    SettingItem::render(move |_, _, cx| {
                        let muted = cx.theme().muted_foreground;
                        let prep = prep.clone();
                        let download = download.clone();
                        let speech_msg = speech_msg.clone();
                        v_flex()
                            .gap_2()
                            .child(
                                h_flex()
                                    .gap_2()
                                    .child(
                                        Button::new("speech-prep")
                                            .small()
                                            .label("准备目录")
                                            .on_click(move |_, _, cx| {
                                                prep.update(cx, |this, cx| this.prepare_speech(cx))
                                                    .ok();
                                            }),
                                    )
                                    .child(
                                        Button::new("speech-dl")
                                            .small()
                                            .primary()
                                            .label("下载 SenseVoice")
                                            .on_click(move |_, _, cx| {
                                                download
                                                    .update(cx, |this, cx| this.download_speech(cx))
                                                    .ok();
                                            }),
                                    ),
                            )
                            .when(!speech_msg.is_empty(), |col| {
                                col.child(div().text_sm().text_color(muted).child(speech_msg))
                            })
                    })
                    .keywords(["SenseVoice", "模型", "下载"]),
                ),
        )
}

fn ocr_page(entity: WeakEntity<SettingsPane>, ocr_msg: String) -> SettingPage {
    let prep = entity.clone();
    let download = entity;
    SettingPage::new("工具")
        .icon(Icon::new(IconName::Eye))
        .resettable(false)
        .group(
            SettingGroup::new()
                .title("PaddleOCR")
                .description("本地识别图片里的文字。")
                .item(
                    SettingItem::render(move |_, _, cx| {
                        let muted = cx.theme().muted_foreground;
                        let prep = prep.clone();
                        let download = download.clone();
                        let ocr_msg = ocr_msg.clone();
                        v_flex()
                            .gap_2()
                            .child(
                                h_flex()
                                    .gap_2()
                                    .child(
                                        Button::new("ocr-prep").small().label("准备目录").on_click(
                                            move |_, _, cx| {
                                                prep.update(cx, |this, cx| this.prepare_ocr(cx))
                                                    .ok();
                                            },
                                        ),
                                    )
                                    .child(
                                        Button::new("ocr-dl")
                                            .small()
                                            .primary()
                                            .label("下载 PaddleOCR")
                                            .on_click(move |_, _, cx| {
                                                download
                                                    .update(cx, |this, cx| this.download_ocr(cx))
                                                    .ok();
                                            }),
                                    ),
                            )
                            .when(!ocr_msg.is_empty(), |col| {
                                col.child(div().text_sm().text_color(muted).child(ocr_msg))
                            })
                    })
                    .keywords(["OCR", "Paddle", "模型"]),
                ),
        )
}

fn agent_pages(
    state: AppState,
    entity: WeakEntity<SettingsPane>,
    form: AgentForm,
) -> Vec<SettingPage> {
    let AgentForm {
        personality,
        memory_input,
        skills_dirs,
        plugins_dirs,
        mcp_json,
        subagents_json,
        hooks_json,
        key_inputs,
        cred_msg,
        agent_json_msg,
    } = form;
    let model_state = state.clone();
    let model_entity = entity.clone();
    let persona_entity = entity.clone();
    let memory_entity = entity.clone();
    let memory_state = state.clone();
    let dirs_entity = entity.clone();
    let json_entity = entity.clone();
    let keys_entity = entity.clone();
    let proxy_read = state.clone();
    let proxy_write = state.clone();
    let proxy_entity = entity.clone();
    let _ = state;
    vec![
        agent_nav(
            SettingPage::new("模型")
                .icon(Icon::new(IconName::Cpu))
                .group(
                    SettingGroup::new().title("默认模型").in_nav(false).item(
                        SettingItem::render(move |_, _, cx| {
                            let default_model = model_state
                                .with(|s| s.prefs.agent.default_model_ref.clone())
                                .unwrap_or_else(|| wb_domain::BUILTIN_MODEL_REF.to_string());
                            let providers = load_providers();
                            let creds = load_credentials();
                            let muted = cx.theme().muted_foreground;
                            let model_entity = model_entity.clone();
                            v_flex()
                                .gap_2()
                                .child(
                                    div()
                                        .text_sm()
                                        .text_color(muted)
                                        .child(format!("新会话默认模型：{default_model}")),
                                )
                                .child(
                                    h_flex().gap_2().flex_wrap().children(
                                        std::iter::once((
                                            wb_domain::BUILTIN_MODEL_REF.to_string(),
                                            "内置".to_string(),
                                        ))
                                        .chain(providers.providers.iter().flat_map(|provider| {
                                            if provider.id.starts_with("builtin") {
                                                return Vec::new().into_iter();
                                            }
                                            let items: Vec<(String, String)> = if provider
                                                .models
                                                .is_empty()
                                            {
                                                vec![(
                                                    format!("{}/default", provider.id),
                                                    provider.name.clone(),
                                                )]
                                            } else {
                                                provider
                                                    .models
                                                    .keys()
                                                    .map(|mid| {
                                                        (
                                                            format!("{}/{}", provider.id, mid),
                                                            format!("{} / {mid}", provider.name),
                                                        )
                                                    })
                                                    .collect()
                                            };
                                            items.into_iter()
                                        }))
                                        .map(
                                            |(model_ref, label)| {
                                                let selected = model_ref == default_model;
                                                let model_ref_click = model_ref.clone();
                                                let model_entity = model_entity.clone();
                                                Button::new(SharedString::from(format!(
                                                    "set-model-{model_ref}"
                                                )))
                                                .xsmall()
                                                .when(selected, |button| button.primary())
                                                .when(!selected, |button| button.ghost())
                                                .label(label)
                                                .on_click(move |_, _, cx| {
                                                    let model_ref_click = model_ref_click.clone();
                                                    model_entity
                                                        .update(cx, |this, cx| {
                                                            this.set_default_model(
                                                                &model_ref_click,
                                                                cx,
                                                            );
                                                        })
                                                        .ok();
                                                })
                                            },
                                        ),
                                    ),
                                )
                                .children(providers.providers.iter().map(|provider| {
                                    let has_key = creds.keys.contains_key(&provider.id);
                                    div().text_sm().child(format!(
                                        "{} · {} {}{}",
                                        provider.name,
                                        provider.base_url,
                                        if provider.enabled { "" } else { "(停用) " },
                                        if provider.api_key_required {
                                            if has_key { "· Key✓" } else { "· 缺 Key" }
                                        } else {
                                            ""
                                        }
                                    ))
                                }))
                        })
                        .keywords(["模型", "provider", "默认"]),
                    ),
                )
                .group(
                    SettingGroup::new().title("代理").in_nav(false).item(
                        SettingItem::new(
                            "HTTP 代理",
                            SettingField::input(
                                move |_| {
                                    proxy_read
                                        .with(|inner| {
                                            inner.prefs.http_proxy.clone().unwrap_or_default()
                                        })
                                        .into()
                                },
                                move |value: SharedString, cx: &mut App| {
                                    proxy_write.with_mut(|inner| {
                                        inner.prefs.http_proxy = if value.trim().is_empty() {
                                            None
                                        } else {
                                            Some(value.trim().to_string())
                                        };
                                    });
                                    proxy_write.persist_prefs();
                                    poke(&proxy_entity, cx);
                                },
                            ),
                        )
                        .description(
                            "只影响模型请求。例如 http://127.0.0.1:7890，留空则不走代理。",
                        ),
                    ),
                )
                .group(keys_group(
                    key_inputs.clone(),
                    keys_entity.clone(),
                    cred_msg.clone(),
                )),
        ),
        agent_nav(
            SettingPage::new("个性化")
                .icon(Icon::new(IconName::User))
                .group(
                    SettingGroup::new().item(
                        SettingItem::render({
                            let personality = personality.clone();
                            let persona_entity = persona_entity.clone();
                            move |_, _, _| {
                                let personality = personality.clone();
                                let persona_entity = persona_entity.clone();
                                v_flex().gap_2().child(Input::new(&personality)).child(
                                    Button::new("save-persona")
                                        .small()
                                        .label("保存个性化")
                                        .on_click(move |_, _, cx| {
                                            persona_entity
                                                .update(cx, |this, cx| this.save_personality(cx))
                                                .ok();
                                        }),
                                )
                            }
                        })
                        .keywords(["人格", "system", "提示"]),
                    ),
                ),
        ),
        agent_nav(
            SettingPage::new("记忆")
                .icon(Icon::new(IconName::BookOpen))
                .group(
                    SettingGroup::new().item(
                        SettingItem::render({
                            let memory_input = memory_input.clone();
                            let memory_entity = memory_entity.clone();
                            let memory_state = memory_state.clone();
                            move |_, _, _cx| {
                                let memories =
                                    memory_state.with(|s| s.prefs.agent.memories.clone());
                                let memory_input = memory_input.clone();
                                let add_entity = memory_entity.clone();
                                v_flex()
                                    .gap_2()
                                    .child(
                                        h_flex().gap_2().child(Input::new(&memory_input)).child(
                                            Button::new("add-mem")
                                                .small()
                                                .primary()
                                                .label("添加记忆")
                                                .on_click(move |_, _, cx| {
                                                    add_entity
                                                        .update(cx, |this, cx| this.add_memory(cx))
                                                        .ok();
                                                }),
                                        ),
                                    )
                                    .children(memories.into_iter().enumerate().map(
                                        |(index, memory)| {
                                            let remove_entity = memory_entity.clone();
                                            h_flex()
                                                .gap_2()
                                                .items_center()
                                                .child(
                                                    div()
                                                        .flex_1()
                                                        .text_sm()
                                                        .child(format!("{}. {memory}", index + 1)),
                                                )
                                                .child(
                                                    Button::new(SharedString::from(format!(
                                                        "rm-mem-{index}"
                                                    )))
                                                    .xsmall()
                                                    .ghost()
                                                    .label("删除")
                                                    .on_click(move |_, _, cx| {
                                                        remove_entity
                                                            .update(cx, |this, cx| {
                                                                this.remove_memory(index, cx)
                                                            })
                                                            .ok();
                                                    }),
                                                )
                                        },
                                    ))
                            }
                        })
                        .keywords(["记忆", "memory"]),
                    ),
                ),
        ),
        agent_nav(subagents_page(
            subagents_json.clone(),
            json_entity.clone(),
            agent_json_msg.clone(),
        )),
        agent_nav(plugins_page(plugins_dirs.clone(), dirs_entity.clone())),
        agent_nav(mcp_page(
            mcp_json.clone(),
            json_entity.clone(),
            agent_json_msg.clone(),
        )),
        agent_nav(skills_page(skills_dirs.clone(), dirs_entity.clone())),
        agent_nav(commands_page()),
        agent_nav(hooks_page(hooks_json.clone(), json_entity, agent_json_msg)),
    ]
}

fn keys_group(
    key_inputs: Vec<(String, Entity<InputState>)>,
    keys_entity: WeakEntity<SettingsPane>,
    cred_msg: String,
) -> SettingGroup {
    SettingGroup::new().title("密钥").in_nav(false).item(
        SettingItem::render(move |_, _, cx| {
            let muted = cx.theme().muted_foreground;
            let key_inputs = key_inputs.clone();
            let keys_entity = keys_entity.clone();
            let cred_msg = cred_msg.clone();
            v_flex()
                .gap_2()
                .children(
                    key_inputs
                        .iter()
                        .map(|(_, input)| Input::new(input).into_any_element()),
                )
                .child(
                    h_flex()
                        .gap_2()
                        .child(
                            Button::new("save-keys")
                                .small()
                                .primary()
                                .label("保存 API Key")
                                .on_click(move |_, _, cx| {
                                    keys_entity
                                        .update(cx, |this, cx| this.save_api_keys(cx))
                                        .ok();
                                }),
                        )
                        .child(
                            Button::new("save-providers")
                                .small()
                                .outline()
                                .label("写入默认 Provider 配置")
                                .on_click(|_, _, _| {
                                    let _ = save_providers(&load_providers());
                                }),
                        ),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(muted)
                        .child("输入 Key 后点保存。只输入一个 - 会清除该 Provider 的 Key。"),
                )
                .when(!cred_msg.is_empty(), |col| {
                    col.child(div().text_sm().text_color(muted).child(cred_msg))
                })
        })
        .keywords(["API", "Key", "密钥"]),
    )
}

fn dir_page(
    title: &str,
    icon: IconName,
    input: Entity<InputState>,
    dirs_entity: WeakEntity<SettingsPane>,
    button_id: &str,
    label: &str,
    keywords: &'static [&'static str],
) -> SettingPage {
    let title = SharedString::from(title);
    let button_id = SharedString::from(button_id);
    let label = SharedString::from(label);
    SettingPage::new(title).icon(Icon::new(icon)).group(
        SettingGroup::new().item(
            SettingItem::render(move |_, _, _| {
                let input = input.clone();
                let dirs_entity = dirs_entity.clone();
                let button_id = button_id.clone();
                let label = label.clone();
                v_flex().gap_2().child(Input::new(&input)).child(
                    Button::new(button_id)
                        .small()
                        .outline()
                        .label(label)
                        .on_click(move |_, _, cx| {
                            dirs_entity.update(cx, |this, cx| this.save_dirs(cx)).ok();
                        }),
                )
            })
            .keywords(keywords.iter().copied()),
        ),
    )
}

fn plugins_page(
    plugins_dirs: Entity<InputState>,
    dirs_entity: WeakEntity<SettingsPane>,
) -> SettingPage {
    dir_page(
        "插件",
        IconName::Folder,
        plugins_dirs,
        dirs_entity,
        "save-plugins",
        "保存插件目录",
        &["插件", "目录"],
    )
}

fn skills_page(
    skills_dirs: Entity<InputState>,
    dirs_entity: WeakEntity<SettingsPane>,
) -> SettingPage {
    dir_page(
        "技能",
        IconName::Star,
        skills_dirs,
        dirs_entity,
        "save-skills",
        "保存技能目录",
        &["技能", "目录"],
    )
}

struct JsonPageSpec {
    title: &'static str,
    icon: IconName,
    input: Entity<InputState>,
    json_entity: WeakEntity<SettingsPane>,
    agent_json_msg: String,
    hint: &'static str,
    button_id: &'static str,
    keywords: &'static [&'static str],
}

fn json_page(spec: JsonPageSpec) -> SettingPage {
    let JsonPageSpec {
        title,
        icon,
        input,
        json_entity,
        agent_json_msg,
        hint,
        button_id,
        keywords,
    } = spec;
    let title = SharedString::from(title);
    let hint = SharedString::from(hint);
    let button_id = SharedString::from(button_id);
    SettingPage::new(title).icon(Icon::new(icon)).group(
        SettingGroup::new().item(
            SettingItem::render(move |_, _, cx| {
                let muted = cx.theme().muted_foreground;
                let input = input.clone();
                let json_entity = json_entity.clone();
                let agent_json_msg = agent_json_msg.clone();
                let hint = hint.clone();
                let button_id = button_id.clone();
                v_flex()
                    .gap_2()
                    .child(div().text_xs().text_color(muted).child(hint))
                    .child(Input::new(&input))
                    .child(
                        h_flex().gap_2().child(
                            Button::new(button_id)
                                .small()
                                .primary()
                                .label("保存")
                                .on_click(move |_, _, cx| {
                                    json_entity
                                        .update(cx, |this, cx| this.save_agent_json(cx))
                                        .ok();
                                }),
                        ),
                    )
                    .when(!agent_json_msg.is_empty(), |col| {
                        col.child(div().text_sm().text_color(muted).child(agent_json_msg))
                    })
            })
            .keywords(keywords.iter().copied()),
        ),
    )
}

fn subagents_page(
    input: Entity<InputState>,
    json_entity: WeakEntity<SettingsPane>,
    agent_json_msg: String,
) -> SettingPage {
    json_page(JsonPageSpec {
        title: "子智能体",
        icon: IconName::Bot,
        input,
        json_entity,
        agent_json_msg,
        hint: "子智能体是 JSON 数组。保存时会一并写入 MCP 和 Hooks。",
        button_id: "save-subagents",
        keywords: &["子智能体", "JSON"],
    })
}

fn mcp_page(
    input: Entity<InputState>,
    json_entity: WeakEntity<SettingsPane>,
    agent_json_msg: String,
) -> SettingPage {
    json_page(JsonPageSpec {
        title: "MCP 服务器",
        icon: IconName::Globe,
        input,
        json_entity,
        agent_json_msg,
        hint: "MCP 服务器是 JSON 数组。保存时会一并写入子智能体和 Hooks。",
        button_id: "save-mcp",
        keywords: &["MCP", "JSON"],
    })
}

fn hooks_page(
    input: Entity<InputState>,
    json_entity: WeakEntity<SettingsPane>,
    agent_json_msg: String,
) -> SettingPage {
    json_page(JsonPageSpec {
        title: "钩子",
        icon: IconName::Settings,
        input,
        json_entity,
        agent_json_msg,
        hint: "Hooks 是 JSON 数组。保存时会一并写入 MCP 和子智能体。",
        button_id: "save-hooks",
        keywords: &["Hooks", "钩子", "JSON"],
    })
}

fn commands_page() -> SettingPage {
    SettingPage::new("命令")
        .icon(Icon::new(IconName::SquareTerminal))
        .group(
            SettingGroup::new().item(
                SettingItem::render(|_, _, cx| {
                    let muted = cx.theme().muted_foreground;
                    v_flex()
                        .gap_2()
                        .child("用命令面板跳到页面、任务、会话和笔记。")
                        .child(
                            div()
                                .text_sm()
                                .text_color(muted)
                                .child("Ctrl+K 或 Ctrl+P 打开命令面板。"),
                        )
                })
                .keywords(["命令", "面板", "Ctrl"]),
            ),
        )
}

fn data_page(state: AppState, entity: WeakEntity<SettingsPane>, data_msg: String) -> SettingPage {
    let status = wb_store::data_dir_status().ok();
    let data_dir = status
        .as_ref()
        .map(|item| item.current.to_string_lossy().to_string())
        .unwrap_or_else(|| "%APPDATA%\\my-workbench".into());
    let loc_hint = status
        .as_ref()
        .map(|item| {
            if item.via_env {
                "（环境变量 WB_DATA_DIR）".to_string()
            } else if item.via_redirect {
                "（已迁移）".to_string()
            } else {
                "（系统默认）".to_string()
            }
        })
        .unwrap_or_default();
    let can_restore = status
        .as_ref()
        .is_some_and(|item| item.via_redirect && !item.via_env);
    let tray_read = state.clone();
    let tray_write = state.clone();
    let tray_entity = entity.clone();
    let close_read = state.clone();
    let close_write = state;
    let close_entity = entity.clone();
    let backup = entity.clone();
    let backup_pick = entity.clone();
    let migrate = entity.clone();
    let restore = entity;
    SettingPage::new("数据")
        .icon(Icon::new(IconName::HardDrive))
        .resettable(false)
        .group(
            SettingGroup::new()
                .title("托盘")
                .in_nav(false)
                .item(
                    SettingItem::new(
                        "启用托盘图标",
                        SettingField::switch(
                            move |_| tray_read.with(|inner| inner.prefs.tray_enabled),
                            move |enabled, cx: &mut App| {
                                tray_write.with_mut(|inner| inner.prefs.tray_enabled = enabled);
                                tray_write.persist_prefs();
                                poke(&tray_entity, cx);
                            },
                        ),
                    )
                    .description("开关在下次启动后生效。"),
                )
                .item(
                    SettingItem::new(
                        "关闭时最小化到托盘",
                        SettingField::switch(
                            move |_| close_read.with(|inner| inner.prefs.close_to_tray),
                            move |enabled, cx: &mut App| {
                                close_write.with_mut(|inner| inner.prefs.close_to_tray = enabled);
                                close_write.persist_prefs();
                                poke(&close_entity, cx);
                            },
                        ),
                    )
                    .description("点窗口关闭会收进托盘。托盘菜单里的「退出」才结束进程。"),
                ),
        )
        .group(
            SettingGroup::new()
                .title("本机数据")
                .in_nav(false)
                .description(format!("数据目录：{data_dir}{loc_hint}"))
                .footer(|_, _| {
                    "备份包含工作台、偏好、主题和密钥，不含语音与 OCR 模型。迁移会留下重定向，原目录保留。"
                })
                .item(
                    SettingItem::render(move |_, _, cx| {
                        let muted = cx.theme().muted_foreground;
                        let backup = backup.clone();
                        let backup_pick = backup_pick.clone();
                        let migrate = migrate.clone();
                        let restore = restore.clone();
                        let data_msg = data_msg.clone();
                        v_flex()
                            .gap_2()
                            .child(
                                h_flex()
                                    .gap_2()
                                    .flex_wrap()
                                    .child(
                                        Button::new("open-data-dir")
                                            .small()
                                            .label("打开数据目录")
                                            .on_click(|_, _, cx| {
                                                if let Ok(dir) = wb_store::resolve_data_dir() {
                                                    cx.open_with_system(&dir);
                                                }
                                            }),
                                    )
                                    .child(
                                        Button::new("backup-data")
                                            .small()
                                            .primary()
                                            .label("一键备份")
                                            .on_click(move |_, _, cx| {
                                                backup
                                                    .update(cx, |this, cx| this.backup_data_here(cx))
                                                    .ok();
                                            }),
                                    )
                                    .child(
                                        Button::new("backup-data-pick")
                                            .small()
                                            .label("备份到…")
                                            .on_click(move |_, _, cx| {
                                                backup_pick
                                                    .update(cx, |this, cx| {
                                                        this.backup_data_pick(cx)
                                                    })
                                                    .ok();
                                            }),
                                    )
                                    .child(
                                        Button::new("migrate-data")
                                            .small()
                                            .label("迁移数据目录…")
                                            .on_click(move |_, _, cx| {
                                                migrate
                                                    .update(cx, |this, cx| {
                                                        this.migrate_data_pick(cx)
                                                    })
                                                    .ok();
                                            }),
                                    )
                                    .when(can_restore, |row| {
                                        row.child(
                                            Button::new("migrate-default")
                                                .small()
                                                .ghost()
                                                .label("迁回默认目录")
                                                .on_click(move |_, _, cx| {
                                                    restore
                                                        .update(cx, |this, cx| {
                                                            this.migrate_data_default(cx)
                                                        })
                                                        .ok();
                                                }),
                                        )
                                    }),
                            )
                            .when(!data_msg.is_empty(), |col| {
                                col.child(div().text_sm().text_color(muted).child(data_msg))
                            })
                            .child(div().text_sm().child(format!(
                                "版本 {} · GPUI + gpui-kit",
                                env!("CARGO_PKG_VERSION")
                            )))
                    })
                    .keywords(["备份", "迁移", "版本", "数据目录"]),
                ),
        )
}

fn about_page() -> SettingPage {
    SettingPage::new("关于")
        .icon(Icon::new(IconName::Info))
        .resettable(false)
        .group(SettingGroup::new().item(SettingItem::render(|_, _, cx| {
            v_flex()
                .gap_3()
                .w_full()
                .items_center()
                .justify_center()
                .py_8()
                .child(Icon::new(IconName::GalleryVerticalEnd).size_16())
                .child("个人工作台")
                .child(
                    div()
                        .text_sm()
                        .text_color(cx.theme().muted_foreground)
                        .child(format!(
                            "版本 {} · 本地优先，数据留在这台电脑上。",
                            env!("CARGO_PKG_VERSION")
                        )),
                )
        })))
}

impl Render for SettingsPane {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div().size_full().child(
            Settings::new("wb-settings")
                .search_placeholder("搜索设置")
                .sidebar_width(px(240.))
                .with_group_variant(GroupBoxVariant::Fill)
                .leading({
                    let state = self.state.clone();
                    let entity = cx.weak_entity();
                    move |_, cx| {
                        let state = state.clone();
                        let entity = entity.clone();
                        Button::new("settings-back")
                            .ghost()
                            .small()
                            .icon(IconName::ChevronLeft)
                            .label("返回工作区")
                            .text_color(cx.theme().muted_foreground)
                            .on_click(move |_, _, cx| {
                                state.with_mut(|inner| {
                                    let back = inner.nav_before_settings;
                                    inner.nav = if back == AppNav::Settings {
                                        AppNav::Today
                                    } else {
                                        back
                                    };
                                });
                                poke(&entity, cx);
                            })
                    }
                })
                .pages(self.pages(cx)),
        )
    }
}
