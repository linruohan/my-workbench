use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use wb_domain::{
    AgentApproval, AgentEvent, AgentMessage, AgentThread, AgentWorkspace, AppNotification, Note,
    Project, ProjectBucket, Tag, Task, TimedRunRecord, TimedTask,
};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbenchSnapshot {
    #[serde(default)]
    pub tasks: Vec<Task>,
    #[serde(default)]
    pub projects: Vec<Project>,
    #[serde(default)]
    pub buckets: HashMap<String, ProjectBucket>,
    #[serde(default)]
    pub today_order: Vec<String>,
    #[serde(default)]
    pub tags: Vec<Tag>,
    #[serde(default)]
    pub task_tags: HashMap<String, Vec<String>>,
    #[serde(default)]
    pub notes: Vec<Note>,
    #[serde(default)]
    pub notifications: Vec<AppNotification>,
    #[serde(default)]
    pub timed_tasks: Vec<TimedTask>,
    #[serde(default)]
    pub timed_runs: Vec<TimedRunRecord>,
    #[serde(default)]
    pub agent_workspaces: Vec<AgentWorkspace>,
    #[serde(default)]
    pub agent_threads: Vec<AgentThread>,
    #[serde(default)]
    pub agent_messages: Vec<AgentMessage>,
    #[serde(default)]
    pub agent_approvals: Vec<AgentApproval>,
    #[serde(default)]
    pub agent_events: Vec<AgentEvent>,
}
