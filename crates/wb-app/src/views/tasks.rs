use super::task_form::TaskForm;
use crate::state::{AppNav, AppState};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::empty::{Empty, EmptyDescription, EmptyHeader, EmptyTitle};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::progress::Progress;
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::tag::Tag;
use gpui_kit::component::{Selectable as _, *};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use std::cell::Cell;
use std::rc::Rc;
use wb_domain::{
    INBOX_PROJECT_ID, PLANNER_CALENDAR_COLUMNS, ReminderOptionId, SchedulePatch, Task,
    add_local_days, apply_schedule_patch, at_local_time, bucket_tasks_for_calendar,
    bucket_tasks_for_day_schedule, clear_plan_fields, compute_task_stats, create_task_draft,
    filter_tasks, format_deadline_chip, format_plan_chip, format_remind_chip, format_spent_label,
    group_tasks_by_plan_day, is_today_member, milliseconds_diff_to_remind_option, now_ms,
    parse_quick_capture, planner_day_columns, select_planner_tasks, select_today_tasks,
    settle_timer_segment, shift_remind_at, start_of_week, task_child_counts, task_is_overdue,
    task_repeat_label, weekday_cn_short,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProjectDialogKind {
    Create,
    Rename,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum TasksMode {
    #[default]
    List,
    Board,
    Calendar,
    Schedule,
    Stats,
}

pub struct TasksPane {
    state: AppState,
    capture: Entity<InputState>,
    project_title: Entity<InputState>,
    project_title_id: Option<String>,
    task_query: Entity<InputState>,
    tag_title: Entity<InputState>,
    task_form: Entity<TaskForm>,
    task_dialog_open: bool,
    project_dialog_open: bool,
    project_dialog: Option<ProjectDialogKind>,
    mode: TasksMode,
    /// Day offset from today for the hourly schedule view.
    schedule_day_offset: i64,
    /// When confirm-before-delete is on, first click stores the id here.
    pending_delete_id: Option<String>,
    editing_tag_id: Option<String>,
    pending_delete_tag_id: Option<String>,
    task_cache_rev: u64,
    task_cache: Vec<Task>,
    _subs: Vec<Subscription>,
}

fn task_matches_query(task: &Task, query: &str) -> bool {
    task.title.to_lowercase().contains(query) || task.notes.to_lowercase().contains(query)
}

fn filter_task_rows(tasks: Vec<(Task, usize)>, query: &str) -> Vec<(Task, usize)> {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return tasks;
    }
    let mut out = Vec::new();
    let mut index = 0;
    while index < tasks.len() {
        if tasks[index].1 != 0 {
            index += 1;
            continue;
        }
        let mut end = index + 1;
        while end < tasks.len() && tasks[end].1 > 0 {
            end += 1;
        }
        let root_hit = task_matches_query(&tasks[index].0, &query);
        if root_hit {
            out.extend(tasks[index..end].iter().cloned());
        } else {
            let children: Vec<_> = tasks[index + 1..end]
                .iter()
                .filter(|(task, _)| task_matches_query(task, &query))
                .cloned()
                .collect();
            if !children.is_empty() {
                out.push(tasks[index].clone());
                out.extend(children);
            }
        }
        index = end;
    }
    out
}

/// Keep an existing lead time when the clock moves. A task that already had a
/// time and no reminder stays quiet. A task with no clock yet uses the default.
fn remind_for_moved_clock(task: &Task, due_ms: i64, fallback: Option<i64>) -> Option<i64> {
    match (task.due_with_time, task.remind_at) {
        (Some(old_due), Some(old_at)) if old_due >= old_at => {
            let option = milliseconds_diff_to_remind_option(old_due - old_at);
            shift_remind_at(due_ms, option)
        }
        (Some(_), None) => None,
        _ => fallback,
    }
}

fn fill_capture_reminders(
    parsed: &mut wb_domain::QuickCaptureResult,
    default_at: impl Fn(i64) -> Option<i64>,
) {
    if parsed.remind_at.is_none()
        && let Some(due) = parsed.due_with_time
    {
        parsed.remind_at = default_at(due);
    }
    if parsed.deadline_remind_at.is_none()
        && parsed.remind_option == ReminderOptionId::None
        && let Some(due) = parsed.deadline_with_time
    {
        parsed.deadline_remind_at = default_at(due);
    }
}

fn default_remind_at(state: &AppState, due_ms: i64) -> Option<i64> {
    let raw = state.with(|s| s.prefs.general.default_remind.clone());
    ReminderOptionId::parse(&raw).and_then(|option| shift_remind_at(due_ms, option))
}

impl TasksPane {
    pub fn new(state: AppState, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let capture = cx.new(|cx| {
            InputState::new(window, cx).placeholder("快速捕获：今天 写报告 #项目 提前10分钟")
        });
        let project_title =
            cx.new(|cx| InputState::new(window, cx).placeholder("项目名称，回车保存"));
        let task_query = cx.new(|cx| InputState::new(window, cx).placeholder("搜索任务"));
        let tag_title = cx.new(|cx| InputState::new(window, cx).placeholder("标签名称，回车保存"));
        let task_form = cx.new(|cx| TaskForm::new(state.clone(), window, cx));
        let mut this = Self {
            state,
            capture: capture.clone(),
            project_title: project_title.clone(),
            project_title_id: None,
            task_query: task_query.clone(),
            tag_title: tag_title.clone(),
            task_form,
            task_dialog_open: false,
            project_dialog_open: false,
            project_dialog: None,
            mode: TasksMode::List,
            schedule_day_offset: 0,
            pending_delete_id: None,
            editing_tag_id: None,
            pending_delete_tag_id: None,
            task_cache_rev: u64::MAX,
            task_cache: Vec::new(),
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
        this._subs.push(cx.subscribe_in(
            &project_title,
            window,
            |this, input, event, window, cx| {
                if let InputEvent::PressEnter { .. } = event {
                    let text = input.read(cx).value().to_string();
                    if this.project_dialog.is_some() {
                        if this.commit_project_dialog(&text, cx) {
                            window.close_dialog(cx);
                        }
                    } else {
                        this.rename_active_project(&text, cx);
                    }
                }
            },
        ));
        this._subs
            .push(cx.subscribe_in(&task_query, window, |_, _, event, _, cx| {
                if matches!(event, InputEvent::Change) {
                    cx.notify();
                }
            }));
        this._subs.push(
            cx.subscribe_in(&tag_title, window, |this, _, event, _, cx| {
                if let InputEvent::PressEnter { .. } = event {
                    this.commit_tag_edit(cx);
                }
            }),
        );
        this
    }

    fn submit_capture(&mut self, text: &str, cx: &mut Context<Self>) {
        let now = wb_domain::now_ms();
        let mut parsed = parse_quick_capture(text, now, None);
        let state = self.state.clone();
        fill_capture_reminders(&mut parsed, |due| default_remind_at(&state, due));
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
                    deadline_remind_at: Some(parsed.deadline_remind_at),
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

    pub fn open_project_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.project_title
            .update(cx, |input, cx| input.set_value("", window, cx));
        self.project_dialog = Some(ProjectDialogKind::Create);
        self.present_project_dialog(window, cx);
    }

    fn open_rename_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let title = self.state.with(|s| {
            s.active_project_id
                .as_ref()
                .and_then(|id| s.repo.list_projects().into_iter().find(|p| &p.id == id))
                .map(|p| p.title)
                .unwrap_or_default()
        });
        self.project_title
            .update(cx, |input, cx| input.set_value(title, window, cx));
        self.project_dialog = Some(ProjectDialogKind::Rename);
        self.present_project_dialog(window, cx);
    }

    fn present_project_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.project_dialog_open {
            return;
        }
        self.project_dialog_open = true;
        let kind = self.project_dialog.unwrap_or(ProjectDialogKind::Create);
        let title_input = self.project_title.clone();
        let pane = cx.weak_entity();
        let focus_once = Rc::new(Cell::new(true));
        window.open_dialog(cx, move |dialog, window, cx| {
            if focus_once.replace(false) {
                title_input.update(cx, |input, cx| input.focus(window, cx));
            }
            let heading = if kind == ProjectDialogKind::Rename {
                "重命名项目"
            } else {
                "新建项目"
            };
            let confirm = if kind == ProjectDialogKind::Rename {
                "保存"
            } else {
                "创建"
            };
            let save_pane = pane.clone();
            let cancel_pane = pane.clone();
            let input = title_input.clone();
            dialog
                .title(heading)
                .w(px(420.))
                .on_cancel({
                    let cancel_pane = cancel_pane.clone();
                    move |_, _, cx| {
                        cancel_pane
                            .update(cx, |pane, cx| {
                                pane.project_dialog = None;
                                pane.project_dialog_open = false;
                                cx.notify();
                            })
                            .ok();
                        true
                    }
                })
                .child(
                    div()
                        .w_full()
                        .px_4()
                        .pb_2()
                        .child(Input::new(&input).w_full()),
                )
                .footer(
                    h_flex()
                        .w_full()
                        .justify_end()
                        .gap_2()
                        .px_4()
                        .pb_2()
                        .child(
                            Button::new("cancel-project-dialog")
                                .small()
                                .label("取消")
                                .on_click({
                                    let cancel_pane = cancel_pane.clone();
                                    move |_, window, cx| {
                                        cancel_pane
                                            .update(cx, |pane, cx| {
                                                pane.project_dialog = None;
                                                pane.project_dialog_open = false;
                                                cx.notify();
                                            })
                                            .ok();
                                        window.close_dialog(cx);
                                    }
                                }),
                        )
                        .child(
                            Button::new("save-project-dialog")
                                .small()
                                .primary()
                                .label(confirm)
                                .on_click({
                                    let input = input.clone();
                                    move |_, window, cx| {
                                        let text = input.read(cx).value().to_string();
                                        let saved = save_pane
                                            .update(cx, |pane, cx| {
                                                pane.commit_project_dialog(&text, cx)
                                            })
                                            .unwrap_or(false);
                                        if saved {
                                            window.close_dialog(cx);
                                        }
                                    }
                                }),
                        ),
                )
        });
    }

    fn commit_project_dialog(&mut self, title: &str, cx: &mut Context<Self>) -> bool {
        let title = title.trim();
        if title.is_empty() {
            return false;
        }
        let kind = self.project_dialog.take();
        self.project_dialog_open = false;
        match kind {
            Some(ProjectDialogKind::Create) => {
                self.state.with_mut(|s| {
                    let project = s.repo.create_project(title);
                    s.nav = AppNav::Projects;
                    s.active_project_id = Some(project.id);
                    s.active_tag_id = None;
                });
                self.state.persist_if_dirty();
                cx.notify();
                true
            }
            Some(ProjectDialogKind::Rename) => {
                self.rename_active_project(title, cx);
                true
            }
            None => false,
        }
    }

    fn confirm_delete_project(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (pid, title) = self.state.with(|s| {
            let pid = s.active_project_id.clone();
            let title = pid
                .as_ref()
                .and_then(|id| s.repo.list_projects().into_iter().find(|p| &p.id == id))
                .map(|project| project.title)
                .unwrap_or_default();
            (pid, title)
        });
        let Some(pid) = pid else {
            return;
        };
        if pid == INBOX_PROJECT_ID {
            return;
        }
        let pane = cx.weak_entity();
        window.open_dialog(cx, move |dialog, _, _| {
            let cancel_pane = pane.clone();
            let delete_pane = pane.clone();
            let pid = pid.clone();
            dialog
                .title("删除项目")
                .w(px(420.))
                .child(
                    div()
                        .px_4()
                        .pb_2()
                        .text_sm()
                        .child(format!("删除「{title}」以及其中的任务？此操作不能撤销。")),
                )
                .footer(
                    h_flex()
                        .w_full()
                        .justify_end()
                        .gap_2()
                        .px_4()
                        .pb_2()
                        .child(
                            Button::new("cancel-delete-project")
                                .small()
                                .label("取消")
                                .on_click(move |_, window, cx| {
                                    let _ = &cancel_pane;
                                    window.close_dialog(cx);
                                }),
                        )
                        .child(
                            Button::new("confirm-delete-project")
                                .small()
                                .danger()
                                .label("删除")
                                .on_click(move |_, window, cx| {
                                    delete_pane
                                        .update(cx, |pane, cx| pane.delete_project(&pid, cx))
                                        .ok();
                                    window.close_dialog(cx);
                                }),
                        ),
                )
        });
    }

    fn delete_project(&mut self, id: &str, cx: &mut Context<Self>) {
        self.state.with_mut(|s| {
            if s.repo.delete_project(id) && s.active_project_id.as_deref() == Some(id) {
                s.active_project_id = None;
                s.nav = AppNav::Inbox;
                s.selected_task_id = None;
            }
        });
        self.state.persist_if_dirty();
        cx.notify();
    }

    pub fn open_task_dialog(
        &mut self,
        id: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let project_id = self.state.with(|s| {
            s.active_project_id
                .clone()
                .filter(|id| id != INBOX_PROJECT_ID)
                .unwrap_or_else(|| INBOX_PROJECT_ID.to_string())
        });
        self.task_form.update(cx, |form, cx| match &id {
            Some(id) => form.load_existing(id, window, cx),
            None => form.load_new(&project_id, window, cx),
        });
        self.present_task_dialog(window, cx);
    }

    fn present_task_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.task_dialog_open {
            cx.notify();
            return;
        }
        self.task_dialog_open = true;
        let form = self.task_form.clone();
        let pane = cx.weak_entity();
        let focus_once = Rc::new(Cell::new(true));
        window.open_dialog(cx, move |dialog, window, cx| {
            if focus_once.replace(false) {
                form.update(cx, |form, cx| form.focus_title(window, cx));
            }
            let editing = form.read(cx).is_editing();
            let subtitle = form.read(cx).subtitle(cx);
            let muted = cx.theme().muted_foreground;
            let save_form = form.clone();
            let delete_form = form.clone();
            let copy_form = form.clone();
            let save_pane = pane.clone();
            let close_pane = pane.clone();
            dialog
                .title(
                    v_flex()
                        .gap_0p5()
                        .child(if editing {
                            "编辑任务"
                        } else {
                            "新建任务"
                        })
                        .child(div().text_xs().text_color(muted).child(subtitle)),
                )
                .w(px(720.))
                .on_cancel({
                    let close_pane = close_pane.clone();
                    move |_, _, cx| {
                        close_pane
                            .update(cx, |pane, cx| {
                                pane.task_dialog_open = false;
                                cx.notify();
                            })
                            .ok();
                        true
                    }
                })
                .child(form.clone())
                .footer(
                    h_flex()
                        .w_full()
                        .items_center()
                        .justify_between()
                        .px_4()
                        .pb_2()
                        .child(
                            h_flex()
                                .gap_2()
                                .child(
                                    Button::new("delete-task-dialog")
                                        .small()
                                        .label("删除")
                                        .on_click({
                                            let delete_form = delete_form.clone();
                                            let close_pane = close_pane.clone();
                                            move |_, window, cx| {
                                                let _ = delete_form
                                                    .update(cx, |form, cx| form.delete(cx));
                                                close_pane
                                                    .update(cx, |pane, cx| {
                                                        pane.task_dialog_open = false;
                                                        cx.notify();
                                                    })
                                                    .ok();
                                                window.close_dialog(cx);
                                            }
                                        }),
                                )
                                .child(
                                    Button::new("copy-task-dialog")
                                        .small()
                                        .label("复制")
                                        .on_click({
                                            let copy_form = copy_form.clone();
                                            let save_pane = save_pane.clone();
                                            move |_, _, cx| {
                                                let copied = copy_form
                                                    .update(cx, |form, cx| form.duplicate(cx));
                                                if copied {
                                                    save_pane.update(cx, |_, cx| cx.notify()).ok();
                                                }
                                            }
                                        }),
                                ),
                        )
                        .child(
                            h_flex()
                                .gap_2()
                                .child(
                                    Button::new("cancel-task-dialog")
                                        .small()
                                        .label("取消")
                                        .on_click({
                                            let close_pane = close_pane.clone();
                                            move |_, window, cx| {
                                                close_pane
                                                    .update(cx, |pane, cx| {
                                                        pane.task_dialog_open = false;
                                                        cx.notify();
                                                    })
                                                    .ok();
                                                window.close_dialog(cx);
                                            }
                                        }),
                                )
                                .child(
                                    Button::new("save-task-dialog")
                                        .small()
                                        .primary()
                                        .label("保存")
                                        .on_click(move |_, window, cx| {
                                            let saved =
                                                save_form.update(cx, |form, cx| form.save(cx));
                                            if saved {
                                                save_pane
                                                    .update(cx, |pane, cx| {
                                                        pane.task_dialog_open = false;
                                                        cx.notify();
                                                    })
                                                    .ok();
                                                window.close_dialog(cx);
                                            }
                                        }),
                                ),
                        ),
                )
        });
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
                            remind_at: Some(None),
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

    fn schedule_selected_at_hour(&mut self, day: &str, hour: u32, cx: &mut Context<Self>) {
        let Some(id) = self.state.with(|s| s.selected_task_id.clone()) else {
            return;
        };
        let Some(ms) = at_local_time(day, hour, 0) else {
            return;
        };
        let fallback = default_remind_at(&self.state, ms);
        self.state.with_mut(|s| {
            if let Some(mut task) = s.repo.get_task(&id).cloned() {
                let remind_at = remind_for_moved_clock(&task, ms, fallback);
                apply_schedule_patch(
                    &mut task,
                    &SchedulePatch {
                        due_day: Some(None),
                        due_with_time: Some(Some(ms)),
                        deadline_day: None,
                        deadline_with_time: None,
                        remind_at: Some(remind_at),
                        deadline_remind_at: None,
                    },
                );
                s.repo.upsert_task(task);
            }
        });
        self.state.persist_if_dirty();
        cx.notify();
    }

    fn schedule_view_day(&self) -> String {
        let today = self.state.today();
        add_local_days(&today, self.schedule_day_offset).unwrap_or(today)
    }

    #[allow(clippy::too_many_arguments)]
    fn render_schedule_body(
        &self,
        tasks: &[(Task, usize)],
        today: &str,
        selected_id: &Option<String>,
        entity: WeakEntity<Self>,
        radius: Pixels,
        muted: Hsla,
        accent: Hsla,
        border: Hsla,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let day = self.schedule_view_day();
        let is_today = day == today;
        let weekday = weekday_cn_short(&day);
        let roots: Vec<Task> = tasks
            .iter()
            .filter(|(_, d)| *d == 0)
            .map(|(t, _)| t.clone())
            .collect();
        let pool: Vec<Task> = if roots
            .iter()
            .any(|t| t.due_day.is_some() || t.due_with_time.is_some())
        {
            roots
        } else {
            select_planner_tasks(&self.task_cache)
                .into_iter()
                .filter(|t| t.parent_id.is_none())
                .cloned()
                .collect()
        };
        let (all_day, hours) = bucket_tasks_for_day_schedule(&pool, &day);
        let mut rows: Vec<AnyElement> = Vec::new();
        rows.push(
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
                        .child(format!("全天 · {}", all_day.len())),
                )
                .children(all_day.into_iter().map(|task| {
                    let selected = selected_id.as_deref() == Some(task.id.as_str());
                    Self::render_calendar_chip(
                        task,
                        entity.clone(),
                        radius,
                        muted,
                        accent,
                        border,
                        selected,
                    )
                    .into_any_element()
                }))
                .into_any_element(),
        );
        for (hour, hour_tasks) in hours {
            let label = format!("{hour:02}:00");
            let chips: Vec<_> = hour_tasks
                .into_iter()
                .map(|task| {
                    let selected = selected_id.as_deref() == Some(task.id.as_str());
                    Self::render_calendar_chip(
                        task,
                        entity.clone(),
                        radius,
                        muted,
                        accent,
                        border,
                        selected,
                    )
                    .into_any_element()
                })
                .collect();
            let count = chips.len();
            let day_for_click = day.clone();
            rows.push(
                h_flex()
                    .id(SharedString::from(format!("sched-h-{hour}")))
                    .w_full()
                    .gap_2()
                    .items_start()
                    .p_2()
                    .rounded(radius)
                    .border_1()
                    .border_color(border)
                    .hover(|s| s.bg(accent.opacity(0.25)))
                    .cursor_pointer()
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.schedule_selected_at_hour(&day_for_click, hour, cx);
                    }))
                    .child(
                        div()
                            .w(px(56.))
                            .text_xs()
                            .font_bold()
                            .text_color(muted)
                            .child(label),
                    )
                    .child(
                        v_flex()
                            .flex_1()
                            .gap_1()
                            .when(count == 0, |col| {
                                col.child(
                                    div()
                                        .text_xs()
                                        .text_color(muted)
                                        .child("点击：把选中任务排到此时刻"),
                                )
                            })
                            .children(chips),
                    )
                    .into_any_element(),
            );
        }
        let day_label = if is_today {
            format!("今天 · 周{weekday} · {day}")
        } else {
            format!("周{weekday} · {day}")
        };
        v_flex()
            .gap_2()
            .flex_1()
            .child(
                h_flex()
                    .gap_2()
                    .items_center()
                    .child(Button::new("sched-prev").xsmall().label("前一天").on_click(
                        cx.listener(|this, _, _, cx| {
                            this.schedule_day_offset -= 1;
                            cx.notify();
                        }),
                    ))
                    .child(
                        Button::new("sched-today")
                            .xsmall()
                            .label("今天")
                            .selected(is_today)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.schedule_day_offset = 0;
                                cx.notify();
                            })),
                    )
                    .child(Button::new("sched-next").xsmall().label("后一天").on_click(
                        cx.listener(|this, _, _, cx| {
                            this.schedule_day_offset += 1;
                            cx.notify();
                        }),
                    ))
                    .child(div().text_sm().font_bold().child(day_label))
                    .child(div().flex_1())
                    .child(
                        div()
                            .text_xs()
                            .text_color(muted)
                            .child("06:00–22:00 · 先选任务再点时刻"),
                    ),
            )
            .child(
                v_flex()
                    .gap_1()
                    .flex_1()
                    .overflow_y_scrollbar()
                    .children(rows),
            )
            .into_any_element()
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
        let confirm = self.state.with(|s| s.prefs.general.confirm_before_delete);
        if confirm && self.pending_delete_id.as_deref() != Some(id) {
            self.pending_delete_id = Some(id.to_string());
            cx.notify();
            return;
        }
        self.pending_delete_id = None;
        self.state.with_mut(|s| {
            s.repo.delete_task(id);
            if s.selected_task_id.as_deref() == Some(id) {
                s.selected_task_id = None;
            }
        });
        self.state.persist_if_dirty();
        cx.notify();
    }

    /// Board lanes: 0 = planned, 1 = unscheduled, 2 = done.
    fn place_in_lane(&mut self, id: &str, lane: u8, cx: &mut Context<Self>) {
        let today = self.state.today();
        self.state.with_mut(|s| match lane {
            2 => {
                s.repo.complete_task(id);
            }
            1 => {
                if s.repo.get_task(id).is_some_and(|task| task.is_done) {
                    s.repo.incomplete_task(id);
                }
                if let Some(mut task) = s.repo.get_task(id).cloned() {
                    clear_plan_fields(&mut task);
                    s.repo.upsert_task(task);
                }
            }
            _ => {
                if s.repo.get_task(id).is_some_and(|task| task.is_done) {
                    s.repo.incomplete_task(id);
                }
                if let Some(mut task) = s.repo.get_task(id).cloned() {
                    if task.due_day.is_none() && task.due_with_time.is_none() {
                        apply_schedule_patch(
                            &mut task,
                            &SchedulePatch {
                                due_day: Some(Some(today)),
                                due_with_time: Some(None),
                                deadline_day: None,
                                deadline_with_time: None,
                                remind_at: None,
                                deadline_remind_at: None,
                            },
                        );
                        s.repo.upsert_task(task);
                    }
                }
            }
        });
        self.state.persist_if_dirty();
        cx.notify();
    }

    fn toggle_timer(&mut self, id: &str, cx: &mut Context<Self>) {
        let today = self.state.today();
        let now = now_ms();
        self.ensure_task_cache();
        let blocked = self.state.with(|s| {
            let timing_this = s.active_timer.as_ref().is_some_and(|(tid, _)| tid == id);
            !timing_this && task_child_counts(&self.task_cache, id).1 > 0
        });
        if blocked {
            return;
        }
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
        self.state.remember_session();
        cx.notify();
    }

    fn add_subtask(&mut self, parent_id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let child_id = self.state.with_mut(|s| {
            let parent = s.repo.get_task(parent_id).cloned()?;
            let child =
                create_task_draft("子任务", Some(&parent.project_id), Some(parent_id), None);
            let id = child.id.clone();
            s.repo.upsert_task(child);
            s.selected_task_id = Some(id.clone());
            Some(id)
        });
        self.state.persist_if_dirty();
        if let Some(id) = child_id {
            self.open_task_dialog(Some(id), window, cx);
        }
        cx.notify();
    }

    fn select_task(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.pending_delete_id.as_deref() != Some(id) {
            self.pending_delete_id = None;
        }
        self.state
            .with_mut(|s| s.selected_task_id = Some(id.to_string()));
        self.state.remember_session();
        self.open_task_dialog(Some(id.to_string()), window, cx);
        cx.notify();
    }

    fn ensure_task_cache(&mut self) {
        let rev = self.state.with(|s| s.repo.data_revision());
        if self.task_cache_rev != rev {
            self.task_cache = self.state.with(|s| s.repo.list_tasks());
            self.task_cache_rev = rev;
        }
    }

    fn filtered_tasks(&mut self) -> (String, Vec<(Task, usize)>) {
        self.ensure_task_cache();
        let nav = self.state.with(|s| s.nav);
        let today = self.state.today();
        let state = self.state.clone();
        let all = &self.task_cache;
        state.with(|s| {
            let roots: Vec<Task> = match nav {
                AppNav::Today => select_today_tasks(all, &today, s.repo.today_order())
                    .into_iter()
                    .cloned()
                    .collect(),
                AppNav::Inbox => filter_tasks(all, Some(INBOX_PROJECT_ID), Some(false), None)
                    .into_iter()
                    .filter(|t| t.parent_id.is_none())
                    .cloned()
                    .collect(),
                AppNav::Done => filter_tasks(all, None, Some(true), None)
                    .into_iter()
                    .filter(|t| t.parent_id.is_none())
                    .cloned()
                    .collect(),
                AppNav::Planner => select_planner_tasks(all)
                    .into_iter()
                    .filter(|t| t.parent_id.is_none())
                    .cloned()
                    .collect(),
                AppNav::Projects => {
                    let pid = s
                        .active_project_id
                        .clone()
                        .unwrap_or_else(|| INBOX_PROJECT_ID.to_string());
                    filter_tasks(all, Some(&pid), Some(false), None)
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
                    .and_then(|id| s.repo.get_project(id))
                    .map(|p| p.title.clone())
                    .unwrap_or_else(|| nav.label().to_string())
            } else if nav == AppNav::Tags {
                s.active_tag_id
                    .as_ref()
                    .and_then(|id| s.repo.get_tag(id))
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
        all_tasks: &[Task],
        entity: WeakEntity<Self>,
        radius: Pixels,
        muted: Hsla,
        accent: Hsla,
        today: &str,
        selected: bool,
        indent: usize,
        timing: bool,
        tag_label: String,
        pending_delete: bool,
        focus_mode: bool,
    ) -> impl IntoElement {
        let id = task.id.clone();
        let done = task.is_done;
        let title = task.title.clone();
        let is_root = task.parent_id.is_none();
        let (child_done, child_total) = task_child_counts(all_tasks, &id);
        let overdue = task_is_overdue(&task, today);
        let plan = format_plan_chip(&task, today).unwrap_or_default();
        let deadline = format_deadline_chip(&task, today).unwrap_or_default();
        let remind = format_remind_chip(&task, today).unwrap_or_default();
        let spent = format_spent_label(task.time_spent);
        let repeat = {
            let label = task_repeat_label(&task);
            if label == "不重复" {
                String::new()
            } else {
                label
            }
        };
        let has_notes = !task.notes.trim().is_empty();
        let show_meta = !focus_mode || selected;
        let show_actions = selected || pending_delete;
        h_flex()
            .id(SharedString::from(format!("task-{}", id)))
            .w_full()
            .items_center()
            .gap_2()
            .px_2()
            .py_1p5()
            .pl(px(8. + indent as f32 * 18.))
            .rounded(radius)
            .when(selected, |row| row.bg(accent.opacity(0.45)))
            .when(!selected && overdue, |row| row.bg(accent.opacity(0.12)))
            .hover(move |s| s.bg(accent.opacity(0.28)))
            .child(
                Button::new(SharedString::from(format!("done-{id}")))
                    .ghost()
                    .xsmall()
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
                    .min_w_0()
                    .gap_1()
                    .overflow_hidden()
                    .cursor_pointer()
                    .when(done, |d| d.text_color(muted))
                    .child(div().when(done, |title| title.line_through()).child(title))
                    .when(show_meta, |col| {
                        col.child(
                            h_flex()
                                .gap_1()
                                .flex_wrap()
                                .items_center()
                                .when(overdue, |row| {
                                    row.child(Tag::danger().xsmall().child("逾期"))
                                })
                                .when(!plan.is_empty(), |row| {
                                    row.child(Tag::secondary().xsmall().outline().child(plan))
                                })
                                .when(!deadline.is_empty(), |row| {
                                    row.child(Tag::warning().xsmall().outline().child(deadline))
                                })
                                .when(!remind.is_empty(), |row| {
                                    row.child(Tag::info().xsmall().outline().child(remind))
                                })
                                .when(!repeat.is_empty(), |row| {
                                    row.child(Tag::secondary().xsmall().child(repeat))
                                })
                                .when(child_total > 0, |row| {
                                    row.child(
                                        Tag::secondary()
                                            .xsmall()
                                            .child(format!("子任务 {child_done}/{child_total}")),
                                    )
                                })
                                .when(!spent.is_empty(), |row| {
                                    row.child(Tag::secondary().xsmall().outline().child(spent))
                                })
                                .when(timing, |row| {
                                    row.child(Tag::warning().xsmall().child("计时中"))
                                })
                                .when(has_notes, |row| {
                                    row.child(Tag::secondary().xsmall().outline().child("备注"))
                                })
                                .when(!tag_label.is_empty(), |row| {
                                    row.child(Tag::info().xsmall().outline().child(tag_label))
                                }),
                        )
                    })
                    .on_click({
                        let id = id.clone();
                        let entity = entity.clone();
                        move |_, window, cx| {
                            cx.stop_propagation();
                            if let Some(e) = entity.upgrade() {
                                e.update(cx, |this, cx| this.select_task(&id, window, cx));
                            }
                        }
                    }),
            )
            .when(show_actions && !done, |row| {
                row.when(child_total == 0, |row| {
                    row.child(
                        Button::new(SharedString::from(format!("timer-{id}")))
                            .xsmall()
                            .ghost()
                            .label(if timing { "停止" } else { "计时" })
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
                })
                .when(is_root, |row| {
                    row.child(
                        Button::new(SharedString::from(format!("sub-{id}")))
                            .xsmall()
                            .ghost()
                            .label("子任务")
                            .on_click({
                                let id = id.clone();
                                let entity = entity.clone();
                                move |_, window, app| {
                                    if let Some(e) = entity.upgrade() {
                                        e.update(app, |this, cx| {
                                            this.add_subtask(&id, window, cx);
                                        });
                                    }
                                }
                            }),
                    )
                })
            })
            .when(show_actions, |row| {
                row.child(
                    Button::new(SharedString::from(format!("del-{id}")))
                        .xsmall()
                        .ghost()
                        .danger()
                        .label(if pending_delete {
                            "确认删除"
                        } else {
                            "删除"
                        })
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
        if self.state.with(|s| s.nav) == AppNav::Tags {
            return;
        }
        self.capture.focus_handle(cx).focus(window, cx);
    }

    fn begin_tag_edit(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let title = self.state.with(|s| {
            s.repo
                .list_tags()
                .into_iter()
                .find(|tag| tag.id == id)
                .map(|tag| tag.title)
                .unwrap_or_default()
        });
        self.editing_tag_id = Some(id.to_string());
        self.pending_delete_tag_id = None;
        self.tag_title.update(cx, |input, cx| {
            input.set_value(title, window, cx);
            input.focus(window, cx);
        });
        cx.notify();
    }

    fn commit_tag_edit(&mut self, cx: &mut Context<Self>) {
        let Some(id) = self.editing_tag_id.clone() else {
            return;
        };
        let title = self.tag_title.read(cx).value().to_string();
        let saved = self
            .state
            .with_mut(|s| s.repo.rename_tag(&id, title.trim()));
        if saved {
            self.editing_tag_id = None;
            self.state.persist_if_dirty();
        }
        cx.notify();
    }

    fn delete_tag(&mut self, id: &str, cx: &mut Context<Self>) {
        let confirm = self.state.with(|s| s.prefs.general.confirm_before_delete);
        if confirm && self.pending_delete_tag_id.as_deref() != Some(id) {
            self.pending_delete_tag_id = Some(id.to_string());
            cx.notify();
            return;
        }
        self.pending_delete_tag_id = None;
        if self.editing_tag_id.as_deref() == Some(id) {
            self.editing_tag_id = None;
        }
        self.state.with_mut(|s| {
            s.repo.delete_tag(id);
        });
        self.state.persist_if_dirty();
        cx.notify();
    }

    fn render_tag_list(
        &mut self,
        radius: Pixels,
        muted: Hsla,
        border: Hsla,
        accent: Hsla,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let tags = self.state.with(|s| {
            s.repo
                .list_tags()
                .into_iter()
                .map(|tag| {
                    let count = s.repo.count_tasks_for_tag(&tag.id);
                    (tag.id, tag.title, count)
                })
                .collect::<Vec<_>>()
        });
        if tags.is_empty() {
            return Empty::new()
                .header(
                    EmptyHeader::new()
                        .title(EmptyTitle::new().child("还没有标签"))
                        .description(
                            EmptyDescription::new().child("在任务详情里添加标签后，会出现在这里。"),
                        ),
                )
                .into_any_element();
        }
        let editing = self.editing_tag_id.clone();
        let pending = self.pending_delete_tag_id.clone();
        let rows = tags.into_iter().map(|(id, title, count)| {
            let editing_this = editing.as_deref() == Some(id.as_str());
            let pending_delete = pending.as_deref() == Some(id.as_str());
            h_flex()
                .id(SharedString::from(format!("tag-row-{id}")))
                .w_full()
                .items_center()
                .gap_2()
                .px_2()
                .py_1p5()
                .rounded(radius)
                .border_1()
                .border_color(border)
                .hover(move |row| row.bg(accent.opacity(0.18)))
                .child(if editing_this {
                    div()
                        .flex_1()
                        .min_w_0()
                        .child(Input::new(&self.tag_title).small())
                        .into_any_element()
                } else {
                    h_flex()
                        .flex_1()
                        .min_w_0()
                        .items_center()
                        .gap_2()
                        .child(div().text_sm().truncate().child(format!("#{title}")))
                        .child(
                            div()
                                .text_xs()
                                .text_color(muted)
                                .child(format!("{count} 个任务")),
                        )
                        .into_any_element()
                })
                .child(if editing_this {
                    h_flex()
                        .gap_1()
                        .child(
                            Button::new(SharedString::from(format!("tag-save-{id}")))
                                .xsmall()
                                .primary()
                                .label("保存")
                                .on_click(cx.listener(|this, _, _, cx| this.commit_tag_edit(cx))),
                        )
                        .child(
                            Button::new(SharedString::from(format!("tag-cancel-{id}")))
                                .xsmall()
                                .ghost()
                                .label("取消")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.editing_tag_id = None;
                                    cx.notify();
                                })),
                        )
                        .into_any_element()
                } else {
                    h_flex()
                        .gap_1()
                        .child(
                            Button::new(SharedString::from(format!("tag-edit-{id}")))
                                .xsmall()
                                .ghost()
                                .label("编辑")
                                .on_click({
                                    let id = id.clone();
                                    cx.listener(move |this, _, window, cx| {
                                        this.begin_tag_edit(&id, window, cx);
                                    })
                                }),
                        )
                        .child(
                            Button::new(SharedString::from(format!("tag-del-{id}")))
                                .xsmall()
                                .ghost()
                                .danger()
                                .label(if pending_delete {
                                    "确认删除"
                                } else {
                                    "删除"
                                })
                                .on_click({
                                    let id = id.clone();
                                    cx.listener(move |this, _, _, cx| this.delete_tag(&id, cx))
                                }),
                        )
                        .into_any_element()
                })
        });
        v_flex()
            .gap_1()
            .flex_1()
            .overflow_y_scrollbar()
            .children(rows)
            .into_any_element()
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

    /// Title stays on one line so the view buttons beside it are not pushed off.
    fn header_title(&self, title: String) -> impl IntoElement {
        div()
            .min_w_0()
            .overflow_hidden()
            .whitespace_nowrap()
            .text_ellipsis()
            .text_xl()
            .font_bold()
            .child(title)
    }

    /// Title, count, and view switcher that used to sit under the page bar.
    /// The shell draws this in the top bar so the name is not shown twice.
    pub fn chrome_header(&mut self, cx: &mut Context<Self>) -> AnyElement {
        if self.state.with(|s| s.nav) == AppNav::Tags {
            let count = self.state.with(|s| s.repo.list_tags().len());
            return h_flex()
                .flex_1()
                .min_w_0()
                .items_center()
                .gap_2()
                .child(div().text_xl().font_bold().child("标签"))
                .child(Tag::secondary().small().child(format!("{count} 项")))
                .into_any_element();
        }
        let (title, tasks) = self.filtered_tasks();
        let show_archive = self.state.with(|s| {
            s.nav == AppNav::Projects
                && s.active_project_id
                    .as_deref()
                    .is_some_and(|id| id != INBOX_PROJECT_ID)
        });
        if show_archive {
            return h_flex()
                .flex_1()
                .min_w_0()
                .items_center()
                .gap_2()
                .child(self.header_title(title))
                .child(div().flex_1())
                .child(
                    Button::new("project-new-task")
                        .small()
                        .icon(IconName::Plus)
                        .tooltip("新建任务")
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.open_task_dialog(None, window, cx);
                        })),
                )
                .child(self.mode_button("mode-list", "列表", TasksMode::List, cx))
                .child(self.mode_button("mode-board", "看板", TasksMode::Board, cx))
                .child(self.mode_button("mode-calendar", "日历", TasksMode::Calendar, cx))
                .child(self.mode_button("mode-schedule", "时间表", TasksMode::Schedule, cx))
                .child(self.mode_button("mode-stats", "统计", TasksMode::Stats, cx))
                .child(
                    Button::new("rename-project")
                        .small()
                        .label("重命名")
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.open_rename_dialog(window, cx);
                        })),
                )
                .child(
                    Button::new("delete-project")
                        .small()
                        .danger()
                        .label("删除")
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.confirm_delete_project(window, cx);
                        })),
                )
                .child(
                    Button::new("archive-project")
                        .small()
                        .label("归档")
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.archive_active_project(cx);
                        })),
                )
                .into_any_element();
        }

        let visible_count = tasks.iter().filter(|(_, depth)| *depth == 0).count();
        let overdue = compute_task_stats(&self.task_cache, &self.state.today()).overdue;
        h_flex()
            .flex_1()
            .min_w_0()
            .items_center()
            .gap_2()
            .child(self.header_title(title))
            .child(
                Tag::secondary()
                    .small()
                    .child(format!("{visible_count} 项")),
            )
            .when(overdue > 0, |row| {
                row.child(Tag::danger().small().child(format!("逾期 {overdue}")))
            })
            .child(div().flex_1())
            .child(self.mode_button("mode-list", "列表", TasksMode::List, cx))
            .child(self.mode_button("mode-board", "看板", TasksMode::Board, cx))
            .child(self.mode_button("mode-calendar", "日历", TasksMode::Calendar, cx))
            .child(self.mode_button("mode-schedule", "时间表", TasksMode::Schedule, cx))
            .child(self.mode_button("mode-stats", "统计", TasksMode::Stats, cx))
            .into_any_element()
    }

    fn toggle_skip_weekends(&mut self, cx: &mut Context<Self>) {
        self.state.with_mut(|s| {
            s.prefs.planner_skip_weekends = !s.prefs.planner_skip_weekends;
        });
        self.state.persist_prefs();
        cx.notify();
    }

    fn render_calendar_chip(
        task: Task,
        entity: WeakEntity<Self>,
        radius: Pixels,
        muted: Hsla,
        accent: Hsla,
        border: Hsla,
        selected: bool,
    ) -> impl IntoElement {
        let id = task.id.clone();
        let title = task.title.clone();
        let time_label = task
            .due_with_time
            .map(|ms| {
                let (h, m) = wb_domain::local_hour_minute(ms);
                format!("{h:02}:{m:02}")
            })
            .unwrap_or_default();
        v_flex()
            .id(SharedString::from(format!("cal-chip-{id}")))
            .w_full()
            .gap_0p5()
            .p_1p5()
            .rounded(radius)
            .border_1()
            .border_color(if selected { accent } else { border })
            .when(selected, |el| el.bg(accent.opacity(0.55)))
            .hover(move |s| s.bg(accent.opacity(0.4)))
            .cursor_pointer()
            .on_click({
                let entity = entity.clone();
                let id = id.clone();
                move |_, window, app| {
                    app.stop_propagation();
                    if let Some(e) = entity.upgrade() {
                        e.update(app, |this, cx| this.select_task(&id, window, cx));
                    }
                }
            })
            .child(div().text_xs().font_bold().child(title))
            .when(!time_label.is_empty(), |col| {
                col.child(div().text_xs().text_color(muted).child(time_label))
            })
    }
}

impl Render for TasksPane {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let (_, tasks) = self.filtered_tasks();
        let entity = cx.weak_entity();
        let today = self.state.today();
        let stats = compute_task_stats(&self.task_cache, &today);
        let projects = self.state.with(|s| s.repo.list_projects());
        let radius = cx.theme().radius;
        let border = cx.theme().border;
        let muted = cx.theme().muted_foreground;
        let accent = cx.theme().accent;
        let (focus_mode, proactive, nav) = self.state.with(|s| {
            (
                s.prefs.general.interface_mode == "focus",
                s.prefs.general.proactive_suggestions && s.prefs.general.interface_mode != "focus",
                s.nav,
            )
        });
        let suggestions: Vec<Task> = if proactive && nav == AppNav::Today {
            self.task_cache
                .iter()
                .filter(|t| {
                    t.parent_id.is_none()
                        && !t.is_done
                        && t.due_day.is_none()
                        && t.due_with_time.is_none()
                        && !tasks.iter().any(|(shown, _)| shown.id == t.id)
                })
                .take(5)
                .cloned()
                .collect()
        } else {
            Vec::new()
        };
        let selected_id = self.state.with(|s| s.selected_task_id.clone());
        let active_timer_id = self
            .state
            .with(|s| s.active_timer.as_ref().map(|(id, _)| id.clone()));

        let show_archive = self.state.with(|s| {
            s.nav == AppNav::Projects
                && s.active_project_id
                    .as_deref()
                    .is_some_and(|id| id != INBOX_PROJECT_ID)
        });
        if show_archive {
            self.sync_project_title(window, cx);
        }
        let tasks = if show_archive {
            let query = self.task_query.read(cx).value().to_string();
            filter_task_rows(tasks, &query)
        } else {
            tasks
        };
        if show_archive && self.mode == TasksMode::Schedule {
            self.mode = TasksMode::List;
        }

        let body = if nav == AppNav::Tags {
            self.render_tag_list(radius, muted, border, accent, cx)
        } else {
            match self.mode {
                TasksMode::List => {
                    let is_planner = self.state.with(|s| s.nav == AppNav::Planner);
                    if is_planner {
                        if tasks.is_empty() {
                            Empty::new()
                            .header(
                                EmptyHeader::new()
                                    .title(EmptyTitle::new().child("计划是空的"))
                                    .description(EmptyDescription::new().child(
                                        "用底部快速捕获写「今天 写报告」或「明天 10:00 开会」。",
                                    )),
                            )
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
                                            let timing = active_timer_id.as_deref()
                                                == Some(task.id.as_str());
                                            let tag_label = self.state.with(|s| {
                                                s.repo
                                                    .tags_for_task(&task.id)
                                                    .into_iter()
                                                    .map(|t| format!("#{}", t.title))
                                                    .collect::<Vec<_>>()
                                                    .join(" ")
                                            });
                                            let pending_delete = self.pending_delete_id.as_deref()
                                                == Some(task.id.as_str());
                                            Self::render_task_row(
                                                task,
                                                &self.task_cache,
                                                entity.clone(),
                                                radius,
                                                muted,
                                                accent,
                                                &today,
                                                selected,
                                                0,
                                                timing,
                                                tag_label,
                                                pending_delete,
                                                focus_mode,
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
                        let hint = self.state.with(|s| s.prefs.general.show_empty_hints);
                        Empty::new()
                        .header(
                            EmptyHeader::new()
                                .title(EmptyTitle::new().child("暂无任务"))
                                .description(EmptyDescription::new().child(if hint {
                                    "在底部输入一句话即可捕获，例如「明天 写周报 #工作 提前10分钟」。"
                                } else {
                                    "当前列表是空的。"
                                })),
                        )
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
                                let pending_delete =
                                    self.pending_delete_id.as_deref() == Some(task.id.as_str());
                                Self::render_task_row(
                                    task,
                                    &self.task_cache,
                                    entity.clone(),
                                    radius,
                                    muted,
                                    accent,
                                    &today,
                                    selected,
                                    indent,
                                    timing,
                                    tag_label,
                                    pending_delete,
                                    focus_mode,
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
                    let columns: Vec<_> = [
                        ("进行中", "已有计划日或时刻", 0u8, active),
                        ("待排期", "还没有安排到某一天", 1u8, backlog),
                        ("已完成", "重复任务会推进到下一次", 2u8, done),
                    ]
                    .into_iter()
                    .map(|(label, hint, lane, col)| {
                        let move_id = selected_id.clone();
                        let move_entity = entity.clone();
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
                                let pending_delete =
                                    self.pending_delete_id.as_deref() == Some(task.id.as_str());
                                Self::render_task_row(
                                    task,
                                    &self.task_cache,
                                    entity.clone(),
                                    radius,
                                    muted,
                                    accent,
                                    &today,
                                    selected,
                                    0,
                                    timing,
                                    tag_label,
                                    pending_delete,
                                    focus_mode,
                                )
                                .into_any_element()
                            })
                            .collect();
                        v_flex()
                            .flex_1()
                            .gap_2()
                            .p_3()
                            .rounded(radius)
                            .border_1()
                            .border_color(border)
                            .bg(cx.theme().secondary.opacity(0.28))
                            .overflow_y_scrollbar()
                            .child(
                                h_flex()
                                    .items_center()
                                    .gap_2()
                                    .child(
                                        v_flex()
                                            .flex_1()
                                            .gap_0p5()
                                            .child(
                                                div()
                                                    .font_bold()
                                                    .child(format!("{label} · {}", rows.len())),
                                            )
                                            .child(div().text_xs().text_color(muted).child(hint)),
                                    )
                                    .child(
                                        Button::new(SharedString::from(format!("lane-{lane}")))
                                            .xsmall()
                                            .label("移入")
                                            .disabled(move_id.is_none())
                                            .on_click(move |_, _, app| {
                                                let Some(id) = move_id.clone() else {
                                                    return;
                                                };
                                                if let Some(e) = move_entity.upgrade() {
                                                    e.update(app, |this, cx| {
                                                        this.place_in_lane(&id, lane, cx);
                                                    });
                                                }
                                            }),
                                    ),
                            )
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
                TasksMode::Calendar => {
                    let (skip, monday) = self.state.with(|s| {
                        (
                            s.prefs.planner_skip_weekends,
                            s.prefs.general.week_starts_on != "sunday",
                        )
                    });
                    let week_start = start_of_week(&today, monday);
                    let day_cols = planner_day_columns(&week_start, PLANNER_CALENDAR_COLUMNS, skip);
                    let roots: Vec<Task> = tasks
                        .iter()
                        .filter(|(_, d)| *d == 0)
                        .map(|(t, _)| t.clone())
                        .collect();
                    let (overdue, buckets) = bucket_tasks_for_calendar(&roots, &day_cols);
                    let mut col_els: Vec<AnyElement> = Vec::new();
                    if !overdue.is_empty() {
                        let chips: Vec<_> = overdue
                            .into_iter()
                            .map(|task| {
                                let selected = selected_id.as_deref() == Some(task.id.as_str());
                                Self::render_calendar_chip(
                                    task,
                                    entity.clone(),
                                    radius,
                                    muted,
                                    accent,
                                    border,
                                    selected,
                                )
                                .into_any_element()
                            })
                            .collect();
                        col_els.push(
                            v_flex()
                                .w(px(132.))
                                .gap_1()
                                .p_2()
                                .rounded(radius)
                                .border_1()
                                .border_color(border)
                                .overflow_y_scrollbar()
                                .child(
                                    div()
                                        .font_bold()
                                        .text_xs()
                                        .text_color(muted)
                                        .child(format!("逾期 · {}", chips.len())),
                                )
                                .children(chips)
                                .into_any_element(),
                        );
                    }
                    for (day, day_tasks) in day_cols.iter().zip(buckets) {
                        let is_today = day == &today;
                        let weekday = weekday_cn_short(day);
                        let md = day.get(5..).unwrap_or(day.as_str()).to_string();
                        let header = if is_today {
                            format!("今天 · 周{weekday} · {md}")
                        } else {
                            format!("周{weekday} · {md}")
                        };
                        let chips: Vec<_> = day_tasks
                            .into_iter()
                            .map(|task| {
                                let selected = selected_id.as_deref() == Some(task.id.as_str());
                                Self::render_calendar_chip(
                                    task,
                                    entity.clone(),
                                    radius,
                                    muted,
                                    accent,
                                    border,
                                    selected,
                                )
                                .into_any_element()
                            })
                            .collect();
                        let count = chips.len();
                        let day_for_click = day.clone();
                        let day_entity = entity.clone();
                        col_els.push(
                            v_flex()
                                .w(px(148.))
                                .gap_1()
                                .p_2()
                                .rounded(radius)
                                .border_1()
                                .border_color(if is_today { accent } else { border })
                                .when(is_today, |col| col.bg(accent.opacity(0.12)))
                                .overflow_y_scrollbar()
                                .child(
                                    div()
                                        .id(SharedString::from(format!("cal-day-{day}")))
                                        .cursor_pointer()
                                        .font_bold()
                                        .text_xs()
                                        .text_color(if is_today { accent } else { muted })
                                        .child(format!("{header} · {count}"))
                                        .hover(|style| style.text_color(accent))
                                        .on_click(move |_, _, app| {
                                            if let Some(pane) = day_entity.upgrade() {
                                                pane.update(app, |this, cx| {
                                                    let Some(id) = this
                                                        .state
                                                        .with(|s| s.selected_task_id.clone())
                                                    else {
                                                        return;
                                                    };
                                                    this.schedule_day(
                                                        &id,
                                                        Some(day_for_click.clone()),
                                                        cx,
                                                    );
                                                });
                                            }
                                        }),
                                )
                                .when(count == 0, |col| {
                                    col.child(div().text_xs().text_color(muted).child("点标题放入"))
                                })
                                .children(chips)
                                .into_any_element(),
                        );
                    }
                    v_flex()
                        .gap_2()
                        .flex_1()
                        .child(
                            h_flex()
                                .gap_2()
                                .items_center()
                                .child(div().text_xs().text_color(muted).child(format!(
                                    "{} 列 · 自 {today}{} · 先选任务，再点日期标题",
                                    PLANNER_CALENDAR_COLUMNS,
                                    if skip { " · 已跳过周末" } else { "" }
                                )))
                                .child(div().flex_1())
                                .child(
                                    Button::new("cal-skip-weekends")
                                        .xsmall()
                                        .label(if skip { "显示周末" } else { "跳过周末" })
                                        .selected(skip)
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.toggle_skip_weekends(cx);
                                        })),
                                ),
                        )
                        .child(
                            h_flex()
                                .gap_2()
                                .flex_1()
                                .overflow_x_scrollbar()
                                .children(col_els),
                        )
                        .into_any_element()
                }
                TasksMode::Schedule => self.render_schedule_body(
                    &tasks,
                    &today,
                    &selected_id,
                    entity.clone(),
                    radius,
                    muted,
                    accent,
                    border,
                    cx,
                ),
                TasksMode::Stats => {
                    let rate = stats.completion_rate * 100.0;
                    let max_project = stats.by_project.iter().map(|(_, n)| *n).max().unwrap_or(1);
                    let cards: Vec<_> = [
                        ("未完成", stats.open.to_string(), false),
                        ("已逾期", stats.overdue.to_string(), stats.overdue > 0),
                        ("今日到期", stats.due_today.to_string(), false),
                        ("未排期", stats.unscheduled.to_string(), false),
                        ("今日完成", stats.done_today.to_string(), false),
                        ("全部完成", stats.done_total.to_string(), false),
                    ]
                    .into_iter()
                    .map(|(k, v, alert)| {
                        v_flex()
                            .w(px(148.))
                            .gap_1()
                            .p_3()
                            .rounded(radius)
                            .border_1()
                            .border_color(if alert { cx.theme().danger } else { border })
                            .bg(if alert {
                                cx.theme().danger.opacity(0.12)
                            } else {
                                cx.theme().secondary.opacity(0.35)
                            })
                            .child(div().text_xs().text_color(muted).child(k))
                            .child(div().text_xl().font_bold().child(v))
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
                                .unwrap_or_else(|| pid.clone());
                            let width = if max_project == 0 {
                                0.0
                            } else {
                                n as f32 / max_project as f32 * 100.0
                            };
                            v_flex()
                                .gap_1()
                                .child(
                                    h_flex()
                                        .justify_between()
                                        .text_sm()
                                        .child(title)
                                        .child(n.to_string()),
                                )
                                .child(
                                    Progress::new(SharedString::from(format!("proj-{pid}")))
                                        .value(width),
                                )
                                .into_any_element()
                        })
                        .collect();
                    v_flex()
                        .gap_3()
                        .flex_1()
                        .overflow_y_scrollbar()
                        .child(
                            v_flex()
                                .gap_2()
                                .p_3()
                                .rounded(radius)
                                .border_1()
                                .border_color(border)
                                .child(
                                    h_flex()
                                        .justify_between()
                                        .items_center()
                                        .child(div().font_bold().child("完成率"))
                                        .child(div().font_bold().child(format!("{rate:.0}%"))),
                                )
                                .child(Progress::new("task-completion").value(rate)),
                        )
                        .child(h_flex().gap_2().flex_wrap().children(cards))
                        .child(div().font_bold().mt_1().child("项目分布"))
                        .children(project_rows)
                        .into_any_element()
                }
            }
        };

        v_flex()
            .size_full()
            .min_h_0()
            .gap_3()
            .p_4()
            .when(show_archive, |col| {
                col.child(Input::new(&self.task_query).cleanable(true))
            })
            .when(nav != AppNav::Tags && !suggestions.is_empty(), |col| {
                let entity = entity.clone();
                col.child(
                    v_flex()
                        .gap_2()
                        .p_3()
                        .rounded(radius)
                        .border_1()
                        .border_color(border)
                        .bg(accent.opacity(0.12))
                        .child(div().text_sm().font_bold().child("主动任务推荐"))
                        .child(
                            div()
                                .text_xs()
                                .text_color(muted)
                                .child("未排期任务，可加入今日"),
                        )
                        .children(suggestions.into_iter().map(|task| {
                            let id = task.id.clone();
                            let title = task.title.clone();
                            let entity = entity.clone();
                            let day = today.clone();
                            h_flex()
                                .items_center()
                                .gap_2()
                                .child(div().flex_1().text_sm().child(title))
                                .child(
                                    Button::new(SharedString::from(format!("suggest-{id}")))
                                        .xsmall()
                                        .primary()
                                        .label("加入今日")
                                        .on_click(move |_, _, app| {
                                            if let Some(e) = entity.upgrade() {
                                                e.update(app, |this, cx| {
                                                    this.schedule_day(&id, Some(day.clone()), cx);
                                                });
                                            }
                                        }),
                                )
                        })),
                )
            })
            .child(v_flex().flex_1().min_h_0().overflow_hidden().child(body))
            .when(nav != AppNav::Tags, |col| {
                col.child(Input::new(&self.capture).cleanable(true))
            })
    }
}

#[cfg(test)]
mod tests {
    use super::remind_for_moved_clock;
    use wb_domain::create_task_draft;

    #[test]
    fn moved_clock_keeps_the_previous_lead() {
        let mut task = create_task_draft("写报告", None, None, Some(1));
        task.due_with_time = Some(1_000_000);
        task.remind_at = Some(1_000_000 - 5 * 60_000);
        assert_eq!(
            remind_for_moved_clock(&task, 2_000_000, Some(2_000_000)),
            Some(2_000_000 - 5 * 60_000)
        );
        task.remind_at = None;
        assert_eq!(remind_for_moved_clock(&task, 2_000_000, Some(1)), None);
        task.due_with_time = None;
        assert_eq!(remind_for_moved_clock(&task, 2_000_000, Some(9)), Some(9));
    }

    #[test]
    fn capture_fills_a_default_deadline_reminder() {
        use super::fill_capture_reminders;
        use wb_domain::parse_quick_capture;
        let mut parsed = parse_quick_capture("截止明天 15:00 交报告", 1_700_000_000_000, None);
        let due = parsed.deadline_with_time.unwrap();
        fill_capture_reminders(&mut parsed, |at| Some(at - 15 * 60_000));
        assert_eq!(parsed.deadline_remind_at, Some(due - 15 * 60_000));

        let mut explicit =
            parse_quick_capture("截止明天 15:00 交报告 提前10分钟", 1_700_000_000_000, None);
        fill_capture_reminders(&mut explicit, |at| Some(at - 15 * 60_000));
        assert_eq!(explicit.deadline_remind_at, Some(due - 10 * 60_000));
    }
}
