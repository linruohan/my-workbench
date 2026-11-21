use crate::state::{AppNav, AppState};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::{Selectable as _, *};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use wb_domain::{
    INBOX_PROJECT_ID, SchedulePatch, Task, TimedSchedulePreset, add_local_days,
    apply_schedule_patch, clear_plan_fields, compute_task_stats, create_task_draft, filter_tasks,
    format_local_day, group_tasks_by_plan_day, is_today_member, now_ms, parse_quick_capture,
    select_planner_tasks, select_today_tasks, set_task_repeat_preset, settle_timer_segment,
    task_repeat_label,
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
    tag_input: Entity<InputState>,
    project_title: Entity<InputState>,
    project_title_id: Option<String>,
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
        let tag_input = cx.new(|cx| InputState::new(window, cx).placeholder("标签名，回车添加"));
        let project_title =
            cx.new(|cx| InputState::new(window, cx).placeholder("项目名称，回车保存"));
        let mut this = Self {
            state,
            capture: capture.clone(),
            notes: notes.clone(),
            tag_input: tag_input.clone(),
            project_title: project_title.clone(),
            project_title_id: None,
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
        this._subs.push(cx.subscribe_in(
            &project_title,
            window,
            |this, input, event, _window, cx| {
                if let InputEvent::PressEnter { .. } = event {
                    let text = input.read(cx).value().to_string();
                    this.rename_active_project(&text, cx);
                }
            },
        ));
        this._subs.push(
            cx.subscribe_in(&tag_input, window, |this, input, event, window, cx| {
                if let InputEvent::PressEnter { .. } = event {
                    let text = input.read(cx).value().to_string();
                    if !text.trim().is_empty() {
                        this.add_tag_to_selected(text.trim(), cx);
                        input.update(cx, |input, cx| {
                            input.set_value("", window, cx);
                        });
                    }
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

    fn rename_active_project(&mut self, title: &str, cx: &mut Context<Self>) {
        let pid = self.state.with(|s| s.active_project_id.clone());
        let Some(pid) = pid else {
            return;
        };
        if title.trim().is_empty() {
            return;
        }
        self.state.with_mut(|s| {
            s.repo.rename_project(&pid, title);
        });
        self.state.persist_if_dirty();
        cx.notify();
    }

    fn sync_project_title(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (pid, title) = self.state.with(|s| {
            let pid = s.active_project_id.clone();
            let title = pid
                .as_ref()
                .and_then(|id| s.repo.list_projects().into_iter().find(|p| &p.id == id))
                .map(|p| p.title)
                .unwrap_or_default();
            (pid, title)
        });
        if pid == self.project_title_id {
            return;
        }
        self.project_title_id = pid;
        self.project_title.update(cx, |input, cx| {
            input.set_value(title, window, cx);
        });
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

    fn move_task_project(&mut self, id: &str, project_id: &str, cx: &mut Context<Self>) {
        self.state.with_mut(|s| {
            if let Some(mut task) = s.repo.get_task(id).cloned() {
                task.project_id = project_id.to_string();
                s.repo.upsert_task(task);
            }
        });
        self.state.persist_if_dirty();
        cx.notify();
    }

    fn toggle_timer(&mut self, id: &str, cx: &mut Context<Self>) {
        let today = self.state.today();
        let now = now_ms();
        self.state.with_mut(|s| {
            if let Some((tid, started)) = s.active_timer.take() {
                if let Some(mut task) = s.repo.get_task(&tid).cloned() {
                    settle_timer_segment(&mut task, &today, now - started, now);
                    s.repo.upsert_task(task);
                }
                if tid == id {
                    return;
                }
            }
            s.active_timer = Some((id.to_string(), now));
            s.selected_task_id = Some(id.to_string());
        });
        self.state.persist_if_dirty();
        cx.notify();
    }

    fn add_subtask(&mut self, parent_id: &str, cx: &mut Context<Self>) {
        self.state.with_mut(|s| {
            let parent = s.repo.get_task(parent_id).cloned();
            let Some(parent) = parent else {
                return;
            };
            let child =
                create_task_draft("子任务", Some(&parent.project_id), Some(parent_id), None);
            let id = child.id.clone();
            s.repo.upsert_task(child);
            s.selected_task_id = Some(id);
        });
        self.state.persist_if_dirty();
        cx.notify();
    }

    fn add_tag_to_selected(&mut self, title: &str, cx: &mut Context<Self>) {
        let Some(tid) = self.state.with(|s| s.selected_task_id.clone()) else {
            return;
        };
        self.state.with_mut(|s| {
            let tag = s.repo.create_tag(title);
            s.repo.add_tag_to_task(&tid, &tag.id);
        });
        self.state.persist_if_dirty();
        cx.notify();
    }

    fn remove_tag_from_selected(&mut self, tag_id: &str, cx: &mut Context<Self>) {
        let Some(tid) = self.state.with(|s| s.selected_task_id.clone()) else {
            return;
        };
        self.state
            .with_mut(|s| s.repo.remove_tag_from_task(&tid, tag_id));
        self.state.persist_if_dirty();
        cx.notify();
    }

    fn set_selected_repeat(&mut self, preset: Option<TimedSchedulePreset>, cx: &mut Context<Self>) {
        let Some(tid) = self.state.with(|s| s.selected_task_id.clone()) else {
            return;
        };
        self.state.with_mut(|s| {
            if let Some(mut task) = s.repo.get_task(&tid).cloned() {
                if set_task_repeat_preset(&mut task, preset).is_ok() {
                    s.repo.upsert_task(task);
                }
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

    fn filtered_tasks(&self) -> (String, Vec<(Task, usize)>) {
        let nav = self.state.with(|s| s.nav);
        let today = self.state.today();
        self.state.with(|s| {
            let all = s.repo.list_tasks();
            let roots: Vec<Task> = match nav {
                AppNav::Today => select_today_tasks(&all, &today, s.repo.today_order())
                    .into_iter()
                    .cloned()
                    .collect(),
                AppNav::Inbox => filter_tasks(&all, Some(INBOX_PROJECT_ID), Some(false), None)
                    .into_iter()
                    .filter(|t| t.parent_id.is_none())
                    .cloned()
                    .collect(),
                AppNav::Done => filter_tasks(&all, None, Some(true), None)
                    .into_iter()
                    .filter(|t| t.parent_id.is_none())
                    .cloned()
                    .collect(),
                AppNav::Planner => select_planner_tasks(&all)
                    .into_iter()
                    .filter(|t| t.parent_id.is_none())
                    .cloned()
                    .collect(),
                AppNav::Projects => {
                    let pid = s
                        .active_project_id
                        .clone()
                        .unwrap_or_else(|| INBOX_PROJECT_ID.to_string());
                    filter_tasks(&all, Some(&pid), Some(false), None)
                        .into_iter()
                        .filter(|t| t.parent_id.is_none())
                        .cloned()
                        .collect()
                }
                AppNav::Tags => {
                    if let Some(tid) = s.active_tag_id.as_deref() {
                        all.iter()
                            .filter(|t| {
                                t.parent_id.is_none()
                                    && !t.is_done
                                    && s.repo.task_has_tag(&t.id, tid)
                            })
                            .cloned()
                            .collect()
                    } else {
                        // 未选标签：展示所有带标签的未完成根任务
                        all.iter()
                            .filter(|t| {
                                t.parent_id.is_none()
                                    && !t.is_done
                                    && !s.repo.tags_for_task(&t.id).is_empty()
                            })
                            .cloned()
                            .collect()
                    }
                }
                _ => all
                    .iter()
                    .filter(|t| t.parent_id.is_none() && !t.is_done && is_today_member(t, &today))
                    .cloned()
                    .collect(),
            };
            let include_done_kids = nav == AppNav::Done;
            let mut list = Vec::new();
            for root in roots {
                let rid = root.id.clone();
                list.push((root, 0usize));
                let mut kids: Vec<_> = all
                    .iter()
                    .filter(|t| t.parent_id.as_deref() == Some(rid.as_str()))
                    .filter(|t| include_done_kids || !t.is_done)
                    .cloned()
                    .collect();
                kids.sort_by_key(|t| t.created_at);
                for k in kids {
                    list.push((k, 1));
                }
            }
            let title = if nav == AppNav::Projects {
                s.active_project_id
                    .as_ref()
                    .and_then(|id| s.repo.list_projects().into_iter().find(|p| &p.id == id))
                    .map(|p| p.title)
                    .unwrap_or_else(|| nav.label().to_string())
            } else if nav == AppNav::Tags {
                s.active_tag_id
                    .as_ref()
                    .and_then(|id| s.repo.list_tags().into_iter().find(|t| &t.id == id))
                    .map(|t| format!("#{}", t.title))
                    .unwrap_or_else(|| "全部标签".into())
            } else {
                nav.label().to_string()
            };
            (title, list)
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn render_task_row(
        task: Task,
        entity: WeakEntity<Self>,
        radius: Pixels,
        muted: Hsla,
        accent: Hsla,
        today: &str,
        selected: bool,
        indent: usize,
        timing: bool,
        tag_label: String,
    ) -> impl IntoElement {
        let id = task.id.clone();
        let done = task.is_done;
        let title = task.title.clone();
        let spent = task.time_spent;
        let plan = task
            .due_day
            .clone()
            .or_else(|| task.due_with_time.map(format_local_day))
            .unwrap_or_default();
        let has_notes = !task.notes.trim().is_empty();
        let is_root = task.parent_id.is_none();
        let tomorrow = add_local_days(today, 1).unwrap_or_else(|| today.to_string());
        let today_day = today.to_string();
        h_flex()
            .id(SharedString::from(format!("task-{}", id)))
            .w_full()
            .items_center()
            .gap_2()
            .p_2()
            .pl(px(8. + indent as f32 * 16.))
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
                v_flex()
                    .id(SharedString::from(format!("sel-{id}")))
                    .flex_1()
                    .overflow_hidden()
                    .cursor_pointer()
                    .when(done, |d| d.text_color(muted))
                    .child(title)
                    .child(
                        h_flex()
                            .gap_2()
                            .text_xs()
                            .text_color(muted)
                            .when(has_notes, |row| row.child("有备注"))
                            .when(!tag_label.is_empty(), |row| row.child(tag_label))
                            .when(spent > 0, |row| row.child(format!("{}m", spent / 60_000))),
                    )
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
                    Button::new(SharedString::from(format!("timer-{id}")))
                        .xsmall()
                        .ghost()
                        .label(if timing { "⏹" } else { "▶" })
                        .on_click({
                            let id = id.clone();
                            let entity = entity.clone();
                            move |_, _, app| {
                                if let Some(e) = entity.upgrade() {
                                    e.update(app, |this, cx| this.toggle_timer(&id, cx));
                                }
                            }
                        }),
                )
                .when(is_root, |row| {
                    row.child(
                        Button::new(SharedString::from(format!("sub-{id}")))
                            .xsmall()
                            .ghost()
                            .label("+子")
                            .on_click({
                                let id = id.clone();
                                let entity = entity.clone();
                                move |_, _, app| {
                                    if let Some(e) = entity.upgrade() {
                                        e.update(app, |this, cx| this.add_subtask(&id, cx));
                                    }
                                }
                            }),
                    )
                })
                .child(
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

    pub fn focus_capture(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.capture.focus_handle(cx).focus(window, cx);
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
        let active_timer_id = self
            .state
            .with(|s| s.active_timer.as_ref().map(|(id, _)| id.clone()));
        let selected_tags = selected_id
            .as_ref()
            .map(|id| self.state.with(|s| s.repo.tags_for_task(id)))
            .unwrap_or_default();
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
        if show_archive {
            self.sync_project_title(window, cx);
        }

        let body = match self.mode {
            TasksMode::List => {
                let is_planner = self.state.with(|s| s.nav == AppNav::Planner);
                if is_planner {
                    if tasks.is_empty() {
                        div()
                            .flex_1()
                            .text_sm()
                            .text_color(muted)
                            .child("计划为空。用快速捕获写「今天 …」或「明天 …」来排期。")
                            .into_any_element()
                    } else {
                        let roots: Vec<Task> = tasks
                            .iter()
                            .filter(|(_, d)| *d == 0)
                            .map(|(t, _)| t.clone())
                            .collect();
                        let groups = group_tasks_by_plan_day(&roots);
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
                                        let selected =
                                            selected_id.as_deref() == Some(task.id.as_str());
                                        let timing =
                                            active_timer_id.as_deref() == Some(task.id.as_str());
                                        let tag_label = self.state.with(|s| {
                                            s.repo
                                                .tags_for_task(&task.id)
                                                .into_iter()
                                                .map(|t| format!("#{}", t.title))
                                                .collect::<Vec<_>>()
                                                .join(" ")
                                        });
                                        Self::render_task_row(
                                            task,
                                            entity.clone(),
                                            radius,
                                            muted,
                                            accent,
                                            &today,
                                            selected,
                                            0,
                                            timing,
                                            tag_label,
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
                    }
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
                        .map(|(task, indent)| {
                            let selected = selected_id.as_deref() == Some(task.id.as_str());
                            let timing = active_timer_id.as_deref() == Some(task.id.as_str());
                            let tag_label = self.state.with(|s| {
                                s.repo
                                    .tags_for_task(&task.id)
                                    .into_iter()
                                    .map(|t| format!("#{}", t.title))
                                    .collect::<Vec<_>>()
                                    .join(" ")
                            });
                            Self::render_task_row(
                                task,
                                entity.clone(),
                                radius,
                                muted,
                                accent,
                                &today,
                                selected,
                                indent,
                                timing,
                                tag_label,
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
                let roots: Vec<Task> = tasks
                    .iter()
                    .filter(|(_, d)| *d == 0)
                    .map(|(t, _)| t.clone())
                    .collect();
                let todo: Vec<_> = roots.iter().filter(|t| !t.is_done).cloned().collect();
                let done: Vec<_> = roots.iter().filter(|t| t.is_done).cloned().collect();
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
                                let timing = active_timer_id.as_deref() == Some(task.id.as_str());
                                let tag_label = self.state.with(|s| {
                                    s.repo
                                        .tags_for_task(&task.id)
                                        .into_iter()
                                        .map(|t| format!("#{}", t.title))
                                        .collect::<Vec<_>>()
                                        .join(" ")
                                });
                                Self::render_task_row(
                                    task,
                                    entity.clone(),
                                    radius,
                                    muted,
                                    accent,
                                    &today,
                                    selected,
                                    0,
                                    timing,
                                    tag_label,
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
            .when(show_archive, |col| {
                col.child(
                    h_flex()
                        .gap_2()
                        .items_center()
                        .child(div().text_sm().text_color(muted).child("项目名"))
                        .child(Input::new(&self.project_title).cleanable(true)),
                )
            })
            .child(body)
            .when(selected_id.is_some(), |col| {
                let sid = selected_id.clone().unwrap();
                let selected_task = all_for_stats.iter().find(|t| t.id == sid);
                let label = selected_task
                    .map(|t| t.title.clone())
                    .unwrap_or_else(|| "任务备注".into());
                let in_inbox = selected_task
                    .map(|t| t.project_id == INBOX_PROJECT_ID)
                    .unwrap_or(true);
                let active_pid = self.state.with(|s| s.active_project_id.clone());
                let show_to_project = active_pid
                    .as_ref()
                    .is_some_and(|pid| pid != INBOX_PROJECT_ID)
                    && selected_task
                        .map(|t| Some(&t.project_id) != active_pid.as_ref())
                        .unwrap_or(false);
                col.child(
                    v_flex()
                        .gap_1()
                        .p_2()
                        .rounded(radius)
                        .border_1()
                        .border_color(border)
                        .child(
                            h_flex()
                                .gap_2()
                                .items_center()
                                .child(
                                    div()
                                        .flex_1()
                                        .text_xs()
                                        .font_bold()
                                        .text_color(muted)
                                        .child(format!("备注 · {label}")),
                                )
                                .when(!in_inbox, |row| {
                                    let sid = sid.clone();
                                    row.child(
                                        Button::new("move-inbox")
                                            .xsmall()
                                            .ghost()
                                            .label("移到收件箱")
                                            .on_click(cx.listener(move |this, _, _, cx| {
                                                this.move_task_project(&sid, INBOX_PROJECT_ID, cx);
                                            })),
                                    )
                                })
                                .when(show_to_project, |row| {
                                    let sid = sid.clone();
                                    let pid = active_pid.clone().unwrap();
                                    row.child(
                                        Button::new("move-project")
                                            .xsmall()
                                            .ghost()
                                            .label("移到当前项目")
                                            .on_click(cx.listener(move |this, _, _, cx| {
                                                this.move_task_project(&sid, &pid, cx);
                                            })),
                                    )
                                }),
                        )
                        .child(Input::new(&self.notes))
                        .child(
                            h_flex()
                                .gap_2()
                                .items_center()
                                .child(div().text_xs().text_color(muted).child("标签"))
                                .child(Input::new(&self.tag_input).cleanable(true)),
                        )
                        .when(!selected_tags.is_empty(), |col| {
                            col.child(h_flex().gap_1().flex_wrap().children(
                                selected_tags.into_iter().map(|tag| {
                                    let tid = tag.id.clone();
                                    Button::new(SharedString::from(format!("rm-tag-{tid}")))
                                        .xsmall()
                                        .ghost()
                                        .label(format!("#{} ×", tag.title))
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            this.remove_tag_from_selected(&tid, cx);
                                        }))
                                }),
                            ))
                        })
                        .child(
                            h_flex()
                                .gap_1()
                                .flex_wrap()
                                .items_center()
                                .child(div().text_xs().text_color(muted).child(format!(
                                            "重复 · {}",
                                            selected_task
                                                .map(task_repeat_label)
                                                .unwrap_or_else(|| "不重复".into())
                                        )))
                                .children(
                                    [
                                        (None, "无"),
                                        (Some(TimedSchedulePreset::Daily), "每天"),
                                        (Some(TimedSchedulePreset::Weekdays), "工作日"),
                                        (Some(TimedSchedulePreset::Weekly), "每周"),
                                        (Some(TimedSchedulePreset::Monthly), "每月"),
                                    ]
                                    .into_iter()
                                    .map(|(preset, label)| {
                                        Button::new(SharedString::from(format!("repeat-{label}")))
                                            .xsmall()
                                            .ghost()
                                            .label(label)
                                            .on_click(cx.listener(move |this, _, _, cx| {
                                                this.set_selected_repeat(preset, cx);
                                            }))
                                    }),
                                ),
                        ),
                )
            })
    }
}
