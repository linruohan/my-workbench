use crate::command_palette::CommandPalette;
use crate::state::{AppNav, AppState};
use crate::style;
use crate::themes;
use crate::title_bar::workbench_title_bar;
use crate::tray::{self, TrayAction};
use crate::views::{KnowledgePane, SettingsPane, TasksPane, TimedPane};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::resizable::{ResizableState, h_resizable, resizable_panel};
use gpui_kit::component::*;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{AnimationExt as _, *};
use std::time::Duration;
use wb_domain::{
    INBOX_PROJECT_ID, NotificationStatus, RIGHT_SIDEBAR_WIDTH_MAX, RIGHT_SIDEBAR_WIDTH_MIN,
    SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN, clamp_right_sidebar_width, clamp_sidebar_width,
    format_local_day, is_today_member, now_ms,
};
use wb_hadron::app::{WorkbenchNavGroup, WorkbenchNavIcon, WorkbenchNavItem};

actions!(
    workbench,
    [OpenPalette, FocusCapture, Escape, EditLastMessage]
);

fn recording_chip(bg: Hsla, fg: Hsla) -> impl IntoElement {
    div()
        .text_xs()
        .px_2()
        .py_1()
        .rounded_md()
        .bg(bg)
        .text_color(fg)
        .child("正在录音… 松开 CapsLock 结束")
        .with_animation(
            "recording-pulse",
            Animation::new(Duration::from_millis(900)).repeat(),
            |chip, delta| {
                let wave = if delta < 0.5 {
                    delta * 2.
                } else {
                    (1. - delta) * 2.
                };
                chip.opacity(0.55 + wave * 0.45)
            },
        )
}

/// 导航缓存的键：仓库修订号 + 今天日期。
struct NavCache {
    revision: u64,
    today: String,
    today_count: usize,
    inbox_count: usize,
    projects: Vec<(String, String)>,
}

/// 左栏「工作区」里的一个归档会话。
#[derive(Clone)]
struct WorkspaceSession {
    id: String,
    label: String,
}

/// 读取工作区的归档会话目录，返回「新 → 旧」排列的会话列表。
fn load_workspace_sessions(sessions_dir: &std::path::Path) -> Vec<WorkspaceSession> {
    let mut sessions: Vec<WorkspaceSession> = wb_hadron::model::list_sessions(sessions_dir)
        .into_iter()
        .rev()
        .map(|session| {
            let label = session.name.unwrap_or_else(|| session.id.clone());
            WorkspaceSession {
                id: session.id,
                label,
            }
        })
        .collect();
    sessions.sort_by(|a, b| b.id.cmp(&a.id));
    sessions
}

/// 左栏「工作区」里的一个工作区：一个目录即 hadron 的一个 workspace。
#[derive(Clone)]
struct WorkspaceEntry {
    /// 仓库根目录（`.wb/` 就落在它下面）。
    root: std::path::PathBuf,
    /// 左栏显示的名字，默认取目录名。
    label: String,
    /// 当前活动会话的显示名（field 里的 `SessionName`，没有则为「当前会话」）。
    active_label: String,
    /// 该工作区的归档会话（新 → 旧）。
    sessions: Vec<WorkspaceSession>,
    /// 归档列表是否展开；默认折叠（归档默认隐藏）。
    archived_open: bool,
}

impl WorkspaceEntry {
    /// 由目录路径构造条目，并顺带读出会话名与归档会话列表。
    fn new(root: std::path::PathBuf) -> Self {
        // 兼容旧版本：旧工作区的 `.hadron/` 先改名为 `.wb/`，再读取会话数据。
        wb_hadron::app::migrate_repo_dir(&root);
        let label = root
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| root.to_string_lossy().to_string());
        let mut entry = Self {
            root,
            label,
            active_label: String::new(),
            sessions: Vec::new(),
            archived_open: false,
        };
        entry.reload_sessions();
        entry
    }

    /// 活动会话的 field 文件路径：`<repo>/.wb/field.jsonl`。
    fn field_path(&self) -> std::path::PathBuf {
        self.root.join(".wb").join("field.jsonl")
    }

    /// 归档会话目录：`<repo>/.wb/sessions/`。
    fn sessions_dir(&self) -> std::path::PathBuf {
        self.root.join(".wb").join("sessions")
    }

    /// 重新读取该工作区的会话名与归档会话。
    fn reload_sessions(&mut self) {
        self.sessions = load_workspace_sessions(&self.sessions_dir());
        self.active_label = wb_hadron::session::read_session_name(&self.field_path())
            .unwrap_or_else(|| "当前会话".to_string());
    }

    /// 保证活动 field 有会话名（没有就写入 8 位随机名），并刷新显示名。
    fn ensure_active_name(&mut self) {
        if let Some(name) = wb_hadron::session::ensure_session_name(&self.field_path()) {
            self.active_label = name;
        }
    }
}

/// 一个已打开的会话：独立 field + 独立守护进程的 chamber。
///
/// 并行多会话的关键就在这里：每个会话对应 `<repo>/.wb/sessions/<id>/`
/// （或工作区默认的 `<repo>/.wb/`），彼此不共享 field，因此可以各聊各的。
struct OpenSession {
    /// 所属工作区在 `workspaces` 里的下标。
    workspace: usize,
    /// 会话 id；`active` 表示工作区默认会话。
    session_id: String,
    /// 标签栏与左栏显示的名字。
    label: String,
    /// 该会话的 field 路径；退出或关闭标签时据此停止对应守护进程。
    field_path: std::path::PathBuf,
    /// 该会话自己的聊天区实例。
    chamber: Entity<wb_hadron::app::Chamber>,
    /// 本进程为该会话拉起的守护进程句柄（已有守护进程时为 None）。
    _gluon: Option<std::process::Child>,
}

impl OpenSession {
    /// 这个会话是否属于指定工作区。
    fn belongs_to(&self, workspace: usize) -> bool {
        self.workspace == workspace
    }
}

/// 会话的 field 路径：`active` 用工作区默认 field，其余用归档目录下的会话 field。
fn session_field_path(entry: &WorkspaceEntry, session_id: &str) -> std::path::PathBuf {
    if session_id == "active" {
        entry.field_path()
    } else {
        entry.sessions_dir().join(session_id).join("field.jsonl")
    }
}

/// `workspaces.json` 的落盘结构。
#[derive(Default, serde::Serialize, serde::Deserialize)]
struct WorkspacesFile {
    /// 上次激活的工作区下标。
    #[serde(default)]
    active: usize,
    /// 工作区根目录（字符串形式，方便手改）。
    #[serde(default)]
    roots: Vec<String>,
}

/// 工作区配置文件名，落在 `wb_store` 的数据目录里。
const WORKSPACES_FILE: &str = "workspaces.json";

/// 读取已保存的工作区列表与活动下标；文件缺失或损坏时返回空列表。
fn load_workspace_state() -> (Vec<std::path::PathBuf>, usize) {
    let Ok(path) = wb_store::data_file_path(WORKSPACES_FILE) else {
        return (Vec::new(), 0);
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return (Vec::new(), 0);
    };
    match serde_json::from_str::<WorkspacesFile>(&text) {
        Ok(file) => {
            // 只保留仍然存在的目录，避免用户删掉文件夹后左栏出现死条目。
            let roots = file
                .roots
                .into_iter()
                .map(std::path::PathBuf::from)
                .filter(|root| root.is_dir())
                .collect();
            (roots, file.active)
        }
        Err(err) => {
            log::warn!("读取工作区配置失败: {err}");
            (Vec::new(), 0)
        }
    }
}

/// 把工作区列表与活动下标写回数据目录。
fn save_workspace_state(workspaces: &[WorkspaceEntry], active: usize) {
    let Ok(path) = wb_store::data_file_path(WORKSPACES_FILE) else {
        return;
    };
    let file = WorkspacesFile {
        active,
        roots: workspaces
            .iter()
            .map(|entry| entry.root.to_string_lossy().to_string())
            .collect(),
    };
    match serde_json::to_string_pretty(&file) {
        Ok(text) => {
            if let Err(err) = std::fs::write(&path, text) {
                log::warn!("写入工作区配置失败: {err}");
            }
        }
        Err(err) => log::warn!("序列化工作区配置失败: {err}"),
    }
}

/// 目录选择器归一化后的结果。
struct PickedWorkspace {
    /// 仓库根目录（`.wb/` 的父目录）。
    root: std::path::PathBuf,
    /// 若用户直接选到了某个会话目录，这里是要恢复的会话 id。
    session_id: Option<String>,
}

/// 把用户选中的目录归一成「仓库根 +（可选）会话 id」。
///
/// 规则：路径里出现 `.wb` 组件就取其前面部分作为仓库根；如果后面紧跟
/// `sessions/<id>`，说明用户点到了某个会话目录，顺便把它作为要打开的会话。
fn resolve_picked_workspace(picked: std::path::PathBuf) -> PickedWorkspace {
    let components: Vec<_> = picked.components().collect();
    let Some(hadron_index) = components
        .iter()
        .position(|component| {
            // 同时接受新旧目录名：旧 `.hadron` 也能被识别并上溯到仓库根。
            matches!(component.as_os_str().to_str(), Some(".wb") | Some(".hadron"))
        })
    else {
        return PickedWorkspace {
            root: picked,
            session_id: None,
        };
    };
    let mut root: std::path::PathBuf = components[..hadron_index].iter().collect();
    if root.as_os_str().is_empty() {
        root = picked.clone();
    }
    let rest = &components[hadron_index + 1..];
    let session_id = match rest {
        [sessions, id, ..] if sessions.as_os_str() == "sessions" => {
            Some(id.as_os_str().to_string_lossy().to_string())
        }
        _ => None,
    };
    PickedWorkspace { root, session_id }
}

/// 没有工作区时的主区空态：解释 + 「新建工作区」入口。
fn empty_workspace_state(cx: &mut Context<WorkbenchApp>) -> impl IntoElement {
    v_flex()
        .size_full()
        .items_center()
        .justify_center()
        .gap_3()
        .child(
            div()
                .text_lg()
                .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                .child("还没有工作区"),
        )
        .child(
            div()
                .max_w(px(420.))
                .text_sm()
                .text_center()
                .text_color(cx.theme().muted_foreground)
                .child("选择一个目录作为工作区，聊天记录会保存在该目录的 .wb 下。也可以直接选择已有会话目录，自动回到那段对话。"),
        )
        .child(
            Button::new("empty-add-workspace")
                .primary()
                .label("新建工作区")
                .on_click(cx.listener(|this, _, window, cx| {
                    // 与左栏「添加工作区」走同一条路径（只弹系统目录选择器）。
                    this.handle_workbench_nav("add-workspace", window, cx);
                })),
        )
}

/// 工作区已就绪、但还没打开任何会话时的主区提示。
fn no_session_state(cx: &mut Context<WorkbenchApp>) -> impl IntoElement {
    v_flex()
        .size_full()
        .items_center()
        .justify_center()
        .gap_3()
        .child(
            div()
                .text_lg()
                .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                .child("还没有打开的会话"),
        )
        .child(
            div()
                .max_w(px(420.))
                .text_sm()
                .text_center()
                .text_color(cx.theme().muted_foreground)
                .child("从左侧选择一个会话，或新建一个开始聊天。多个会话可以同时打开，各聊各的。"),
        )
        .child(
            Button::new("empty-new-session")
                .primary()
                .label("新建会话")
                .on_click(cx.listener(|this, _, window, cx| {
                    this.handle_workbench_nav("new-session", window, cx);
                })),
        )
}

/// 没有工作区时给 chamber 用的「空壳」根目录。
///
/// 左栏与浮层都需要一个 chamber 实例来绘制，但此时不该在用户目录里落下
/// `.wb/`，所以把壳放在数据目录下的 `shell/`，同时也不为它启动守护进程。
fn empty_shell_root() -> std::path::PathBuf {
    wb_store::ensure_data_dir()
        .map(|dir| dir.join("shell"))
        .unwrap_or_else(|_| std::env::temp_dir().join("my-workbench-shell"))
}

/// 给（可能是新建的）chamber 注入工作台设置的页签、切页回调与左侧栏点击回调。
///
/// 初始创建和切换工作区重建 chamber 时都要调用一遍，避免新实例丢回调。
fn configure_chamber(
    chamber: &Entity<wb_hadron::app::Chamber>,
    settings: &Entity<SettingsPane>,
    cx: &mut Context<WorkbenchApp>,
) {
    // 外观/技能已合并进 hadron 内置页，不再单独出现在导航里。
    let workbench_tabs: Vec<(String, String)> = crate::views::settings::WORKBENCH_SETTINGS_TABS
        .iter()
        .filter(|(id, _)| !matches!(*id, "appearance" | "skills"))
        .map(|(id, label)| ((*id).to_string(), (*label).to_string()))
        .collect();
    let settings = settings.clone();
    let nav_host = cx.weak_entity();
    chamber.update(cx, |chamber, _| {
        chamber.set_workbench_settings_tabs(workbench_tabs);
        chamber.set_workbench_settings_handler(move |tab_id: &str, app: &mut gpui_kit::App| {
            settings.update(app, |pane, cx| pane.select_settings_page(tab_id, cx));
        });
        // 左侧栏点击：chamber 只回传条目 id，由工作台决定切页 / 切工作区。
        chamber.set_workbench_nav_handler(move |id, window, app| {
            if let Some(host) = nav_host.upgrade() {
                host.update(app, |this, cx| this.handle_workbench_nav(id, window, cx));
            }
        });
    });
}

pub struct WorkbenchApp {
    state: AppState,
    collapsed: bool,
    right_collapsed: bool,
    ptt_held: bool,
    sidebar_panels: Entity<ResizableState>,
    tasks: Entity<TasksPane>,
    timed: Entity<TimedPane>,
    knowledge: Entity<KnowledgePane>,
    /// Hadron 聊天区与右侧栏（替代原 AgentPane + InspectorPane）。
    chamber: Entity<wb_hadron::app::Chamber>,
    /// 首次启动时由本进程拉起的 gluon 守护进程句柄（已有守护进程时为 None）。
    /// 仅用于持有子进程，避免提前回收。
    _gluon: Option<std::process::Child>,
    settings: Entity<SettingsPane>,
    palette: Entity<CommandPalette>,
    /// Sidebar counts and project names for the current repo revision and day.
    nav_cache: Option<NavCache>,
    /// 左栏「工作区」列表：每个目录即一个 hadron workspace。
    workspaces: Vec<WorkspaceEntry>,
    /// 当前活动工作区在 `workspaces` 中的下标。
    active_workspace: usize,
    /// 已打开的会话池：可同时打开多个，各聊各的（每个会话独立 chamber）。
    open_sessions: Vec<OpenSession>,
    /// 前台会话在 `open_sessions` 中的下标。
    active_session: Option<usize>,
    /// 目录选择器回调拿不到 window，先存下来，等渲染时再延后一帧激活。
    pending_workspace_root: Option<std::path::PathBuf>,
    /// 当前打开的重命名弹窗（同一时间只允许一个）。
    rename: Option<Entity<crate::rename_dialog::RenameDialog>>,
    /// Kept alive so the OS tray icon is not dropped.
    _tray: Option<tray_icon::TrayIcon>,
}

impl WorkbenchApp {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let state = AppState::load();
        let collapsed = state.with(|s| s.prefs.sidebar_collapsed);
        let right_collapsed = state.with(|s| s.prefs.right_sidebar_collapsed);
        themes::apply_saved_appearance(Some(window), cx);

        let tasks = cx.new(|cx| TasksPane::new(state.clone(), window, cx));
        let timed = cx.new(|cx| TimedPane::new(state.clone(), window, cx));
        let knowledge = cx.new(|cx| KnowledgePane::new(state.clone(), window, cx));
        let settings = cx.new(|cx| SettingsPane::new(state.clone(), window, cx));

        // 左栏「工作区」：一个目录即 hadron 的一个 workspace，配置持久化到
        // `<data>/workspaces.json`；首次启动保持空列表，由主区空态引导用户选择目录。
        let (saved_roots, saved_active) = load_workspace_state();
        let mut workspaces: Vec<WorkspaceEntry> =
            saved_roots.into_iter().map(WorkspaceEntry::new).collect();
        let active_workspace = if workspaces.is_empty() {
            0
        } else {
            saved_active.min(workspaces.len() - 1)
        };
        // 活动工作区：保证会话有默认名（8 位随机串），再刷新左栏显示。
        if let Some(entry) = workspaces.get_mut(active_workspace) {
            entry.ensure_active_name();
            entry.reload_sessions();
        }

        // 没有工作区时也需要一个 chamber 来渲染左栏与浮层：给它一个数据目录下的壳，
        // 不启动守护进程，主区改为「新建工作区」空态。
        let repo_root = workspaces
            .get(active_workspace)
            .map(|entry| entry.root.clone())
            .unwrap_or_else(empty_shell_root);
        let has_workspace = !workspaces.is_empty();

        // Hadron 聊天区 + 右侧栏：初始化字体/快捷键并构建嵌入式 Chamber。
        // field 落在当前工作区的 `.wb/field.jsonl`。
        wb_hadron::app::init_embedded(cx, &repo_root);
        wb_hadron::app::bind_embedded_keys(cx);
        let chamber_init = wb_hadron::app::prepare_embedded(&repo_root);
        let chamber = cx.new(|cx| wb_hadron::app::Chamber::embedded(chamber_init, window, cx));
        // 确保守护进程在跑，否则聊天只写 field、收不到回复。
        let gluon = if has_workspace {
            wb_hadron::app::ensure_daemon_for_repo(&repo_root)
        } else {
            None
        };

        // 设置页签与左侧栏点击回调统一注入；切换工作区重建 chamber 时会复用。
        configure_chamber(&chamber, &settings, cx);
        // 有工作区时立刻落盘，之后的启动就能记住；空态不写，保留首次启动的语义。
        if has_workspace {
            save_workspace_state(&workspaces, active_workspace);
        }
        // 首次启动（空工作区）直接把主区切到 Agent 位，让「新建工作区」引导可见。
        if !has_workspace {
            state.with_mut(|s| s.nav = AppNav::Agent);
        }

        let host = cx.weak_entity();
        let tasks_for_palette = tasks.downgrade();
        let palette = cx.new(|cx| {
            CommandPalette::new(state.clone(), host.clone(), tasks_for_palette, window, cx)
        });
        let sidebar_panels = cx.new(|_| ResizableState::default());

        let voice_on = state.with(|s| s.prefs.voice.enabled || s.prefs.voice.caps_lock_ptt);
        wb_host::voice_ptt_set_enabled(voice_on);

        cx.bind_keys([
            KeyBinding::new("ctrl-p", OpenPalette, None),
            KeyBinding::new("ctrl-k", OpenPalette, None),
            KeyBinding::new("ctrl-n", FocusCapture, None),
            KeyBinding::new("alt-up", EditLastMessage, None),
            KeyBinding::new("escape", Escape, None),
        ]);

        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_secs(15))
                    .await;
                this.update(cx, |this, cx| {
                    this.on_tick(cx);
                })
                .ok();
            }
        })
        .detach();

        // PTT 录音态与转写结果需要更密的轮询。语音关闭时放慢，避免空转唤醒 UI。
        cx.spawn(async move |this, cx| {
            loop {
                let fast = this
                    .update(cx, |this, _cx| {
                        this.ptt_held
                            || this
                                .state
                                .with(|s| s.prefs.voice.enabled || s.prefs.voice.caps_lock_ptt)
                    })
                    .unwrap_or(false);
                let wait = if fast { 50 } else { 1_000 };
                cx.background_executor()
                    .timer(Duration::from_millis(wait))
                    .await;
                this.update(cx, |this, cx| {
                    this.on_ptt_poll(cx);
                })
                .ok();
            }
        })
        .detach();

        cx.observe_window_appearance(window, |this, window, cx| {
            if matches!(this.state.theme_mode(), wb_domain::ThemeModePref::System) {
                Theme::sync_system_appearance(Some(window), cx);
                themes::reapply_overrides(&this.state, cx);
                cx.notify();
            }
        })
        .detach();

        let tray_on = state.with(|s| s.prefs.tray_enabled);
        let close_to_tray = state.with(|s| s.prefs.close_to_tray);
        let tray_icon = if tray_on { tray::create_tray() } else { None };
        let app = cx.weak_entity();
        let hide_on_close = tray_on && close_to_tray;
        // Close always flushes. With the tray, close hides the window instead of quitting.
        window.on_window_should_close(cx, move |window, cx| {
            if hide_on_close && !tray::is_force_quit() {
                let _ = app.update(cx, |this, cx| this.flush_persistent_state(cx));
                tray::hide_main_window(window);
                return false;
            }
            let _ = app.update(cx, |this, cx| {
                this.flush_persistent_state(cx);
                // 真正退出（非隐藏到托盘）时，一并停止本应用的守护进程。
                this.stop_gluon_daemons();
            });
            true
        });

        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(120))
                    .await;
                let Some(action) = tray::poll_action() else {
                    continue;
                };
                this.update(cx, |this, cx| {
                    this.handle_tray_action(action, cx);
                })
                .ok();
            }
        })
        .detach();

        let mut app = Self {
            state,
            collapsed,
            right_collapsed,
            ptt_held: false,
            sidebar_panels,
            tasks,
            timed,
            knowledge,
            chamber,
            _gluon: gluon,
            settings,
            palette,
            nav_cache: None,
            workspaces,
            active_workspace,
            open_sessions: Vec::new(),
            active_session: None,
            pending_workspace_root: None,
            rename: None,
            _tray: tray_icon,
        };
        // 有工作区时把默认会话打开在前台；启动阶段不切页，保留用户上次所在页面。
        if has_workspace {
            app.open_session(active_workspace, "active", false, window, cx);
        }
        app
    }

    fn handle_tray_action(&mut self, action: TrayAction, cx: &mut Context<Self>) {
        match action {
            TrayAction::Show => {
                cx.activate(true);
                if let Some(handle) = cx.active_window() {
                    let _ = handle.update(cx, |_, window, _| {
                        tray::show_main_window(window);
                    });
                }
            }
            TrayAction::Quit => {
                self.flush_persistent_state(cx);
                // 退出前收掉所有守护进程，避免任务管理器里残留 wb-gluon.exe。
                self.stop_gluon_daemons();
                tray::request_force_quit();
                cx.quit();
            }
        }
    }

    fn set_sidebar_width(&mut self, width: f32, cx: &mut Context<Self>) {
        let width = clamp_sidebar_width(width);
        let changed = self.state.with_mut(|s| {
            if (s.prefs.sidebar_width - width).abs() < 0.5 {
                false
            } else {
                s.prefs.sidebar_width = width;
                true
            }
        });
        if changed {
            self.state.persist_prefs();
            cx.notify();
        }
    }

    fn set_right_sidebar_width(&mut self, width: f32, cx: &mut Context<Self>) {
        let width = clamp_right_sidebar_width(width);
        let changed = self.state.with_mut(|s| {
            if (s.prefs.right_sidebar_width - width).abs() < 0.5 {
                false
            } else {
                s.prefs.right_sidebar_width = width;
                true
            }
        });
        if changed {
            self.state.persist_prefs();
            cx.notify();
        }
    }

    fn checkpoint_timer(&mut self) {
        let now = now_ms();
        let today = format_local_day(now);
        self.state.with_mut(|s| {
            let Some((task_id, started)) = s.active_timer.clone() else {
                return;
            };
            let elapsed = now.saturating_sub(started);
            if elapsed < 1_000 {
                return;
            }
            if let Some(mut task) = s.repo.get_task(&task_id).cloned() {
                wb_domain::settle_timer_segment(&mut task, &today, elapsed, now);
                s.repo.upsert_task(task);
            }
            s.active_timer = Some((task_id, now));
        });
    }

    fn flush_persistent_state(&mut self, _cx: &mut Context<Self>) {
        self.checkpoint_timer();
        self.state.remember_session();
        self.state.persist_blocking();
    }

    fn on_tick(&mut self, cx: &mut Context<Self>) {
        let now = now_ms();
        self.checkpoint_timer();
        self.timed.update(cx, |timed, cx| timed.tick_due(cx));
        // Keep timer UI fresh while a timer is running.
        let timing = self.state.with(|s| s.active_timer.is_some());
        if timing {
            self.tasks.update(cx, |_, cx| cx.notify());
        }
        let due_reminds: Vec<(String, String, bool)> = self.state.with_mut(|s| {
            s.repo.wake_snoozed_notifications(now);
            let mut due = Vec::new();
            let due_ids: Vec<String> = s
                .repo
                .tasks()
                .filter(|task| {
                    !task.is_done
                        && (task.remind_at.is_some_and(|at| at <= now)
                            || task.deadline_remind_at.is_some_and(|at| at <= now))
                })
                .map(|task| task.id.clone())
                .collect();
            for id in due_ids {
                let Some(task) = s.repo.get_task(&id).cloned() else {
                    continue;
                };
                let mut next = task.clone();
                if task.remind_at.is_some_and(|at| at <= now) {
                    due.push((task.id.clone(), task.title.clone(), false));
                    next.remind_at = None;
                }
                if task.deadline_remind_at.is_some_and(|at| at <= now) {
                    due.push((task.id.clone(), task.title.clone(), true));
                    next.deadline_remind_at = None;
                }
                s.repo.upsert_task(next);
            }
            s.last_tick = now;
            due
        });
        let has_due = !due_reminds.is_empty();
        for (id, title, is_deadline) in due_reminds {
            if is_deadline {
                self.state.push_notification(
                    wb_domain::NotificationKind::DeadlineRemind,
                    &title,
                    "截止提醒",
                    Some(&id),
                );
            } else {
                self.state.push_notification(
                    wb_domain::NotificationKind::TaskRemind,
                    &title,
                    "计划提醒",
                    Some(&id),
                );
            }
        }
        self.state.remember_session();
        self.state.persist_if_dirty();
        if timing || has_due {
            cx.notify();
        }
    }

    fn on_ptt_poll(&mut self, cx: &mut Context<Self>) {
        let held = wb_host::voice_ptt_is_held();
        let mut dirty = false;
        if self.ptt_held != held {
            self.ptt_held = held;
            dirty = true;
        }
        if let Some(pending) = wb_host::voice_ptt_take_pending() {
            match pending {
                wb_host::VoicePending::Text(text) => {
                    // Paste failed inside the host, so surface the text instead
                    // of losing it. The notification body is selectable.
                    self.state.push_notification(
                        wb_domain::NotificationKind::System,
                        "语音已转写（未能自动粘贴）",
                        &text,
                        None,
                    );
                }
                wb_host::VoicePending::Error(message) => {
                    self.state.push_notification(
                        wb_domain::NotificationKind::System,
                        "语音输入",
                        &message,
                        None,
                    );
                }
            }
            dirty = true;
        }
        if dirty {
            cx.notify();
        }
    }

    /// 处理 hadron 左侧栏回传的导航点击。
    ///
    /// 条目 id 有这几类：`project:<id>`（项目）、`new-project`（新建项目）、
    /// `session:<id>`（工作区会话，`active` 表示当前活动会话）、
    /// `new-session`（归档当前会话并新开一个），以及 [`AppNav::from_view_id`]
    /// 能识别的页面 id。
    pub(crate) fn handle_workbench_nav(
        &mut self,
        id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match id {
            "new-project" => {
                self.tasks
                    .update(cx, |tasks, cx| tasks.open_project_dialog(window, cx));
                return;
            }
            "settings" => {
                self.set_nav(AppNav::Settings, cx);
                return;
            }
            "add-workspace" => {
                // 目录选择回调拿不到 window，先存下结果，等渲染时再延后激活。
                crate::views::prompt_directory(cx, |this, picked, cx| {
                    if picked.is_some() {
                        this.pending_workspace_root = picked;
                        cx.notify();
                    }
                });
                return;
            }
            _ => {}
        }

        // 「已归档 (N)」折叠行：纯宿主状态，不碰 chamber，可以直接改。
        if let Some(index) = id
            .strip_prefix("archive-toggle:")
            .and_then(|raw| raw.parse::<usize>().ok())
        {
            if let Some(entry) = self.workspaces.get_mut(index) {
                entry.archived_open = !entry.archived_open;
            }
            cx.notify();
            return;
        }

        // 会话 / 工作区动作都要操作 chamber，统一延后到下一帧执行，
        // 避免在 chamber 自己的点击回调里对同一个 Entity 重入借用。
        if id == "new-session"
            || id.starts_with("workspace:")
            || id.starts_with("session:")
            || id.starts_with("rename-session:")
        {
            let id = id.to_string();
            cx.defer_in(window, move |this, window, cx| {
                this.apply_workspace_action(&id, window, cx);
            });
            return;
        }

        if let Some(project_id) = id.strip_prefix("project:") {
            self.state.with_mut(|s| {
                s.nav = AppNav::Projects;
                s.active_project_id = Some(project_id.to_string());
                s.active_tag_id = None;
            });
            self.state.remember_session();
            cx.notify();
            return;
        }

        if let Some(nav) = AppNav::from_view_id(id) {
            self.set_nav(nav, cx);
        }
    }

    /// 执行会话 / 工作区类导航动作。
    ///
    /// 只由 [`Self::handle_workbench_nav`] 通过 `cx.defer_in` 调用，保证此时
    /// chamber 的点击回调已经返回，可以安全地 `update` 它。
    fn apply_workspace_action(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        // 没有工作区时所有会话动作都无处落地（chamber 只是空壳）。
        if self.workspaces.is_empty() {
            return;
        }
        match id {
            // 新会话：在当前工作区建一个独立会话目录并并行打开（不再归档当前会话）。
            "new-session" => {
                self.new_session_in_active_workspace(window, cx);
                return;
            }
            _ => {}
        }

        // 会话行「更多」→ 打开重命名弹窗：`rename-session:<工作区下标>:<会话 id>`。
        if let Some(rest) = id.strip_prefix("rename-session:") {
            let (index, session_id) = match rest.split_once(':') {
                Some((index, session_id)) => (
                    index.parse::<usize>().unwrap_or(self.active_workspace),
                    session_id.to_string(),
                ),
                None => (self.active_workspace, rest.to_string()),
            };
            self.open_session_rename(index, session_id, window, cx);
            return;
        }

        if let Some(index) = id
            .strip_prefix("workspace:")
            .and_then(|raw| raw.parse::<usize>().ok())
        {
            self.activate_workspace(index, None, window, cx);
            return;
        }

        if let Some(rest) = id.strip_prefix("session:") {
            // id 形如 `session:<工作区下标>:<会话 id>`，`active` 表示当前会话。
            let (index, session_id) = match rest.split_once(':') {
                Some((index, session_id)) => (
                    index.parse::<usize>().unwrap_or(self.active_workspace),
                    session_id.to_string(),
                ),
                None => (self.active_workspace, rest.to_string()),
            };
            if index != self.active_workspace {
                // 跨工作区：先切工作区，再在新工作区里打开目标会话。
                self.activate_workspace(index, Some(session_id), window, cx);
                return;
            }
            // 同一工作区：已打开就前置，没打开就并行新开一个。
            self.open_session(index, &session_id, true, window, cx);
        }
    }

    /// 把焦点交给前台会话的输入框（没有打开会话时用壳 chamber 兜底）。
    fn focus_chat(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let chamber = self
            .active_session_chamber()
            .unwrap_or_else(|| self.chamber.clone());
        chamber.update(cx, |chamber, cx| chamber.focus_chat_input(window, cx));
    }

    /// 返回当前前台会话的 chamber；没有打开会话时为 None。
    fn active_session_chamber(&self) -> Option<Entity<wb_hadron::app::Chamber>> {
        self.active_session
            .and_then(|index| self.open_sessions.get(index))
            .map(|session| session.chamber.clone())
    }

    /// 打开一个会话（已打开则直接前置）。
    ///
    /// `focus` 为真时切到 Agent 页并持久化导航；启动恢复阶段传 false，
    /// 避免覆盖用户上次停留的页面。
    fn open_session(
        &mut self,
        workspace: usize,
        session_id: &str,
        focus: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(entry) = self.workspaces.get(workspace) else {
            return;
        };
        if let Some(index) = self
            .open_sessions
            .iter()
            .position(|session| session.belongs_to(workspace) && session.session_id == session_id)
        {
            self.active_session = Some(index);
            if focus {
                self.set_nav(AppNav::Agent, cx);
            } else {
                cx.notify();
            }
            return;
        }
        let root = entry.root.clone();
        let field = session_field_path(entry, session_id);
        // 先保证会话有名字（8 位随机串），标签栏与左栏立即能显示有意义的内容。
        let label = wb_hadron::session::ensure_session_name(&field)
            .unwrap_or_else(|| session_id.to_string());
        wb_hadron::app::set_embedded_workspace(&root);
        let chamber_init = wb_hadron::app::prepare_embedded_at(&root, &field);
        let chamber = cx.new(|cx| wb_hadron::app::Chamber::embedded(chamber_init, window, cx));
        configure_chamber(&chamber, &self.settings, cx);
        // 每个会话有独立运行目录，守护进程也按 field 单独拉起，互不干扰。
        let gluon = wb_hadron::app::ensure_daemon_for_field(&field);
        self.open_sessions.push(OpenSession {
            workspace,
            session_id: session_id.to_string(),
            label,
            field_path: field,
            chamber,
            _gluon: gluon,
        });
        self.active_session = Some(self.open_sessions.len() - 1);
        self.refresh_workspace_sessions();
        if focus {
            self.set_nav(AppNav::Agent, cx);
        } else {
            cx.notify();
        }
    }

    /// 把已打开的会话切到前台（点标签栏）。
    pub(crate) fn activate_open_session(&mut self, index: usize, cx: &mut Context<Self>) {
        if index >= self.open_sessions.len() {
            return;
        }
        self.active_session = Some(index);
        self.set_nav(AppNav::Agent, cx);
    }

    /// 关闭一个已打开的会话（只关界面，不动磁盘上的 field，下次还能再打开）。
    pub(crate) fn close_open_session(&mut self, index: usize, cx: &mut Context<Self>) {
        if index >= self.open_sessions.len() {
            return;
        }
        let session = self.open_sessions.remove(index);
        let field = session.field_path.clone();
        // 先释放 chamber，再停守护进程，避免 RPC 还在等待时被强杀。
        drop(session);
        match wb_hadron::sys::stop_gluon_daemon(&field) {
            Ok(true) => log::info!("已停止会话守护进程: {}", field.display()),
            Ok(false) => {}
            Err(err) => log::warn!("停止会话守护进程失败 {}: {err}", field.display()),
        }
        self.active_session = match self.active_session {
            // 关掉的是前台：优先落到原位置的后一个，没有就退到最后一个。
            Some(active) if active == index => {
                if self.open_sessions.is_empty() {
                    None
                } else {
                    Some(active.min(self.open_sessions.len() - 1))
                }
            }
            Some(active) if active > index => Some(active - 1),
            other => other,
        };
        cx.notify();
    }

    /// 收集本应用当前涉及的 field：每个工作区的默认 field + 已打开会话的 field。
    ///
    /// 退出时按这些 field 停守护进程；去重避免同一个默认 field 被停两次。
    fn gluon_field_paths(&self) -> Vec<std::path::PathBuf> {
        let mut fields: Vec<std::path::PathBuf> = Vec::new();
        for entry in &self.workspaces {
            let field = entry.field_path();
            if !fields.contains(&field) {
                fields.push(field);
            }
        }
        for session in &self.open_sessions {
            if !fields.contains(&session.field_path) {
                fields.push(session.field_path.clone());
            }
        }
        fields
    }

    /// 停止本应用使用的所有 gluon 守护进程，避免退出后进程残留。
    ///
    /// 用 field 而不是子进程句柄来判断：应用可能复用了一个已在运行的守护进程
    /// （此时本进程没有 Child 句柄），但退出时同样应该把它收掉。
    fn stop_gluon_daemons(&mut self) {
        for field in self.gluon_field_paths() {
            match wb_hadron::sys::stop_gluon_daemon(&field) {
                Ok(true) => log::info!("已停止守护进程: {}", field.display()),
                Ok(false) => {}
                Err(err) => log::warn!("停止守护进程失败 {}: {err}", field.display()),
            }
        }
        // 句柄清空，Drop 兜底时不会重复停止。
        self.open_sessions.iter_mut().for_each(|session| session._gluon = None);
        self._gluon = None;
    }

    /// 在当前工作区新开一个并行会话：建独立目录 + 独立 field，然后入池并前置。
    fn new_session_in_active_workspace(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(entry) = self.workspaces.get(self.active_workspace) else {
            return;
        };
        let sessions_dir = entry.sessions_dir();
        // 用时间戳做目录名；同一秒内重复点击时补序号，保证唯一。
        let stamp = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
        let mut id = stamp.clone();
        let mut suffix = 1;
        while sessions_dir.join(&id).exists() {
            id = format!("{stamp}_{suffix}");
            suffix += 1;
        }
        self.open_session(self.active_workspace, &id, true, window, cx);
        self.refresh_workspace_sessions();
        cx.notify();
    }

    /// 重新读取当前工作区的归档会话，刷新左栏「工作区」列表。
    fn refresh_workspace_sessions(&mut self) {
        if let Some(entry) = self.workspaces.get_mut(self.active_workspace) {
            entry.reload_sessions();
        }
    }

    /// 打开会话重命名弹窗；`session_id == "active"` 表示当前活动会话。
    fn open_session_rename(
        &mut self,
        index: usize,
        session_id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(entry) = self.workspaces.get(index) else {
            return;
        };
        let current = if session_id == "active" {
            entry.active_label.clone()
        } else {
            entry
                .sessions
                .iter()
                .find(|session| session.id == session_id)
                .map(|session| session.label.clone())
                .unwrap_or_default()
        };
        let target = crate::rename_dialog::RenameTarget {
            workspace: index,
            session_id,
        };
        let host = cx.weak_entity();
        let dialog =
            cx.new(|cx| crate::rename_dialog::RenameDialog::new(host, target, current, window, cx));
        dialog.update(cx, |dialog, cx| dialog.focus(window, cx));
        self.rename = Some(dialog);
        cx.notify();
    }

    /// 关闭重命名弹窗（取消或保存后）。
    pub(crate) fn close_session_rename(&mut self, cx: &mut Context<Self>) {
        self.rename = None;
        cx.notify();
    }

    /// 把新名字写进对应会话的 field，然后刷新左栏并关闭弹窗。
    pub(crate) fn apply_session_rename(
        &mut self,
        target: &crate::rename_dialog::RenameTarget,
        name: String,
        cx: &mut Context<Self>,
    ) {
        if let Some(entry) = self.workspaces.get(target.workspace) {
            let field = if target.session_id == "active" {
                entry.field_path()
            } else {
                entry
                    .sessions_dir()
                    .join(&target.session_id)
                    .join("field.jsonl")
            };
            if let Err(err) = wb_hadron::session::rename_session(&field, &name) {
                log::warn!("重命名会话失败: {err}");
            }
        }
        if let Some(entry) = self.workspaces.get_mut(target.workspace) {
            entry.reload_sessions();
        }
        // 若这个会话正开着，标签栏也跟着改名。
        for session in self.open_sessions.iter_mut() {
            if session.workspace == target.workspace && session.session_id == target.session_id {
                session.label = name.clone();
            }
        }
        self.rename = None;
        cx.notify();
    }

    /// 新增一个工作区并切换过去；目录已在列表里时直接切换。
    ///
    /// 用户可能选到 `<repo>/.wb`、`<repo>/.wb/sessions` 甚至某个会话目录，
    /// 这里统一上溯到仓库根；选中的是会话目录时顺便把该会话恢复出来。
    fn add_workspace(
        &mut self,
        picked: std::path::PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let PickedWorkspace { root, session_id } = resolve_picked_workspace(picked);
        let index = match self
            .workspaces
            .iter()
            .position(|entry| wb_store::paths_equal(&entry.root, &root))
        {
            Some(index) => index,
            None => {
                self.workspaces.push(WorkspaceEntry::new(root));
                self.workspaces.len() - 1
            }
        };
        self.activate_workspace(index, session_id, window, cx);
    }

    /// 切换活动工作区：换掉 field 根目录并重建嵌入式聊天区。
    ///
    /// 只重建壳 chamber（左栏/浮层/设置仍由它渲染），重建后重新注入设置页签
    /// 与导航回调；`resume` 有值时在新工作区里打开指定会话。
    fn activate_workspace(
        &mut self,
        index: usize,
        resume: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(entry) = self.workspaces.get(index).cloned() else {
            return;
        };
        if index != self.active_workspace {
            // 后续 `file://` 链接都相对新工作区解析。
            wb_hadron::app::set_embedded_workspace(&entry.root);
            let chamber_init = wb_hadron::app::prepare_embedded(&entry.root);
            let chamber = cx.new(|cx| wb_hadron::app::Chamber::embedded(chamber_init, window, cx));
            configure_chamber(&chamber, &self.settings, cx);
            // 旧 chamber 随赋值被替换；守护进程按新工作区重新确保一次。
            self._gluon = wb_hadron::app::ensure_daemon_for_repo(&entry.root);
            self.chamber = chamber;
            self.active_workspace = index;
            // 切工作区时关掉旧工作区的会话池，避免多个仓库的守护进程同时常驻。
            self.open_sessions.clear();
            self.active_session = None;
            // 新工作区先补默认会话名，再刷新左栏。
            if let Some(entry) = self.workspaces.get_mut(index) {
                entry.ensure_active_name();
            }
            self.refresh_workspace_sessions();
            save_workspace_state(&self.workspaces, index);
            // 默认把该工作区的当前会话打开在前台。
            self.open_session(index, "active", false, window, cx);
        }

        if let Some(session_id) = resume {
            self.open_session(index, &session_id, true, window, cx);
        } else {
            self.set_nav(AppNav::Agent, cx);
        }
    }

    fn set_nav(&mut self, nav: AppNav, cx: &mut Context<Self>) {
        self.state.with_mut(|s| {
            if nav == AppNav::Settings && s.nav != AppNav::Settings {
                s.nav_before_settings = s.nav;
            }
            s.nav = nav;
            if nav != AppNav::Projects {
                s.active_project_id = None;
            }
            s.active_tag_id = None;
        });
        self.state.remember_session();
        cx.notify();
    }

    fn open_notification_task(
        &mut self,
        task_id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let found = self.state.with_mut(|s| {
            let Some(task) = s.repo.get_task(task_id).cloned() else {
                s.notifications_open = false;
                return false;
            };
            s.selected_task_id = Some(task.id.clone());
            if task.project_id == INBOX_PROJECT_ID {
                s.nav = AppNav::Inbox;
                s.active_project_id = None;
            } else {
                s.nav = AppNav::Projects;
                s.active_project_id = Some(task.project_id);
            }
            s.notifications_open = false;
            true
        });
        if found {
            self.state.remember_session();
            let id = task_id.to_string();
            self.tasks.update(cx, |tasks, cx| {
                tasks.open_task_dialog(Some(id), window, cx);
            });
        }
        cx.notify();
    }

    pub(crate) fn toggle_collapsed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.collapsed = !self.collapsed;
        self.state
            .with_mut(|s| s.prefs.sidebar_collapsed = self.collapsed);
        self.state.persist_prefs();
        let width = if self.collapsed {
            48.0
        } else {
            self.state
                .with(|s| clamp_sidebar_width(s.prefs.sidebar_width))
        };
        self.sidebar_panels.update(cx, |state, cx| {
            state.resize_panel(0, px(width), window, cx);
        });
        cx.notify();
    }

    /// Show or hide the Agent right rail. Hidden means the panel is gone, not a thin strip.
    pub(crate) fn set_right_collapsed(
        &mut self,
        collapsed: bool,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.right_collapsed == collapsed {
            return;
        }
        self.right_collapsed = collapsed;
        self.state
            .with_mut(|s| s.prefs.right_sidebar_collapsed = collapsed);
        self.state.persist_prefs();
        cx.notify();
    }

    fn open_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.state.with_mut(|s| s.palette_open = true);
        self.palette.update(cx, |p, cx| {
            p.refresh_catalog(cx);
            p.focus_query(window, cx);
        });
        cx.notify();
    }
}

impl Drop for WorkbenchApp {
    /// 兜底清理：无论从哪条路径退出（窗口关闭、托盘退出、`cx.quit`），
    /// 都尽量把本应用拉起的守护进程一并停止。
    fn drop(&mut self) {
        self.stop_gluon_daemons();
    }
}

impl Render for WorkbenchApp {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // 目录选择器选完新工作区后，把激活动作延后到本帧之后执行。
        if let Some(root) = self.pending_workspace_root.take() {
            cx.defer_in(window, move |this, window, cx| {
                this.add_workspace(root, window, cx);
            });
        }
        let nav = self.state.with(|s| s.nav);
        // 设置以浮层形式打开：主区继续显示打开设置前所在的页面。
        let content_nav = if nav == AppNav::Settings {
            self.state.with(|s| s.nav_before_settings)
        } else {
            nav
        };
        let width = self
            .state
            .with(|s| clamp_sidebar_width(s.prefs.sidebar_width));
        let right_width = self
            .state
            .with(|s| clamp_right_sidebar_width(s.prefs.right_sidebar_width));
        let today = self.state.today();
        let revision = self.state.with(|s| s.repo.data_revision());
        let cache_hit = self
            .nav_cache
            .as_ref()
            .is_some_and(|cache| cache.revision == revision && cache.today == today);
        if !cache_hit {
            let (today_count, inbox_count, projects) = self.state.with(|s| {
                let mut today_count = 0usize;
                let mut inbox_count = 0usize;
                for task in s.repo.tasks() {
                    if task.parent_id.is_some() {
                        continue;
                    }
                    if is_today_member(task, &today) {
                        today_count += 1;
                    }
                    if !task.is_done && task.project_id == INBOX_PROJECT_ID {
                        inbox_count += 1;
                    }
                }
                let projects = s
                    .repo
                    .list_projects()
                    .into_iter()
                    .filter(|project| project.id != INBOX_PROJECT_ID && !project.is_archived)
                    .map(|project| (project.id, project.title))
                    .collect();
                (today_count, inbox_count, projects)
            });
            self.nav_cache = Some(NavCache {
                revision,
                today: today.clone(),
                today_count,
                inbox_count,
                projects,
            });
        }
        let cache = self.nav_cache.as_ref().expect("nav cache");
        let today_count = cache.today_count;
        let inbox_count = cache.inbox_count;
        let active_project = self.state.with(|s| s.active_project_id.clone());
        let project_items: Vec<(String, String, bool)> = cache
            .projects
            .iter()
            .map(|(id, title)| {
                let active =
                    nav == AppNav::Projects && active_project.as_deref() == Some(id.as_str());
                (id.clone(), title.clone(), active)
            })
            .collect();
        let palette_open = self.state.with(|s| s.palette_open);
        let notifications_open = self.state.with(|s| s.notifications_open);
        let entity = cx.weak_entity();
        let collapsed = self.collapsed;
        let ptt_held = self.ptt_held;
        let account_name = self.state.with(|s| {
            let name = s.prefs.general.display_name.trim();
            if name.is_empty() {
                "本地用户".to_string()
            } else {
                name.to_string()
            }
        });

        // Hadron 左栏导航。
        // 任务组：任务清单 + 项目列表（项目是任务的子项），末尾是「新建项目」。
        let mut task_items = vec![
            WorkbenchNavItem::new("today", "今日", WorkbenchNavIcon::Today)
                .badge(today_count)
                .active(nav == AppNav::Today),
            WorkbenchNavItem::new("inbox", "收件箱", WorkbenchNavIcon::Inbox)
                .badge(inbox_count)
                .active(nav == AppNav::Inbox),
            WorkbenchNavItem::new("done", "已完成", WorkbenchNavIcon::Done)
                .active(nav == AppNav::Done),
            WorkbenchNavItem::new("planner", "计划", WorkbenchNavIcon::Planner)
                .active(nav == AppNav::Planner),
            WorkbenchNavItem::new("tags", "标签", WorkbenchNavIcon::Tags)
                .active(nav == AppNav::Tags),
        ];
        for (id, title, active) in project_items {
            task_items.push(
                WorkbenchNavItem::new(format!("project:{id}"), title, WorkbenchNavIcon::Project)
                    .active(active),
            );
        }
        task_items.push(WorkbenchNavItem::new(
            "new-project",
            "新建项目",
            WorkbenchNavIcon::NewProject,
        ));

        // 工作区列表：每个工作区一行；活动工作区下面挂「已打开的会话」和折叠的归档，
        // 末尾一行「添加工作区」。已打开的会话直接可切，实现并行多聊天。
        let mut workspace_items = Vec::new();
        for (index, entry) in self.workspaces.iter().enumerate() {
            let is_active = index == self.active_workspace;
            workspace_items.push(
                WorkbenchNavItem::new(
                    format!("workspace:{index}"),
                    entry.label.clone(),
                    WorkbenchNavIcon::Project,
                )
                // 切到 Agent 页时，高亮留给当前会话那一行。
                .active(is_active && nav != AppNav::Agent),
            );
            if !is_active {
                continue;
            }
            let open_ids: Vec<String> = self
                .open_sessions
                .iter()
                .filter(|session| session.belongs_to(index))
                .map(|session| session.session_id.clone())
                .collect();
            // 工作区默认会话（active）没有被打开时，仍给一个入口。
            if !open_ids.iter().any(|id| id == "active") {
                workspace_items.push(
                    WorkbenchNavItem::new(
                        format!("session:{index}:active"),
                        entry.active_label.clone(),
                        WorkbenchNavIcon::Session,
                    )
                    .indent(true)
                    .action(
                        format!("rename-session:{index}:active"),
                        WorkbenchNavIcon::More,
                    ),
                );
            }
            // 已打开的会话：按会话池顺序排列，前台那个高亮。
            for (open_index, session) in self.open_sessions.iter().enumerate() {
                if !session.belongs_to(index) {
                    continue;
                }
                workspace_items.push(
                    WorkbenchNavItem::new(
                        format!("session:{index}:{}", session.session_id),
                        session.label.clone(),
                        WorkbenchNavIcon::Session,
                    )
                    .indent(true)
                    .active(nav == AppNav::Agent && Some(open_index) == self.active_session)
                    .action(
                        format!("rename-session:{index}:{}", session.session_id),
                        WorkbenchNavIcon::More,
                    ),
                );
            }
            // 归档会话（排除已经打开的，避免一行出现两次），默认折叠。
            let archived: Vec<&WorkspaceSession> = entry
                .sessions
                .iter()
                .filter(|session| !open_ids.contains(&session.id))
                .collect();
            if !archived.is_empty() {
                let chevron = if entry.archived_open {
                    WorkbenchNavIcon::ChevronDown
                } else {
                    WorkbenchNavIcon::ChevronRight
                };
                workspace_items.push(
                    WorkbenchNavItem::new(
                        format!("archive-toggle:{index}"),
                        format!("已归档 ({})", archived.len()),
                        chevron,
                    )
                    .indent(true),
                );
                if entry.archived_open {
                    for session in archived {
                        workspace_items.push(
                            WorkbenchNavItem::new(
                                format!("session:{index}:{}", session.id),
                                session.label.clone(),
                                WorkbenchNavIcon::Session,
                            )
                            .indent(true)
                            .action(
                                format!("rename-session:{index}:{}", session.id),
                                WorkbenchNavIcon::More,
                            ),
                        );
                    }
                }
            }
        }
        workspace_items.push(WorkbenchNavItem::new(
            "add-workspace",
            "添加工作区",
            WorkbenchNavIcon::NewProject,
        ));

        let nav_groups = vec![
            WorkbenchNavGroup::new("任务").items(task_items),
            // 无标题分组：知识库 / 定时任务与任务平级（Agent 入口已并入工作区会话）。
            WorkbenchNavGroup::new("").items(vec![
                WorkbenchNavItem::new("knowledge", "知识库", WorkbenchNavIcon::Knowledge)
                    .active(nav == AppNav::Knowledge),
                WorkbenchNavItem::new("timed", "定时任务", WorkbenchNavIcon::Timed)
                    .active(nav == AppNav::Timed),
            ]),
            // 工作区：一个目录即一个 hadron workspace，可切换并新增会话。
            WorkbenchNavGroup::new("工作区")
                .items(workspace_items)
                .action("new-session", WorkbenchNavIcon::NewProject),
        ];
        let nav_footer =
            WorkbenchNavItem::new("settings", account_name.clone(), WorkbenchNavIcon::Settings)
                .active(nav == AppNav::Settings);
        self.chamber.update(cx, |chamber, _| {
            chamber.set_workbench_nav(nav_groups, Some(nav_footer))
        });

        let main_view = match content_nav {
            AppNav::Timed => self.timed.clone().into_any_element(),
            AppNav::Knowledge => self.knowledge.clone().into_any_element(),
            // Agent 主区：有工作区时是 hadron 聊天区（上方一条会话标签栏，可并行切换）；
            // 没有工作区时显示「新建工作区」空态。
            AppNav::Agent => {
                if self.workspaces.is_empty() {
                    empty_workspace_state(cx).into_any_element()
                } else if self.open_sessions.is_empty() {
                    no_session_state(cx).into_any_element()
                } else {
                    let tabs: Vec<(String, bool)> = self
                        .open_sessions
                        .iter()
                        .enumerate()
                        .map(|(index, session)| {
                            (session.label.clone(), Some(index) == self.active_session)
                        })
                        .collect();
                    let tab_bar = crate::session_tabs::session_tab_bar(&tabs, cx);
                    let chat = self.active_session_chamber().map(|chamber| {
                        chamber.update(cx, |chamber, cx| {
                            chamber.render_chat_surface(window, cx).into_any_element()
                        })
                    });
                    v_flex()
                        .size_full()
                        .child(tab_bar)
                        .child(
                            div()
                                .flex_1()
                                .min_h_0()
                                .when_some(chat, |col, chat| col.child(chat)),
                        )
                        .into_any_element()
                }
            }
            _ => self.tasks.clone().into_any_element(),
        };

        let notes = if notifications_open {
            self.state.with(|s| s.repo.list_notifications())
        } else {
            Vec::new()
        };

        div()
            .id("workbench-root")
            .relative()
            .size_full()
            .overflow_hidden()
            .bg(style::canvas(cx))
            .child(style::field_wash(cx))
            .track_focus(&cx.focus_handle())
            .on_action(cx.listener(|this, _: &OpenPalette, window, cx| {
                this.open_palette(window, cx);
            }))
            .on_action(cx.listener(|this, _: &Escape, _, cx| {
                // 设置浮层打开时，Esc 优先关闭它并回到原页面。
                if this.state.with(|s| s.nav) == AppNav::Settings {
                    let back = this.state.with(|s| s.nav_before_settings);
                    this.set_nav(back, cx);
                    return;
                }
                this.state.with_mut(|s| {
                    s.palette_open = false;
                    s.notifications_open = false;
                });
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &FocusCapture, window, cx| {
                let nav = this.state.with(|s| s.nav);
                match nav {
                    AppNav::Agent => {
                        this.focus_chat(window, cx);
                    }
                    AppNav::Today
                    | AppNav::Inbox
                    | AppNav::Done
                    | AppNav::Planner
                    | AppNav::Projects
                    | AppNav::Tags => {
                        this.tasks
                            .update(cx, |tasks, cx| tasks.focus_capture(window, cx));
                    }
                    _ => {
                        this.set_nav(AppNav::Today, cx);
                        this.tasks
                            .update(cx, |tasks, cx| tasks.focus_capture(window, cx));
                    }
                }
            }))
            .on_action(cx.listener(|this, _: &EditLastMessage, window, cx| {
                // hadron 输入框没有「编辑上一条」语义，退化为聚焦输入框。
                this.focus_chat(window, cx);
            }))
            .child(
                v_flex()
                    .size_full()
                    .child(workbench_title_bar(
                        self.state.clone(),
                        cx.weak_entity(),
                        collapsed,
                        cx,
                    ))
                    .child(
                        div()
                            .h(px(1.))
                            .w_full()
                            .flex()
                            .justify_center()
                            .bg(style::hairline(cx))
                            .child(
                                div()
                                    .h_full()
                                    .w(px(220.))
                                    .bg(cx.theme().primary.opacity(0.35)),
                            ),
                    )
                    .child(div().flex_1().min_h_0().p_1().child({
                        // 左栏由 hadron 渲染：同一套深色皮肤，内容由上面的 nav_groups 驱动。
                        let sidebar = self.chamber.update(cx, |chamber, cx| {
                            chamber
                                .render_sidebar_surface(collapsed, cx)
                                .into_any_element()
                        });
                        // 设置浮层打开时，主区按“打开前的页面”决定页头。
                        let hide_page_bar =
                            matches!(content_nav, AppNav::Knowledge | AppNav::Agent);
                        let page_header = if hide_page_bar {
                            None
                        } else if content_nav == AppNav::Timed {
                            Some(self.timed.update(cx, |pane, cx| pane.chrome_header(cx)))
                        } else {
                            Some(self.tasks.update(cx, |pane, cx| pane.chrome_header(cx)))
                        };
                        let recording_bg = cx.theme().danger;
                        let recording_fg = cx.theme().danger_foreground;
                        let panel_radius = style::panel_radius(cx);
                        let panel_border = style::hairline(cx);
                        let main = v_flex()
                            .relative()
                            .flex_1()
                            .h_full()
                            .min_w_0()
                            .overflow_hidden()
                            .rounded(panel_radius)
                            .border_1()
                            .border_color(panel_border)
                            .bg(style::panel(cx))
                            .when_some(page_header, |col, header| {
                                col.child(
                                    h_flex()
                                        .min_h(px(44.))
                                        .px_3()
                                        .py_1()
                                        .items_center()
                                        .gap_2()
                                        .border_b_1()
                                        .border_color(style::hairline(cx))
                                        .child(header)
                                        .when(ptt_held, |row| {
                                            row.child(recording_chip(recording_bg, recording_fg))
                                        }),
                                )
                            })
                            // 无页头的页面（Agent / 知识库）把录音提示浮在右上角：
                            // 绝对定位不参与布局，录音时不会把聊天区挤下去。
                            .when(hide_page_bar && ptt_held, |col| {
                                col.child(
                                    div()
                                        .absolute()
                                        .top(px(6.))
                                        .right(px(10.))
                                        .child(recording_chip(recording_bg, recording_fg)),
                                )
                            })
                            .child(div().flex_1().min_h_0().child(main_view));

                        let entity = entity.clone();
                        let right_collapsed = self.right_collapsed;
                        let show_right = content_nav == AppNav::Agent;
                        // 右侧栏内容：展开态是 hadron 右栏（终端/文件/Git/Mission/可视化），
                        // 收起态只留一条窄条与展开按钮，保证随时能收放。
                        let rail_panel = if !show_right {
                            div().into_any_element()
                        } else if right_collapsed {
                            v_flex()
                                .size_full()
                                .items_center()
                                .pt_2()
                                .child(
                                    Button::new("rail-expand")
                                        .ghost()
                                        .xsmall()
                                        .icon(IconName::PanelRightOpen)
                                        .tooltip("展开检查器")
                                        .on_click(cx.listener(|this, _, window, cx| {
                                            this.set_right_collapsed(false, window, cx)
                                        })),
                                )
                                .into_any_element()
                        } else {
                            // 右栏（终端/文件/Git/任务）跟着前台会话走，各会话互不干扰。
                            let rail_chamber = self
                                .active_session_chamber()
                                .unwrap_or_else(|| self.chamber.clone());
                            let rail = rail_chamber.update(cx, |chamber, cx| {
                                chamber.render_rail_surface(cx).into_any_element()
                            });
                            v_flex()
                                .size_full()
                                .child(
                                    h_flex()
                                        .h(px(34.))
                                        .px_2()
                                        .items_center()
                                        .gap_2()
                                        .border_b_1()
                                        .border_color(panel_border)
                                        .child(div().text_xs().child("检查器"))
                                        .child(div().flex_1())
                                        .child(
                                            Button::new("rail-collapse")
                                                .ghost()
                                                .xsmall()
                                                .icon(IconName::PanelRightClose)
                                                .tooltip("收起检查器")
                                                .on_click(cx.listener(|this, _, window, cx| {
                                                    this.set_right_collapsed(true, window, cx)
                                                })),
                                        ),
                                )
                                .child(div().flex_1().min_h_0().child(rail))
                                .into_any_element()
                        };
                        let left_width = if collapsed { 48.0 } else { width };
                        let left_range = if collapsed {
                            px(48.)..px(48.)
                        } else {
                            px(SIDEBAR_WIDTH_MIN)..px(SIDEBAR_WIDTH_MAX)
                        };
                        div()
                            .size_full()
                            .child(
                                h_resizable("wb-layout")
                                    .with_state(&self.sidebar_panels)
                                    .on_resize(move |state, _, app| {
                                        let sizes = state.read(app).sizes().clone();
                                        let left = sizes.first().copied().map(f32::from);
                                        let right = sizes.get(2).copied().map(f32::from);
                                        if let Some(e) = entity.upgrade() {
                                            e.update(app, |this, cx| {
                                                if let Some(w) = left {
                                                    if !this.collapsed {
                                                        this.set_sidebar_width(w, cx);
                                                    }
                                                }
                                                if let Some(w) = right {
                                                    if !this.right_collapsed {
                                                        this.set_right_sidebar_width(w, cx);
                                                    }
                                                }
                                            });
                                        }
                                    })
                                    .child(
                                        resizable_panel()
                                            .size(px(left_width))
                                            .size_range(left_range)
                                            .fixed()
                                            .child(
                                                div().size_full().p_0p5().child(
                                                    div()
                                                        .size_full()
                                                        .overflow_hidden()
                                                        .rounded(panel_radius)
                                                        .border_1()
                                                        .border_color(panel_border)
                                                        .child(sidebar),
                                                ),
                                            ),
                                    )
                                    .child(
                                        resizable_panel()
                                            .child(div().size_full().p_0p5().child(main)),
                                    )
                                    .when(show_right, move |row| {
                                        let right_size =
                                            if right_collapsed { 36.0 } else { right_width };
                                        let right_range = if right_collapsed {
                                            px(36.)..px(36.)
                                        } else {
                                            px(RIGHT_SIDEBAR_WIDTH_MIN)..px(RIGHT_SIDEBAR_WIDTH_MAX)
                                        };
                                        row.child(
                                            resizable_panel()
                                                .size(px(right_size))
                                                .size_range(right_range)
                                                .fixed()
                                                .child(
                                                    div().size_full().p_0p5().child(
                                                        div()
                                                            .size_full()
                                                            .overflow_hidden()
                                                            .rounded(panel_radius)
                                                            .border_1()
                                                            .border_color(panel_border)
                                                            .child(rail_panel),
                                                    ),
                                                ),
                                        )
                                    }),
                            )
                            .into_any_element()
                    })),
            )
            // Hadron 的悬浮层（应用菜单/关于/更新日志/进程管理/REPL/项目切换/toast）
            // 叠在整窗最上层，聊天区的快捷键才能真正唤起它们。
            .child(self.chamber.update(cx, |chamber, cx| {
                chamber.render_overlays(window, cx).into_any_element()
            }))
            // 设置浮层：参考 hadron，居中卡片 + 遮罩 + 右上角关闭按钮，不占满主区。
            .when(nav == AppNav::Settings, |root| {
                // 当前工作台页仍由完整设置面板渲染；外观/技能则合并进 hadron 内置页。
                let page = self.settings.clone().into_any_element();
                let injected = self.settings.update(cx, |pane, cx| {
                    let mut injected = pane.merged_injected_settings(cx);
                    injected.page = Some(page);
                    injected
                });
                let settings_card = self.chamber.update(cx, |chamber, cx| {
                    chamber
                        .render_settings_surface(window, cx, injected)
                        .into_any_element()
                });
                root.child(
                    div()
                        .id("settings-modal-backdrop")
                        .absolute()
                        .inset_0()
                        .flex()
                        .items_center()
                        .justify_center()
                        .bg(rgba(0x00000080))
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|this, _, _, cx| {
                                let back = this.state.with(|s| s.nav_before_settings);
                                this.set_nav(back, cx);
                            }),
                        )
                        .child(
                            div()
                                .relative()
                                .occlude()
                                .w(relative(0.92))
                                .h(relative(0.9))
                                .max_w(px(1120.))
                                .max_h(px(760.))
                                .rounded(style::panel_radius(cx))
                                .overflow_hidden()
                                .child(settings_card)
                                .child(
                                    div().absolute().top(px(8.)).right(px(8.)).child(
                                        Button::new("settings-modal-close")
                                            .ghost()
                                            .xsmall()
                                            .icon(IconName::WindowClose)
                                            .tooltip("关闭设置")
                                            .on_click(cx.listener(|this, _, _, cx| {
                                                let back =
                                                    this.state.with(|s| s.nav_before_settings);
                                                this.set_nav(back, cx);
                                            })),
                                    ),
                                ),
                        ),
                )
            })
            .when(palette_open, |root| {
                root.child(self.palette.clone().into_any_element())
            })
            // 会话重命名弹窗：盖在所有浮层之上，保存/取消都回传宿主。
            .when_some(self.rename.clone(), |root, dialog| {
                root.child(dialog.into_any_element())
            })
            .when(notifications_open, |root| {
                let entity = entity.clone();
                let visible: Vec<_> = notes
                    .into_iter()
                    .filter(|n| {
                        matches!(
                            n.status,
                            NotificationStatus::Pending | NotificationStatus::Delivered
                        )
                    })
                    .take(20)
                    .collect();
                root.child(
                    div()
                        .absolute()
                        .top(TITLE_BAR_HEIGHT)
                        .right(px(12.))
                        .w(px(320.))
                        .max_h(px(420.))
                        .rounded(style::panel_radius(cx))
                        .border_1()
                        .border_color(style::hairline(cx))
                        .bg(style::card(cx))
                        .text_color(cx.theme().popover_foreground)
                        .p_3()
                        .with_animation(
                            "notifications-in",
                            Animation::new(Duration::from_millis(160)),
                            |panel, delta| panel.opacity(delta).mt(px(8.) * (1. - delta)),
                        )
                        .child(
                            h_flex()
                                .items_center()
                                .mb_2()
                                .gap_2()
                                .child(div().font_bold().child("通知"))
                                .child(div().flex_1())
                                .when(!visible.is_empty(), |row| {
                                    let entity = entity.clone();
                                    row.child(
                                        Button::new("dismiss-all")
                                            .xsmall()
                                            .ghost()
                                            .label("全部关闭")
                                            .on_click(move |_, _, app| {
                                                if let Some(e) = entity.upgrade() {
                                                    e.update(app, |this, cx| {
                                                        this.state.with_mut(|s| {
                                                            s.repo.dismiss_all_notifications();
                                                        });
                                                        this.state.persist_if_dirty();
                                                        cx.notify();
                                                    });
                                                }
                                            }),
                                    )
                                }),
                        )
                        .child(if visible.is_empty() {
                            div()
                                .text_sm()
                                .text_color(cx.theme().muted_foreground)
                                .child("暂无通知")
                                .into_any_element()
                        } else {
                            v_flex()
                                .gap_2()
                                .children(visible.into_iter().map(|n| {
                                    let id = n.id.clone();
                                    let ref_id = n.ref_id.clone();
                                    let entity = entity.clone();
                                    v_flex()
                                        .gap_1()
                                        .p_2()
                                        .rounded(style::card_radius(cx))
                                        .border_1()
                                        .border_color(style::hairline(cx))
                                        .bg(style::raised(cx))
                                        .child(div().font_bold().child(n.title))
                                        .child(
                                            div()
                                                .text_xs()
                                                .text_color(cx.theme().muted_foreground)
                                                .child(n.body),
                                        )
                                        .child(
                                            h_flex()
                                                .gap_1()
                                                .when(ref_id.is_some(), |row| {
                                                    let entity = entity.clone();
                                                    let task_id = ref_id.clone().unwrap();
                                                    row.child(
                                                        Button::new(SharedString::from(format!(
                                                            "open-{id}"
                                                        )))
                                                        .xsmall()
                                                        .ghost()
                                                        .label("打开")
                                                        .on_click(move |_, window, app| {
                                                            if let Some(e) = entity.upgrade() {
                                                                e.update(app, |this, cx| {
                                                                    this.open_notification_task(
                                                                        &task_id, window, cx,
                                                                    );
                                                                });
                                                            }
                                                        }),
                                                    )
                                                })
                                                .child({
                                                    let entity = entity.clone();
                                                    let id = id.clone();
                                                    Button::new(SharedString::from(format!(
                                                        "snooze-{id}"
                                                    )))
                                                    .xsmall()
                                                    .ghost()
                                                    .label("稍后")
                                                    .on_click(move |_, _, app| {
                                                        if let Some(e) = entity.upgrade() {
                                                            e.update(app, |this, cx| {
                                                                let until =
                                                                    now_ms() + 15 * 60 * 1000;
                                                                this.state.with_mut(|s| {
                                                                    s.repo.snooze_notification(
                                                                        &id, until,
                                                                    );
                                                                });
                                                                this.state.persist_if_dirty();
                                                                cx.notify();
                                                            });
                                                        }
                                                    })
                                                })
                                                .child({
                                                    let entity = entity.clone();
                                                    Button::new(SharedString::from(format!(
                                                        "dismiss-{id}"
                                                    )))
                                                    .xsmall()
                                                    .ghost()
                                                    .label("关闭")
                                                    .on_click(move |_, _, app| {
                                                        if let Some(e) = entity.upgrade() {
                                                            e.update(app, |this, cx| {
                                                                this.state.with_mut(|s| {
                                                                    s.repo
                                                                        .dismiss_notification(&id);
                                                                });
                                                                this.state.persist_if_dirty();
                                                                cx.notify();
                                                            });
                                                        }
                                                    })
                                                }),
                                        )
                                }))
                                .into_any_element()
                        }),
                )
            })
    }
}
