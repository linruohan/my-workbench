//! Per-thread session goal. The goal itself lives on the agent thread so a
//! restart keeps it; the "in a goal round" flag is only meaningful for the
//! live turn and stays in memory.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use wb_domain::{AgentSessionGoal, DEFAULT_GOAL_BLOCKED_AFTER};
use wb_store::MemoryWorkbenchRepository;

pub type SessionGoal = AgentSessionGoal;

fn round_flags() -> &'static Mutex<HashMap<String, bool>> {
    static FLAGS: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();
    FLAGS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn in_goal_round(thread_id: &str) -> bool {
    round_flags()
        .lock()
        .unwrap()
        .get(thread_id)
        .copied()
        .unwrap_or(false)
}

pub fn clear_goal_round_flag(thread_id: &str) {
    round_flags()
        .lock()
        .unwrap()
        .insert(thread_id.to_string(), false);
}

fn set_round_flag(thread_id: &str, on: bool) {
    round_flags()
        .lock()
        .unwrap()
        .insert(thread_id.to_string(), on);
}

pub fn get_goal(repo: &MemoryWorkbenchRepository, thread_id: &str) -> Option<SessionGoal> {
    repo.get_agent_thread(thread_id)
        .and_then(|thread| thread.session_goal.clone())
}

pub fn create_goal(
    repo: &mut MemoryWorkbenchRepository,
    thread_id: &str,
    objective: &str,
    max_rounds: Option<u32>,
) -> Result<SessionGoal, String> {
    if repo.get_agent_thread(thread_id).is_none() {
        return Err("会话不存在，目标无法保存".into());
    }
    let goal = SessionGoal {
        objective: objective.trim().to_string(),
        status: "active".into(),
        max_rounds,
        rounds_started: 0,
        blocked_after: DEFAULT_GOAL_BLOCKED_AFTER,
    };
    repo.set_session_goal(thread_id, Some(goal.clone()));
    set_round_flag(thread_id, false);
    Ok(goal)
}

pub fn update_goal(
    repo: &mut MemoryWorkbenchRepository,
    thread_id: &str,
    action: &str,
    objective: Option<&str>,
) -> Result<SessionGoal, String> {
    if repo.get_agent_thread(thread_id).is_none() {
        return Err("会话不存在，目标无法保存".into());
    }
    let in_goal_round = in_goal_round(thread_id);
    if action == "clear" {
        repo.set_session_goal(thread_id, None);
        set_round_flag(thread_id, false);
        return Ok(SessionGoal {
            objective: String::new(),
            status: "cleared".into(),
            max_rounds: None,
            rounds_started: 0,
            blocked_after: DEFAULT_GOAL_BLOCKED_AFTER,
        });
    }
    let Some(mut goal) = get_goal(repo, thread_id) else {
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
        "tick" => {
            goal.rounds_started = goal.rounds_started.saturating_add(1);
            if let Some(max) = goal.max_rounds
                && goal.rounds_started >= max
            {
                goal.status = "blocked".into();
            }
        }
        other => {
            return Err(format!(
                "未知 action：{other}（edit/pause/resume/complete/blocked/clear/tick）"
            ));
        }
    }
    repo.set_session_goal(thread_id, Some(goal.clone()));
    Ok(goal)
}

/// If an active goal should drive another idle round, tick it and return a prompt.
pub fn prepare_goal_idle_round(
    repo: &mut MemoryWorkbenchRepository,
    thread_id: &str,
) -> Option<String> {
    let goal = get_goal(repo, thread_id)?;
    if goal.status != "active" {
        return None;
    }
    let updated = update_goal(repo, thread_id, "tick", None).ok()?;
    set_round_flag(thread_id, true);
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
    use wb_domain::{AgentThread, BUILTIN_MODEL_REF, now_ms};

    fn thread(repo: &mut MemoryWorkbenchRepository) -> String {
        let now = now_ms();
        let id = format!("goal-{}", uuid::Uuid::new_v4());
        repo.upsert_agent_thread(AgentThread {
            id: id.clone(),
            workspace_id: repo.list_agent_workspaces()[0].id.clone(),
            project_id: None,
            title: "goal".into(),
            model_ref: BUILTIN_MODEL_REF.into(),
            permission_mode: Default::default(),
            queue_json: None,
            web_url: None,
            archived_at: None,
            pinned_at: None,
            session_todos: Vec::new(),
            session_goal: None,
            cwd: None,
            draft: None,
            allowed_commands: Vec::new(),
            created_at: now,
            updated_at: now,
        });
        id
    }

    #[test]
    fn blocked_threshold_in_goal_round() {
        let mut repo = MemoryWorkbenchRepository::default();
        let id = thread(&mut repo);
        create_goal(&mut repo, &id, "测阈值", None).unwrap();
        assert!(prepare_goal_idle_round(&mut repo, &id).is_some());
        let err = update_goal(&mut repo, &id, "blocked", None).unwrap_err();
        assert!(err.contains("GOAL_TOOL_BLOCK_THRESHOLD"));
        clear_goal_round_flag(&id);
        create_goal(&mut repo, &id, "测阈值2", None).unwrap();
        for _ in 0..3 {
            update_goal(&mut repo, &id, "tick", None).unwrap();
        }
        set_round_flag(&id, true);
        assert!(update_goal(&mut repo, &id, "blocked", None).is_ok());
        let stored = get_goal(&repo, &id).unwrap();
        assert_eq!(stored.status, "blocked");
        assert_eq!(stored.objective, "测阈值2");
    }

    #[test]
    fn goal_survives_snapshot() {
        let mut repo = MemoryWorkbenchRepository::default();
        let id = thread(&mut repo);
        create_goal(&mut repo, &id, "写完持久化", Some(4)).unwrap();
        let snap = repo.export_snapshot();
        let mut restored = MemoryWorkbenchRepository::new();
        restored.import_snapshot(snap);
        let goal = get_goal(&restored, &id).unwrap();
        assert_eq!(goal.objective, "写完持久化");
        assert_eq!(goal.max_rounds, Some(4));
    }
}
