//! In-process managed subagent registry (light DSH subagent-control).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use wb_domain::now_ms;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManagedAgentStatus {
    Running,
    Inactive,
    Interrupted,
}

impl ManagedAgentStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Inactive => "inactive",
            Self::Interrupted => "interrupted",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ManagedAgentRecord {
    pub id: String,
    pub parent_thread_id: String,
    pub name: String,
    pub status: ManagedAgentStatus,
    pub depth: u32,
    pub inbox: Vec<String>,
    pub result_text: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone)]
pub struct ManagedAgentView {
    pub id: String,
    pub parent_thread_id: String,
    pub name: String,
    pub status: ManagedAgentStatus,
    pub depth: u32,
    pub inbox: usize,
    pub result_text: Option<String>,
}

fn agents() -> &'static Mutex<HashMap<String, ManagedAgentRecord>> {
    static AGENTS: OnceLock<Mutex<HashMap<String, ManagedAgentRecord>>> = OnceLock::new();
    AGENTS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn register_managed_agent(
    id: &str,
    parent_thread_id: &str,
    name: &str,
    depth: u32,
) -> ManagedAgentRecord {
    let record = ManagedAgentRecord {
        id: id.to_string(),
        parent_thread_id: parent_thread_id.to_string(),
        name: name.to_string(),
        status: ManagedAgentStatus::Running,
        depth,
        inbox: Vec::new(),
        result_text: None,
        created_at: now_ms(),
    };
    agents()
        .lock()
        .unwrap()
        .insert(record.id.clone(), record.clone());
    record
}

pub fn get_managed_agent(id: &str) -> Option<ManagedAgentRecord> {
    agents().lock().unwrap().get(id.trim()).cloned()
}

pub fn list_managed_agents(parent_thread_id: &str, descendants: bool) -> Vec<ManagedAgentView> {
    let parent = parent_thread_id.trim();
    if parent.is_empty() {
        return Vec::new();
    }
    let map = agents().lock().unwrap();
    if !descendants {
        let mut out: Vec<_> = map
            .values()
            .filter(|a| a.parent_thread_id == parent)
            .map(view_of)
            .collect();
        out.sort_by(|a, b| a.id.cmp(&b.id));
        return out;
    }
    let mut out = Vec::new();
    fn walk(
        map: &HashMap<String, ManagedAgentRecord>,
        pid: &str,
        depth: u32,
        out: &mut Vec<ManagedAgentView>,
    ) {
        let mut kids: Vec<_> = map
            .values()
            .filter(|a| a.parent_thread_id == pid)
            .cloned()
            .collect();
        kids.sort_by(|a, b| a.id.cmp(&b.id));
        for agent in kids {
            let mut view = view_of(&agent);
            view.depth = depth;
            let id = agent.id.clone();
            out.push(view);
            walk(map, &id, depth + 1, out);
        }
    }
    walk(&map, parent, 1, &mut out);
    out
}

pub fn interrupt_managed_agent(
    agent_id: &str,
    caller_thread_id: &str,
) -> Result<ManagedAgentView, String> {
    let mut map = agents().lock().unwrap();
    let Some(agent) = map.get_mut(agent_id.trim()) else {
        return Err("未知子智能体".into());
    };
    if caller_thread_id != agent.parent_thread_id {
        return Err("只能中断自己的直接子智能体".into());
    }
    if agent.status == ManagedAgentStatus::Running {
        agent.status = ManagedAgentStatus::Interrupted;
    }
    Ok(view_of(agent))
}

pub fn send_managed_agent_message(
    agent_id: &str,
    caller_thread_id: &str,
    message: &str,
) -> Result<ManagedAgentView, String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("消息不能为空".into());
    }
    let mut map = agents().lock().unwrap();
    let Some(agent) = map.get_mut(agent_id.trim()) else {
        return Err("未知子智能体".into());
    };
    if caller_thread_id != agent.parent_thread_id {
        return Err("只能给自己的直接子智能体发消息".into());
    }
    if agent.status == ManagedAgentStatus::Interrupted {
        return Err("子智能体已中断".into());
    }
    agent.inbox.push(message.to_string());
    if agent.status == ManagedAgentStatus::Inactive {
        agent.status = ManagedAgentStatus::Running;
    }
    Ok(view_of(agent))
}

pub fn take_managed_agent_inbox(agent_id: &str) -> Vec<String> {
    let mut map = agents().lock().unwrap();
    let Some(agent) = map.get_mut(agent_id.trim()) else {
        return Vec::new();
    };
    std::mem::take(&mut agent.inbox)
}

pub fn finish_managed_agent(agent_id: &str, result_text: &str) -> Option<ManagedAgentView> {
    let mut map = agents().lock().unwrap();
    let agent = map.get_mut(agent_id.trim())?;
    agent.status = ManagedAgentStatus::Inactive;
    agent.result_text = Some(result_text.to_string());
    Some(view_of(agent))
}

pub fn remove_managed_agent(agent_id: &str) {
    agents().lock().unwrap().remove(agent_id.trim());
}

fn view_of(agent: &ManagedAgentRecord) -> ManagedAgentView {
    ManagedAgentView {
        id: agent.id.clone(),
        parent_thread_id: agent.parent_thread_id.clone(),
        name: agent.name.clone(),
        status: agent.status,
        depth: agent.depth,
        inbox: agent.inbox.len(),
        result_text: agent.result_text.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_list_interrupt() {
        remove_managed_agent("child-a");
        register_managed_agent("child-a", "parent-1", "researcher", 1);
        let listed = list_managed_agents("parent-1", false);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "researcher");
        let view = interrupt_managed_agent("child-a", "parent-1").unwrap();
        assert_eq!(view.status, ManagedAgentStatus::Interrupted);
        remove_managed_agent("child-a");
    }
}
