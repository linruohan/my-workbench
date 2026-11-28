use super::model_settings::{ModelEditor, model_page};
use crate::appearance::apply_ui_font;
use crate::state::{AppNav, AppState};
use crate::style;
use crate::themes;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::group_box::GroupBoxVariant;
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::scroll::ScrollbarMode;
use gpui_kit::component::setting::{
    SelectIndex, SettingField, SettingGroup, SettingItem, SettingPage, Settings, SettingsState,
};
use gpui_kit::component::switch::Switch;
use gpui_kit::component::*;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use wb_domain::ThemeModePref;
use wb_host::{list_skills, list_system_fonts, path_is_within, paths_equal, voice_ptt_set_enabled};

#[path = "tools_settings.rs"]
mod tools_ui;

pub struct SettingsPane {
    state: AppState,
    memory_input: Entity<InputState>,
    plugins_dirs: Entity<InputState>,
    personality: Entity<InputState>,
    mcp_json: Entity<InputState>,
    subagents_json: Entity<InputState>,
    hooks_json: Entity<InputState>,
    pub(crate) model_editor: ModelEditor,
    _model_subs: Vec<Subscription>,
    /// 设置页选中状态：由 hadron 设置左侧导航驱动，组件自身的侧栏已隐藏。
    settings_state: Entity<SettingsState>,
    /// 固定停在工作台「外观」页的状态（用于合并进 hadron 的 Appearance 页）。
    appearance_state: Entity<SettingsState>,
    /// 固定停在工作台「技能」页的状态（用于合并进 hadron 的 Skills 页）。
    skills_state: Entity<SettingsState>,
    font_count: usize,
    /// System font enumeration stays off the startup path.
    fonts_ready: bool,
    speech_msg: String,
    /// Per-engine status, keyed by engine id.
    speech_statuses: Vec<wb_host::SpeechStatus>,
    /// Engine currently being downloaded (or prepared).
    speech_busy: Option<String>,
    /// Live progress of the running download, when there is one.
    speech_progress: Option<wb_host::DownloadProgress>,
    /// Input devices reported by the audio host.
    speech_devices: Vec<String>,
    /// Whether an engine is already loaded and warm.
    speech_warm: bool,
    /// Guards the one-time device / model scan on first paint.
    speech_started: bool,
    /// True while a background status scan is running.
    speech_scanning: bool,
    tool_catalog: wb_host::ToolCatalog,
    tool_filter: tools_ui::ToolListFilter,
    tools_busy: bool,
    tools_started: bool,
    agent_json_msg: String,
    data_msg: String,
    skills_msg: String,
}

/// 工作台设置页签（顺序必须与 `SettingsPane::pages()` 返回的 `SettingPage` 一致）。
///
/// hadron 设置的 WORKBENCH 分组按这个列表逐行渲染；点击某行时把 id 传回来切页。
pub(crate) const WORKBENCH_SETTINGS_TABS: &[(&str, &str)] = &[
    ("general", "常规"),
    ("appearance", "外观"),
    ("tools", "工具"),
    ("notify", "通知"),
    ("voice", "语音输入"),
    ("data", "数据"),
    ("model", "模型"),
    ("skills", "技能"),
    ("plugins", "插件"),
    ("commands", "命令"),
    ("personality", "个性化"),
    ("memory", "记忆"),
    ("subagents", "子智能体"),
    ("mcp", "MCP 服务器"),
    ("hooks", "钩子"),
    ("about", "关于"),
];

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
        let plugins_val = state.with(|s| s.prefs.agent.plugins_dirs.join(";"));
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
        let (model_editor, model_subs) = ModelEditor::new(state.clone(), window, cx);
        let settings_state = cx.new(|cx| SettingsState::new(window, cx));
        // 合并进 hadron 内置页的两个固定页状态：外观 / 技能。
        let appearance_ix = WORKBENCH_SETTINGS_TABS
            .iter()
            .position(|(id, _)| *id == "appearance")
            .unwrap_or(1);
        let skills_ix = WORKBENCH_SETTINGS_TABS
            .iter()
            .position(|(id, _)| *id == "skills")
            .unwrap_or(7);
        let appearance_state = cx.new(|cx| {
            let mut state = SettingsState::new(window, cx);
            state.set_selected_index(
                SelectIndex {
                    page_ix: appearance_ix,
                    group_ix: None,
                },
                cx,
            );
            state
        });
        let skills_state = cx.new(|cx| {
            let mut state = SettingsState::new(window, cx);
            state.set_selected_index(
                SelectIndex {
                    page_ix: skills_ix,
                    group_ix: None,
                },
                cx,
            );
            state
        });
        let font_count = 0;
        // Speech models are scanned after the window is up: hashing a few
        // hundred megabytes here would delay every cold start.
        let speech_msg = String::new();
        let tool_catalog = wb_host::ToolCatalog {
            tools_dir: String::new(),
            scanned_at: None,
            bootstrapped: true,
            rows: Vec::new(),
        };
        Self {
            state,
            memory_input,
            plugins_dirs,
            personality,
            mcp_json,
            subagents_json,
            hooks_json,
            model_editor,
            _model_subs: model_subs,
            settings_state,
            appearance_state,
            skills_state,
            font_count,
            fonts_ready: false,
            speech_msg,
            speech_statuses: Vec::new(),
            speech_busy: None,
            speech_progress: None,
            speech_devices: Vec::new(),
            speech_warm: false,
            speech_started: false,
            speech_scanning: false,
            tool_catalog,
            tool_filter: tools_ui::ToolListFilter::All,
            tools_busy: false,
            tools_started: false,
            agent_json_msg: String::new(),
            data_msg: String::new(),
            skills_msg: String::new(),
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
        let plugins = self.plugins_dirs.read(cx).value().to_string();
        let split = |s: &str| -> Vec<String> {
            s.split([';', ','])
                .map(str::trim)
                .filter(|x| !x.is_empty())
                .map(|x| x.to_string())
                .collect()
        };
        self.state.with_mut(|s| {
            s.prefs.agent.plugins_dirs = split(&plugins);
        });
        self.state.persist_prefs();
        cx.notify();
    }

    fn add_skill_dir(&mut self, cx: &mut Context<Self>) {
        super::prompt_directory(cx, |this, picked, cx| {
            let Some(path) = picked else {
                return;
            };
            if !path.is_dir() {
                this.skills_msg = "所选路径不是文件夹".into();
                cx.notify();
                return;
            }
            let text = path.display().to_string();
            let duplicate = this.state.with(|s| {
                s.prefs
                    .agent
                    .skills_dirs
                    .iter()
                    .any(|dir| paths_equal(dir, &text))
            });
            if duplicate {
                this.skills_msg = "这个目录已经添加过了".into();
                cx.notify();
                return;
            }
            let found = list_skills(std::slice::from_ref(&text)).len();
            this.state.with_mut(|s| {
                s.prefs
                    .agent
                    .disabled_skill_dirs
                    .retain(|dir| !paths_equal(dir, &text));
                s.prefs.agent.skills_dirs.push(text);
            });
            this.state.persist_prefs();
            this.skills_msg = if found == 0 {
                "已添加，目录中没有发现 SKILL.md".into()
            } else {
                format!("已加载 {found} 个技能")
            };
            cx.notify();
        });
    }

    fn remove_skill_dir(&mut self, path: String, cx: &mut Context<Self>) {
        self.state.with_mut(|s| {
            s.prefs
                .agent
                .skills_dirs
                .retain(|dir| !paths_equal(dir, &path));
            s.prefs
                .agent
                .disabled_skill_dirs
                .retain(|dir| !paths_equal(dir, &path));
            s.prefs
                .agent
                .disabled_skills
                .retain(|skill| !path_is_within(skill, &path));
        });
        self.state.persist_prefs();
        self.skills_msg.clear();
        cx.notify();
    }

    fn set_skill_dir_enabled(&mut self, path: String, enabled: bool, cx: &mut Context<Self>) {
        self.state.with_mut(|s| {
            s.prefs
                .agent
                .disabled_skill_dirs
                .retain(|dir| !paths_equal(dir, &path));
            if !enabled {
                s.prefs.agent.disabled_skill_dirs.push(path);
            }
        });
        self.state.persist_prefs();
        cx.notify();
    }

    fn set_skill_enabled(&mut self, path: String, enabled: bool, cx: &mut Context<Self>) {
        self.state.with_mut(|s| {
            s.prefs
                .agent
                .disabled_skills
                .retain(|skill| !paths_equal(skill, &path));
            if !enabled {
                s.prefs.agent.disabled_skills.push(path);
            }
        });
        self.state.persist_prefs();
        cx.notify();
    }

    /// Re-check speech models and input devices off the UI thread.
    ///
    /// `speech_status` hashes model files, so it must never run inline in a
    /// click handler or on the first paint.
    fn refresh_speech(&mut self, cx: &mut Context<Self>) {
        if self.speech_scanning {
            return;
        }
        self.speech_scanning = true;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let (statuses, devices) = cx
                .background_executor()
                .spawn(async { (wb_host::speech_status_all(), wb_host::voice_input_devices()) })
                .await;
            this.update(cx, |this, cx| {
                this.speech_scanning = false;
                if this.speech_msg.is_empty() {
                    this.speech_msg = statuses
                        .iter()
                        .find(|st| st.ready)
                        .and_then(|st| st.message.clone())
                        .unwrap_or_else(|| "尚无可用语音模型，选择引擎后下载即可离线识别".into());
                }
                this.speech_statuses = statuses;
                this.speech_devices = devices;
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Create the engine directory without downloading anything.
    fn prepare_speech(&mut self, engine: String, cx: &mut Context<Self>) {
        self.speech_msg = format!("正在准备 {} 的目录…", wb_host::speech_engine_label(&engine));
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { wb_host::speech_ensure_models(&engine) })
                .await;
            this.update(cx, |this, cx| {
                this.speech_msg = match result {
                    Ok(st) => st
                        .message
                        .unwrap_or_else(|| format!("目录已准备：{}", st.model_dir)),
                    Err(e) => format!("准备目录失败：{e}"),
                };
                this.refresh_speech(cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Download (or repair) every file the engine needs, in the background.
    fn download_speech(&mut self, engine: String, cx: &mut Context<Self>) {
        if self.speech_busy.is_some() {
            return;
        }
        self.speech_busy = Some(engine.clone());
        self.speech_progress = None;
        self.speech_msg = format!("正在准备 {}…", wb_host::speech_engine_label(&engine));
        cx.notify();
        cx.spawn(async move |this, cx| {
            let label = wb_host::speech_engine_label(&engine);
            let (tx, rx) = std::sync::mpsc::channel();
            let worker = cx.background_executor().spawn(async move {
                let result = wb_host::speech_ensure_models_with(&engine, true, |progress| {
                    // Dropping the receiver just means nobody is listening.
                    let _ = tx.send(WorkerEvent::Progress(progress));
                });
                let _ = tx.send(WorkerEvent::Finished(result));
            });
            loop {
                match rx.try_recv() {
                    Ok(WorkerEvent::Progress(progress)) => {
                        this.update(cx, |this, cx| {
                            this.speech_progress = Some(progress);
                            this.speech_msg = format!(
                                "{label}：正在下载 {}（{}%）",
                                this.speech_progress
                                    .as_ref()
                                    .map(|p| p.file.clone())
                                    .unwrap_or_default(),
                                this.speech_progress
                                    .as_ref()
                                    .map(|p| p.percent())
                                    .unwrap_or(0)
                            );
                            cx.notify();
                        })
                        .ok();
                    }
                    Ok(WorkerEvent::Finished(result)) => {
                        let message = match result {
                            Ok(st) if st.ready => format!("{label} 下载完成，已通过完整性校验"),
                            Ok(st) => format!(
                                "{label} 部分完成：{}",
                                st.message.unwrap_or_else(|| st.missing.join("、"))
                            ),
                            Err(e) => format!("{label} 下载失败：{e:#}"),
                        };
                        this.update(cx, |this, cx| {
                            this.speech_busy = None;
                            this.speech_progress = None;
                            this.speech_msg = message;
                            this.refresh_speech(cx);
                            cx.notify();
                        })
                        .ok();
                        break;
                    }
                    Err(std::sync::mpsc::TryRecvError::Empty) => {
                        cx.background_executor()
                            .timer(std::time::Duration::from_millis(200))
                            .await;
                    }
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                        this.update(cx, |this, cx| {
                            this.speech_busy = None;
                            this.speech_progress = None;
                            cx.notify();
                        })
                        .ok();
                        break;
                    }
                }
            }
            worker.await;
        })
        .detach();
    }

    /// Delete an engine's files so it can be fetched again.
    fn remove_speech(&mut self, engine: String, cx: &mut Context<Self>) {
        if self.speech_busy.is_some() {
            return;
        }
        let label = wb_host::speech_engine_label(&engine);
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { wb_host::speech_remove_models(&engine) })
                .await;
            this.update(cx, |this, cx| {
                this.speech_msg = match result {
                    Ok(_) => format!("已删除 {label} 的本地模型文件"),
                    Err(e) => format!("删除 {label} 失败：{e}"),
                };
                this.refresh_speech(cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Load the active engine so the first dictation is not slowed down by it.
    fn warm_speech(&mut self, cx: &mut Context<Self>) {
        let engine = wb_host::speech_active_engine();
        self.speech_msg = format!("正在预热 {}…", wb_host::speech_engine_label(&engine));
        cx.notify();
        cx.spawn(async move |this, cx| {
            let engine_for_worker = engine.clone();
            let result = cx
                .background_executor()
                .spawn(async move { wb_host::speech_warm(&engine_for_worker) })
                .await;
            this.update(cx, |this, cx| {
                this.speech_msg = match result {
                    Ok(st) if st.ready => {
                        this.speech_warm = true;
                        format!(
                            "{} 已热备，可以按 CapsLock 说话",
                            wb_host::speech_engine_label(&engine)
                        )
                    }
                    Ok(st) => st.message.unwrap_or_else(|| "模型尚未就绪".into()),
                    Err(e) => format!("预热失败：{e:#}"),
                };
                this.refresh_speech(cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Record briefly and report the loudest level, so the device can be verified.
    fn probe_speech_device(&mut self, cx: &mut Context<Self>) {
        let device = self.state.with(|s| s.prefs.voice.input_device.clone());
        self.speech_devices = wb_host::voice_input_devices();
        self.speech_msg = "正在测试麦克风，请对着麦克风说话（2.5 秒）…".into();
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    wb_host::voice_probe_level(
                        device.as_deref(),
                        std::time::Duration::from_millis(2_500),
                    )
                })
                .await;
            this.update(cx, |this, cx| {
                this.speech_msg = match result {
                    // A quiet room is a valid outcome, not a broken device.
                    Ok(level) if level < 0.01 => {
                        "输入设备正常，但没有收到声音；请确认未静音后重试".to_string()
                    }
                    Ok(level) => format!("输入设备正常，峰值音量 {:.0}%", level * 100.0),
                    Err(e) => format!("输入设备不可用：{e:#}"),
                };
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn bootstrap_tools(&mut self, cx: &mut Context<Self>) {
        if self.tools_started {
            return;
        }
        self.tools_started = true;
        cx.spawn(async move |this, cx| {
            let catalog = cx
                .background_executor()
                .spawn(async { wb_host::read_tool_catalog() })
                .await;
            let fetch_after = !catalog.bootstrapped;
            let need_scan = catalog.scanned_at.is_none();
            this.update(cx, |this, cx| {
                this.tool_catalog = catalog;
                cx.notify();
            })
            .ok();
            if !fetch_after && !need_scan {
                return;
            }
            this.update(cx, |this, cx| {
                this.tools_busy = true;
                cx.notify();
            })
            .ok();
            let (tx, rx) = std::sync::mpsc::channel();
            let worker = cx.background_executor().spawn(async move {
                if need_scan {
                    let _ = tx.send(wb_host::scan_tool_catalog());
                } else {
                    wb_host::clear_tool_busy();
                }
                if fetch_after {
                    let ids = wb_host::tools_pending_fetch();
                    wb_host::acquire_tools(&ids, true, || {
                        let _ = tx.send(wb_host::read_tool_catalog());
                    });
                }
            });
            loop {
                match rx.try_recv() {
                    Ok(catalog) => {
                        this.update(cx, |this, cx| {
                            this.tool_catalog = catalog;
                            cx.notify();
                        })
                        .ok();
                    }
                    Err(std::sync::mpsc::TryRecvError::Empty) => {
                        cx.background_executor()
                            .timer(std::time::Duration::from_millis(300))
                            .await;
                    }
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => break,
                }
            }
            worker.await;
            let catalog = wb_host::read_tool_catalog();
            this.update(cx, |this, cx| {
                this.tool_catalog = catalog;
                this.tools_busy = false;
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn scan_tools(&mut self, cx: &mut Context<Self>) {
        if self.tools_busy {
            return;
        }
        self.tools_busy = true;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let catalog = cx
                .background_executor()
                .spawn(async { wb_host::scan_tool_catalog() })
                .await;
            this.update(cx, |this, cx| {
                this.tool_catalog = catalog;
                this.tools_busy = false;
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn fetch_tool(&mut self, id: &'static str, cx: &mut Context<Self>) {
        if self.tools_busy {
            return;
        }
        self.tools_busy = true;
        if let Some(row) = self.tool_catalog.rows.iter_mut().find(|row| row.id == id) {
            row.busy = true;
        }
        cx.notify();
        let id = id.to_string();
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .spawn(async move {
                    wb_host::acquire_tools(&[id], false, || {});
                })
                .await;
            let catalog = wb_host::read_tool_catalog();
            this.update(cx, |this, cx| {
                this.tool_catalog = catalog;
                this.tools_busy = false;
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn set_tool_enabled(&mut self, id: &'static str, enabled: bool, cx: &mut Context<Self>) {
        wb_host::set_tool_enabled(id, enabled);
        if let Some(row) = self.tool_catalog.rows.iter_mut().find(|row| row.id == id) {
            row.enabled = enabled;
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

    /// 按页签 id 切换工作台设置页（供 hadron 设置导航调用）。
    pub(crate) fn select_settings_page(&mut self, tab_id: &str, cx: &mut Context<Self>) {
        let Some(page_ix) = WORKBENCH_SETTINGS_TABS
            .iter()
            .position(|(id, _)| *id == tab_id)
        else {
            return;
        };
        self.settings_state.update(cx, |state, cx| {
            state.set_selected_index(
                SelectIndex {
                    page_ix,
                    group_ix: None,
                },
                cx,
            );
        });
        cx.notify();
    }

    /// 渲染工作台设置的某个固定页面（不影响当前选中页），用于合并进 hadron 内置页。
    ///
    /// 页面组件本身是「填满父容器」的布局，放进 hadron 的滚动区时必须给定高度，
    /// 否则会被压成 0 高；这里固定 640px，页面内容超出时在块内滚动。
    fn render_fixed_page(
        &self,
        page: &'static str,
        cx: &mut Context<Self>,
    ) -> gpui_kit::AnyElement {
        let (id, state) = match page {
            "appearance" => ("wb-settings-merged-appearance", &self.appearance_state),
            _ => ("wb-settings-merged-skills", &self.skills_state),
        };
        div()
            .w_full()
            .h(px(640.))
            .child(
                Settings::new(id)
                    .sidebar_width(px(0.))
                    .sidebar_size_range(px(0.)..px(0.))
                    .state(state)
                    .with_group_variant(GroupBoxVariant::Fill)
                    .pages(self.pages(cx)),
            )
            .into_any_element()
    }

    /// 生成注入给 hadron 设置的内容：把工作台「外观」「技能」合并进内置页尾部。
    pub(crate) fn merged_injected_settings(
        &self,
        cx: &mut Context<Self>,
    ) -> wb_hadron::app::InjectedWorkbenchSettings {
        wb_hadron::app::InjectedWorkbenchSettings {
            page: None,
            merged: vec![
                ("appearance", self.render_fixed_page("appearance", cx)),
                ("skills", self.render_fixed_page("skills", cx)),
            ],
        }
    }

    fn pages(&self, cx: &mut Context<Self>) -> Vec<SettingPage> {
        let state = self.state.clone();
        let entity = cx.weak_entity();
        let theme_name = cx.theme().theme_name().clone();
        let font_count = self.font_count;
        let data_msg = self.data_msg.clone();
        let agent = AgentForm {
            personality: self.personality.clone(),
            memory_input: self.memory_input.clone(),
            plugins_dirs: self.plugins_dirs.clone(),
            mcp_json: self.mcp_json.clone(),
            subagents_json: self.subagents_json.clone(),
            hooks_json: self.hooks_json.clone(),
            agent_json_msg: self.agent_json_msg.clone(),
            skills_msg: self.skills_msg.clone(),
        };

        // 侧栏对齐 Hadron：常规（含外观）→ 执行 → 环境 → 模型 → 技能，
        // 工作台多出来的 Agent 配置和关于页接在后面。
        let mut pages = vec![
            general_page(state.clone(), entity.clone()),
            appearance_page(state.clone(), entity.clone(), theme_name, font_count).section("常规"),
            tools_ui::tools_page(
                entity.clone(),
                self.tool_catalog.clone(),
                self.tool_filter,
                self.tools_busy,
            )
            .section("执行"),
            notify_page(state.clone(), entity.clone()).section("执行"),
            voice_page(
                state.clone(),
                entity.clone(),
                VoiceForm {
                    statuses: self.speech_statuses.clone(),
                    busy: self.speech_busy.clone(),
                    progress: self.speech_progress.clone(),
                    devices: self.speech_devices.clone(),
                    message: self.speech_msg.clone(),
                    warm: self.speech_warm,
                    scanning: self.speech_scanning,
                },
            )
            .section("环境"),
            data_page(state.clone(), entity.clone(), data_msg).section("环境"),
        ];
        pages.extend(agent_pages(state, entity, agent));
        pages.push(about_page().section("关于"));
        pages
    }
}

struct AgentForm {
    personality: Entity<InputState>,
    memory_input: Entity<InputState>,
    plugins_dirs: Entity<InputState>,
    mcp_json: Entity<InputState>,
    subagents_json: Entity<InputState>,
    hooks_json: Entity<InputState>,
    agent_json_msg: String,
    skills_msg: String,
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

fn in_section(page: SettingPage, section: &'static str) -> SettingPage {
    page.section(section).resettable(false)
}

fn general_page(state: AppState, entity: WeakEntity<SettingsPane>) -> SettingPage {
    let office = state.with(|inner| inner.prefs.general.interface_mode != "focus");
    let name_state = state.clone();
    let name_write = state.clone();
    let name_entity = entity.clone();
    let shell_state = state.clone();
    let shell_write = state.clone();
    let shell_entity = entity.clone();
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
        .section("常规")
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
                .border_color(style::hairline(cx))
                .bg(style::raised(cx))
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
                        "终端类型",
                        SettingField::dropdown(
                            vec![
                                ("auto".into(), "自动".into()),
                                ("bash".into(), "Bash".into()),
                                ("cmd".into(), "命令提示符".into()),
                                ("powershell".into(), "Windows PowerShell".into()),
                                ("pwsh".into(), "PowerShell 7".into()),
                                ("alacritty".into(), "Alacritty".into()),
                            ],
                            move |_| {
                                let value = shell_state
                                    .with(|inner| inner.prefs.general.terminal_shell.clone());
                                if value.is_empty() {
                                    "auto".into()
                                } else {
                                    value.into()
                                }
                            },
                            move |value: SharedString, cx: &mut App| {
                                let value = value.to_string();
                                set_general(&shell_write, &shell_entity, cx, |prefs| {
                                    prefs.terminal_shell = value;
                                });
                            },
                        ),
                    )
                    .description("右侧栏和 Agent 里新开的终端使用这个程序。Alacritty 会打开独立窗口，其余在内嵌终端中运行。"),
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
                    .description("下次启动时的窗口状态；「记住上次」暂与默认相同"),
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
    let web_font_state = state.clone();
    let web_font_write = state.clone();
    let web_font_entity = entity.clone();
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
                    .description(if font_count == 0 {
                        "留空使用系统界面字体。正在扫描系统字体…".to_string()
                    } else {
                        format!("留空使用系统界面字体。已扫描系统字体 {font_count} 个。")
                    }),
                )
                .item(
                    SettingItem::new(
                        "网页字体",
                        SettingField::input(
                            move |_| {
                                web_font_state
                                    .with(|s| s.prefs.web_font.clone().unwrap_or_default())
                                    .into()
                            },
                            move |value: SharedString, cx: &mut App| {
                                web_font_write.with_mut(|s| {
                                    s.prefs.web_font = if value.trim().is_empty() {
                                        None
                                    } else {
                                        Some(value.trim().to_string())
                                    };
                                });
                                web_font_write.persist_prefs();
                                poke(&web_font_entity, cx);
                            },
                        ),
                    )
                    .description("只作用于 Agent 网页会话。留空则使用网页自身字体。"),
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

/// Placeholder device id meaning "follow the system default".
const SPEECH_DEFAULT_DEVICE: &str = "__system_default__";

/// Reload the resident recognizer after a voice preference change.
fn rewarm_voice(state: &AppState) {
    let on = state.with(|s| s.prefs.voice.enabled || s.prefs.voice.caps_lock_ptt);
    if on {
        voice_ptt_set_enabled(true);
    }
}

/// Messages from the background download thread back to the UI.
enum WorkerEvent {
    Progress(wb_host::DownloadProgress),
    Finished(anyhow::Result<wb_host::SpeechStatus>),
}

/// Language choices for engines that accept one.
fn speech_language_choices() -> Vec<(SharedString, SharedString)> {
    [
        ("auto", "自动识别"),
        ("zh", "中文"),
        ("en", "英文"),
        ("ja", "日文"),
        ("ko", "韩文"),
        ("yue", "粤语"),
    ]
    .into_iter()
    .map(|(value, label)| (value.into(), label.into()))
    .collect()
}

/// Everything the voice page needs from `SettingsPane`.
struct VoiceForm {
    statuses: Vec<wb_host::SpeechStatus>,
    busy: Option<String>,
    progress: Option<wb_host::DownloadProgress>,
    devices: Vec<String>,
    message: String,
    warm: bool,
    /// A background status scan is in flight.
    scanning: bool,
}

fn voice_page(state: AppState, entity: WeakEntity<SettingsPane>, form: VoiceForm) -> SettingPage {
    let VoiceForm {
        statuses,
        busy,
        progress,
        devices,
        message,
        warm,
        scanning,
    } = form;

    // Everything below the switch only exists once voice input is on.
    let enabled = state.with(|s| s.prefs.voice.enabled);
    let read = state.clone();
    let toggle_state = state.clone();
    let toggle_entity = entity.clone();
    let page = SettingPage::new("语音输入")
        .icon(Icon::new(IconName::Mic))
        .resettable(false)
        .group(
            SettingGroup::new()
                .title("语音输入")
                .description(
                    "本地识别，录音不出这台电脑。按住 CapsLock 说话，松手后转写并粘贴到当前输入框。",
                )
                .item(
                    SettingItem::new(
                        "启用语音输入",
                        SettingField::switch(
                            move |_| read.with(|s| s.prefs.voice.enabled),
                            move |enabled, cx: &mut App| {
                                toggle_state.with_mut(|s| {
                                    s.prefs.voice.enabled = enabled;
                                    s.prefs.voice.caps_lock_ptt = enabled;
                                });
                                voice_ptt_set_enabled(enabled);
                                toggle_state.persist_prefs();
                                poke(&toggle_entity, cx);
                            },
                        ),
                    )
                    .description("开启后按住 CapsLock 说话，松手结束；关闭则收起下方全部设置。"),
                ),
        );

    if !enabled {
        return page;
    }

    page.group(engine_group(
        state.clone(),
        entity.clone(),
        statuses,
        busy,
        progress,
        scanning,
    ))
    .group(language_group(state.clone(), entity.clone(), devices))
    .group(recording_group(entity, message, warm))
}

/// Engine picker plus the download / verify controls for the chosen engine.
fn engine_group(
    state: AppState,
    entity: WeakEntity<SettingsPane>,
    statuses: Vec<wb_host::SpeechStatus>,
    busy: Option<String>,
    progress: Option<wb_host::DownloadProgress>,
    scanning: bool,
) -> SettingGroup {
    let options: Vec<(SharedString, SharedString)> = wb_host::speech_engines()
        .into_iter()
        .map(|info| (info.id.into(), info.label.into()))
        .collect();
    let engine_read = state.clone();
    let engine_write = state.clone();
    let engine_entity = entity.clone();
    let active = active_engine(&state, &statuses);

    SettingGroup::new()
        .title("识别引擎")
        .description("不同引擎的模型文件相互独立；换引擎后需要各自下载一次。")
        .item(
            SettingItem::new(
                "识别引擎",
                SettingField::dropdown(
                    options,
                    move |_| {
                        engine_read
                            .with(|s| active_engine_id(&s.prefs.voice.engine))
                            .into()
                    },
                    move |value: SharedString, cx: &mut App| {
                        let value = value.to_string();
                        engine_write.with_mut(|s| s.prefs.voice.engine = Some(value));
                        engine_write.persist_prefs();
                        rewarm_voice(&engine_write);
                        poke(&engine_entity, cx);
                    },
                ),
            )
            .description("切换后立即生效，按住 CapsLock 时使用所选引擎。"),
        )
        .item(
            SettingItem::render({
                let entity = entity.clone();
                move |_, _, cx| {
                    render_engine_list(
                        &entity,
                        &statuses,
                        busy.as_deref(),
                        progress.as_ref(),
                        scanning,
                        &active,
                        cx,
                    )
                }
            })
            .keywords(["SenseVoice", "QwenCTC", "Qwen3-ASR", "模型", "下载", "校验"]),
        )
}

/// Language picker; only SenseVoice honours it, QwenCTC detects by itself.
fn language_group(
    state: AppState,
    entity: WeakEntity<SettingsPane>,
    devices: Vec<String>,
) -> SettingGroup {
    let lang_read = state.clone();
    let lang_write = state.clone();
    let lang_entity = entity.clone();
    let device_read = state.clone();
    let device_write = state.clone();
    let device_entity = entity.clone();
    let probe_entity = entity.clone();

    let mut device_options: Vec<(SharedString, SharedString)> = vec![(
        SPEECH_DEFAULT_DEVICE.into(),
        match devices.first() {
            Some(default) => format!("系统默认（{default}）").into(),
            None => "系统默认".into(),
        },
    )];
    device_options.extend(
        devices
            .iter()
            .map(|name| (name.clone().into(), name.clone().into())),
    );

    SettingGroup::new()
        .title("输入")
        .item(
            SettingItem::new(
                "识别语言",
                SettingField::dropdown(
                    speech_language_choices(),
                    move |_| {
                        lang_read
                            .with(|s| {
                                s.prefs
                                    .voice
                                    .language
                                    .clone()
                                    .unwrap_or_else(|| "auto".into())
                            })
                            .into()
                    },
                    move |value: SharedString, cx: &mut App| {
                        let value = value.to_string();
                        lang_write.with_mut(|s| {
                            s.prefs.voice.language =
                                if value == "auto" { None } else { Some(value) };
                        });
                        lang_write.persist_prefs();
                        rewarm_voice(&lang_write);
                        poke(&lang_entity, cx);
                    },
                ),
            )
            .description("仅 SenseVoice 使用；QwenCTC 自行判断语种。"),
        )
        .item(
            SettingItem::new(
                "输入设备",
                SettingField::dropdown(
                    device_options,
                    move |_| {
                        device_read
                            .with(|s| {
                                s.prefs
                                    .voice
                                    .input_device
                                    .clone()
                                    .unwrap_or_else(|| SPEECH_DEFAULT_DEVICE.into())
                            })
                            .into()
                    },
                    move |value: SharedString, cx: &mut App| {
                        let value = value.to_string();
                        device_write.with_mut(|s| {
                            s.prefs.voice.input_device = if value == SPEECH_DEFAULT_DEVICE {
                                None
                            } else {
                                Some(value)
                            };
                        });
                        device_write.persist_prefs();
                        rewarm_voice(&device_write);
                        poke(&device_entity, cx);
                    },
                ),
            )
            .description("插拔耳机会重新读取设备；列表为空时表示系统没有可用的麦克风。"),
        )
        .item(
            SettingItem::render(move |_, _, cx| {
                let muted = cx.theme().muted_foreground;
                let entity = probe_entity.clone();
                h_flex()
                    .gap_2()
                    .items_center()
                    .child(
                        Button::new("speech-probe")
                            .small()
                            .label("测试麦克风")
                            .on_click(move |_, _, cx| {
                                entity
                                    .update(cx, |this, cx| this.probe_speech_device(cx))
                                    .ok();
                            }),
                    )
                    .child(
                        div()
                            .text_sm()
                            .text_color(muted)
                            .child("录 2.5 秒并显示峰值音量，可用来确认设备是否可用。"),
                    )
            })
            .keywords(["麦克风", "设备", "音量", "测试"]),
        )
}

/// Recording hint plus the most recent status line.
fn recording_group(entity: WeakEntity<SettingsPane>, message: String, warm: bool) -> SettingGroup {
    let refresh = entity.clone();
    let prepare = entity.clone();
    let warm_entity = entity.clone();
    SettingGroup::new()
        .title("说话与状态")
        .description("说出来，记下来。")
        .item(
            SettingItem::render(move |_, _, cx| {
                let muted = cx.theme().muted_foreground;
                let success = cx.theme().success;
                let border = style::hairline(cx);
                let fg = cx.theme().foreground;
                let refresh = refresh.clone();
                let prepare = prepare.clone();
                let warm_entity = warm_entity.clone();
                v_flex()
                    .w_full()
                    .gap_2()
                    .child(
                        h_flex()
                            .gap_2()
                            .flex_wrap()
                            .child(
                                Button::new("speech-refresh")
                                    .small()
                                    .secondary()
                                    .label("重新检查")
                                    .on_click(move |_, _, cx| {
                                        refresh.update(cx, |this, cx| this.refresh_speech(cx)).ok();
                                    }),
                            )
                            .child(
                                Button::new("speech-prepare")
                                    .small()
                                    .label("准备目录")
                                    .on_click(move |_, _, cx| {
                                        let engine = prepare
                                            .upgrade()
                                            .map(|pane| pane.read(cx).active_speech_engine())
                                            .unwrap_or_else(wb_host::speech_active_engine);
                                        prepare
                                            .update(cx, |this, cx| this.prepare_speech(engine, cx))
                                            .ok();
                                    }),
                            )
                            .when(warm, |row| {
                                row.child(
                                    h_flex()
                                        .gap_1()
                                        .items_center()
                                        .child(
                                            Icon::new(IconName::CircleCheck)
                                                .size(px(14.))
                                                .text_color(success),
                                        )
                                        .child(
                                            div().text_sm().text_color(success).child("热备就绪"),
                                        ),
                                )
                            }),
                    )
                    .child(
                        div()
                            .w_full()
                            .rounded(cx.theme().radius)
                            .border_1()
                            .border_color(border)
                            .p_2()
                            .text_sm()
                            .text_color(if warm { fg } else { muted })
                            .child(if message.is_empty() {
                                "尚未检查模型状态".to_string()
                            } else {
                                message.clone()
                            }),
                    )
                    .when(!warm, |col| {
                        col.child(
                            Button::new("speech-warm")
                                .small()
                                .primary()
                                .label("预热引擎")
                                .on_click(move |_, _, cx| {
                                    warm_entity.update(cx, |this, cx| this.warm_speech(cx)).ok();
                                }),
                        )
                    })
            })
            .keywords(["预热", "状态", "检查", "就绪"]),
        )
}

/// One card per engine: verified files, byte totals and its actions.
fn render_engine_list(
    entity: &WeakEntity<SettingsPane>,
    statuses: &[wb_host::SpeechStatus],
    busy: Option<&str>,
    live: Option<&wb_host::DownloadProgress>,
    scanning: bool,
    active: &str,
    cx: &App,
) -> AnyElement {
    let muted = cx.theme().muted_foreground;
    let fg = cx.theme().foreground;
    let border = cx.theme().border;
    let success = cx.theme().success;
    let warning = cx.theme().warning;
    let radius = cx.theme().radius;

    v_flex()
        .w_full()
        .gap_2()
        .children(wb_host::speech_engines().into_iter().map(|info| {
            let status = statuses.iter().find(|st| st.engine == info.id);
            let selected = info.id == active;
            let is_busy = busy == Some(info.id.as_str());
            let ready = status.is_some_and(|st| st.ready);
            // While a download runs, show the streamed file instead of the
            // stale on-disk status.
            let live = live.filter(|_| is_busy);
            let (icon, tone, text) = match (live, status) {
                (Some(p), _) => (
                    IconName::LoaderCircle,
                    warning,
                    format!("正在下载 {}（{}%）", p.file, p.percent()),
                ),
                (None, Some(st)) if st.ready => (
                    IconName::CircleCheck,
                    success,
                    if selected {
                        "本地资源已准备，识别引擎保持热备"
                    } else {
                        "本地资源已准备"
                    }
                    .to_string(),
                ),
                // Files are fine but the runtime is missing: downloading again
                // would not help, so say what is actually wrong.
                (None, Some(st)) if st.runtime_missing => (
                    IconName::CircleAlert,
                    warning,
                    st.message
                        .clone()
                        .unwrap_or_else(|| "缺少识别运行时".into()),
                ),
                (None, Some(st)) => (
                    IconName::CircleAlert,
                    warning,
                    st.message.clone().unwrap_or_else(|| "尚未下载".into()),
                ),
                (None, None) => (
                    IconName::CircleAlert,
                    warning,
                    "无法读取模型目录".to_string(),
                ),
            };
            // Before the background scan finishes there is no status yet;
            // saying the directory is unreadable would be wrong.
            let (icon, tone, text) = if status.is_none() && scanning {
                (
                    IconName::LoaderCircle,
                    warning,
                    "正在检查本地模型…".to_string(),
                )
            } else {
                (icon, tone, text)
            };
            let progress = match live {
                Some(p) if p.total > 0 => p.done as f32 / p.total as f32,
                _ => status.map(|st| st.progress()).unwrap_or(0.0),
            };
            let progress = progress.clamp(0.0, 1.0);
            let bytes = match live {
                Some(p) => format_bytes(p.done, p.total.max(p.done)),
                None => status
                    .map(|st| format_bytes(st.present_bytes, st.total_bytes))
                    .unwrap_or_else(|| "—".into()),
            };
            let download = entity.clone();
            let remove = entity.clone();
            let download_id = info.id.clone();
            let remove_id = info.id.clone();
            let can_remove = status.is_some_and(|st| st.present_bytes > 0);

            v_flex()
                .w_full()
                .gap_2()
                .rounded(radius)
                .border_1()
                .border_color(if selected { tone } else { border })
                .p_2()
                .child(
                    h_flex()
                        .w_full()
                        .gap_2()
                        .items_center()
                        .justify_between()
                        .child(
                            h_flex()
                                .gap_2()
                                .items_center()
                                .child(Icon::new(icon).size(px(16.)).text_color(tone))
                                .child(
                                    v_flex()
                                        .gap_1()
                                        .child(
                                            h_flex()
                                                .gap_2()
                                                .items_center()
                                                .child(
                                                    div()
                                                        .text_sm()
                                                        .font_semibold()
                                                        .text_color(fg)
                                                        .child(info.label.clone()),
                                                )
                                                .when(selected, |row| {
                                                    row.child(
                                                        div()
                                                            .text_xs()
                                                            .text_color(muted)
                                                            .child("当前使用"),
                                                    )
                                                }),
                                        )
                                        .child(
                                            div()
                                                .text_xs()
                                                .text_color(muted)
                                                .child(info.detail.clone()),
                                        ),
                                ),
                        )
                        .child(
                            h_flex()
                                .gap_1()
                                .child(
                                    Button::new(SharedString::from(format!(
                                        "speech-dl-{}",
                                        info.id
                                    )))
                                    .small()
                                    .when(!ready, |button| button.primary())
                                    .disabled(busy.is_some())
                                    .label(if is_busy {
                                        "下载中"
                                    } else if ready {
                                        "重新下载"
                                    } else {
                                        "下载"
                                    })
                                    .on_click(
                                        move |_, _, cx| {
                                            let download_id = download_id.clone();
                                            download
                                                .update(cx, |this, cx| {
                                                    this.download_speech(download_id, cx)
                                                })
                                                .ok();
                                        },
                                    ),
                                )
                                .when(can_remove && busy.is_none(), |row| {
                                    row.child(
                                        Button::new(SharedString::from(format!(
                                            "speech-rm-{}",
                                            info.id
                                        )))
                                        .small()
                                        .ghost()
                                        .label("删除")
                                        .on_click(
                                            move |_, _, cx| {
                                                let remove_id = remove_id.clone();
                                                remove
                                                    .update(cx, |this, cx| {
                                                        this.remove_speech(remove_id, cx)
                                                    })
                                                    .ok();
                                            },
                                        ),
                                    )
                                }),
                        ),
                )
                .child(
                    v_flex()
                        .w_full()
                        .gap_1()
                        .child(
                            h_flex()
                                .w_full()
                                .justify_between()
                                .gap_2()
                                .child(div().text_xs().text_color(tone).child(text))
                                .child(div().text_xs().text_color(muted).child(bytes)),
                        )
                        .child(
                            div()
                                .w_full()
                                .h(px(3.))
                                .rounded_full()
                                .bg(style::raised(cx))
                                .child(
                                    div().h_full().rounded_full().w(relative(progress)).bg(tone),
                                ),
                        )
                        .child(div().text_xs().text_color(muted).child(format!(
                            "{} · 约 {} MB",
                            info.languages,
                            info.total_bytes / 1_000_000
                        ))),
                )
                .into_any_element()
        }))
        .into_any_element()
}

fn format_bytes(present: u64, total: u64) -> String {
    let mb = |bytes: u64| bytes as f64 / 1_048_576.0;
    if total == 0 {
        return "—".into();
    }
    format!("{:.0} / {:.0} MB", mb(present), mb(total))
}

/// Stored engine id, falling back to SenseVoice.
fn active_engine_id(engine: &Option<String>) -> String {
    engine
        .as_deref()
        .map(wb_host::normalize_engine)
        .unwrap_or_else(|| wb_host::ENGINE_SENSEVOICE.into())
}

/// The engine to act on: the stored choice, else the first one that is ready.
fn active_engine(state: &AppState, statuses: &[wb_host::SpeechStatus]) -> String {
    let stored = state.with(|s| active_engine_id(&s.prefs.voice.engine));
    if statuses.iter().any(|st| st.engine == stored) {
        return stored;
    }
    statuses
        .iter()
        .find(|st| st.ready)
        .map(|st| st.engine.clone())
        .unwrap_or(stored)
}

impl SettingsPane {
    fn active_speech_engine(&self) -> String {
        self.speech_statuses
            .iter()
            .find(|st| st.ready)
            .map(|st| st.engine.clone())
            .unwrap_or_else(|| active_engine_id(&self.state.with(|s| s.prefs.voice.engine.clone())))
    }
}

fn agent_pages(
    state: AppState,
    entity: WeakEntity<SettingsPane>,
    form: AgentForm,
) -> Vec<SettingPage> {
    let AgentForm {
        personality,
        memory_input,
        plugins_dirs,
        mcp_json,
        subagents_json,
        hooks_json,
        agent_json_msg,
        skills_msg,
    } = form;
    let model_entity = entity.clone();
    let persona_entity = entity.clone();
    let memory_entity = entity.clone();
    let memory_state = state.clone();
    let dirs_entity = entity.clone();
    let json_entity = entity.clone();
    let proxy_read = state.clone();
    let proxy_write = state.clone();
    let proxy_entity = entity.clone();
    let skills_state = state.clone();
    let skills_entity = entity.clone();
    let _ = state;
    vec![
        in_section(
            model_page(model_entity).group(
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
                    .description("只影响模型请求。例如 http://127.0.0.1:7890，留空则不走代理。"),
                ),
            ),
            "模型",
        ),
        in_section(skills_page(skills_state, skills_entity, skills_msg), "技能"),
        in_section(
            plugins_page(plugins_dirs.clone(), dirs_entity.clone()),
            "技能",
        ),
        in_section(commands_page(), "技能"),
        in_section(
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
            "Agent",
        ),
        in_section(
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
            "Agent",
        ),
        in_section(
            subagents_page(
                subagents_json.clone(),
                json_entity.clone(),
                agent_json_msg.clone(),
            ),
            "Agent",
        ),
        in_section(
            mcp_page(
                mcp_json.clone(),
                json_entity.clone(),
                agent_json_msg.clone(),
            ),
            "Agent",
        ),
        in_section(
            hooks_page(hooks_json.clone(), json_entity, agent_json_msg),
            "Agent",
        ),
    ]
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
    state: AppState,
    entity: WeakEntity<SettingsPane>,
    skills_msg: String,
) -> SettingPage {
    SettingPage::new("技能")
        .icon(Icon::new(IconName::Star))
        .group(
            SettingGroup::new().item(
                SettingItem::render(move |_, _, cx| {
                    let muted = cx.theme().muted_foreground;
                    let border = style::hairline(cx);
                    let card = style::hover(cx);
                    let fg = cx.theme().foreground;
                    let accent = cx.theme().success;
                    let radius = cx.theme().radius;
                    let (dirs, disabled_dirs, disabled_skills) = state.with(|s| {
                        (
                            s.prefs.agent.skills_dirs.clone(),
                            s.prefs.agent.disabled_skill_dirs.clone(),
                            s.prefs.agent.disabled_skills.clone(),
                        )
                    });
                    let skills = list_skills(&dirs);
                    let enabled_dirs = dirs
                        .iter()
                        .filter(|dir| !disabled_dirs.iter().any(|off| paths_equal(off, dir)))
                        .count();
                    let add_entity = entity.clone();
                    let skills_msg = skills_msg.clone();
                    v_flex()
                        .gap_3()
                        .w_full()
                        .child(
                            div().text_sm().text_color(muted).child(
                                "添加本机技能目录。目录本身或子目录内含 SKILL.md 时会被发现；已启用技能的短描述进入会话，完整说明由 Agent 调用 skill_load 读取。",
                            ),
                        )
                        .child(
                            h_flex()
                                .gap_3()
                                .items_center()
                                .child(
                                    Button::new("add-skill-dir")
                                        .small()
                                        .secondary()
                                        .label("添加技能目录")
                                        .on_click(move |_, _, cx| {
                                            add_entity
                                                .update(cx, |this, cx| this.add_skill_dir(cx))
                                                .ok();
                                        }),
                                )
                                .when(!dirs.is_empty(), |row| {
                                    row.child(
                                        div().text_xs().text_color(muted).child(format!(
                                            "{enabled_dirs} 个目录启用 · 发现 {} 个技能",
                                            skills.len()
                                        )),
                                    )
                                }),
                        )
                        .when(!skills_msg.is_empty(), |col| {
                            col.child(div().text_sm().text_color(muted).child(skills_msg))
                        })
                        .children(dirs.iter().enumerate().map(|(index, dir)| {
                            let count = skills
                                .iter()
                                .filter(|skill| paths_equal(&skill.root, dir))
                                .count();
                            let enabled = !disabled_dirs.iter().any(|off| paths_equal(off, dir));
                            skill_dir_row(SkillDirRow {
                                index,
                                path: dir.clone(),
                                count,
                                enabled,
                                entity: entity.clone(),
                                border,
                                card,
                                fg,
                                muted,
                                accent,
                                radius,
                            })
                        }))
                        .when(!skills.is_empty(), |col| {
                            col.child(
                                div()
                                    .text_sm()
                                    .font_semibold()
                                    .pt_2()
                                    .child("已发现技能"),
                            )
                            .children(skills.iter().enumerate().map(|(index, skill)| {
                                let dir_enabled = !disabled_dirs
                                    .iter()
                                    .any(|off| paths_equal(off, &skill.root));
                                let skill_enabled = !disabled_skills
                                    .iter()
                                    .any(|off| paths_equal(off, &skill.path));
                                skill_entry_row(SkillEntryRow {
                                    index,
                                    name: skill.name.clone(),
                                    path: skill.path.clone(),
                                    summary: skill.summary.clone(),
                                    enabled: dir_enabled && skill_enabled,
                                    switch_disabled: !dir_enabled,
                                    entity: entity.clone(),
                                    border,
                                    card,
                                    fg: if dir_enabled { fg } else { muted },
                                    muted,
                                    accent,
                                    radius,
                                })
                            }))
                        })
                })
                .keywords(["技能", "目录", "SKILL", "skill"]),
            ),
        )
}

struct SkillDirRow {
    index: usize,
    path: String,
    count: usize,
    enabled: bool,
    entity: WeakEntity<SettingsPane>,
    border: Hsla,
    card: Hsla,
    fg: Hsla,
    muted: Hsla,
    accent: Hsla,
    radius: Pixels,
}

fn skill_dir_row(row: SkillDirRow) -> impl IntoElement {
    let SkillDirRow {
        index,
        path,
        count,
        enabled,
        entity,
        border,
        card,
        fg,
        muted,
        accent,
        radius,
    } = row;
    let name = dir_label(&path);
    let toggle_entity = entity.clone();
    let toggle_path = path.clone();
    let remove_path = path.clone();
    h_flex()
        .id(SharedString::from(format!("skill-dir-row-{index}")))
        .w_full()
        .items_center()
        .gap_3()
        .px_3()
        .py_2()
        .rounded(radius)
        .border_1()
        .border_color(border)
        .hover(|row| row.bg(card))
        .child(Icon::new(IconName::Folder).size(px(16.)).text_color(muted))
        .child(
            v_flex()
                .flex_1()
                .overflow_hidden()
                .child(
                    div()
                        .text_sm()
                        .font_semibold()
                        .text_color(if enabled { fg } else { muted })
                        .child(name.clone()),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(muted)
                        .child(format!("已发现 {count} 个技能")),
                ),
        )
        .child(
            Switch::new(SharedString::from(format!("skill-dir-{index}")))
                .small()
                .checked(enabled)
                .color(accent)
                .accessibility_label(SharedString::from(format!("启用目录 {name}")))
                .on_click(move |checked, _, cx| {
                    let enabled = *checked;
                    let path = toggle_path.clone();
                    toggle_entity
                        .update(cx, |this, cx| this.set_skill_dir_enabled(path, enabled, cx))
                        .ok();
                }),
        )
        .child(
            Button::new(SharedString::from(format!("skill-dir-del-{index}")))
                .ghost()
                .xsmall()
                .icon(IconName::Delete)
                .tooltip(SharedString::from(format!("移除 {path}")))
                .accessibility_label("移除技能目录")
                .on_click(move |_, _, cx| {
                    let path = remove_path.clone();
                    entity
                        .update(cx, |this, cx| this.remove_skill_dir(path, cx))
                        .ok();
                }),
        )
}

struct SkillEntryRow {
    index: usize,
    name: String,
    path: String,
    summary: String,
    enabled: bool,
    switch_disabled: bool,
    entity: WeakEntity<SettingsPane>,
    border: Hsla,
    card: Hsla,
    fg: Hsla,
    muted: Hsla,
    accent: Hsla,
    radius: Pixels,
}

fn skill_entry_row(row: SkillEntryRow) -> impl IntoElement {
    let SkillEntryRow {
        index,
        name,
        path,
        summary,
        enabled,
        switch_disabled,
        entity,
        border,
        card,
        fg,
        muted,
        accent,
        radius,
    } = row;
    let summary = if summary.is_empty() {
        "无短描述".to_string()
    } else {
        summary
    };
    let label = name.clone();
    h_flex()
        .id(SharedString::from(format!("skill-row-{index}")))
        .w_full()
        .items_center()
        .gap_3()
        .px_3()
        .py_2()
        .rounded(radius)
        .border_1()
        .border_color(border)
        .hover(|row| row.bg(card))
        .child(
            Icon::new(IconName::FileText)
                .size(px(16.))
                .text_color(muted),
        )
        .child(
            v_flex()
                .flex_1()
                .min_w(px(0.))
                .overflow_hidden()
                .child(div().text_sm().font_semibold().text_color(fg).child(name))
                .child(
                    div()
                        .w_full()
                        .overflow_x_hidden()
                        .whitespace_nowrap()
                        .text_ellipsis()
                        .text_xs()
                        .text_color(muted)
                        .child(summary),
                ),
        )
        .child(
            Switch::new(SharedString::from(format!("skill-on-{index}")))
                .small()
                .checked(enabled)
                .disabled(switch_disabled)
                .color(accent)
                .accessibility_label(SharedString::from(format!("启用技能 {label}")))
                .on_click(move |checked, _, cx| {
                    let enabled = *checked;
                    entity
                        .update(cx, |this, cx| {
                            this.set_skill_enabled(path.clone(), enabled, cx)
                        })
                        .ok();
                }),
        )
}

fn dir_label(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or(path)
        .to_string()
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
                        "关闭时收到托盘",
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
        self.bootstrap_tools(cx);
        // Device list and file checks must not run on every frame, so they are
        // loaded once when the pane first paints.
        if !self.speech_started {
            self.speech_started = true;
            self.refresh_speech(cx);
        }
        if !self.fonts_ready {
            self.fonts_ready = true;
            cx.spawn(async move |this, cx| {
                let count = cx
                    .background_executor()
                    .spawn(async { list_system_fonts().map(|fonts| fonts.len()).unwrap_or(0) })
                    .await;
                this.update(cx, |this, cx| {
                    this.font_count = count;
                    cx.notify();
                })
                .ok();
            })
            .detach();
        }
        div().size_full().child(
            Settings::new("wb-settings")
                .search_placeholder("搜索设置")
                // 侧栏由 hadron 设置的 WORKBENCH 分组承担，这里收起到 0 宽。
                .sidebar_width(px(0.))
                .sidebar_size_range(px(0.)..px(0.))
                .state(&self.settings_state)
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
