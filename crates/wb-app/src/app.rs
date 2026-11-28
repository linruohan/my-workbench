use crate::command_palette::CommandPalette;
use crate::state::{AppNav, AppState};
use crate::style;
use crate::themes;
use crate::title_bar::workbench_title_bar;
use crate::tray::{self, TrayAction};
use crate::views::{KnowledgePane, SettingsPane, TasksPane, TimedPane};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::resizable::{ResizableState, h_resizable, resizable_panel};
use gpui_kit::component::sidebar::{
    Sidebar, SidebarCollapsible, SidebarGroup, SidebarMenu, SidebarMenuItem,
};
use gpui_kit::component::*;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{AnimationExt as _, *};
use std::time::Duration;
use wb_domain::{
    INBOX_PROJECT_ID, NotificationStatus, RIGHT_SIDEBAR_WIDTH_MAX, RIGHT_SIDEBAR_WIDTH_MIN,
    SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN, clamp_right_sidebar_width, clamp_sidebar_width,
    format_local_day, is_today_member, now_ms,
};

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

        // Hadron 聊天区 + 右侧栏：初始化字体/快捷键并构建嵌入式 Chamber。
        // 工作目录取自启动目录（即当前工作台仓库根），field 落在 `.hadron/field.jsonl`。
        let repo_root = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
        wb_hadron::app::init_embedded(cx, &repo_root);
        wb_hadron::app::bind_embedded_keys(cx);
        let chamber_init = wb_hadron::app::prepare_embedded(&repo_root);
        let chamber = cx.new(|cx| wb_hadron::app::Chamber::embedded(chamber_init, window, cx));
        // 确保守护进程在跑，否则聊天只写 field、收不到回复。
        let gluon = wb_hadron::app::ensure_daemon_for_repo(&repo_root);

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
            let _ = app.update(cx, |this, cx| this.flush_persistent_state(cx));
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

        Self {
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
            _tray: tray_icon,
        }
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

    fn menu_item(
        label: &'static str,
        icon: IconName,
        nav: AppNav,
        active: bool,
        entity: WeakEntity<Self>,
    ) -> SidebarMenuItem {
        SidebarMenuItem::new(label)
            .icon(icon)
            .active(active)
            .on_click(move |_, _, app| {
                if let Some(e) = entity.upgrade() {
                    e.update(app, |this, cx| this.set_nav(nav, cx));
                }
            })
    }
}

impl Render for WorkbenchApp {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let nav = self.state.with(|s| s.nav);
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

        let today_label = if today_count > 0 {
            format!("今日 ({today_count})")
        } else {
            "今日".into()
        };
        let inbox_label = if inbox_count > 0 {
            format!("收件箱 ({inbox_count})")
        } else {
            "收件箱".into()
        };
        let task_menu = SidebarMenu::new().children([
            {
                let entity = entity.clone();
                SidebarMenuItem::new(today_label)
                    .icon(IconName::Calendar)
                    .active(nav == AppNav::Today)
                    .on_click(move |_, _, app| {
                        if let Some(e) = entity.upgrade() {
                            e.update(app, |this, cx| this.set_nav(AppNav::Today, cx));
                        }
                    })
            },
            {
                let entity = entity.clone();
                SidebarMenuItem::new(inbox_label)
                    .icon(IconName::Inbox)
                    .active(nav == AppNav::Inbox)
                    .on_click(move |_, _, app| {
                        if let Some(e) = entity.upgrade() {
                            e.update(app, |this, cx| this.set_nav(AppNav::Inbox, cx));
                        }
                    })
            },
            Self::menu_item(
                "已完成",
                IconName::Check,
                AppNav::Done,
                nav == AppNav::Done,
                entity.clone(),
            ),
            Self::menu_item(
                "计划",
                IconName::Calendar,
                AppNav::Planner,
                nav == AppNav::Planner,
                entity.clone(),
            ),
            Self::menu_item(
                "定时任务",
                IconName::SquareTerminal,
                AppNav::Timed,
                nav == AppNav::Timed,
                entity.clone(),
            ),
            Self::menu_item(
                "标签",
                IconName::Star,
                AppNav::Tags,
                nav == AppNav::Tags,
                entity.clone(),
            ),
        ]);

        let project_menu =
            SidebarMenu::new().children(project_items.into_iter().map(|(id, title, active)| {
                let entity = entity.clone();
                SidebarMenuItem::new(title)
                    .icon(IconName::Folder)
                    .active(active)
                    .on_click(move |_, _, app| {
                        if let Some(e) = entity.upgrade() {
                            e.update(app, |this, cx| {
                                this.state.with_mut(|s| {
                                    s.nav = AppNav::Projects;
                                    s.active_project_id = Some(id.clone());
                                    s.active_tag_id = None;
                                });
                                cx.notify();
                            });
                        }
                    })
            }));

        let tools_menu = SidebarMenu::new().children([
            Self::menu_item(
                "知识库",
                IconName::BookOpen,
                AppNav::Knowledge,
                nav == AppNav::Knowledge,
                entity.clone(),
            ),
            Self::menu_item(
                "Agent",
                IconName::Bot,
                AppNav::Agent,
                nav == AppNav::Agent,
                entity.clone(),
            ),
        ]);

        let main_view = match nav {
            AppNav::Timed => self.timed.clone().into_any_element(),
            AppNav::Knowledge => self.knowledge.clone().into_any_element(),
            // Agent 主区：hadron 聊天区（消息流 + 搜索 + 输入框）。
            AppNav::Agent => self.chamber.update(cx, |chamber, cx| {
                chamber.render_chat_surface(window, cx).into_any_element()
            }),
            AppNav::Settings => self.settings.clone().into_any_element(),
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
                        this.chamber
                            .update(cx, |chamber, cx| chamber.focus_chat_input(window, cx));
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
                this.chamber
                    .update(cx, |chamber, cx| chamber.focus_chat_input(window, cx));
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
                    .child(
                        div()
                            .flex_1()
                            .min_h_0()
                            .p_1()
                            .child(if nav == AppNav::Settings {
                                div()
                                    .size_full()
                                    .overflow_hidden()
                                    .rounded(style::panel_radius(cx))
                                    .border_1()
                                    .border_color(style::hairline(cx))
                                    .bg(style::panel(cx))
                                    .child(self.settings.clone())
                                    .into_any_element()
                            } else {
                                let sidebar = Sidebar::new("wb-sidebar")
                                    .w_full()
                                    .collapsible(SidebarCollapsible::Icon)
                                    .collapsed(collapsed)
                                    .child(SidebarGroup::new("任务").child(task_menu))
                                    .child(
                                        SidebarGroup::new("项目")
                                            .suffix({
                                                let entity = entity.clone();
                                                move |_, _| {
                                                    let entity = entity.clone();
                                                    Button::new("sidebar-add-project")
                                                        .ghost()
                                                        .xsmall()
                                                        .icon(IconName::Plus)
                                                        .tooltip("新建项目")
                                                        .on_click(move |_, window, app| {
                                                            if let Some(e) = entity.upgrade() {
                                                                e.update(app, |this, cx| {
                                                            this.tasks.update(cx, |tasks, cx| {
                                                                tasks.open_project_dialog(
                                                                    window, cx,
                                                                );
                                                            });
                                                        });
                                                            }
                                                        })
                                                }
                                            })
                                            .child(project_menu),
                                    )
                                    .child(SidebarGroup::new("工具").child(tools_menu))
                                    .footer({
                                        let account_footer = div()
                                            .id("account-nav")
                                            .w_full()
                                            .h_7()
                                            .flex()
                                            .items_center()
                                            .gap_2()
                                            .px_2()
                                            .rounded(cx.theme().radius)
                                            .text_sm()
                                            .cursor_pointer()
                                            .hover(|this| {
                                                this.bg(cx.theme().tokens.sidebar_accent)
                                                    .text_color(
                                                        cx.theme().sidebar_accent_foreground,
                                                    )
                                            })
                                            .when(nav == AppNav::Settings, |this| {
                                                this.bg(cx.theme().tokens.sidebar_accent)
                                                    .text_color(
                                                        cx.theme().sidebar_accent_foreground,
                                                    )
                                            })
                                            .on_click(cx.listener(|this, _, _, cx| {
                                                this.set_nav(AppNav::Settings, cx);
                                            }));
                                        if collapsed {
                                            account_footer
                                                .justify_center()
                                                .child(Icon::new(IconName::CircleUser).size_4())
                                        } else {
                                            account_footer
                                                .justify_between()
                                                .child(
                                                    h_flex()
                                                        .flex_1()
                                                        .min_w_0()
                                                        .gap_2()
                                                        .items_center()
                                                        .child(
                                                            Icon::new(IconName::CircleUser)
                                                                .size_4(),
                                                        )
                                                        .child(
                                                            div()
                                                                .min_w_0()
                                                                .truncate()
                                                                .child(account_name.clone()),
                                                        ),
                                                )
                                                .child(Icon::new(IconName::Settings).size_4())
                                        }
                                    });
                                let hide_page_bar =
                                    matches!(nav, AppNav::Knowledge | AppNav::Agent);
                                let page_header = if hide_page_bar {
                                    None
                                } else if nav == AppNav::Timed {
                                    Some(self.timed.update(cx, |pane, cx| pane.chrome_header(cx)))
                                } else {
                                    Some(self.tasks.update(cx, |pane, cx| pane.chrome_header(cx)))
                                };
                                let recording_bg = cx.theme().danger;
                                let recording_fg = cx.theme().danger_foreground;
                                let panel_radius = style::panel_radius(cx);
                                let panel_border = style::hairline(cx);
                                let main =
                                    v_flex()
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
                                                        row.child(recording_chip(
                                                            recording_bg,
                                                            recording_fg,
                                                        ))
                                                    }),
                                            )
                                        })
                                        .when(hide_page_bar && ptt_held, |col| {
                                            col.child(
                                                h_flex().px_3().py_1().justify_end().child(
                                                    recording_chip(recording_bg, recording_fg),
                                                ),
                                            )
                                        })
                                        .child(div().flex_1().min_h_0().child(main_view));

                                let entity = entity.clone();
                                let right_collapsed = self.right_collapsed;
                                let show_right = nav == AppNav::Agent;
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
                                    let rail = self.chamber.update(cx, |chamber, cx| {
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
                                                        .on_click(cx.listener(
                                                            |this, _, window, cx| {
                                                                this.set_right_collapsed(
                                                                    true, window, cx,
                                                                )
                                                            },
                                                        )),
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
                                                        div().size_full().p_1().child(
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
                                                    .child(div().size_full().p_1().child(main)),
                                            )
                                            .when(show_right, move |row| {
                                                let right_size = if right_collapsed {
                                                    36.0
                                                } else {
                                                    right_width
                                                };
                                                let right_range = if right_collapsed {
                                                    px(36.)..px(36.)
                                                } else {
                                                    px(RIGHT_SIDEBAR_WIDTH_MIN)
                                                        ..px(RIGHT_SIDEBAR_WIDTH_MAX)
                                                };
                                                row.child(
                                                    resizable_panel()
                                                        .size(px(right_size))
                                                        .size_range(right_range)
                                                        .fixed()
                                                        .child(
                                                            div().size_full().p_1().child(
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
                            }),
                    ),
            )
            .when(palette_open, |root| {
                root.child(self.palette.clone().into_any_element())
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
