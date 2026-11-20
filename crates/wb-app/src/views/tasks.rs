use crate::state::{AppNav, AppState};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::*;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use wb_domain::{
    INBOX_PROJECT_ID, SchedulePatch, apply_schedule_patch, filter_tasks, is_today_member,
    parse_quick_capture, select_planner_tasks, select_today_tasks,
};

pub struct TasksPane {
    state: AppState,
    capture: Entity<InputState>,
    _subs: Vec<Subscription>,
}

impl TasksPane {
    pub fn new(state: AppState, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let capture = cx.new(|cx| {
            InputState::new(window, cx).placeholder("快速捕获：今天 写报告 #项目 提前10分钟")
        });
        let mut this = Self {
            state,
            capture: capture.clone(),
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
}

impl Render for TasksPane {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let nav = self.state.with(|s| s.nav);
        let today = self.state.today();
        let (title, tasks) = self.state.with(|s| {
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
        });

        let entity = cx.weak_entity();

        v_flex()
            .size_full()
            .gap_3()
            .p_4()
            .child(
                h_flex()
                    .items_center()
                    .justify_between()
                    .child(div().text_xl().font_bold().child(title))
                    .child(
                        div()
                            .text_sm()
                            .text_color(cx.theme().muted_foreground)
                            .child(format!("{} 项", tasks.len())),
                    ),
            )
            .child(Input::new(&self.capture).cleanable(true))
            .child(
                v_flex()
                    .gap_1()
                    .flex_1()
                    .overflow_hidden()
                    .children(tasks.into_iter().map(|task| {
                        let id = task.id.clone();
                        let done = task.is_done;
                        let title = task.title.clone();
                        let plan = task
                            .due_day
                            .clone()
                            .or_else(|| task.due_with_time.map(wb_domain::format_local_day))
                            .unwrap_or_default();
                        let entity = entity.clone();
                        h_flex()
                            .id(SharedString::from(format!("task-{}", id)))
                            .w_full()
                            .items_center()
                            .gap_2()
                            .p_2()
                            .rounded(cx.theme().radius)
                            .hover(|s| s.bg(cx.theme().accent.opacity(0.4)))
                            .child(
                                Button::new(SharedString::from(format!("done-{id}")))
                                    .ghost()
                                    .label(if done { "☑" } else { "☐" })
                                    .on_click({
                                        let id = id.clone();
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
                                    .flex_1()
                                    .overflow_hidden()
                                    .when(done, |d| d.text_color(cx.theme().muted_foreground))
                                    .child(title),
                            )
                            .when(!plan.is_empty(), |row| {
                                row.child(
                                    div()
                                        .text_xs()
                                        .text_color(cx.theme().muted_foreground)
                                        .child(plan),
                                )
                            })
                    })),
            )
    }
}
