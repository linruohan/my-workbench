use crate::date::{add_local_days, at_local_time, format_local_day, local_hour_minute, now_ms};
use crate::id::create_id;
use crate::types::{EndMode, TimedIntervalUnit, TimedSchedule, TimedSchedulePreset, TimedTask};
use chrono::{Datelike, Local, TimeZone, Timelike, Weekday};

pub const DEFAULT_AT_TIME: &str = "09:00";
pub const TIMED_TASK_MISS_GRACE_MS: i64 = 90_000;

pub fn normalize_at_time(raw: Option<&str>) -> String {
    match raw {
        Some(s) if s.len() == 5 && s.as_bytes()[2] == b':' => {
            let ok = s.chars().enumerate().all(
                |(i, c)| {
                    if i == 2 { c == ':' } else { c.is_ascii_digit() }
                },
            );
            if ok {
                return s.to_string();
            }
        }
        _ => {}
    }
    DEFAULT_AT_TIME.to_string()
}

pub fn normalize_timed_schedule(raw: TimedSchedule) -> TimedSchedule {
    match raw {
        TimedSchedule::Once { at } => TimedSchedule::Once {
            at: if at == 0 { now_ms() } else { at },
        },
        TimedSchedule::Preset { preset, at_time } => TimedSchedule::Preset {
            preset,
            at_time: normalize_at_time(Some(&at_time)),
        },
        TimedSchedule::Custom {
            every,
            unit,
            at_time,
            end_mode,
            end_date,
        } => TimedSchedule::Custom {
            every: every.max(1),
            unit,
            at_time: normalize_at_time(Some(&at_time)),
            end_mode,
            end_date,
        },
    }
}

pub fn create_timed_task_draft(
    title: Option<&str>,
    command: Option<&str>,
    schedule: Option<TimedSchedule>,
    now: Option<i64>,
) -> TimedTask {
    let now = now.unwrap_or_else(now_ms);
    let schedule = schedule.map(normalize_timed_schedule);
    let next = schedule.as_ref().and_then(|s| compute_next_run_at(s, now));
    TimedTask {
        id: create_id(now),
        title: title
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| "未命名定时任务".into()),
        command: command.unwrap_or("").to_string(),
        schedule,
        enabled: true,
        last_run_at: None,
        next_run_at: next,
        created_at: now,
        updated_at: now,
    }
}

pub fn patch_timed_task(
    task: &TimedTask,
    title: Option<&str>,
    command: Option<&str>,
    schedule: Option<Option<TimedSchedule>>,
    enabled: Option<bool>,
    last_run_at: Option<Option<i64>>,
    now: i64,
) -> TimedTask {
    let schedule = match schedule {
        Some(s) => s.map(normalize_timed_schedule),
        None => task.schedule.clone(),
    };
    let last = match last_run_at {
        Some(v) => v,
        None => task.last_run_at,
    };
    let from_ms = last.filter(|v| *v > 0).unwrap_or(now);
    let is_once = matches!(schedule, Some(TimedSchedule::Once { .. }));
    let has_run = last.filter(|v| *v > 0).is_some();
    let enabled = match enabled {
        Some(e) => e,
        None if is_once && has_run => false,
        None => task.enabled,
    };
    let next = match &schedule {
        None => None,
        Some(s) if is_once && has_run && !enabled => None,
        Some(s) => compute_next_run_at(s, from_ms),
    };

    TimedTask {
        id: task.id.clone(),
        title: title
            .map(|t| {
                let t = t.trim();
                if t.is_empty() {
                    "未命名定时任务".into()
                } else {
                    t.to_string()
                }
            })
            .unwrap_or_else(|| task.title.clone()),
        command: command
            .map(|c| c.to_string())
            .unwrap_or_else(|| task.command.clone()),
        schedule,
        enabled,
        last_run_at: last,
        next_run_at: next,
        created_at: task.created_at,
        updated_at: now,
    }
}

pub fn mark_timed_task_ran(task: &TimedTask, now: i64) -> TimedTask {
    patch_timed_task(task, None, None, None, None, Some(Some(now)), now)
}

/// Toggle enabled. Turning a stale task back on schedules the next future slot
/// from `now` and keeps the previous run timestamp.
pub fn set_timed_task_enabled(task: &TimedTask, enabled: bool, now: i64) -> TimedTask {
    let mut next = task.next_run_at;
    if enabled && next.map(|at| at <= now).unwrap_or(true) {
        next = task
            .schedule
            .as_ref()
            .and_then(|schedule| compute_next_run_at(schedule, now));
    }
    TimedTask {
        enabled,
        next_run_at: next,
        updated_at: now,
        ..task.clone()
    }
}

pub fn timed_preset_label(preset: TimedSchedulePreset) -> &'static str {
    match preset {
        TimedSchedulePreset::Hourly => "每小时",
        TimedSchedulePreset::Daily => "每天",
        TimedSchedulePreset::Weekdays => "每工作日",
        TimedSchedulePreset::Weekly => "每周",
        TimedSchedulePreset::Monthly => "每月",
    }
}

pub fn timed_interval_unit_label(unit: TimedIntervalUnit) -> &'static str {
    match unit {
        TimedIntervalUnit::Minute => "分钟",
        TimedIntervalUnit::Hour => "小时",
        TimedIntervalUnit::Day => "天",
        TimedIntervalUnit::Week => "周",
        TimedIntervalUnit::Month => "个月",
        TimedIntervalUnit::Year => "年",
    }
}

pub fn timed_schedule_label(schedule: Option<&TimedSchedule>) -> String {
    let Some(schedule) = schedule else {
        return "未设置计划".into();
    };
    let s = normalize_timed_schedule(schedule.clone());
    match s {
        TimedSchedule::Once { at } => {
            let dt = Local
                .timestamp_millis_opt(at)
                .single()
                .unwrap_or_else(Local::now);
            format!("一次性 · {}", dt.format("%Y/%m/%d %H:%M"))
        }
        TimedSchedule::Preset { preset, at_time } => {
            if matches!(preset, TimedSchedulePreset::Hourly) {
                timed_preset_label(preset).into()
            } else {
                format!("{} · {at_time}", timed_preset_label(preset))
            }
        }
        TimedSchedule::Custom {
            every,
            unit,
            at_time,
            end_mode,
            end_date,
        } => {
            let unit_l = timed_interval_unit_label(unit);
            let base = format!("每 {every} {unit_l}");
            let with_time = if matches!(unit, TimedIntervalUnit::Minute | TimedIntervalUnit::Hour) {
                base
            } else {
                format!("{base}，{at_time}")
            };
            if matches!(end_mode, EndMode::OnDate) {
                if let Some(d) = end_date {
                    return format!("{with_time} · 至 {d}");
                }
            }
            with_time
        }
    }
}

fn apply_at_time(date: &mut chrono::DateTime<Local>, at_time: &str) {
    let parts: Vec<_> = normalize_at_time(Some(at_time))
        .split(':')
        .filter_map(|p| p.parse::<u32>().ok())
        .collect();
    let hh = parts.first().copied().unwrap_or(9);
    let mm = parts.get(1).copied().unwrap_or(0);
    *date = date
        .with_hour(hh)
        .and_then(|d| d.with_minute(mm))
        .and_then(|d| d.with_second(0))
        .and_then(|d| d.with_nanosecond(0))
        .unwrap_or(*date);
}

fn add_months_clamped(date: &mut chrono::DateTime<Local>, months: i32) {
    let day = date.day();
    let mut d = date.with_day(1).unwrap_or(*date);
    let (y, m) = {
        let total = d.year() * 12 + (d.month() as i32 - 1) + months;
        let y = total.div_euclid(12);
        let m = (total.rem_euclid(12) + 1) as u32;
        (y, m)
    };
    d = d.with_year(y).and_then(|x| x.with_month(m)).unwrap_or(d);
    let last = chrono::NaiveDate::from_ymd_opt(d.year(), d.month(), 1)
        .and_then(|n| n.with_day(1))
        .map(|n| {
            let next = if n.month() == 12 {
                chrono::NaiveDate::from_ymd_opt(n.year() + 1, 1, 1)
            } else {
                chrono::NaiveDate::from_ymd_opt(n.year(), n.month() + 1, 1)
            };
            next.and_then(|x| x.pred_opt())
                .map(|x| x.day())
                .unwrap_or(28)
        })
        .unwrap_or(28);
    *date = d.with_day(day.min(last)).unwrap_or(d);
}

pub fn compute_next_run_at(schedule: &TimedSchedule, from_ms: i64) -> Option<i64> {
    let s = normalize_timed_schedule(schedule.clone());
    let from = Local.timestamp_millis_opt(from_ms).single()?;

    match s {
        TimedSchedule::Once { at } => Some(at),
        TimedSchedule::Preset { preset, at_time } => match preset {
            TimedSchedulePreset::Hourly => {
                let mut d = from + chrono::Duration::hours(1);
                d = d
                    .with_minute(0)
                    .and_then(|x| x.with_second(0))
                    .and_then(|x| x.with_nanosecond(0))
                    .unwrap_or(d);
                Some(d.timestamp_millis())
            }
            TimedSchedulePreset::Daily => {
                let mut d = from;
                apply_at_time(&mut d, &at_time);
                if d.timestamp_millis() <= from_ms {
                    d += chrono::Duration::days(1);
                    apply_at_time(&mut d, &at_time);
                }
                Some(d.timestamp_millis())
            }
            TimedSchedulePreset::Weekdays => {
                let mut d = from;
                apply_at_time(&mut d, &at_time);
                if d.timestamp_millis() <= from_ms {
                    d += chrono::Duration::days(1);
                    apply_at_time(&mut d, &at_time);
                }
                while matches!(d.weekday(), Weekday::Sat | Weekday::Sun) {
                    d += chrono::Duration::days(1);
                    apply_at_time(&mut d, &at_time);
                }
                Some(d.timestamp_millis())
            }
            TimedSchedulePreset::Weekly => {
                let mut d = from;
                apply_at_time(&mut d, &at_time);
                if d.timestamp_millis() <= from_ms {
                    d += chrono::Duration::weeks(1);
                    apply_at_time(&mut d, &at_time);
                }
                Some(d.timestamp_millis())
            }
            TimedSchedulePreset::Monthly => {
                let mut d = from;
                apply_at_time(&mut d, &at_time);
                if d.timestamp_millis() <= from_ms {
                    add_months_clamped(&mut d, 1);
                    apply_at_time(&mut d, &at_time);
                }
                Some(d.timestamp_millis())
            }
        },
        TimedSchedule::Custom {
            every,
            unit,
            at_time,
            end_mode,
            end_date,
        } => {
            let mut d = from;
            match unit {
                TimedIntervalUnit::Minute => {
                    d += chrono::Duration::minutes(every);
                }
                TimedIntervalUnit::Hour => {
                    d += chrono::Duration::hours(every);
                }
                TimedIntervalUnit::Day => {
                    apply_at_time(&mut d, &at_time);
                    if d.timestamp_millis() <= from_ms {
                        d += chrono::Duration::days(every);
                        apply_at_time(&mut d, &at_time);
                    }
                }
                TimedIntervalUnit::Week => {
                    apply_at_time(&mut d, &at_time);
                    if d.timestamp_millis() <= from_ms {
                        d += chrono::Duration::weeks(every);
                        apply_at_time(&mut d, &at_time);
                    }
                }
                TimedIntervalUnit::Month => {
                    apply_at_time(&mut d, &at_time);
                    if d.timestamp_millis() <= from_ms {
                        add_months_clamped(&mut d, every as i32);
                        apply_at_time(&mut d, &at_time);
                    }
                }
                TimedIntervalUnit::Year => {
                    apply_at_time(&mut d, &at_time);
                    if d.timestamp_millis() <= from_ms {
                        add_months_clamped(&mut d, every as i32 * 12);
                        apply_at_time(&mut d, &at_time);
                    }
                }
            }
            if matches!(end_mode, EndMode::OnDate) {
                if let Some(ref end) = end_date {
                    let end_ms = crate::date::at_local_time(end, 23, 59)?;
                    if d.timestamp_millis() > end_ms {
                        return None;
                    }
                }
            }
            Some(d.timestamp_millis())
        }
    }
}

pub fn is_timed_task_due(task: &TimedTask, now: i64) -> bool {
    task.enabled && task.next_run_at.map(|n| n <= now).unwrap_or(false)
}

pub fn is_timed_task_missed(task: &TimedTask, now: i64, grace_ms: i64) -> bool {
    task.enabled
        && task
            .next_run_at
            .map(|n| now - n > grace_ms)
            .unwrap_or(false)
}

pub fn is_timed_task_auto_due(task: &TimedTask, now: i64) -> bool {
    is_timed_task_due(task, now) && !is_timed_task_missed(task, now, TIMED_TASK_MISS_GRACE_MS)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimedRunState {
    Disabled,
    Unscheduled,
    Missed,
    Due,
    Soon,
    Scheduled,
}

pub fn timed_run_state(task: &TimedTask, now: i64) -> TimedRunState {
    if !task.enabled {
        return TimedRunState::Disabled;
    }
    let Some(next) = task.next_run_at else {
        return TimedRunState::Unscheduled;
    };
    if is_timed_task_missed(task, now, TIMED_TASK_MISS_GRACE_MS) {
        return TimedRunState::Missed;
    }
    if next <= now {
        return TimedRunState::Due;
    }
    if next - now <= 24 * 60 * 60 * 1000 {
        return TimedRunState::Soon;
    }
    TimedRunState::Scheduled
}

pub fn timed_run_state_label(state: TimedRunState) -> &'static str {
    match state {
        TimedRunState::Disabled => "已停用",
        TimedRunState::Unscheduled => "未排期",
        TimedRunState::Missed => "已错过",
        TimedRunState::Due => "待执行",
        TimedRunState::Soon => "即将到期",
        TimedRunState::Scheduled => "已排期",
    }
}

pub fn format_timed_instant(ms: i64, now: i64) -> String {
    let day = format_local_day(ms);
    let today = format_local_day(now);
    let (hour, minute) = local_hour_minute(ms);
    let clock = format!("{hour:02}:{minute:02}");
    let day_label = if day == today {
        "今天".to_string()
    } else if add_local_days(&today, 1).as_deref() == Some(day.as_str()) {
        "明天".to_string()
    } else if add_local_days(&today, -1).as_deref() == Some(day.as_str()) {
        "昨天".to_string()
    } else {
        day.get(5..).unwrap_or(day.as_str()).to_string()
    };
    format!("{day_label} {clock}")
}

/// Missed and due tasks first, then upcoming, disabled last.
pub fn timed_tasks_in_display_order(tasks: &[TimedTask], now: i64) -> Vec<TimedTask> {
    let mut out = tasks.to_vec();
    out.sort_by(|a, b| {
        let rank = |task: &TimedTask| match timed_run_state(task, now) {
            TimedRunState::Missed => 0,
            TimedRunState::Due => 1,
            TimedRunState::Soon => 2,
            TimedRunState::Scheduled => 3,
            TimedRunState::Unscheduled => 4,
            TimedRunState::Disabled => 5,
        };
        rank(a)
            .cmp(&rank(b))
            .then_with(|| {
                a.next_run_at
                    .unwrap_or(i64::MAX)
                    .cmp(&b.next_run_at.unwrap_or(i64::MAX))
            })
            .then_with(|| a.created_at.cmp(&b.created_at))
    });
    out
}

fn clock_hour_minute(at_time: &str) -> (u32, u32) {
    let normalized = normalize_at_time(Some(at_time));
    let mut parts = normalized.split(':');
    let hour = parts.next().and_then(|p| p.parse().ok()).unwrap_or(9);
    let minute = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    (hour.min(23), minute.min(59))
}

/// Next clock occurrence: later today, otherwise the same clock tomorrow.
pub fn once_at_from_clock(now: i64, at_time: &str) -> i64 {
    let today = format_local_day(now);
    let (hour, minute) = clock_hour_minute(at_time);
    let today_at = at_local_time(&today, hour, minute).unwrap_or(now);
    if today_at > now {
        return today_at;
    }
    add_local_days(&today, 1)
        .and_then(|day| at_local_time(&day, hour, minute))
        .unwrap_or(today_at)
}

pub fn make_once_from_clock(now: i64, at_time: &str) -> TimedSchedule {
    TimedSchedule::Once {
        at: once_at_from_clock(now, at_time),
    }
}

pub fn make_preset_schedule(preset: TimedSchedulePreset, at_time: &str) -> TimedSchedule {
    TimedSchedule::Preset {
        preset,
        at_time: normalize_at_time(Some(at_time)),
    }
}

pub fn make_custom_schedule(every: i64, unit: TimedIntervalUnit, at_time: &str) -> TimedSchedule {
    make_custom_schedule_ending(every, unit, at_time, None)
}

pub fn make_custom_schedule_ending(
    every: i64,
    unit: TimedIntervalUnit,
    at_time: &str,
    end_date: Option<&str>,
) -> TimedSchedule {
    let end_date = end_date
        .map(str::trim)
        .filter(|day| !day.is_empty())
        .filter(|day| crate::date::parse_local_day(day).is_some())
        .map(str::to_string);
    TimedSchedule::Custom {
        every: every.max(1),
        unit,
        at_time: normalize_at_time(Some(at_time)),
        end_mode: if end_date.is_some() {
            EndMode::OnDate
        } else {
            EndMode::Never
        },
        end_date,
    }
}

pub fn build_timed_task_prompt(task: &TimedTask) -> String {
    let sched = timed_schedule_label(task.schedule.as_ref());
    format!(
        "【定时任务】{}\n计划：{sched}\n指令：\n{}",
        task.title, task.command
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn once_schedule_returns_at() {
        let s = TimedSchedule::Once { at: 123 };
        assert_eq!(compute_next_run_at(&s, 0), Some(123));
    }

    #[test]
    fn label_none() {
        assert_eq!(timed_schedule_label(None), "未设置计划");
    }

    #[test]
    fn custom_schedule_next_run() {
        let s = make_custom_schedule(2, TimedIntervalUnit::Day, "09:00");
        let next = compute_next_run_at(&s, 1_700_000_000_000);
        assert!(next.is_some());
        assert!(next.unwrap() > 1_700_000_000_000);
    }

    #[test]
    fn weekly_keeps_a_later_slot_today() {
        let now = Local::now();
        if now.hour() >= 22 {
            return;
        }
        let at = format!("{:02}:00", now.hour() + 1);
        let schedule = make_preset_schedule(TimedSchedulePreset::Weekly, &at);
        let next = compute_next_run_at(&schedule, now.timestamp_millis()).unwrap();
        let delta = next - now.timestamp_millis();
        assert!(delta > 0);
        assert!(delta < 3 * 60 * 60 * 1000, "delta={delta}");
    }

    #[test]
    fn once_clock_rolls_to_tomorrow_after_the_slot() {
        let morning = Local::now()
            .with_hour(8)
            .and_then(|d| d.with_minute(0))
            .and_then(|d| d.with_second(0))
            .and_then(|d| d.with_nanosecond(0))
            .unwrap();
        let later_today = once_at_from_clock(morning.timestamp_millis(), "09:00");
        assert!(later_today > morning.timestamp_millis());
        assert!(later_today - morning.timestamp_millis() < 2 * 60 * 60 * 1000);

        let evening = morning.with_hour(18).unwrap();
        let tomorrow = once_at_from_clock(evening.timestamp_millis(), "09:00");
        assert!(tomorrow - evening.timestamp_millis() > 12 * 60 * 60 * 1000);
    }

    #[test]
    fn custom_end_date_is_kept_only_when_valid() {
        let open = make_custom_schedule_ending(1, TimedIntervalUnit::Day, "09:00", Some("nope"));
        match open {
            TimedSchedule::Custom {
                end_mode, end_date, ..
            } => {
                assert_eq!(end_mode, EndMode::Never);
                assert!(end_date.is_none());
            }
            other => panic!("expected custom, got {other:?}"),
        }
        let closed =
            make_custom_schedule_ending(1, TimedIntervalUnit::Week, "08:30", Some("2026-12-31"));
        match closed {
            TimedSchedule::Custom {
                end_mode, end_date, ..
            } => {
                assert_eq!(end_mode, EndMode::OnDate);
                assert_eq!(end_date.as_deref(), Some("2026-12-31"));
            }
            other => panic!("expected custom, got {other:?}"),
        }
    }

    #[test]
    fn enabling_stale_task_schedules_a_future_slot() {
        let now = Local::now().timestamp_millis();
        let mut task = create_timed_task_draft(
            Some("日报"),
            Some("hi"),
            Some(make_preset_schedule(TimedSchedulePreset::Daily, "09:00")),
            Some(now - 86_400_000),
        );
        task.enabled = false;
        task.next_run_at = Some(now - 3_600_000);
        let on = set_timed_task_enabled(&task, true, now);
        assert!(on.enabled);
        assert!(on.next_run_at.is_some_and(|next| next > now));
        assert_eq!(on.last_run_at, task.last_run_at);
    }

    #[test]
    fn display_order_puts_missed_before_disabled() {
        let now = 1_700_000_000_000;
        let mut missed = create_timed_task_draft(Some("错过"), None, None, Some(1));
        missed.enabled = true;
        missed.next_run_at = Some(now - 10 * 60 * 1000);
        let mut disabled = create_timed_task_draft(Some("停用"), None, None, Some(2));
        disabled.enabled = false;
        disabled.next_run_at = Some(now - 10 * 60 * 1000);
        let ordered = timed_tasks_in_display_order(&[disabled, missed], now);
        assert_eq!(ordered[0].title, "错过");
        assert_eq!(timed_run_state(&ordered[0], now), TimedRunState::Missed);
        assert_eq!(timed_run_state_label(TimedRunState::Soon), "即将到期");
    }
}
