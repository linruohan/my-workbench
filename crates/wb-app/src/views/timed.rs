use crate::state::AppState;
use crate::timed_deliver::{fire_timed_task, skip_timed_task};
use crate::views::agent::AgentPane;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::empty::{Empty, EmptyDescription, EmptyHeader, EmptyTitle};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::tag::Tag;
use gpui_kit::component::*;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use wb_domain::{
    TimedIntervalUnit, TimedRunState, TimedSchedule, TimedSchedulePreset, create_timed_task_draft,
    format_timed_instant, is_timed_task_auto_due, make_custom_schedule_ending,
    make_once_from_clock, make_preset_schedule, now_ms, patch_timed_task, set_timed_task_enabled,
    timed_interval_unit_label, timed_preset_label, timed_run_state, timed_run_state_label,
    timed_schedule_label, timed_tasks_in_display_order,
};

pub struct TimedPane {
    state: AppState,
    title: Entity<InputState>,
    command: Entity<InputState>,
    custom_every: Entity<InputState>,
    custom_at: Entity<InputState>,
    custom_end: Entity<InputState>,
    custom_unit: TimedIntervalUnit,
    agent: Option<Entity<AgentPane>>,
    pending_delete_id: Option<String>,
    editing_id: Option<String>,
}

impl TimedPane {
    pub fn new(state: AppState, window: &mut Window, cx: &mut Context<Self>) -> Self {
        Self {
            state,
            title: cx.new(|cx| InputState::new(window, cx).placeholder("标题，例如：晨间简报")),
            command: cx.new(|cx| {
                InputState::new(window, cx).placeholder("投递给 Agent 的指令；留空则只发通知")
            }),
            custom_every: cx.new(|cx| {
                InputState::new(window, cx)
                    .placeholder("间隔")
                    .default_value("2")
            }),
            custom_at: cx.new(|cx| {
                InputState::new(window, cx)
                    .placeholder("时刻 HH:MM")
                    .default_value("09:00")
            }),
            custom_end: cx
                .new(|cx| InputState::new(window, cx).placeholder("结束日期 YYYY-MM-DD，可空")),
            custom_unit: TimedIntervalUnit::Day,
            agent: None,
            pending_delete_id: None,
            editing_id: None,
        }
    }

    pub fn bind_agent(&mut self, agent: Entity<AgentPane>) {
        self.agent = Some(agent);
    }

    fn form_title_command(&self, cx: &Context<Self>) -> (String, String) {
        let title = self.title.read(cx).value().to_string();
        let command = self.command.read(cx).value().to_string();
        let title = if title.trim().is_empty() {
            "未命名定时任务".to_string()
        } else {
            title.trim().to_string()
        };
        (title, command)
    }

    fn clear_form(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.editing_id = None;
        self.title.update(cx, |input, cx| {
            input.set_value("", window, cx);
        });
        self.command.update(cx, |input, cx| {
            input.set_value("", window, cx);
        });
    }

    fn commit_schedule(
        &mut self,
        schedule: TimedSchedule,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (title, command) = self.form_title_command(cx);
        if let Some(id) = self.editing_id.clone() {
            let now = now_ms();
            let updated = self.state.with(|s| {
                s.repo.get_timed_task(&id).cloned().map(|task| {
                    patch_timed_task(
                        &task,
                        Some(&title),
                        Some(&command),
                        Some(Some(schedule.clone())),
                        None,
                        None,
                        now,
                    )
                })
            });
            if let Some(task) = updated {
                self.state.with_mut(|s| s.repo.upsert_timed_task(task));
            } else {
                self.insert_new(&title, &command, schedule);
            }
        } else {
            self.insert_new(&title, &command, schedule);
        }
        self.clear_form(window, cx);
        self.state.persist_if_dirty();
        cx.notify();
    }

    fn insert_new(&self, title: &str, command: &str, schedule: TimedSchedule) {
        let task = create_timed_task_draft(Some(title), Some(command), Some(schedule), None);
        self.state.with_mut(|s| s.repo.upsert_timed_task(task));
    }

    fn add_preset(
        &mut self,
        preset: TimedSchedulePreset,
        at_time: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.commit_schedule(make_preset_schedule(preset, at_time), window, cx);
    }

    fn add_once(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let at = self.custom_at.read(cx).value().to_string();
        let at = if at.trim().is_empty() {
            "09:00"
        } else {
            at.trim()
        };
        self.commit_schedule(make_once_from_clock(now_ms(), at), window, cx);
    }

    fn add_custom(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let every = self
            .custom_every
            .read(cx)
            .value()
            .trim()
            .parse::<i64>()
            .unwrap_or(1)
            .max(1);
        let at = self.custom_at.read(cx).value().to_string();
        let at = if at.trim().is_empty() {
            "09:00"
        } else {
            at.trim()
        };
        let end = self.custom_end.read(cx).value().to_string();
        let end = if end.trim().is_empty() {
            None
        } else {
            Some(end.trim())
        };
        let schedule = make_custom_schedule_ending(every, self.custom_unit, at, end);
        self.commit_schedule(schedule, window, cx);
    }

    fn begin_edit(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let task = self.state.with(|s| s.repo.get_timed_task(id).cloned());
        let Some(task) = task else {
            return;
        };
        self.editing_id = Some(id.to_string());
        self.pending_delete_id = None;
        let title = task.title.clone();
        let command = task.command.clone();
        self.title.update(cx, |input, cx| {
            input.set_value(title, window, cx);
        });
        self.command.update(cx, |input, cx| {
            input.set_value(command, window, cx);
        });
        if let Some(wb_domain::TimedSchedule::Custom {
            every,
            unit,
            at_time,
            end_date,
            ..
        }) = task.schedule
        {
            self.custom_unit = unit;
            let every = every.to_string();
            let end = end_date.unwrap_or_default();
            self.custom_every.update(cx, |input, cx| {
                input.set_value(every, window, cx);
            });
            self.custom_at.update(cx, |input, cx| {
                input.set_value(at_time, window, cx);
            });
            self.custom_end.update(cx, |input, cx| {
                input.set_value(end, window, cx);
            });
        }
        cx.notify();
    }

    fn cancel_edit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.clear_form(window, cx);
        cx.notify();
    }

    fn after_deliver(&mut self, cx: &mut Context<Self>) {
        if let Some(agent) = &self.agent {
            agent.update(cx, |_, cx| cx.notify());
        }
        cx.notify();
    }

    fn run_now(&mut self, id: &str, cx: &mut Context<Self>) {
        let task = self.state.with(|s| s.repo.get_timed_task(id).cloned());
        let Some(task) = task else {
            return;
        };
        fire_timed_task(&self.state, &task, cx, |this, cx| {
            this.after_deliver(cx);
        });
        self.after_deliver(cx);
    }

    fn skip_once(&mut self, id: &str, cx: &mut Context<Self>) {
        let task = self.state.with(|s| s.repo.get_timed_task(id).cloned());
        let Some(task) = task else {
            return;
        };
        skip_timed_task(&self.state, &task);
        cx.notify();
    }

    fn delete(&mut self, id: &str, cx: &mut Context<Self>) {
        let confirm = self.state.with(|s| s.prefs.general.confirm_before_delete);
        if confirm && self.pending_delete_id.as_deref() != Some(id) {
            self.pending_delete_id = Some(id.to_string());
            cx.notify();
            return;
        }
        self.pending_delete_id = None;
        if self.editing_id.as_deref() == Some(id) {
            self.editing_id = None;
        }
        self.state.with_mut(|s| s.repo.delete_timed_task(id));
        self.state.persist_if_dirty();
        cx.notify();
    }

    fn toggle_enabled(&mut self, id: &str, cx: &mut Context<Self>) {
        let now = now_ms();
        self.state.with_mut(|s| {
            if let Some(task) = s.repo.get_timed_task(id).cloned() {
                let task = set_timed_task_enabled(&task, !task.enabled, now);
                s.repo.upsert_timed_task(task);
            }
        });
        self.state.persist_if_dirty();
        cx.notify();
    }

    pub fn tick_due(&mut self, cx: &mut Context<Self>) {
        let now = now_ms();
        let due: Vec<_> = self.state.with(|s| {
            s.repo
                .list_timed_tasks()
                .into_iter()
                .filter(|t| is_timed_task_auto_due(t, now))
                .collect()
        });
        if due.is_empty() {
            return;
        }
        for task in due {
            fire_timed_task(&self.state, &task, cx, |this, cx| {
                this.after_deliver(cx);
            });
        }
        self.after_deliver(cx);
    }

    fn preset_button(
        &self,
        id: &'static str,
        preset: TimedSchedulePreset,
        at: &'static str,
        cx: &mut Context<Self>,
    ) -> Button {
        let label = if matches!(preset, TimedSchedulePreset::Hourly) {
            timed_preset_label(preset).to_string()
        } else {
            format!("{} {at}", timed_preset_label(preset))
        };
        Button::new(id)
            .small()
            .label(label)
            .on_click(cx.listener(move |this, _, window, cx| {
                this.add_preset(preset, at, window, cx);
            }))
    }
}

fn command_preview(command: &str) -> String {
    let flat = command.trim().replace('\n', " ");
    if flat.is_empty() {
        return "未填写指令，到期只发通知".into();
    }
    let chars: Vec<char> = flat.chars().collect();
    if chars.len() > 96 {
        format!("{}…", chars.into_iter().take(96).collect::<String>())
    } else {
        flat
    }
}

fn status_tag(state: TimedRunState) -> Tag {
    let label = timed_run_state_label(state);
    match state {
        TimedRunState::Missed | TimedRunState::Due => Tag::danger().xsmall().child(label),
        TimedRunState::Soon => Tag::warning().xsmall().child(label),
        TimedRunState::Scheduled => Tag::success().xsmall().child(label),
        TimedRunState::Disabled => Tag::secondary().xsmall().child(label),
        TimedRunState::Unscheduled => Tag::secondary().xsmall().outline().child(label),
    }
}

impl Render for TimedPane {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let now = now_ms();
        let tasks = self.state.with(|s| s.repo.list_timed_tasks());
        let tasks = timed_tasks_in_display_order(&tasks, now);
        let enabled_count = tasks.iter().filter(|task| task.enabled).count();
        let attention = tasks
            .iter()
            .filter(|task| {
                matches!(
                    timed_run_state(task, now),
                    TimedRunState::Missed | TimedRunState::Due
                )
            })
            .count();
        let entity = cx.weak_entity();
        let radius = cx.theme().radius;
        let border = cx.theme().border;
        let muted = cx.theme().muted_foreground;
        let editing = self.editing_id.clone();

        v_flex()
            .size_full()
            .gap_3()
            .p_4()
            .child(
                h_flex()
                    .items_center()
                    .gap_2()
                    .flex_wrap()
                    .child(div().text_xl().font_bold().child("定时任务"))
                    .child(
                        Tag::secondary()
                            .small()
                            .child(format!("启用 {enabled_count}/{}", tasks.len())),
                    )
                    .when(attention > 0, |row| {
                        row.child(Tag::danger().small().child(format!("待处理 {attention}")))
                    }),
            )
            .child(
                v_flex()
                    .gap_3()
                    .p_3()
                    .rounded(radius)
                    .border_1()
                    .border_color(border)
                    .bg(cx.theme().secondary.opacity(0.28))
                    .when(editing.is_some(), |card| {
                        card.child(
                            h_flex()
                                .items_center()
                                .gap_2()
                                .child(Tag::info().xsmall().child("正在编辑"))
                                .child(
                                    div()
                                        .flex_1()
                                        .text_xs()
                                        .text_color(muted)
                                        .child("改完后点预设或自定义，会覆盖当前计划"),
                                )
                                .child(
                                    Button::new("cancel-edit")
                                        .xsmall()
                                        .ghost()
                                        .label("取消")
                                        .on_click(cx.listener(|this, _, window, cx| {
                                            this.cancel_edit(window, cx);
                                        })),
                                ),
                        )
                    })
                    .child(Input::new(&self.title).cleanable(true))
                    .child(Input::new(&self.command).cleanable(true))
                    .child(
                        div()
                            .text_xs()
                            .font_bold()
                            .text_color(muted)
                            .child(if editing.is_some() {
                                "保存为所选计划"
                            } else {
                                "用预设添加"
                            }),
                    )
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
                            ))
                            .child(
                                Button::new("preset-once")
                                    .small()
                                    .label("一次性")
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.add_once(window, cx);
                                    })),
                            ),
                    )
                    .child(
                        div()
                            .text_xs()
                            .font_bold()
                            .text_color(muted)
                            .child("自定义间隔"),
                    )
                    .child(
                        h_flex()
                            .gap_2()
                            .flex_wrap()
                            .items_center()
                            .child(Input::new(&self.custom_every).w(px(72.)))
                            .children(
                                [
                                    TimedIntervalUnit::Hour,
                                    TimedIntervalUnit::Day,
                                    TimedIntervalUnit::Week,
                                    TimedIntervalUnit::Month,
                                ]
                                .into_iter()
                                .map(|unit| {
                                    let selected = self.custom_unit == unit;
                                    let label = timed_interval_unit_label(unit);
                                    Button::new(SharedString::from(format!("unit-{label}")))
                                        .xsmall()
                                        .when(selected, |b| b.primary())
                                        .when(!selected, |b| b.ghost())
                                        .label(label)
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            this.custom_unit = unit;
                                            cx.notify();
                                        }))
                                }),
                            )
                            .child(Input::new(&self.custom_at).w(px(108.)))
                            .child(Input::new(&self.custom_end).w(px(196.)))
                            .child(
                                Button::new("add-custom")
                                    .small()
                                    .primary()
                                    .label(if editing.is_some() {
                                        "保存自定义"
                                    } else {
                                        "添加自定义"
                                    })
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.add_custom(window, cx);
                                    })),
                            ),
                    ),
            )
            .child(if tasks.is_empty() {
                Empty::new()
                    .header(
                        EmptyHeader::new()
                            .title(EmptyTitle::new().child("还没有定时任务"))
                            .description(
                                EmptyDescription::new().child(
                                    "写下标题和指令，选一个节奏。到期后会通知你，并在有指令时投递给 Agent。错过的触发不会自动补跑。",
                                ),
                            ),
                    )
                    .into_any_element()
            } else {
                let pending_delete_id = self.pending_delete_id.clone();
                let editing_id = self.editing_id.clone();
                div()
                    .flex()
                    .flex_row()
                    .flex_wrap()
                    .items_stretch()
                    .content_start()
                    .justify_start()
                    .gap_3()
                    .w_full()
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scrollbar()
                    .children(tasks.into_iter().map(|task| {
                        let id = task.id.clone();
                        let state = timed_run_state(&task, now);
                        let sched = timed_schedule_label(task.schedule.as_ref());
                        let next_label = task
                            .next_run_at
                            .map(|ms| format_timed_instant(ms, now))
                            .unwrap_or_else(|| "无".into());
                        let last_label = task
                            .last_run_at
                            .map(|ms| format_timed_instant(ms, now))
                            .unwrap_or_else(|| "尚未执行".into());
                        let preview = command_preview(&task.command);
                        let pending_delete = pending_delete_id.as_deref() == Some(id.as_str());
                        let is_editing = editing_id.as_deref() == Some(id.as_str());
                        let enabled = task.enabled;
                        let entity = entity.clone();
                        v_flex()
                            .id(SharedString::from(format!("timed-{id}")))
                            .w(px(360.))
                            .flex_shrink_1()
                            .min_w(px(280.))
                            .gap_2()
                            .p_3()
                            .rounded(radius)
                            .border_1()
                            .border_color(match state {
                                TimedRunState::Missed | TimedRunState::Due => cx.theme().danger,
                                TimedRunState::Soon => cx.theme().warning,
                                _ if is_editing => cx.theme().primary,
                                _ => border,
                            })
                            .bg(cx.theme().secondary.opacity(0.22))
                            .when(!enabled, |card| card.opacity(0.62))
                            .child(
                                h_flex()
                                    .gap_2()
                                    .items_start()
                                    .justify_between()
                                    .child(
                                        div()
                                            .flex_1()
                                            .min_w_0()
                                            .font_bold()
                                            .whitespace_normal()
                                            .child(task.title.clone()),
                                    )
                                    .child(status_tag(state)),
                            )
                            .child(
                                v_flex()
                                    .gap_1()
                                    .flex_1()
                                    .child(
                                        div()
                                            .text_xs()
                                            .text_color(muted)
                                            .whitespace_normal()
                                            .child(sched),
                                    )
                                    .child(
                                        div()
                                            .text_xs()
                                            .text_color(muted)
                                            .whitespace_normal()
                                            .child(format!("下次 {next_label} · 上次 {last_label}")),
                                    )
                                    .child(
                                        div()
                                            .text_sm()
                                            .text_color(muted)
                                            .whitespace_normal()
                                            .child(preview),
                                    ),
                            )
                            .child(
                                h_flex()
                                    .gap_2()
                                    .flex_wrap()
                                    .child(
                                        Button::new(SharedString::from(format!("toggle-{id}")))
                                            .xsmall()
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
                                            .xsmall()
                                            .primary()
                                            .label(if matches!(
                                                state,
                                                TimedRunState::Missed | TimedRunState::Due
                                            ) {
                                                "现在补跑"
                                            } else {
                                                "立即执行"
                                            })
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
                                        Button::new(SharedString::from(format!("edit-{id}")))
                                            .xsmall()
                                            .ghost()
                                            .label(if is_editing { "编辑中" } else { "编辑" })
                                            .on_click({
                                                let id = id.clone();
                                                let entity = entity.clone();
                                                move |_, window, app| {
                                                    if let Some(e) = entity.upgrade() {
                                                        e.update(app, |this, cx| {
                                                            this.begin_edit(&id, window, cx);
                                                        });
                                                    }
                                                }
                                            }),
                                    )
                                    .child(
                                        Button::new(SharedString::from(format!("skip-{id}")))
                                            .xsmall()
                                            .ghost()
                                            .label("跳过本次")
                                            .on_click({
                                                let id = id.clone();
                                                let entity = entity.clone();
                                                move |_, _, app| {
                                                    if let Some(e) = entity.upgrade() {
                                                        e.update(app, |this, cx| this.skip_once(&id, cx));
                                                    }
                                                }
                                            }),
                                    )
                                    .child(
                                        Button::new(SharedString::from(format!("del-{id}")))
                                            .xsmall()
                                            .danger()
                                            .label(if pending_delete {
                                                "确认删除"
                                            } else {
                                                "删除"
                                            })
                                            .on_click({
                                                let id = id.clone();
                                                move |_, _, app| {
                                                    if let Some(e) = entity.upgrade() {
                                                        e.update(app, |this, cx| this.delete(&id, cx));
                                                    }
                                                }
                                            }),
                                    ),
                            )
                    }))
                    .into_any_element()
            })
    }
}
