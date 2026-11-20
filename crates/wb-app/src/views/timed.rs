use crate::state::AppState;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::*;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use wb_domain::{
    NotificationKind, TimedSchedulePreset, create_timed_task_draft, is_timed_task_auto_due,
    make_preset_schedule, mark_timed_task_ran, now_ms, timed_preset_label, timed_schedule_label,
};

pub struct TimedPane {
    state: AppState,
    title: Entity<InputState>,
    command: Entity<InputState>,
}

impl TimedPane {
    pub fn new(state: AppState, window: &mut Window, cx: &mut Context<Self>) -> Self {
        Self {
            state,
            title: cx.new(|cx| InputState::new(window, cx).placeholder("标题")),
            command: cx
                .new(|cx| InputState::new(window, cx).placeholder("投递给 Agent 的指令或技能")),
        }
    }

    fn add_preset(&mut self, preset: TimedSchedulePreset, at_time: &str, cx: &mut Context<Self>) {
        let title = self.title.read(cx).value().to_string();
        let command = self.command.read(cx).value().to_string();
        let schedule = make_preset_schedule(preset, at_time);
        let task = create_timed_task_draft(
            Some(if title.trim().is_empty() {
                "未命名定时任务"
            } else {
                title.trim()
            }),
            Some(&command),
            Some(schedule),
            None,
        );
        self.state.with_mut(|s| s.repo.upsert_timed_task(task));
        self.state.persist_if_dirty();
        cx.notify();
    }

    fn run_now(&mut self, id: &str, cx: &mut Context<Self>) {
        self.state.with_mut(|s| {
            if let Some(task) = s.repo.get_timed_task(id).cloned() {
                let updated = mark_timed_task_ran(&task, now_ms());
                s.repo.upsert_timed_task(updated);
                s.repo.push_notification(
                    NotificationKind::System,
                    &format!("定时任务：{}", task.title),
                    &task.command,
                    Some(&task.id),
                );
            }
        });
        self.state.persist_if_dirty();
        cx.notify();
    }

    fn delete(&mut self, id: &str, cx: &mut Context<Self>) {
        self.state.with_mut(|s| s.repo.delete_timed_task(id));
        self.state.persist_if_dirty();
        cx.notify();
    }

    fn toggle_enabled(&mut self, id: &str, cx: &mut Context<Self>) {
        self.state.with_mut(|s| {
            if let Some(mut task) = s.repo.get_timed_task(id).cloned() {
                task.enabled = !task.enabled;
                s.repo.upsert_timed_task(task);
            }
        });
        self.state.persist_if_dirty();
        cx.notify();
    }

    pub fn tick_due(&mut self, cx: &mut Context<Self>) {
        let now = now_ms();
        let mut fired = false;
        self.state.with_mut(|s| {
            let due: Vec<_> = s
                .repo
                .list_timed_tasks()
                .into_iter()
                .filter(|t| is_timed_task_auto_due(t, now))
                .collect();
            for task in due {
                let updated = mark_timed_task_ran(&task, now);
                s.repo.upsert_timed_task(updated);
                s.repo.push_notification(
                    NotificationKind::System,
                    &format!("定时任务：{}", task.title),
                    &task.command,
                    Some(&task.id),
                );
                fired = true;
            }
        });
        if fired {
            self.state.persist_if_dirty();
            cx.notify();
        }
    }

    fn preset_button(
        &self,
        id: &'static str,
        preset: TimedSchedulePreset,
        at: &'static str,
        cx: &mut Context<Self>,
    ) -> Button {
        Button::new(id)
            .small()
            .label(format!("{} {}", timed_preset_label(preset), at))
            .on_click(cx.listener(move |this, _, _, cx| {
                this.add_preset(preset, at, cx);
            }))
    }
}

impl Render for TimedPane {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let tasks = self.state.with(|s| s.repo.list_timed_tasks());
        let entity = cx.weak_entity();

        v_flex()
            .size_full()
            .gap_3()
            .p_4()
            .child(div().text_xl().font_bold().child("定时任务"))
            .child(
                v_flex()
                    .gap_2()
                    .child(Input::new(&self.title))
                    .child(Input::new(&self.command))
                    .child(
                        h_flex()
                            .gap_2()
                            .flex_wrap()
                            .child(self.preset_button(
                                "preset-hourly",
                                TimedSchedulePreset::Hourly,
                                "00:00",
                                cx,
                            ))
                            .child(self.preset_button(
                                "preset-daily",
                                TimedSchedulePreset::Daily,
                                "09:00",
                                cx,
                            ))
                            .child(self.preset_button(
                                "preset-weekdays",
                                TimedSchedulePreset::Weekdays,
                                "09:00",
                                cx,
                            ))
                            .child(self.preset_button(
                                "preset-weekly",
                                TimedSchedulePreset::Weekly,
                                "09:00",
                                cx,
                            ))
                            .child(self.preset_button(
                                "preset-monthly",
                                TimedSchedulePreset::Monthly,
                                "09:00",
                                cx,
                            )),
                    ),
            )
            .child(if tasks.is_empty() {
                div()
                    .flex_1()
                    .text_sm()
                    .text_color(cx.theme().muted_foreground)
                    .child("暂无定时任务。填写标题与指令后，点上方预设即可添加。")
                    .into_any_element()
            } else {
                let radius = cx.theme().radius;
                let border = cx.theme().border;
                let muted = cx.theme().muted_foreground;
                v_flex()
                    .gap_2()
                    .flex_1()
                    .overflow_y_scrollbar()
                    .children(tasks.into_iter().map(|task| {
                        let id = task.id.clone();
                        let title = task.title.clone();
                        let sched = timed_schedule_label(task.schedule.as_ref());
                        let enabled = task.enabled;
                        let entity = entity.clone();
                        h_flex()
                            .id(SharedString::from(format!("timed-{id}")))
                            .w_full()
                            .items_center()
                            .gap_2()
                            .p_3()
                            .rounded(radius)
                            .border_1()
                            .border_color(border)
                            .child(
                                v_flex()
                                    .flex_1()
                                    .child(div().font_bold().child(title))
                                    .child(div().text_xs().text_color(muted).child(format!(
                                        "{sched} · {}",
                                        if enabled { "启用" } else { "停用" }
                                    ))),
                            )
                            .child(
                                Button::new(SharedString::from(format!("toggle-{id}")))
                                    .small()
                                    .label(if enabled { "停用" } else { "启用" })
                                    .on_click({
                                        let id = id.clone();
                                        let entity = entity.clone();
                                        move |_, _, app| {
                                            if let Some(e) = entity.upgrade() {
                                                e.update(app, |this, cx| {
                                                    this.toggle_enabled(&id, cx)
                                                });
                                            }
                                        }
                                    }),
                            )
                            .child(
                                Button::new(SharedString::from(format!("run-{id}")))
                                    .small()
                                    .label("立即执行")
                                    .on_click({
                                        let id = id.clone();
                                        let entity = entity.clone();
                                        move |_, _, app| {
                                            if let Some(e) = entity.upgrade() {
                                                e.update(app, |this, cx| this.run_now(&id, cx));
                                            }
                                        }
                                    }),
                            )
                            .child(
                                Button::new(SharedString::from(format!("del-{id}")))
                                    .small()
                                    .danger()
                                    .label("删除")
                                    .on_click({
                                        let id = id.clone();
                                        move |_, _, app| {
                                            if let Some(e) = entity.upgrade() {
                                                e.update(app, |this, cx| this.delete(&id, cx));
                                            }
                                        }
                                    }),
                            )
                    }))
                    .into_any_element()
            })
    }
}
