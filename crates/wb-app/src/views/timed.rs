use crate::state::AppState;
use crate::style;
use crate::timed_deliver::{fire_timed_task, skip_timed_task};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::empty::{Empty, EmptyDescription, EmptyHeader, EmptyTitle};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::tab::{Tab, TabBar};
use gpui_kit::component::tag::Tag;
use gpui_kit::component::{Selectable as _, *};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use std::cell::Cell;
use std::rc::Rc;
use wb_domain::{
    EndMode, TimedIntervalUnit, TimedRunOutcome, TimedRunState, TimedSchedule, TimedSchedulePreset,
    create_timed_task_draft, format_local_day, format_timed_instant, is_timed_task_auto_due,
    local_hour_minute, make_custom_schedule_ending, make_once_on_day, make_preset_schedule, now_ms,
    patch_timed_task, set_timed_task_enabled, timed_preset_label, timed_run_outcome_label,
    timed_run_state, timed_run_state_label, timed_schedule_label, timed_tasks_in_display_order,
};

#[derive(Clone, Copy, PartialEq, Eq)]
enum SchedulePick {
    Preset(TimedSchedulePreset),
    Once,
    Custom,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TimedDetailTab {
    Detail,
    History,
}

impl TimedDetailTab {
    fn index(self) -> usize {
        match self {
            Self::Detail => 0,
            Self::History => 1,
        }
    }

    fn from_index(index: usize) -> Self {
        if index == 1 {
            Self::History
        } else {
            Self::Detail
        }
    }
}

pub struct TimedPane {
    state: AppState,
    title: Entity<InputState>,
    command: Entity<InputState>,
    custom_every: Entity<InputState>,
    custom_at: Entity<InputState>,
    custom_end: Entity<InputState>,
    custom_end_at: Entity<InputState>,
    once_day: Entity<InputState>,
    custom_unit: TimedIntervalUnit,
    end_limited: bool,
    pick: SchedulePick,
    pending_delete_id: Option<String>,
    editing_id: Option<String>,
    composer_open: bool,
    open_id: Option<String>,
    detail_tab: TimedDetailTab,
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
            custom_end: cx.new(|cx| InputState::new(window, cx).placeholder("终止日期 YYYY-MM-DD")),
            custom_end_at: cx.new(|cx| {
                InputState::new(window, cx)
                    .placeholder("终止时间 HH:MM")
                    .default_value("18:00")
            }),
            once_day: cx.new(|cx| {
                InputState::new(window, cx)
                    .placeholder("日期 YYYY-MM-DD")
                    .default_value(format_local_day(now_ms()))
            }),
            custom_unit: TimedIntervalUnit::Day,
            end_limited: false,
            pick: SchedulePick::Preset(TimedSchedulePreset::Daily),
            pending_delete_id: None,
            editing_id: None,
            composer_open: false,
            open_id: None,
            detail_tab: TimedDetailTab::Detail,
        }
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

    fn set_input(input: &Entity<InputState>, value: String, window: &mut Window, cx: &mut App) {
        input.update(cx, |input, cx| input.set_value(value, window, cx));
    }

    fn reset_draft(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.editing_id = None;
        self.pick = SchedulePick::Preset(TimedSchedulePreset::Daily);
        self.custom_unit = TimedIntervalUnit::Day;
        self.end_limited = false;
        Self::set_input(&self.title, String::new(), window, cx);
        Self::set_input(&self.command, String::new(), window, cx);
        Self::set_input(&self.custom_every, "2".into(), window, cx);
        Self::set_input(&self.custom_at, "09:00".into(), window, cx);
        Self::set_input(&self.custom_end, String::new(), window, cx);
        Self::set_input(&self.custom_end_at, "18:00".into(), window, cx);
        Self::set_input(&self.once_day, format_local_day(now_ms()), window, cx);
    }

    fn clock_value(&self, cx: &Context<Self>) -> String {
        let at = self.custom_at.read(cx).value().to_string();
        if at.trim().is_empty() {
            "09:00".to_string()
        } else {
            at.trim().to_string()
        }
    }

    fn current_schedule(&self, cx: &Context<Self>) -> TimedSchedule {
        let at = self.clock_value(cx);
        match self.pick {
            SchedulePick::Preset(TimedSchedulePreset::Hourly) => {
                make_preset_schedule(TimedSchedulePreset::Hourly, "00:00")
            }
            SchedulePick::Preset(preset) => make_preset_schedule(preset, &at),
            SchedulePick::Once => {
                let day = self.once_day.read(cx).value().to_string();
                make_once_on_day(day.trim(), &at, now_ms())
            }
            SchedulePick::Custom => {
                let every = self
                    .custom_every
                    .read(cx)
                    .value()
                    .trim()
                    .parse::<i64>()
                    .unwrap_or(1)
                    .max(1);
                let (end_day, end_clock) = if self.end_limited {
                    let day = self.custom_end.read(cx).value().to_string();
                    let clock = self.custom_end_at.read(cx).value().to_string();
                    (
                        (!day.trim().is_empty()).then(|| day.trim().to_string()),
                        (!clock.trim().is_empty()).then(|| clock.trim().to_string()),
                    )
                } else {
                    (None, None)
                };
                make_custom_schedule_ending(
                    every,
                    self.custom_unit,
                    &at,
                    end_day.as_deref(),
                    end_clock.as_deref(),
                )
            }
        }
    }

    fn commit_schedule(&mut self, schedule: TimedSchedule, cx: &mut Context<Self>) {
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
        self.editing_id = None;
        self.composer_open = false;
        self.state.persist_if_dirty();
        cx.notify();
    }

    fn commit_composer(&mut self, cx: &mut Context<Self>) -> bool {
        let schedule = self.current_schedule(cx);
        self.commit_schedule(schedule, cx);
        true
    }

    fn insert_new(&self, title: &str, command: &str, schedule: TimedSchedule) {
        let task = create_timed_task_draft(Some(title), Some(command), Some(schedule), None);
        self.state.with_mut(|s| s.repo.upsert_timed_task(task));
    }

    fn dismiss_composer(&mut self, cx: &mut Context<Self>) {
        self.composer_open = false;
        self.editing_id = None;
        cx.notify();
    }

    fn present_composer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.composer_open {
            return;
        }
        self.composer_open = true;
        let title_input = self.title.clone();
        let command_input = self.command.clone();
        let every_input = self.custom_every.clone();
        let at_input = self.custom_at.clone();
        let end_input = self.custom_end.clone();
        let end_at_input = self.custom_end_at.clone();
        let once_input = self.once_day.clone();
        let pane = cx.weak_entity();
        let focus_once = Rc::new(Cell::new(true));
        window.open_dialog(cx, move |dialog, window, cx| {
            if focus_once.replace(false) {
                title_input.update(cx, |input, cx| input.focus(window, cx));
            }
            let (editing, pick, unit, end_limited) = pane
                .read_with(cx, |this, _| {
                    (
                        this.editing_id.is_some(),
                        this.pick,
                        this.custom_unit,
                        this.end_limited,
                    )
                })
                .unwrap_or((
                    false,
                    SchedulePick::Preset(TimedSchedulePreset::Daily),
                    TimedIntervalUnit::Day,
                    false,
                ));
            let heading = if editing {
                "编辑定时任务"
            } else {
                "添加定时任务"
            };
            let confirm = if editing { "保存" } else { "创建" };
            let show_once = matches!(pick, SchedulePick::Once);
            let show_custom = matches!(pick, SchedulePick::Custom);
            let show_preset_clock = matches!(
                pick,
                SchedulePick::Preset(
                    TimedSchedulePreset::Daily
                        | TimedSchedulePreset::Weekdays
                        | TimedSchedulePreset::Weekly
                        | TimedSchedulePreset::Monthly
                )
            );
            let show_custom_clock =
                show_custom && !matches!(unit, TimedIntervalUnit::Minute | TimedIntervalUnit::Hour);
            let save_pane = pane.clone();
            let cancel_pane = pane.clone();
            dialog
                .title(heading)
                .w(px(600.))
                .on_cancel({
                    let cancel_pane = cancel_pane.clone();
                    move |_, _, cx| {
                        cancel_pane
                            .update(cx, |pane, cx| pane.dismiss_composer(cx))
                            .ok();
                        true
                    }
                })
                .child(
                    v_flex()
                        .w_full()
                        .gap_3()
                        .px_4()
                        .pb_2()
                        .child(Input::new(&title_input).cleanable(true))
                        .child(Input::new(&command_input).cleanable(true))
                        .child(div().text_xs().font_bold().child("计划"))
                        .child(
                            h_flex()
                                .gap_2()
                                .flex_wrap()
                                .children(preset_choices(pick, pane.clone()))
                                .child(
                                    paint_choice(
                                        Button::new("pick-once").small().label("一次性"),
                                        matches!(pick, SchedulePick::Once),
                                    )
                                    .on_click({
                                        let pane = pane.clone();
                                        move |_, _, cx| {
                                            pane.update(cx, |this, cx| {
                                                this.pick = SchedulePick::Once;
                                                cx.notify();
                                            })
                                            .ok();
                                        }
                                    }),
                                )
                                .child(
                                    paint_choice(
                                        Button::new("pick-custom").small().label("自定义"),
                                        show_custom,
                                    )
                                    .on_click({
                                        let pane = pane.clone();
                                        move |_, _, cx| {
                                            pane.update(cx, |this, cx| {
                                                this.pick = SchedulePick::Custom;
                                                cx.notify();
                                            })
                                            .ok();
                                        }
                                    }),
                                ),
                        )
                        .child(
                            div()
                                .text_xs()
                                .text_color(cx.theme().muted_foreground)
                                .child(if editing {
                                    "改完后点「保存」，才会覆盖当前计划。"
                                } else {
                                    "选好计划后点「创建」，才会添加定时任务。"
                                }),
                        )
                        .when(
                            matches!(pick, SchedulePick::Preset(TimedSchedulePreset::Hourly)),
                            |col| {
                                col.child(
                                    div()
                                        .text_xs()
                                        .text_color(cx.theme().muted_foreground)
                                        .child("每小时整点重复，不用填时刻。"),
                                )
                            },
                        )
                        .when(show_once, |col| {
                            let at_input = at_input.clone();
                            col.child(
                                h_flex()
                                    .gap_2()
                                    .flex_wrap()
                                    .items_end()
                                    .child(
                                        v_flex()
                                            .gap_1()
                                            .child(div().text_xs().font_bold().child("日期"))
                                            .child(Input::new(&once_input).w(px(160.))),
                                    )
                                    .child(
                                        v_flex()
                                            .gap_1()
                                            .child(div().text_xs().font_bold().child("时间"))
                                            .child(Input::new(&at_input).w(px(120.))),
                                    ),
                            )
                        })
                        .when(show_preset_clock, |col| {
                            let at_input = at_input.clone();
                            col.child(
                                v_flex()
                                    .gap_1()
                                    .child(div().text_xs().font_bold().child("时间"))
                                    .child(Input::new(&at_input).w(px(120.))),
                            )
                        })
                        .when(show_custom, |col| {
                            let pane = pane.clone();
                            let at_input = at_input.clone();
                            col.child(
                                v_flex()
                                    .gap_2()
                                    .child(div().text_xs().font_bold().child("每"))
                                    .child(
                                        h_flex()
                                            .gap_2()
                                            .flex_wrap()
                                            .items_center()
                                            .child(Input::new(&every_input).w(px(72.)))
                                            .children(
                                                [
                                                    (TimedIntervalUnit::Minute, "分钟"),
                                                    (TimedIntervalUnit::Hour, "小时"),
                                                    (TimedIntervalUnit::Day, "日"),
                                                    (TimedIntervalUnit::Month, "月"),
                                                    (TimedIntervalUnit::Week, "周"),
                                                    (TimedIntervalUnit::Year, "年"),
                                                ]
                                                .into_iter()
                                                .map(|(item, label)| {
                                                    let selected = unit == item;
                                                    paint_choice(
                                                        Button::new(SharedString::from(format!(
                                                            "unit-{label}"
                                                        )))
                                                        .xsmall()
                                                        .label(label),
                                                        selected,
                                                    )
                                                    .on_click({
                                                        let pane = pane.clone();
                                                        move |_, _, cx| {
                                                            pane.update(cx, |this, cx| {
                                                                this.custom_unit = item;
                                                                cx.notify();
                                                            })
                                                            .ok();
                                                        }
                                                    })
                                                }),
                                            ),
                                    )
                                    .when(
                                        matches!(
                                            unit,
                                            TimedIntervalUnit::Minute | TimedIntervalUnit::Hour
                                        ),
                                        |form| {
                                            form.child(
                                                div()
                                                    .text_xs()
                                                    .text_color(cx.theme().muted_foreground)
                                                    .child("分钟和小时从现在起按间隔重复。"),
                                            )
                                        },
                                    )
                                    .when(show_custom_clock, |form| {
                                        form.child(
                                            v_flex()
                                                .gap_1()
                                                .child(div().text_xs().font_bold().child("时间"))
                                                .child(Input::new(&at_input).w(px(120.))),
                                        )
                                    })
                                    .child(div().text_xs().font_bold().child("终止日期和时间"))
                                    .child(
                                        h_flex()
                                            .gap_2()
                                            .flex_wrap()
                                            .child(
                                                paint_choice(
                                                    Button::new("end-never").small().label("从不"),
                                                    !end_limited,
                                                )
                                                .on_click({
                                                    let pane = pane.clone();
                                                    move |_, _, cx| {
                                                        pane.update(cx, |this, cx| {
                                                            this.end_limited = false;
                                                            cx.notify();
                                                        })
                                                        .ok();
                                                    }
                                                }),
                                            )
                                            .child(
                                                paint_choice(
                                                    Button::new("end-on")
                                                        .small()
                                                        .label("选择日期和时间"),
                                                    end_limited,
                                                )
                                                .on_click({
                                                    let pane = pane.clone();
                                                    let end_input = end_input.clone();
                                                    let end_at_input = end_at_input.clone();
                                                    move |_, window, cx| {
                                                        pane.update(cx, |this, cx| {
                                                            this.end_limited = true;
                                                            cx.notify();
                                                        })
                                                        .ok();
                                                        if end_input
                                                            .read(cx)
                                                            .value()
                                                            .trim()
                                                            .is_empty()
                                                        {
                                                            Self::set_input(
                                                                &end_input,
                                                                format_local_day(now_ms()),
                                                                window,
                                                                cx,
                                                            );
                                                        }
                                                        if end_at_input
                                                            .read(cx)
                                                            .value()
                                                            .trim()
                                                            .is_empty()
                                                        {
                                                            Self::set_input(
                                                                &end_at_input,
                                                                "18:00".into(),
                                                                window,
                                                                cx,
                                                            );
                                                        }
                                                    }
                                                }),
                                            ),
                                    )
                                    .when(end_limited, |form| {
                                        form.child(
                                            h_flex()
                                                .gap_2()
                                                .flex_wrap()
                                                .items_center()
                                                .child(Input::new(&end_input).w(px(180.)))
                                                .child(Input::new(&end_at_input).w(px(140.))),
                                        )
                                    }),
                            )
                        }),
                )
                .footer(
                    h_flex()
                        .w_full()
                        .justify_end()
                        .gap_2()
                        .px_4()
                        .pb_2()
                        .child(
                            Button::new("cancel-timed-composer")
                                .small()
                                .outline()
                                .label("取消")
                                .on_click({
                                    let cancel_pane = cancel_pane.clone();
                                    move |_, window, cx| {
                                        cancel_pane
                                            .update(cx, |pane, cx| pane.dismiss_composer(cx))
                                            .ok();
                                        window.close_dialog(cx);
                                    }
                                }),
                        )
                        .child(
                            Button::new("save-timed-composer")
                                .small()
                                .primary()
                                .label(confirm)
                                .on_click(move |_, window, cx| {
                                    let saved = save_pane
                                        .update(cx, |pane, cx| pane.commit_composer(cx))
                                        .unwrap_or(false);
                                    if saved {
                                        window.close_dialog(cx);
                                    }
                                }),
                        ),
                )
        });
    }

    fn open_create(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.reset_draft(window, cx);
        self.present_composer(window, cx);
    }

    fn begin_edit(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let task = self.state.with(|s| s.repo.get_timed_task(id).cloned());
        let Some(task) = task else {
            return;
        };
        self.editing_id = Some(id.to_string());
        self.pending_delete_id = None;
        self.open_id = Some(id.to_string());
        self.end_limited = false;
        Self::set_input(&self.title, task.title.clone(), window, cx);
        Self::set_input(&self.command, task.command.clone(), window, cx);
        Self::set_input(&self.once_day, format_local_day(now_ms()), window, cx);
        Self::set_input(&self.custom_end_at, "18:00".into(), window, cx);
        match task.schedule {
            Some(TimedSchedule::Preset { preset, at_time }) => {
                self.pick = SchedulePick::Preset(preset);
                Self::set_input(&self.custom_at, at_time, window, cx);
            }
            Some(TimedSchedule::Once { at }) => {
                self.pick = SchedulePick::Once;
                let (hour, minute) = local_hour_minute(at);
                Self::set_input(&self.once_day, format_local_day(at), window, cx);
                Self::set_input(
                    &self.custom_at,
                    format!("{hour:02}:{minute:02}"),
                    window,
                    cx,
                );
            }
            Some(TimedSchedule::Custom {
                every,
                unit,
                at_time,
                end_mode,
                end_date,
                end_time,
            }) => {
                self.pick = SchedulePick::Custom;
                self.custom_unit = unit;
                self.end_limited = matches!(end_mode, EndMode::OnDate);
                Self::set_input(&self.custom_every, every.to_string(), window, cx);
                Self::set_input(&self.custom_at, at_time, window, cx);
                Self::set_input(&self.custom_end, end_date.unwrap_or_default(), window, cx);
                Self::set_input(
                    &self.custom_end_at,
                    end_time.unwrap_or_else(|| "23:59".into()),
                    window,
                    cx,
                );
            }
            None => {
                self.pick = SchedulePick::Preset(TimedSchedulePreset::Daily);
            }
        }
        self.present_composer(window, cx);
    }

    fn open_task(&mut self, id: &str, cx: &mut Context<Self>) {
        if self.open_id.as_deref() != Some(id) {
            self.detail_tab = TimedDetailTab::Detail;
            self.pending_delete_id = None;
        }
        self.open_id = Some(id.to_string());
        cx.notify();
    }

    fn close_task(&mut self, cx: &mut Context<Self>) {
        self.open_id = None;
        self.pending_delete_id = None;
        cx.notify();
    }

    fn after_deliver(&mut self, cx: &mut Context<Self>) {
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
        if self.open_id.as_deref() == Some(id) {
            self.open_id = None;
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

fn format_run_time(ms: i64) -> String {
    let day = format_local_day(ms);
    let (hour, minute) = local_hour_minute(ms);
    format!("{day} {hour:02}:{minute:02}")
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

fn outcome_tag(status: TimedRunOutcome) -> Tag {
    let label = timed_run_outcome_label(status);
    match status {
        TimedRunOutcome::Executed => Tag::success().xsmall().child(label),
        TimedRunOutcome::Skipped => Tag::secondary().xsmall().outline().child(label),
    }
}

fn paint_choice(button: Button, selected: bool) -> Button {
    if selected {
        button.primary().selected(true)
    } else {
        button.outline()
    }
}

fn paint_enabled(button: Button, enabled: bool) -> Button {
    if enabled {
        button
            .success()
            .selected(true)
            .label("启用")
            .tooltip("当前启用，点击停用")
    } else {
        button.outline().label("停用").tooltip("当前停用，点击启用")
    }
}

fn preset_choices(pick: SchedulePick, pane: WeakEntity<TimedPane>) -> Vec<Button> {
    [
        TimedSchedulePreset::Hourly,
        TimedSchedulePreset::Daily,
        TimedSchedulePreset::Weekdays,
        TimedSchedulePreset::Weekly,
        TimedSchedulePreset::Monthly,
    ]
    .into_iter()
    .map(|preset| {
        let selected = matches!(pick, SchedulePick::Preset(current) if current == preset);
        let label = timed_preset_label(preset);
        paint_choice(
            Button::new(SharedString::from(format!("pick-{label}")))
                .small()
                .label(label),
            selected,
        )
        .on_click({
            let pane = pane.clone();
            move |_, _, cx| {
                pane.update(cx, |this, cx| {
                    this.pick = SchedulePick::Preset(preset);
                    cx.notify();
                })
                .ok();
            }
        })
    })
    .collect()
}

impl TimedPane {
    /// Title and actions that used to sit under the page bar.
    pub fn chrome_header(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let now = now_ms();
        let tasks = self.state.with(|s| s.repo.list_timed_tasks());
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
        h_flex()
            .flex_1()
            .min_w_0()
            .items_center()
            .gap_2()
            .child(
                h_flex()
                    .min_w_0()
                    .items_center()
                    .gap_2()
                    .child(
                        div()
                            .w(px(3.))
                            .h(px(18.))
                            .rounded_full()
                            .bg(cx.theme().primary),
                    )
                    .child(
                        div()
                            .min_w_0()
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .text_ellipsis()
                            .text_xl()
                            .font_bold()
                            .child("定时任务"),
                    ),
            )
            .child(
                Tag::secondary()
                    .small()
                    .child(format!("启用 {enabled_count}/{}", tasks.len())),
            )
            .when(attention > 0, |row| {
                row.child(Tag::danger().small().child(format!("待处理 {attention}")))
            })
            .child(div().flex_1())
            .child(
                Button::new("add-timed-task")
                    .small()
                    .primary()
                    .icon(IconName::Plus)
                    .label("添加定时任务")
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.open_create(window, cx);
                    })),
            )
            .into_any_element()
    }
}

impl Render for TimedPane {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let now = now_ms();
        let tasks = self.state.with(|s| s.repo.list_timed_tasks());
        let tasks = timed_tasks_in_display_order(&tasks, now);
        let entity = cx.weak_entity();
        let radius = style::card_radius(cx);
        let border = style::hairline(cx);
        let muted = cx.theme().muted_foreground;
        let open_id = self.open_id.clone();
        let open_task = open_id
            .as_ref()
            .and_then(|id| tasks.iter().find(|task| &task.id == id).cloned());
        let pending_delete_id = self.pending_delete_id.clone();
        let detail_tab = self.detail_tab;

        let list = if tasks.is_empty() {
            Empty::new()
                .header(
                    EmptyHeader::new()
                        .title(EmptyTitle::new().child("还没有定时任务"))
                        .description(
                            EmptyDescription::new().child(
                                "点右上角「添加定时任务」。选好计划后点创建，到期会通知你，并在有指令时投递给 Agent。",
                            ),
                        ),
                )
                .into_any_element()
        } else {
            let hover_bg = cx.theme().accent.opacity(0.16);
            div()
                .flex()
                .flex_row()
                .flex_wrap()
                .items_stretch()
                .content_start()
                .justify_start()
                .gap_3()
                .w_full()
                .children(tasks.iter().map(|task| {
                    let id = task.id.clone();
                    let state = timed_run_state(task, now);
                    let sched = timed_schedule_label(task.schedule.as_ref());
                    let next_label = task
                        .next_run_at
                        .map(|ms| format_timed_instant(ms, now))
                        .unwrap_or_else(|| "无".into());
                    let preview = command_preview(&task.command);
                    let enabled = task.enabled;
                    let is_open = open_id.as_deref() == Some(id.as_str());
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
                        .border_color(if is_open {
                            cx.theme().primary
                        } else {
                            match state {
                                TimedRunState::Missed | TimedRunState::Due => cx.theme().danger,
                                TimedRunState::Soon => cx.theme().warning,
                                _ => border,
                            }
                        })
                        .bg(if is_open {
                            cx.theme().primary.opacity(0.12)
                        } else {
                            style::card(cx).opacity(0.6)
                        })
                        .when(!enabled, |card| card.opacity(0.72))
                        .cursor_pointer()
                        .hover(move |style| style.bg(hover_bg))
                        .on_click({
                            let entity = entity.clone();
                            let id = id.clone();
                            move |_, _, app| {
                                if let Some(view) = entity.upgrade() {
                                    view.update(app, |this, cx| this.open_task(&id, cx));
                                }
                            }
                        })
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
                            div()
                                .text_xs()
                                .text_color(muted)
                                .whitespace_normal()
                                .child(format!("{sched} · 下次 {next_label}")),
                        )
                        .child(
                            div()
                                .text_sm()
                                .text_color(muted)
                                .text_ellipsis()
                                .child(preview),
                        )
                        .child(
                            paint_enabled(
                                Button::new(SharedString::from(format!("toggle-{id}"))).xsmall(),
                                enabled,
                            )
                            .on_click({
                                let id = id.clone();
                                let entity = entity.clone();
                                move |_, _, app| {
                                    app.stop_propagation();
                                    if let Some(view) = entity.upgrade() {
                                        view.update(app, |this, cx| this.toggle_enabled(&id, cx));
                                    }
                                }
                            }),
                        )
                }))
                .into_any_element()
        };

        let detail = open_task.map(|task| {
            let id = task.id.clone();
            let state = timed_run_state(&task, now);
            let sched = timed_schedule_label(task.schedule.as_ref());
            let next_label = task
                .next_run_at
                .map(|ms| format_timed_instant(ms, now))
                .unwrap_or_else(|| "无".into());
            let last_label = task
                .last_run_at
                .map(format_run_time)
                .unwrap_or_else(|| "尚未执行".into());
            let pending_delete = pending_delete_id.as_deref() == Some(id.as_str());
            let enabled = task.enabled;
            let runs = self.state.with(|s| s.repo.list_timed_runs(&id));
            let entity = entity.clone();
            v_flex()
                .id("timed-detail")
                .w(px(420.))
                .h_full()
                .min_h_0()
                .min_w(px(320.))
                .gap_2()
                .p_3()
                .rounded(radius)
                .border_1()
                .border_color(border)
                .bg(cx.theme().background)
                .child(
                    h_flex()
                        .items_start()
                        .gap_2()
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .font_bold()
                                .whitespace_normal()
                                .child(task.title.clone()),
                        )
                        .child(status_tag(state))
                        .child(
                            Button::new("close-timed-detail")
                                .xsmall()
                                .ghost()
                                .label("关闭")
                                .on_click(cx.listener(|this, _, _, cx| this.close_task(cx))),
                        ),
                )
                .child(
                    TabBar::new("timed-detail-tabs")
                        .underline()
                        .small()
                        .w_full()
                        .selected_index(detail_tab.index())
                        .child(Tab::new().label("定时任务详情"))
                        .child(Tab::new().label("定时任务已执行历史"))
                        .on_click(cx.listener(|this, index, _, cx| {
                            this.detail_tab = TimedDetailTab::from_index(*index);
                            cx.notify();
                        })),
                )
                .child(
                    div()
                        .flex_1()
                        .min_h_0()
                        .overflow_y_scrollbar()
                        .child(match detail_tab {
                            TimedDetailTab::Detail => v_flex()
                                .gap_2()
                                .pt_1()
                                .child(div().text_sm().whitespace_normal().child(sched.clone()))
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
                                        .child(command_preview(&task.command)),
                                )
                                .child(
                                    h_flex()
                                        .gap_2()
                                        .flex_wrap()
                                        .items_center()
                                        .child(
                                            paint_enabled(
                                                Button::new(SharedString::from(format!(
                                                    "detail-toggle-{id}"
                                                )))
                                                .small(),
                                                enabled,
                                            )
                                            .on_click(
                                                {
                                                    let id = id.clone();
                                                    let entity = entity.clone();
                                                    move |_, _, app| {
                                                        if let Some(view) = entity.upgrade() {
                                                            view.update(app, |this, cx| {
                                                                this.toggle_enabled(&id, cx)
                                                            });
                                                        }
                                                    }
                                                },
                                            ),
                                        )
                                        .child(
                                            Button::new(SharedString::from(format!(
                                                "detail-run-{id}"
                                            )))
                                            .small()
                                            .primary()
                                            .label(
                                                if matches!(
                                                    state,
                                                    TimedRunState::Missed | TimedRunState::Due
                                                ) {
                                                    "现在补跑"
                                                } else {
                                                    "立即执行"
                                                },
                                            )
                                            .on_click({
                                                let id = id.clone();
                                                let entity = entity.clone();
                                                move |_, _, app| {
                                                    if let Some(view) = entity.upgrade() {
                                                        view.update(app, |this, cx| {
                                                            this.run_now(&id, cx)
                                                        });
                                                    }
                                                }
                                            }),
                                        )
                                        .child(
                                            Button::new(SharedString::from(format!(
                                                "detail-edit-{id}"
                                            )))
                                            .small()
                                            .outline()
                                            .label("编辑")
                                            .on_click({
                                                let id = id.clone();
                                                let entity = entity.clone();
                                                move |_, window, app| {
                                                    if let Some(view) = entity.upgrade() {
                                                        view.update(app, |this, cx| {
                                                            this.begin_edit(&id, window, cx);
                                                        });
                                                    }
                                                }
                                            }),
                                        )
                                        .child(
                                            Button::new(SharedString::from(format!(
                                                "detail-skip-{id}"
                                            )))
                                            .small()
                                            .outline()
                                            .label("跳过本次")
                                            .on_click({
                                                let id = id.clone();
                                                let entity = entity.clone();
                                                move |_, _, app| {
                                                    if let Some(view) = entity.upgrade() {
                                                        view.update(app, |this, cx| {
                                                            this.skip_once(&id, cx)
                                                        });
                                                    }
                                                }
                                            }),
                                        )
                                        .child(
                                            Button::new(SharedString::from(format!(
                                                "detail-del-{id}"
                                            )))
                                            .small()
                                            .danger()
                                            .outline()
                                            .label(if pending_delete {
                                                "确认删除"
                                            } else {
                                                "删除"
                                            })
                                            .on_click({
                                                let id = id.clone();
                                                move |_, _, app| {
                                                    if let Some(view) = entity.upgrade() {
                                                        view.update(app, |this, cx| {
                                                            this.delete(&id, cx)
                                                        });
                                                    }
                                                }
                                            }),
                                        ),
                                )
                                .into_any_element(),
                            TimedDetailTab::History => {
                                if runs.is_empty() {
                                    div()
                                        .pt_2()
                                        .text_sm()
                                        .text_color(muted)
                                        .child("还没有执行记录")
                                        .into_any_element()
                                } else {
                                    v_flex()
                                        .gap_2()
                                        .pt_1()
                                        .children(runs.into_iter().map(|run| {
                                            h_flex()
                                                .justify_between()
                                                .items_center()
                                                .gap_2()
                                                .px_2()
                                                .py_1p5()
                                                .rounded(radius)
                                                .bg(style::card(cx).opacity(0.7))
                                                .child(
                                                    div()
                                                        .text_sm()
                                                        .child(format_run_time(run.ran_at)),
                                                )
                                                .child(outcome_tag(run.status))
                                        }))
                                        .into_any_element()
                                }
                            }
                        }),
                )
        });

        v_flex().size_full().gap_3().p_4().child(
            div()
                .flex()
                .flex_row()
                .items_stretch()
                .gap_3()
                .w_full()
                .flex_1()
                .min_h_0()
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .h_full()
                        .overflow_y_scrollbar()
                        .child(list),
                )
                .children(detail),
        )
    }
}
