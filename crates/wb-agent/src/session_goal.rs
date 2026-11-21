//! Lightweight per-process session goal (not full DSH round driver).

use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionGoal {
    pub objective: String,
    #[serde(default = "default_status")]
    pub status: String,
    #[serde(default)]
    pub max_rounds: Option<u32>,
    #[serde(default)]
    pub rounds_started: u32,
}

fn default_status() -> String {
    "active".into()
}

fn store() -> &'static Mutex<Option<SessionGoal>> {
    static GOAL: OnceLock<Mutex<Option<SessionGoal>>> = OnceLock::new();
    GOAL.get_or_init(|| Mutex::new(None))
}

pub fn get_goal() -> Option<SessionGoal> {
    store().lock().unwrap().clone()
}

pub fn create_goal(objective: &str, max_rounds: Option<u32>) -> SessionGoal {
    let goal = SessionGoal {
        objective: objective.trim().to_string(),
        status: "active".into(),
        max_rounds,
        rounds_started: 0,
    };
    *store().lock().unwrap() = Some(goal.clone());
    goal
}

pub fn update_goal(action: &str, objective: Option<&str>) -> Result<SessionGoal, String> {
    let mut guard = store().lock().unwrap();
    let Some(goal) = guard.as_mut() else {
        return Err("当前无 goal，请先 create_goal".into());
    };
    match action {
        "edit" => {
            if let Some(obj) = objective.map(str::trim).filter(|s| !s.is_empty()) {
                goal.objective = obj.to_string();
            }
        }
        "pause" => goal.status = "paused".into(),
        "resume" => {
            if goal.status == "paused" {
                goal.status = "active".into();
            }
        }
        "complete" => goal.status = "completed".into(),
        "blocked" => goal.status = "blocked".into(),
        "clear" => {
            *guard = None;
            return Ok(SessionGoal {
                objective: String::new(),
                status: "cleared".into(),
                max_rounds: None,
                rounds_started: 0,
            });
        }
        "tick" => {
            goal.rounds_started = goal.rounds_started.saturating_add(1);
            if let Some(max) = goal.max_rounds {
                if goal.rounds_started >= max {
                    goal.status = "blocked".into();
                }
            }
        }
        other => {
            return Err(format!(
                "未知 action：{other}（edit/pause/resume/complete/blocked/clear/tick）"
            ));
        }
    }
    Ok(goal.clone())
}

pub fn clear_goal() {
    *store().lock().unwrap() = None;
}
