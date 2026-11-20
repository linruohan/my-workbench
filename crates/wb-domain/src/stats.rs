use crate::date::format_local_day;
use crate::task::task_plan_day;
use crate::types::Task;
use std::collections::HashMap;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct TaskStats {
    pub open: usize,
    pub overdue: usize,
    pub due_today: usize,
    pub unscheduled: usize,
    pub done_today: usize,
    pub done_total: usize,
    pub completion_rate: f32,
    pub by_project: Vec<(String, usize)>,
}

pub fn compute_task_stats(tasks: &[Task], today: &str) -> TaskStats {
    let mut open = 0usize;
    let mut overdue = 0usize;
    let mut due_today = 0usize;
    let mut unscheduled = 0usize;
    let mut done_today = 0usize;
    let mut done_total = 0usize;
    let mut by_project: HashMap<String, usize> = HashMap::new();

    for t in tasks {
        if t.is_done {
            done_total += 1;
            if let Some(done_on) = t.done_on {
                if format_local_day(done_on) == today {
                    done_today += 1;
                }
            }
            continue;
        }
        open += 1;
        *by_project.entry(t.project_id.clone()).or_insert(0) += 1;
        match task_plan_day(t) {
            None => unscheduled += 1,
            Some(day) if day.as_str() == today => due_today += 1,
            Some(day) if day.as_str() < today => overdue += 1,
            Some(_) => {}
        }
    }

    let completion_rate = if open + done_total == 0 {
        0.0
    } else {
        done_total as f32 / (open + done_total) as f32
    };

    let mut by_project: Vec<_> = by_project.into_iter().collect();
    by_project.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

    TaskStats {
        open,
        overdue,
        due_today,
        unscheduled,
        done_today,
        done_total,
        completion_rate,
        by_project,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task::create_task_draft;

    #[test]
    fn counts_open_and_unscheduled() {
        let t = create_task_draft("a", None, None, Some(1));
        let stats = compute_task_stats(&[t], "2026-01-01");
        assert_eq!(stats.open, 1);
        assert_eq!(stats.unscheduled, 1);
    }
}
