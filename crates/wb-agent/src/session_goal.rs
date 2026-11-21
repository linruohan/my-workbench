//! Lightweight per-process session goal (not full DSH round driver).

use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};

const DEFAULT_BLOCKED_AFTER: u32 = 3;

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
    /// Autonomous goal rounds must reach this before `blocked` is accepted.
    #[serde(default = "default_blocked_after")]
    pub blocked_after: u32,
}

fn default_status() -> String {
    "active".into()
}

fn default_blocked_after() -> u32 {
    DEFAULT_BLOCKED_AFTER
}

struct GoalState {
    goal: Option<SessionGoal>,
    /// True while the current turn was started by `prepare_goal_idle_round`.
    in_goal_round: bool,
}

fn store() -> &'static Mutex<GoalState> {
    static GOAL: OnceLock<Mutex<GoalState>> = OnceLock::new();
    GOAL.get_or_init(|| {
        Mutex::new(GoalState {
            goal: None,
            in_goal_round: false,
        })
    })
}

pub fn get_goal() -> Option<SessionGoal> {
    store().lock().unwrap().goal.clone()
}

pub fn in_goal_round() -> bool {
    store().lock().unwrap().in_goal_round
}

pub fn clear_goal_round_flag() {
    store().lock().unwrap().in_goal_round = false;
}

pub fn create_goal(objective: &str, max_rounds: Option<u32>) -> SessionGoal {
    let goal = SessionGoal {
        objective: objective.trim().to_string(),
        status: "active".into(),
        max_rounds,
        rounds_started: 0,
        blocked_after: DEFAULT_BLOCKED_AFTER,
    };
    let mut guard = store().lock().unwrap();
    guard.goal = Some(goal.clone());
    guard.in_goal_round = false;
    goal
}

pub fn update_goal(action: &str, objective: Option<&str>) -> Result<SessionGoal, String> {
    let mut guard = store().lock().unwrap();
    let in_goal_round = guard.in_goal_round;
    let Some(goal) = guard.goal.as_mut() else {
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
        "blocked" => {
            if in_goal_round && goal.rounds_started < goal.blocked_after {
                return Err(format!(
                    "GOAL_TOOL_BLOCK_THRESHOLD：自主 Goal Round 须至少 {} 轮后才可 blocked（当前 {}）",
                    goal.blocked_after, goal.rounds_started
                ));
            }
            goal.status = "blocked".into();
        }
        "clear" => {
            guard.goal = None;
            guard.in_goal_round = false;
            return Ok(SessionGoal {
                objective: String::new(),
                status: "cleared".into(),
                max_rounds: None,
                rounds_started: 0,
                blocked_after: DEFAULT_BLOCKED_AFTER,
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
    let mut guard = store().lock().unwrap();
    guard.goal = None;
    guard.in_goal_round = false;
}

/// If an active goal should drive another idle round, tick it and return a prompt.
pub fn prepare_goal_idle_round() -> Option<String> {
    let g = get_goal()?;
    if g.status != "active" {
        return None;
    }
    let updated = update_goal("tick", None).ok()?;
    store().lock().unwrap().in_goal_round = true;
    if updated.status == "blocked" {
        return Some(format!(
            "[Goal] 已达回合上限并标记 blocked。目标：{}\n请总结进度或 update_goal(action=complete)。",
            updated.objective
        ));
    }
    if updated.status != "active" {
        return None;
    }
    Some(format!(
        "[Goal Round {}] 继续推进目标：{}\n完成后调用 update_goal(action=complete)；自主 blocked 需满 {} 轮。",
        updated.rounds_started, updated.objective, updated.blocked_after
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocked_threshold_in_goal_round() {
        clear_goal();
        create_goal("测阈值", None);
        assert!(prepare_goal_idle_round().is_some());
        let err = update_goal("blocked", None).unwrap_err();
        assert!(err.contains("GOAL_TOOL_BLOCK_THRESHOLD"));
        clear_goal_round_flag();
        create_goal("测阈值2", None);
        for _ in 0..3 {
            let _ = update_goal("tick", None);
        }
        store().lock().unwrap().in_goal_round = true;
        assert!(update_goal("blocked", None).is_ok());
        clear_goal();
    }
}
