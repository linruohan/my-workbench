use crate::state::{AppNav, AppState};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::{Selectable as _, *};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use wb_domain::{
    INBOX_PROJECT_ID, SchedulePatch, Task, add_local_days, apply_schedule_patch, clear_plan_fields,
    compute_task_stats, filter_tasks, format_local_day, group_tasks_by_plan_day, is_today_member,
    parse_quick_capture, select_planner_tasks, select_today_tasks,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum TasksMode {
    #[default]
    List,
    Board,
    Stats,
}

pub struct TasksPane {
    state: AppState,
    capture: Entity<InputState>,
    notes: Entity<InputState>,
    notes_task_id: Option<String>,
    mode: TasksMode,
    _subs: Vec<Subscription>,
}

impl TasksPane {
    pub fn new(state: AppState, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let capture = cx.new(|cx| {
            InputState::new(window, cx).placeholder("快速捕获：今天 写报告 #项目 提前10分钟")
        });
        let notes = cx.new(|cx| InputState::new(window, cx).placeholder("选中任务后编辑备注…"));
        let mut this = Self {
            state,
            capture: capture.clone(),
            notes: notes.clone(),
            notes_task_id: None,
            mode: TasksMode::List,
            _subs: Vec::new(),
        };
        this._subs.push(
            cx.subscribe_in(&capture, window, |this, input, event, window, cx| {
                if let InputEvent::PressEnter { .. } = event {
                    let text = input.read(cx).value().to_string();
                    if !text.trim().is_empty() {
                        this.submit_capture(&text, cx);
                        input.update(cx, |input, cx| {
                            input.set_value("", window, cx);
                        });
                    }
                }
            }),
        );
        this._subs.push(
            cx.subscribe_in(&notes, window, |this, input, event, _window, cx| {
                if matches!(event, InputEvent::Blur) {
                    let text = input.read(cx).value().to_string();
                    this.save_notes(&text, cx);
                }
            }),
        );
        this
    }

    fn submit_capture(&mut self, text: &str, cx: &mut Context<Self>) {
        let now = wb_domain::now_ms();
        let parsed = parse_quick_capture(text, now, None);
        self.state.with_mut(|s| {
            let mut project_id = parsed
                .project_id
                .clone()
                .unwrap_or_else(|| INBOX_PROJECT_ID.to_string());
            if let Some(ref title) = parsed.project_title {
                if let Some(existing) = s
                    .repo
                    .list_projects()
                    .into_iter()
                    .find(|p| p.title == *title)
                {
                    project_id = existing.id;
                } else {
                    project_id = s.repo.create_project(title).id;
                }
            }
            let mut task = s.repo.create_task(&parsed.title, Some(&project_id));
            apply_schedule_patch(
                &mut task,
                &SchedulePatch {
                    due_day: Some(parsed.due_day),
                    due_with_time: Some(parsed.due_with_time),
                    deadline_day: Some(parsed.deadline_day),
                    deadline_with_time: Some(parsed.deadline_with_time),
                    remind_at: Some(parsed.remind_at),
                    deadline_remind_at: None,
                },
            );
            s.repo.upsert_task(task);
        });
        self.state.persist_if_dirty();
        cx.notify();
    }

    fn toggle_done(&mut self, id: &str, cx: &mut Context<Self>) {
        self.state.with_mut(|s| {
            if let Some(t) = s.repo.get_task(id).cloned() {
                if t.is_done {
                    s.repo.incomplete_task(id);
                } else {
                    s.repo.complete_task(id);
                }
            }
        });
        self.state.persist_if_dirty();
        cx.notify();
    }

    fn create_project(&mut self, cx: &mut Context<Self>) {
        self.state.with_mut(|s| {
            let p = s.repo.create_project("新项目");
            s.nav = AppNav::Projects;
            s.active_project_id = Some(p.id);
        });
        self.state.persist_if_dirty();
        cx.notify();
    }

    fn schedule_day(&mut self, id: &str, day: Option<String>, cx: &mut Context<Self>) {
        self.state.with_mut(|s| {
            if let Some(mut task) = s.repo.get_task(id).cloned() {
                if day.is_none() {
                    clear_plan_fields(&mut task);
                } else {
                    apply_schedule_patch(
                        &mut task,
                        &SchedulePatch {
                            due_day: Some(day),
                            due_with_time: Some(None),
                            deadline_day: None,
                            deadline_with_time: None,
                            remind_at: None,
                            deadline_remind_at: None,
                        },
                    );
                }
                s.repo.upsert_task(task);
            }
        });
        self.state.persist_if_dirty();
        cx.notify();
    }

    fn archive_active_project(&mut self, cx: &mut Context<Self>) {
        let pid = self.state.with(|s| s.active_project_id.clone());
        let Some(pid) = pid else {
            return;
        };
        self.state.with_mut(|s| {
            s.repo.set_project_archived(&pid, true);
            s.active_project_id = None;
            s.nav = AppNav::Inbox;
        });
        self.state.persist_if_dirty();
        cx.notify();
    }

    fn delete_task(&mut self, id: &str, cx: &mut Context<Self>) {
        self.state.with_mut(|s| {
            s.repo.delete_task(id);
            if s.selected_task_id.as_deref() == Some(id) {
                s.selected_task_id = None;
            }
        });
        self.state.persist_if_dirty();
        cx.notify();
    }

    fn select_task(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.state
            .with_mut(|s| s.selected_task_id = Some(id.to_string()));
        self.load_notes_for(id, window, cx);
        cx.notify();
    }

    fn load_notes_for(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let notes = self.state.with(|s| {
            s.repo
                .get_task(id)
                .map(|t| t.notes.clone())
                .unwrap_or_default()
        });
        self.notes_task_id = Some(id.to_string());
        self.notes.update(cx, |input, cx| {
            input.set_value(notes, window, cx);
        });
    }

    fn save_notes(&mut self, text: &str, _cx: &mut Context<Self>) {
        let Some(id) = self.state.with(|s| s.selected_task_id.clone()) else {
            return;
        };
        self.state.with_mut(|s| {
            if let Some(mut task) = s.repo.get_task(&id).cloned() {
                task.notes = text.to_string();
                s.repo.upsert_task(task);
            }
        });
        self.state.persist_if_dirty();
    }

    fn filtered_tasks(&self) -> (String, Vec<Task>) {
        let nav = self.state.with(|s| s.nav);
        let today = self.state.today();
        self.state.with(|s| {
            let all = s.repo.list_tasks();
            let list: Vec<_> = match nav {
                AppNav::Today => select_today_tasks(&all, &today, s.repo.today_order())
                    .into_iter()
                    .cloned()
                    .collect(),
                AppNav::Inbox => filter_tasks(&all, Some(INBOX_PROJECT_ID), Some(false), None)
                    .into_iter()
                    .cloned()
                    .collect(),
                AppNav::Done => filter_tasks(&all, None, Some(true), None)
                    .into_iter()
                    .cloned()
                    .collect(),
                AppNav::Planner => select_planner_tasks(&all).into_iter().cloned().collect(),
                AppNav::Projects => {
                    let pid = s
                        .active_project_id
                        .clone()
                        .unwrap_or_else(|| INBOX_PROJECT_ID.to_string());
                    filter_tasks(&all, Some(&pid), Some(false), None)
                        .into_iter()
                        .cloned()
                        .collect()
                }
                _ => all
                    .into_iter()
                    .filter(|t| !t.is_done && is_today_member(t, &today))
                    .collect(),
            };
            (nav.label().to_string(), list)
        })
    }

    fn render_task_row(
        task: Task,
        entity: WeakEntity<Self>,
        radius: Pixels,
        muted: Hsla,
        accent: Hsla,
        today: &str,
        selected: bool,
    ) -> impl IntoElement {
        let id = task.id.clone();
        let done = task.is_done;
        let title = task.title.clone();
        let plan = task
            .due_day
            .clone()
            .or_else(|| task.due_with_time.map(format_local_day))
            .unwrap_or_default();
        let tomorrow = add_local_days(today, 1).unwrap_or_else(|| today.to_string());
        let today_day = today.to_string();
        h_flex()
            .id(SharedString::from(format!("task-{}", id)))
            .w_full()
            .items_center()
            .gap_2()
            .p_2()
            .rounded(radius)
            .when(selected, |row| row.bg(accent.opacity(0.55)))
            .hover(move |s| s.bg(accent.opacity(0.4)))
            .child(
                Button::new(SharedString::from(format!("done-{id}")))
                    .ghost()
                    .label(if done { "☑" } else { "☐" })
                    .on_click({
                        let id = id.clone();
                        let entity = entity.clone();
                        move |_, _, app| {
                            if let Some(entity) = entity.upgrade() {
                                entity.update(app, |this, cx| {
                                    this.toggle_done(&id, cx);
                                });
                            }
                        }
                    }),
            )
            .child(
                div()
                    .id(SharedString::from(format!("sel-{id}")))
                    .flex_1()
                    .overflow_hidden()
                    .cursor_pointer()
                    .when(done, |d| d.text_color(muted))
                    .child(title)
                    .on_click({
                        let id = id.clone();
                        let entity = entity.clone();
                        move |_, window, app| {
                            if let Some(e) = entity.upgrade() {
                                e.update(app, |this, cx| this.select_task(&id, window, cx));
                            }
                        }
                    }),
            )
            .when(!plan.is_empty(), |row| {
                row.child(div().text_xs().text_color(muted).child(plan))
            })
            .when(!done, |row| {
                row.child(
                    Button::new(SharedString::from(format!("today-{id}")))
                        .xsmall()
                        .ghost()
                        .label("今")
                        .on_click({
                            let id = id.clone();
                            let entity = entity.clone();
                            let day = today_day.clone();
                            move |_, _, app| {
                                if let Some(e) = entity.upgrade() {
                                    e.update(app, |this, cx| {
                                        this.schedule_day(&id, Some(day.clone()), cx);
                                    });
                                }
                            }
                        }),
                )
                .child(
                    Button::new(SharedString::from(format!("tmr-{id}")))
                        .xsmall()
                        .ghost()
                        .label("明")
                        .on_click({
                            let id = id.clone();
                            let entity = entity.clone();
                            let day = tomorrow.clone();
                            move |_, _, app| {
                                if let Some(e) = entity.upgrade() {
                                    e.update(app, |this, cx| {
                                        this.schedule_day(&id, Some(day.clone()), cx);
                                    });
                                }
                            }
                        }),
                )
                .child(
                    Button::new(SharedString::from(format!("clr-{id}")))
                        .xsmall()
                        .ghost()
                        .label("清")
                        .on_click({
                            let id = id.clone();
                            let entity = entity.clone();
                            move |_, _, app| {
                                if let Some(e) = entity.upgrade() {
                                    e.update(app, |this, cx| {
                                        this.schedule_day(&id, None, cx);
                                    });
                                }
                            }
                        }),
                )
                .child(
                    Button::new(SharedString::from(format!("del-{id}")))
                        .xsmall()
                        .ghost()
                        .label("删")
                        .on_click({
                            let id = id.clone();
                            let entity = entity.clone();
                            move |_, _, app| {
                                if let Some(e) = entity.upgrade() {
                                    e.update(app, |this, cx| this.delete_task(&id, cx));
                                }
                            }
                        }),
                )
            })
    }

    fn mode_button(
        &self,
        id: &'static str,
        label: &'static str,
        mode: TasksMode,
        cx: &mut Context<Self>,
    ) -> Button {
        Button::new(id)
            .small()
            .label(label)
            .selected(self.mode == mode)
            .on_click(cx.listener(move |this, _, _, cx| {
                this.mode = mode;
                cx.notify();
            }))
    }
}

impl Render for TasksPane {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let (title, tasks) = self.filtered_tasks();
        let entity = cx.weak_entity();
        let today = self.state.today();
        let all_for_stats = self.state.with(|s| s.repo.list_tasks());
        let stats = compute_task_stats(&all_for_stats, &today);
        let projects = self.state.with(|s| s.repo.list_projects());
        let radius = cx.theme().radius;
        let border = cx.theme().border;
        let muted = cx.theme().muted_foreground;
        let accent = cx.theme().accent;
        let selected_id = self.state.with(|s| s.selected_task_id.clone());
        if selected_id != self.notes_task_id {
            match &selected_id {
                Some(id) => self.load_notes_for(id, window, cx),
                None => {
                    self.notes_task_id = None;
                    self.notes.update(cx, |input, cx| {
                        input.set_value("", window, cx);
                    });
                }
            }
        }

        let show_archive = self.state.with(|s| {
            s.nav == AppNav::Projects
                && s.active_project_id
                    .as_deref()
                    .is_some_and(|id| id != INBOX_PROJECT_ID)
        });

        let body = match self.mode {
            TasksMode::List => {
                let is_planner = self.state.with(|s| s.nav == AppNav::Planner);
                if is_planner {
                    let groups = group_tasks_by_plan_day(&tasks);
                    let sections: Vec<_> = groups
                        .into_iter()
                        .map(|(day, day_tasks)| {
                            let label = if day == today {
                                format!("今天 · {day}")
                            } else if day.as_str() < today.as_str() {
                                format!("逾期 · {day}")
                            } else {
                                day.clone()
                            };
                            let rows: Vec<_> = day_tasks
                                .into_iter()
                                .map(|task| {
                                    let selected = selected_id.as_deref() == Some(task.id.as_str());
                                    Self::render_task_row(
                                        task,
                                        entity.clone(),
                                        radius,
                                        muted,
                                        accent,
                                        &today,
                                        selected,
                                    )
                                    .into_any_element()
                                })
                                .collect();
                            v_flex()
                                .gap_1()
                                .child(
                                    div()
                                        .font_bold()
                                        .text_sm()
                                        .text_color(muted)
                                        .mt_2()
                                        .child(format!("{label} · {}", rows.len())),
                                )
                                .children(rows)
                                .into_any_element()
                        })
                        .collect();
                    v_flex()
                        .gap_2()
                        .flex_1()
                        .overflow_y_scrollbar()
                        .children(sections)
                        .into_any_element()
                } else if tasks.is_empty() {
                    div()
                        .flex_1()
                        .text_sm()
                        .text_color(muted)
                        .child("暂无任务。在上方输入框快速捕获一条吧。")
                        .into_any_element()
                } else {
                    let rows: Vec<_> = tasks
                        .into_iter()
                        .map(|task| {
                            let selected = selected_id.as_deref() == Some(task.id.as_str());
                            Self::render_task_row(
                                task,
                                entity.clone(),
                                radius,
                                muted,
                                accent,
                                &today,
                                selected,
                            )
                            .into_any_element()
                        })
                        .collect();
                    v_flex()
                        .gap_1()
                        .flex_1()
                        .overflow_y_scrollbar()
                        .children(rows)
                        .into_any_element()
                }
            }
            TasksMode::Board => {
                let todo: Vec<_> = tasks.iter().filter(|t| !t.is_done).cloned().collect();
                let done: Vec<_> = tasks.iter().filter(|t| t.is_done).cloned().collect();
                let active: Vec<_> = todo
                    .iter()
                    .filter(|t| t.due_day.is_some() || t.due_with_time.is_some())
                    .cloned()
                    .collect();
                let backlog: Vec<_> = todo
                    .iter()
                    .filter(|t| t.due_day.is_none() && t.due_with_time.is_none())
                    .cloned()
                    .collect();
                let columns: Vec<_> = [("进行中", active), ("待办箱", backlog), ("已完成", done)]
                    .into_iter()
                    .map(|(label, col)| {
                        let rows: Vec<_> = col
                            .into_iter()
                            .map(|task| {
                                let selected = selected_id.as_deref() == Some(task.id.as_str());
                                Self::render_task_row(
                                    task,
                                    entity.clone(),
                                    radius,
                                    muted,
                                    accent,
                                    &today,
                                    selected,
                                )
                                .into_any_element()
                            })
                            .collect();
                        v_flex()
                            .flex_1()
                            .gap_2()
                            .p_2()
                            .rounded(radius)
                            .border_1()
                            .border_color(border)
                            .overflow_y_scrollbar()
                            .child(div().font_bold().child(format!("{label} · {}", rows.len())))
                            .children(rows)
                            .into_any_element()
                    })
                    .collect();
                h_flex()
                    .gap_3()
                    .flex_1()
                    .children(columns)
                    .into_any_element()
            }
            TasksMode::Stats => {
                let cards: Vec<_> = [
                    ("未完成", stats.open.to_string()),
                    ("已逾期", stats.overdue.to_string()),
                    ("今日到期", stats.due_today.to_string()),
                    ("未排期", stats.unscheduled.to_string()),
                    ("今日完成", stats.done_today.to_string()),
                    ("完成率", format!("{:.0}%", stats.completion_rate * 100.0)),
                ]
                .into_iter()
                .map(|(k, v)| {
                    h_flex()
                        .justify_between()
                        .p_3()
                        .rounded(radius)
                        .border_1()
                        .border_color(border)
                        .child(div().child(k))
                        .child(div().font_bold().child(v))
                        .into_any_element()
                })
                .collect();
                let project_rows: Vec<_> = stats
                    .by_project
                    .into_iter()
                    .map(|(pid, n)| {
                        let title = projects
                            .iter()
                            .find(|p| p.id == pid)
                            .map(|p| p.title.clone())
                            .unwrap_or(pid);
                        h_flex()
                            .justify_between()
                            .text_sm()
                            .child(title)
                            .child(n.to_string())
                            .into_any_element()
                    })
                    .collect();
                v_flex()
                    .gap_3()
                    .flex_1()
                    .children(cards)
                    .child(div().font_bold().mt_2().child("项目分布"))
                    .children(project_rows)
                    .into_any_element()
            }
        };

        v_flex()
            .size_full()
            .gap_3()
            .p_4()
            .child(
                h_flex()
                    .items_center()
                    .gap_2()
                    .child(div().text_xl().font_bold().child(title))
                    .child(div().flex_1())
                    .child(self.mode_button("mode-list", "列表", TasksMode::List, cx))
                    .child(self.mode_button("mode-board", "看板", TasksMode::Board, cx))
                    .child(self.mode_button("mode-stats", "统计", TasksMode::Stats, cx))
                    .child(
                        Button::new("new-project")
                            .small()
                            .label("新项目")
                            .on_click(cx.listener(|this, _, _, cx| this.create_project(cx))),
                    )
                    .when(show_archive, |row| {
                        row.child(
                            Button::new("archive-project")
                                .small()
                                .danger()
                                .label("归档项目")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.archive_active_project(cx);
                                })),
                        )
                    }),
            )
            .child(Input::new(&self.capture).cleanable(true))
            .child(body)
            .when(selected_id.is_some(), |col| {
                let label = selected_id
                    .as_ref()
                    .and_then(|id| {
                        all_for_stats
                            .iter()
                            .find(|t| &t.id == id)
                            .map(|t| t.title.clone())
                    })
                    .unwrap_or_else(|| "任务备注".into());
                col.child(
                    v_flex()
                        .gap_1()
                        .p_2()
                        .rounded(radius)
                        .border_1()
                        .border_color(border)
                        .child(
                            div()
                                .text_xs()
                                .font_bold()
                                .text_color(muted)
                                .child(format!("备注 · {label}")),
                        )
                        .child(Input::new(&self.notes)),
                )
            })
    }
}
