use crate::DomainError;
use crate::date::{add_local_days, format_local_day, local_hour_minute, now_ms};
use crate::id::create_id;
use crate::timed::{compute_next_run_at, make_preset_schedule, timed_schedule_label};
use crate::types::{
    INBOX_PROJECT_ID, Project, ProjectBucket, SchedulePatch, Task, TimedSchedule,
    TimedSchedulePreset,
};
use std::collections::HashMap;

pub fn create_inbox_project(now: i64) -> Project {
    Project {
        id: INBOX_PROJECT_ID.into(),
        title: "收件箱".into(),
        is_archived: false,
        is_done: false,
        done_on: None,
        created_at: now,
        updated_at: now,
    }
}

pub fn create_task_draft(
    title: &str,
    project_id: Option<&str>,
    parent_id: Option<&str>,
    now: Option<i64>,
) -> Task {
    let now = now.unwrap_or_else(now_ms);
    Task {
        id: create_id(now),
        project_id: project_id.unwrap_or(INBOX_PROJECT_ID).to_string(),
        parent_id: parent_id.map(|s| s.to_string()),
        title: title.trim().to_string(),
        notes: String::new(),
        is_done: false,
        done_on: None,
        due_day: None,
        due_with_time: None,
        deadline_day: None,
        deadline_with_time: None,
        remind_at: None,
        deadline_remind_at: None,
        time_estimate: 0,
        time_spent: 0,
        time_spent_on_day: HashMap::new(),
        repeat_cfg_id: None,
        created_at: now,
        updated_at: now,
    }
}

pub fn apply_schedule_patch(task: &mut Task, patch: &SchedulePatch) {
    if let Some(ref due_day) = patch.due_day {
        task.due_day = due_day.clone();
        if due_day.is_some() {
            task.due_with_time = None;
        }
    }
    if let Some(ref due_with_time) = patch.due_with_time {
        task.due_with_time = *due_with_time;
        if due_with_time.is_some() {
            task.due_day = None;
        }
    }
    if let Some(ref deadline_day) = patch.deadline_day {
        task.deadline_day = deadline_day.clone();
        if deadline_day.is_some() {
            task.deadline_with_time = None;
        }
    }
    if let Some(ref deadline_with_time) = patch.deadline_with_time {
        task.deadline_with_time = *deadline_with_time;
        if deadline_with_time.is_some() {
            task.deadline_day = None;
        }
    }
    if let Some(remind_at) = patch.remind_at {
        task.remind_at = remind_at;
    }
    if let Some(deadline_remind_at) = patch.deadline_remind_at {
        task.deadline_remind_at = deadline_remind_at;
    }
}

pub fn clear_plan_fields(task: &mut Task) {
    task.due_day = None;
    task.due_with_time = None;
    task.remind_at = None;
}

pub fn mark_task_complete(task: &mut Task, now: i64) {
    task.is_done = true;
    task.done_on = Some(now);
    task.remind_at = None;
    task.deadline_remind_at = None;
    task.updated_at = now;
}

pub fn mark_task_incomplete(task: &mut Task, now: i64) {
    task.is_done = false;
    task.done_on = None;
    task.updated_at = now;
}

pub fn assert_no_repeat_on_subtask(task: &Task) -> Result<(), DomainError> {
    if task.parent_id.is_some() && task.repeat_cfg_id.is_some() {
        return Err(DomainError::new("子任务不能设置重复"));
    }
    Ok(())
}

pub fn parse_repeat_schedule(raw: &str) -> Option<TimedSchedule> {
    serde_json::from_str(raw).ok()
}

pub fn encode_repeat_schedule(schedule: &TimedSchedule) -> String {
    serde_json::to_string(schedule).unwrap_or_default()
}

pub fn set_task_repeat_preset(
    task: &mut Task,
    preset: Option<TimedSchedulePreset>,
) -> Result<(), DomainError> {
    if preset.is_some() && task.parent_id.is_some() {
        return Err(DomainError::new("子任务不能设置重复"));
    }
    let at_time = task
        .due_with_time
        .map(|ms| {
            let (hour, minute) = local_hour_minute(ms);
            format!("{hour:02}:{minute:02}")
        })
        .unwrap_or_else(|| "09:00".to_string());
    task.repeat_cfg_id =
        preset.map(|preset| encode_repeat_schedule(&make_preset_schedule(preset, &at_time)));
    task.updated_at = now_ms();
    Ok(())
}

pub fn task_repeat_preset(task: &Task) -> Option<TimedSchedulePreset> {
    match task
        .repeat_cfg_id
        .as_deref()
        .and_then(parse_repeat_schedule)?
    {
        TimedSchedule::Preset { preset, .. } => Some(preset),
        _ => None,
    }
}

pub fn task_repeat_label(task: &Task) -> String {
    task.repeat_cfg_id
        .as_deref()
        .and_then(parse_repeat_schedule)
        .map(|s| timed_schedule_label(Some(&s)))
        .unwrap_or_else(|| "不重复".into())
}

/// Completing a repeating task advances its plan instead of staying done.
/// Returns `true` when the task was reopened with the next occurrence.
pub fn try_advance_repeat(task: &mut Task, now: i64) -> bool {
    if task.parent_id.is_some() {
        return false;
    }
    let Some(raw) = task.repeat_cfg_id.as_deref() else {
        return false;
    };
    let Some(schedule) = parse_repeat_schedule(raw) else {
        return false;
    };
    if matches!(schedule, TimedSchedule::Once { .. }) {
        return false;
    }

    let from = task
        .due_with_time
        .or_else(|| {
            task.due_day
                .as_ref()
                .and_then(|d| crate::date::at_local_time(d, 9, 0))
        })
        .unwrap_or(now);

    let next = compute_next_run_at(&schedule, from)
        .filter(|n| *n > from)
        .or_else(|| compute_next_run_at(&schedule, now))
        .filter(|n| *n > now);
    let Some(next) = next else {
        return false;
    };

    let previous_due = task.due_with_time;
    let previous_remind = task.remind_at;
    mark_task_incomplete(task, now);
    let (h, m) = local_hour_minute(next);
    if h == 0 && m == 0 {
        task.due_day = Some(format_local_day(next));
        task.due_with_time = None;
    } else {
        task.due_with_time = Some(next);
        task.due_day = None;
    }
    task.remind_at = match (previous_due, previous_remind, task.due_with_time) {
        (Some(old_due), Some(old_at), Some(new_due)) if old_due >= old_at => {
            let option = crate::reminder::milliseconds_diff_to_remind_option(old_due - old_at);
            crate::reminder::shift_remind_at(new_due, option)
        }
        _ => None,
    };
    task.updated_at = now;
    true
}

/// Effective plan day for a task: due_with_time wins over due_day.
pub fn task_plan_day(task: &Task) -> Option<String> {
    if let Some(ms) = task.due_with_time {
        return Some(format_local_day(ms));
    }
    task.due_day.clone()
}

pub fn task_is_overdue(task: &Task, today: &str) -> bool {
    !task.is_done && task_plan_day(task).is_some_and(|day| day.as_str() < today)
}

/// `(done, total)` for direct children only.
pub fn task_child_counts(tasks: &[Task], parent_id: &str) -> (usize, usize) {
    let mut done = 0usize;
    let mut total = 0usize;
    for task in tasks {
        if task.parent_id.as_deref() == Some(parent_id) {
            total += 1;
            if task.is_done {
                done += 1;
            }
        }
    }
    (done, total)
}

pub fn task_has_children(tasks: &[Task], parent_id: &str) -> bool {
    tasks
        .iter()
        .any(|task| task.parent_id.as_deref() == Some(parent_id))
}

/// `今天` / `明天` / `逾期 11-20` / `11-22`, plus `HH:MM` when the moment has a clock.
pub fn format_moment_label(ms: i64, today: &str) -> String {
    let day = format_local_day(ms);
    let (hour, minute) = local_hour_minute(ms);
    format!("{} {hour:02}:{minute:02}", relative_day_label(&day, today))
}

pub fn relative_day_label(day: &str, today: &str) -> String {
    if day == today {
        return "今天".into();
    }
    if add_local_days(today, 1).as_deref() == Some(day) {
        return "明天".into();
    }
    if add_local_days(today, -1).as_deref() == Some(day) {
        return "昨天".into();
    }
    if day < today {
        return format!("逾期 {}", short_month_day(day));
    }
    short_month_day(day)
}

fn short_month_day(day: &str) -> String {
    day.get(5..).unwrap_or(day).to_string()
}

pub fn format_plan_chip(task: &Task, today: &str) -> Option<String> {
    let day = task_plan_day(task)?;
    if let Some(ms) = task.due_with_time {
        return Some(format_moment_label(ms, today));
    }
    Some(relative_day_label(&day, today))
}

pub fn format_deadline_chip(task: &Task, today: &str) -> Option<String> {
    if let Some(ms) = task.deadline_with_time {
        return Some(format!("截止 {}", format_moment_label(ms, today)));
    }
    let day = task.deadline_day.as_deref()?;
    Some(format!("截止 {}", relative_day_label(day, today)))
}

pub fn format_remind_chip(task: &Task, today: &str) -> Option<String> {
    let plan = task
        .remind_at
        .map(|ms| format!("提醒 {}", format_moment_label(ms, today)));
    let deadline = task
        .deadline_remind_at
        .map(|ms| format!("截止提醒 {}", format_moment_label(ms, today)));
    match (plan, deadline) {
        (Some(plan), Some(deadline)) => Some(format!("{plan} · {deadline}")),
        (Some(plan), None) => Some(plan),
        (None, Some(deadline)) => Some(deadline),
        (None, None) => None,
    }
}

pub fn format_spent_label(ms: i64) -> String {
    if ms <= 0 {
        return String::new();
    }
    let mins = ms / 60_000;
    if mins < 1 {
        return "不足 1 分钟".into();
    }
    if mins < 60 {
        return format!("{mins} 分钟");
    }
    let hours = mins / 60;
    let remain = mins % 60;
    if remain == 0 {
        format!("{hours} 小时")
    } else {
        format!("{hours} 小时 {remain} 分")
    }
}

pub fn is_today_member(task: &Task, today: &str) -> bool {
    if task.is_done {
        return false;
    }
    match task_plan_day(task) {
        Some(day) => day.as_str() <= today,
        None => false,
    }
}

pub fn select_today_tasks<'a>(
    tasks: &'a [Task],
    today: &str,
    today_order: &[String],
) -> Vec<&'a Task> {
    let mut roots: Vec<&Task> = tasks
        .iter()
        .filter(|t| t.parent_id.is_none() && is_today_member(t, today))
        .collect();
    // Parent already today → children don't duplicate as roots (already filtered by parent_id)
    roots.sort_by(|a, b| {
        let ia = today_order.iter().position(|id| id == &a.id);
        let ib = today_order.iter().position(|id| id == &b.id);
        match (ia, ib) {
            (Some(x), Some(y)) => x.cmp(&y),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => a.created_at.cmp(&b.created_at),
        }
    });
    roots
}

pub fn select_planner_tasks(tasks: &[Task]) -> Vec<&Task> {
    let mut out: Vec<&Task> = tasks
        .iter()
        .filter(|t| !t.is_done && task_plan_day(t).is_some())
        .collect();
    out.sort_by(|a, b| {
        let da = task_plan_day(a).unwrap_or_default();
        let db = task_plan_day(b).unwrap_or_default();
        da.cmp(&db)
            .then_with(|| a.due_with_time.cmp(&b.due_with_time))
            .then_with(|| a.created_at.cmp(&b.created_at))
    });
    out
}

/// Group already-sorted planner tasks into (day, tasks) buckets.
pub fn group_tasks_by_plan_day(tasks: &[Task]) -> Vec<(String, Vec<Task>)> {
    let mut groups: Vec<(String, Vec<Task>)> = Vec::new();
    for task in tasks {
        let day = task_plan_day(task).unwrap_or_else(|| "未排期".into());
        match groups.last_mut() {
            Some((d, list)) if *d == day => list.push(task.clone()),
            _ => groups.push((day, vec![task.clone()])),
        }
    }
    groups
}

/// Number of day columns in the planner calendar view.
pub const PLANNER_CALENDAR_COLUMNS: usize = 15;

/// Bucket root tasks into planner calendar columns.
/// Returns `(overdue, columns)` where `columns` aligns 1:1 with `day_columns`.
/// Tasks with plan day before the first column go into `overdue`;
/// tasks after the last column or without a plan day are omitted.
pub fn bucket_tasks_for_calendar(
    tasks: &[Task],
    day_columns: &[String],
) -> (Vec<Task>, Vec<Vec<Task>>) {
    let mut overdue = Vec::new();
    let mut columns: Vec<Vec<Task>> = day_columns.iter().map(|_| Vec::new()).collect();
    if day_columns.is_empty() {
        return (overdue, columns);
    }
    let first = day_columns.first().map(String::as_str).unwrap_or("");
    let last = day_columns.last().map(String::as_str).unwrap_or("");
    for task in tasks {
        if task.parent_id.is_some() || task.is_done {
            continue;
        }
        let Some(day) = task_plan_day(task) else {
            continue;
        };
        if day.as_str() < first {
            overdue.push(task.clone());
            continue;
        }
        if day.as_str() > last {
            continue;
        }
        if let Some(idx) = day_columns.iter().position(|d| d == &day) {
            columns[idx].push(task.clone());
        }
    }
    (overdue, columns)
}

/// Hourly schedule grid: first visible hour (inclusive) through last (exclusive).
pub const SCHEDULE_HOUR_START: u32 = 6;
pub const SCHEDULE_HOUR_END: u32 = 23;

/// Bucket root tasks for a single day's hourly schedule.
/// Returns `(all_day, by_hour)` where `by_hour[i]` is hour `SCHEDULE_HOUR_START + i`.
/// Timed tasks outside the visible window still appear under the clamped hour.
pub fn bucket_tasks_for_day_schedule(
    tasks: &[Task],
    day: &str,
) -> (Vec<Task>, Vec<(u32, Vec<Task>)>) {
    let hour_count = SCHEDULE_HOUR_END.saturating_sub(SCHEDULE_HOUR_START) as usize;
    let mut all_day = Vec::new();
    let mut by_hour: Vec<(u32, Vec<Task>)> = (0..hour_count)
        .map(|i| (SCHEDULE_HOUR_START + i as u32, Vec::new()))
        .collect();
    for task in tasks {
        if task.parent_id.is_some() || task.is_done {
            continue;
        }
        let Some(plan) = task_plan_day(task) else {
            continue;
        };
        if plan != day {
            continue;
        }
        match task.due_with_time {
            Some(ms) => {
                let (h, _) = local_hour_minute(ms);
                let clamped = h.clamp(SCHEDULE_HOUR_START, SCHEDULE_HOUR_END.saturating_sub(1));
                if let Some((_, list)) = by_hour.iter_mut().find(|(hour, _)| *hour == clamped) {
                    list.push(task.clone());
                }
            }
            None => all_day.push(task.clone()),
        }
    }
    (all_day, by_hour)
}

pub fn filter_tasks<'a>(
    tasks: &'a [Task],
    project_id: Option<&str>,
    done: Option<bool>,
    query: Option<&str>,
) -> Vec<&'a Task> {
    let q = query
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());
    tasks
        .iter()
        .filter(|t| {
            if let Some(pid) = project_id {
                if t.project_id != pid {
                    return false;
                }
            }
            if let Some(d) = done {
                if t.is_done != d {
                    return false;
                }
            }
            if let Some(ref q) = q {
                if !t.title.to_lowercase().contains(q) && !t.notes.to_lowercase().contains(q) {
                    return false;
                }
            }
            true
        })
        .collect()
}

pub fn reorder_ids(order: &[String], from: usize, to: usize) -> Vec<String> {
    let mut out = order.to_vec();
    if from >= out.len() || to >= out.len() || from == to {
        return out;
    }
    let item = out.remove(from);
    out.insert(to, item);
    out
}

pub fn sum_time_spent_on_day(map: &HashMap<String, i64>) -> i64 {
    map.values().sum()
}

pub fn settle_timer_segment(task: &mut Task, day: &str, elapsed_ms: i64, now: i64) {
    let entry = task.time_spent_on_day.entry(day.to_string()).or_insert(0);
    *entry += elapsed_ms.max(0);
    task.time_spent = sum_time_spent_on_day(&task.time_spent_on_day);
    task.updated_at = now;
}

pub fn default_bucket() -> ProjectBucket {
    ProjectBucket::Active
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_planner_by_day() {
        let mut a = create_task_draft("a", None, None, Some(1));
        a.due_day = Some("2026-01-02".into());
        let mut b = create_task_draft("b", None, None, Some(2));
        b.due_day = Some("2026-01-01".into());
        let mut c = create_task_draft("c", None, None, Some(3));
        c.due_day = Some("2026-01-01".into());
        let sorted: Vec<Task> = select_planner_tasks(&[a.clone(), b.clone(), c.clone()])
            .into_iter()
            .cloned()
            .collect();
        let groups = group_tasks_by_plan_day(&sorted);
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].0, "2026-01-01");
        assert_eq!(groups[0].1.len(), 2);
        assert_eq!(groups[1].0, "2026-01-02");
    }

    #[test]
    fn today_member_overdue() {
        let mut t = create_task_draft("x", None, None, Some(1));
        t.due_day = Some("2020-01-01".into());
        assert!(is_today_member(&t, "2026-01-01"));
        t.is_done = true;
        assert!(!is_today_member(&t, "2026-01-01"));
    }

    #[test]
    fn advance_daily_repeat_reopens() {
        let mut t = create_task_draft("日报", None, None, Some(1_700_000_000_000));
        set_task_repeat_preset(&mut t, Some(TimedSchedulePreset::Daily)).unwrap();
        t.due_with_time = Some(1_700_000_000_000);
        t.remind_at = Some(1_700_000_000_000 - 10 * 60_000);
        assert!(try_advance_repeat(&mut t, 1_700_000_000_000));
        assert!(!t.is_done);
        let next = t.due_with_time.unwrap();
        assert!(next > 1_700_000_000_000);
        assert_eq!(t.remind_at, Some(next - 10 * 60_000));
    }

    #[test]
    fn calendar_buckets_overdue_and_columns() {
        let cols = vec![
            "2026-11-21".into(),
            "2026-11-22".into(),
            "2026-11-23".into(),
        ];
        let mut overdue = create_task_draft("旧", None, None, Some(1));
        overdue.due_day = Some("2026-11-20".into());
        let mut today = create_task_draft("今", None, None, Some(2));
        today.due_day = Some("2026-11-21".into());
        let mut later = create_task_draft("后", None, None, Some(3));
        later.due_day = Some("2026-11-23".into());
        let mut far = create_task_draft("远", None, None, Some(4));
        far.due_day = Some("2026-12-01".into());
        let (ov, buckets) = bucket_tasks_for_calendar(&[overdue, today, later, far], &cols);
        assert_eq!(ov.len(), 1);
        assert_eq!(ov[0].title, "旧");
        assert_eq!(buckets[0].len(), 1);
        assert_eq!(buckets[0][0].title, "今");
        assert!(buckets[1].is_empty());
        assert_eq!(buckets[2].len(), 1);
        assert_eq!(buckets[2][0].title, "后");
    }

    #[test]
    fn plan_chip_and_overdue_use_plan_day() {
        let mut task = create_task_draft("写报告", None, None, Some(1));
        task.due_day = Some("2026-11-22".into());
        assert_eq!(
            format_plan_chip(&task, "2026-11-22").as_deref(),
            Some("今天")
        );
        assert_eq!(
            format_plan_chip(&task, "2026-11-21").as_deref(),
            Some("明天")
        );
        assert!(task_is_overdue(&task, "2026-11-23"));
        assert!(!task_is_overdue(&task, "2026-11-22"));
        task.deadline_day = Some("2026-11-23".into());
        task.remind_at = Some(1);
        task.deadline_remind_at = Some(2);
        let remind = format_remind_chip(&task, "2026-11-22").unwrap_or_default();
        assert!(remind.contains("提醒 "));
        assert!(remind.contains("截止提醒 "));
        assert_eq!(
            format_deadline_chip(&task, "2026-11-22").as_deref(),
            Some("截止 明天")
        );
    }

    #[test]
    fn child_counts_and_spent_label() {
        let parent = create_task_draft("父", None, None, Some(1));
        let mut done = create_task_draft("甲", None, Some(&parent.id), Some(2));
        done.is_done = true;
        let open = create_task_draft("乙", None, Some(&parent.id), Some(3));
        let open_id = open.id.clone();
        let tasks = [parent.clone(), done, open];
        assert_eq!(task_child_counts(&tasks, &parent.id), (1, 2));
        assert!(task_has_children(&tasks, &parent.id));
        assert!(!task_has_children(&tasks, &open_id));
        assert_eq!(format_spent_label(0), "");
        assert_eq!(format_spent_label(5 * 60_000), "5 分钟");
        assert_eq!(format_spent_label(65 * 60_000), "1 小时 5 分");
    }

    #[test]
    fn repeat_preset_keeps_existing_clock() {
        let mut task = create_task_draft("日报", None, None, Some(1));
        task.due_with_time = crate::date::at_local_time("2026-11-22", 18, 30);
        set_task_repeat_preset(&mut task, Some(TimedSchedulePreset::Daily)).unwrap();
        let schedule = parse_repeat_schedule(task.repeat_cfg_id.as_deref().unwrap()).unwrap();
        match schedule {
            TimedSchedule::Preset { at_time, .. } => assert_eq!(at_time, "18:30"),
            other => panic!("expected preset, got {other:?}"),
        }
        assert_eq!(task_repeat_preset(&task), Some(TimedSchedulePreset::Daily));
    }

    #[test]
    fn day_schedule_splits_all_day_and_hours() {
        let day = "2026-11-21";
        let mut all = create_task_draft("整天", None, None, Some(1));
        all.due_day = Some(day.into());
        let mut timed = create_task_draft("开会", None, None, Some(2));
        timed.due_with_time = crate::date::at_local_time(day, 10, 30);
        let mut early = create_task_draft("早", None, None, Some(3));
        early.due_with_time = crate::date::at_local_time(day, 3, 0);
        let (ad, hours) = bucket_tasks_for_day_schedule(&[all, timed, early], day);
        assert_eq!(ad.len(), 1);
        assert_eq!(ad[0].title, "整天");
        let h10 = hours.iter().find(|(h, _)| *h == 10).unwrap();
        assert_eq!(h10.1.len(), 1);
        assert_eq!(h10.1[0].title, "开会");
        let h6 = hours.iter().find(|(h, _)| *h == 6).unwrap();
        assert_eq!(h6.1.len(), 1);
        assert_eq!(h6.1[0].title, "早");
    }
}
