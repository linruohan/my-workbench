use crate::command_palette::CommandPalette;
use crate::state::{AppNav, AppState};
use crate::views::{AgentPane, KnowledgePane, SettingsPane, TasksPane, TimedPane};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::sidebar::{
    Sidebar, SidebarCollapsible, SidebarFooter, SidebarGroup, SidebarHeader, SidebarMenu,
    SidebarMenuItem, SidebarToggleButton,
};
use gpui_kit::component::*;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use std::time::Duration;
use wb_domain::{
    INBOX_PROJECT_ID, NotificationStatus, clamp_sidebar_width, is_today_member, now_ms,
};

actions!(workbench, [OpenPalette, FocusCapture, Escape]);

pub struct WorkbenchApp {
    state: AppState,
    collapsed: bool,
    tasks: Entity<TasksPane>,
    timed: Entity<TimedPane>,
    knowledge: Entity<KnowledgePane>,
    agent: Entity<AgentPane>,
    settings: Entity<SettingsPane>,
    palette: Entity<CommandPalette>,
}

impl WorkbenchApp {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let state = AppState::load();
        let collapsed = state.with(|s| s.prefs.sidebar_collapsed);
        if state.theme_is_dark() {
            Theme::change(ThemeMode::Dark, None, cx);
        }

        let tasks = cx.new(|cx| TasksPane::new(state.clone(), window, cx));
        let timed = cx.new(|cx| TimedPane::new(state.clone(), window, cx));
        let knowledge = cx.new(|cx| KnowledgePane::new(state.clone(), window, cx));
        let agent = cx.new(|cx| AgentPane::new(state.clone(), window, cx));
        let settings = cx.new(|cx| SettingsPane::new(state.clone(), window, cx));
        let palette = cx.new(|cx| CommandPalette::new(state.clone(), window, cx));

        cx.bind_keys([
            KeyBinding::new("ctrl-p", OpenPalette, None),
            KeyBinding::new("ctrl-k", OpenPalette, None),
            KeyBinding::new("ctrl-n", FocusCapture, None),
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

        Self {
            state,
            collapsed,
            tasks,
            timed,
            knowledge,
            agent,
            settings,
            palette,
        }
    }

    fn on_tick(&mut self, cx: &mut Context<Self>) {
        let now = now_ms();
        self.timed.update(cx, |timed, cx| timed.tick_due(cx));
        self.state.with_mut(|s| {
            s.repo.wake_snoozed_notifications(now);
            for task in s.repo.list_tasks() {
                if let Some(at) = task.remind_at {
                    if at <= now && !task.is_done {
                        s.repo.push_notification(
                            wb_domain::NotificationKind::TaskRemind,
                            &task.title,
                            "计划提醒",
                            Some(&task.id),
                        );
                        let mut t = task.clone();
                        t.remind_at = None;
                        s.repo.upsert_task(t);
                    }
                }
                if let Some(at) = task.deadline_remind_at {
                    if at <= now && !task.is_done {
                        s.repo.push_notification(
                            wb_domain::NotificationKind::DeadlineRemind,
                            &task.title,
                            "截止提醒",
                            Some(&task.id),
                        );
                        let mut t = task.clone();
                        t.deadline_remind_at = None;
                        s.repo.upsert_task(t);
                    }
                }
            }
            s.last_tick = now;
        });
        self.state.persist_if_dirty();
        cx.notify();
    }

    fn set_nav(&mut self, nav: AppNav, cx: &mut Context<Self>) {
        self.state.with_mut(|s| {
            s.nav = nav;
            if nav != AppNav::Projects {
                s.active_project_id = None;
            }
        });
        cx.notify();
    }

    fn open_notification_task(&mut self, task_id: &str, cx: &mut Context<Self>) {
        self.state.with_mut(|s| {
            if let Some(task) = s.repo.get_task(task_id).cloned() {
                s.selected_task_id = Some(task.id.clone());
                if task.project_id == INBOX_PROJECT_ID {
                    s.nav = AppNav::Inbox;
                    s.active_project_id = None;
                } else {
                    s.nav = AppNav::Projects;
                    s.active_project_id = Some(task.project_id);
                }
            }
            s.notifications_open = false;
        });
        cx.notify();
    }

    fn toggle_collapsed(&mut self, cx: &mut Context<Self>) {
        self.collapsed = !self.collapsed;
        self.state
            .with_mut(|s| s.prefs.sidebar_collapsed = self.collapsed);
        self.state.persist_prefs();
        cx.notify();
    }

    fn open_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.state.with_mut(|s| s.palette_open = true);
        self.palette.update(cx, |p, cx| p.focus_query(window, cx));
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
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let nav = self.state.with(|s| s.nav);
        let width = self
            .state
            .with(|s| clamp_sidebar_width(s.prefs.sidebar_width));
        let today = self.state.today();
        let (today_count, inbox_count, pending_notifications) = self.state.with(|s| {
            let tasks = s.repo.list_tasks();
            let today_count = tasks
                .iter()
                .filter(|t| t.parent_id.is_none() && is_today_member(t, &today))
                .count();
            let inbox_count = tasks
                .iter()
                .filter(|t| !t.is_done && t.project_id == INBOX_PROJECT_ID && t.parent_id.is_none())
                .count();
            let pending = s
                .repo
                .list_notifications()
                .into_iter()
                .filter(|n| {
                    matches!(
                        n.status,
                        NotificationStatus::Pending | NotificationStatus::Delivered
                    )
                })
                .count();
            (today_count, inbox_count, pending)
        });
        let project_items: Vec<(String, String, bool)> = self.state.with(|s| {
            s.repo
                .list_projects()
                .into_iter()
                .filter(|p| p.id != INBOX_PROJECT_ID && !p.is_archived)
                .map(|p| {
                    let active = nav == AppNav::Projects
                        && s.active_project_id.as_deref() == Some(p.id.as_str());
                    (p.id, p.title, active)
                })
                .collect()
        });
        let palette_open = self.state.with(|s| s.palette_open);
        let notifications_open = self.state.with(|s| s.notifications_open);
        let save_ok = self.state.with(|s| s.save_status.ok);
        let entity = cx.weak_entity();
        let collapsed = self.collapsed;

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
                                });
                                cx.notify();
                            });
                        }
                    })
            }));

        let more_menu = SidebarMenu::new().children([
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
            Self::menu_item(
                "设置",
                IconName::Settings,
                AppNav::Settings,
                nav == AppNav::Settings,
                entity.clone(),
            ),
        ]);

        let main_view = match nav {
            AppNav::Timed => self.timed.clone().into_any_element(),
            AppNav::Knowledge => self.knowledge.clone().into_any_element(),
            AppNav::Agent => self.agent.clone().into_any_element(),
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
            .size_full()
            .bg(cx.theme().background)
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
                if !matches!(
                    nav,
                    AppNav::Today
                        | AppNav::Inbox
                        | AppNav::Done
                        | AppNav::Planner
                        | AppNav::Projects
                ) {
                    this.set_nav(AppNav::Today, cx);
                }
                this.tasks
                    .update(cx, |tasks, cx| tasks.focus_capture(window, cx));
            }))
            .child(
                h_flex()
                    .size_full()
                    .child(
                        Sidebar::new("wb-sidebar")
                            .collapsible(SidebarCollapsible::Icon)
                            .collapsed(collapsed)
                            .w(px(width))
                            .header(
                                SidebarHeader::new().child(
                                    h_flex()
                                        .gap_2()
                                        .items_center()
                                        .child(Icon::new(IconName::LayoutDashboard))
                                        .when(!collapsed, |row| {
                                            row.child(div().font_bold().child("个人工作台"))
                                        }),
                                ),
                            )
                            .child(SidebarGroup::new("任务").child(task_menu))
                            .child(SidebarGroup::new("项目").child(project_menu))
                            .child(SidebarGroup::new("更多").child(more_menu))
                            .footer(
                                SidebarFooter::new().child(
                                    Button::new("search")
                                        .ghost()
                                        .icon(IconName::Search)
                                        .label(if collapsed { "" } else { "搜索 Ctrl+P" })
                                        .on_click(cx.listener(|this, _, window, cx| {
                                            this.open_palette(window, cx);
                                        })),
                                ),
                            ),
                    )
                    .child(
                        v_flex()
                            .flex_1()
                            .h_full()
                            .min_w_0()
                            .child(
                                h_flex()
                                    .h(px(44.))
                                    .px_3()
                                    .items_center()
                                    .gap_2()
                                    .border_b_1()
                                    .border_color(cx.theme().border)
                                    .child(
                                        SidebarToggleButton::new().collapsed(collapsed).on_click(
                                            cx.listener(|this, _, _, cx| {
                                                this.toggle_collapsed(cx);
                                            }),
                                        ),
                                    )
                                    .child(div().font_bold().child(nav.label()))
                                    .child(div().flex_1())
                                    .child(
                                        Button::new("bell")
                                            .ghost()
                                            .icon(IconName::Bell)
                                            .label(if pending_notifications > 0 {
                                                pending_notifications.to_string()
                                            } else {
                                                String::new()
                                            })
                                            .on_click(cx.listener(|this, _, _, cx| {
                                                this.state.with_mut(|s| {
                                                    s.notifications_open = !s.notifications_open;
                                                });
                                                cx.notify();
                                            })),
                                    )
                                    .child(
                                        div()
                                            .text_xs()
                                            .text_color(if save_ok {
                                                cx.theme().muted_foreground
                                            } else {
                                                cx.theme().danger
                                            })
                                            .child(if save_ok {
                                                "已保存"
                                            } else {
                                                "保存失败"
                                            }),
                                    ),
                            )
                            .child(div().flex_1().min_h_0().child(main_view)),
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
                        .top(px(48.))
                        .right(px(12.))
                        .w(px(320.))
                        .max_h(px(420.))
                        .rounded(cx.theme().radius)
                        .border_1()
                        .border_color(cx.theme().border)
                        .bg(cx.theme().background)
                        .p_3()
                        .shadow_md()
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
                                        .rounded(cx.theme().radius)
                                        .bg(cx.theme().secondary)
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
                                                        .on_click(move |_, _, app| {
                                                            if let Some(e) = entity.upgrade() {
                                                                e.update(app, |this, cx| {
                                                                    this.open_notification_task(
                                                                        &task_id, cx,
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
