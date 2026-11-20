use crate::DomainError;
use crate::date::{format_local_day, now_ms};
use crate::id::create_id;
use crate::types::{INBOX_PROJECT_ID, Project, ProjectBucket, SchedulePatch, Task};
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

/// Effective plan day for a task: due_with_time wins over due_day.
pub fn task_plan_day(task: &Task) -> Option<String> {
    if let Some(ms) = task.due_with_time {
        return Some(format_local_day(ms));
    }
    task.due_day.clone()
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
    fn today_member_overdue() {
        let mut t = create_task_draft("x", None, None, Some(1));
        t.due_day = Some("2020-01-01".into());
        assert!(is_today_member(&t, "2026-01-01"));
        t.is_done = true;
        assert!(!is_today_member(&t, "2026-01-01"));
    }
}
