use crate::snapshot::WorkbenchSnapshot;
use std::collections::{HashMap, HashSet};
use wb_domain::{
    AgentApproval, AgentMessage, AgentThread, AgentWorkspace, AppNotification,
    DEFAULT_AGENT_WORKSPACE_TITLE, INBOX_PROJECT_ID, Note, NotificationKind, NotificationStatus,
    Project, ProjectBucket, Tag, Task, TimedTask, create_id, create_inbox_project,
    create_task_draft, mark_task_complete, mark_task_incomplete, now_ms, try_advance_repeat,
};

#[derive(Debug, Clone)]
pub struct MemoryWorkbenchRepository {
    tasks: HashMap<String, Task>,
    projects: HashMap<String, Project>,
    buckets: HashMap<String, ProjectBucket>,
    today_order: Vec<String>,
    tags: HashMap<String, Tag>,
    task_tags: HashMap<String, HashSet<String>>,
    notes: HashMap<String, Note>,
    notifications: Vec<AppNotification>,
    timed_tasks: HashMap<String, TimedTask>,
    agent_workspaces: HashMap<String, AgentWorkspace>,
    agent_threads: HashMap<String, AgentThread>,
    agent_messages: HashMap<String, AgentMessage>,
    agent_approvals: HashMap<String, AgentApproval>,
    dirty: bool,
}

impl Default for MemoryWorkbenchRepository {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryWorkbenchRepository {
    pub fn new() -> Self {
        let now = now_ms();
        let mut projects = HashMap::new();
        projects.insert(INBOX_PROJECT_ID.into(), create_inbox_project(now));
        let mut agent_workspaces = HashMap::new();
        let ws_id = create_id(now);
        agent_workspaces.insert(
            ws_id.clone(),
            AgentWorkspace {
                id: ws_id,
                title: DEFAULT_AGENT_WORKSPACE_TITLE.into(),
                root_path: None,
                created_at: now,
                updated_at: now,
            },
        );
        Self {
            tasks: HashMap::new(),
            projects,
            buckets: HashMap::new(),
            today_order: Vec::new(),
            tags: HashMap::new(),
            task_tags: HashMap::new(),
            notes: HashMap::new(),
            notifications: Vec::new(),
            timed_tasks: HashMap::new(),
            agent_workspaces,
            agent_threads: HashMap::new(),
            agent_messages: HashMap::new(),
            agent_approvals: HashMap::new(),
            dirty: false,
        }
    }

    pub fn is_dirty(&self) -> bool {
        self.dirty
    }

    pub fn clear_dirty(&mut self) {
        self.dirty = false;
    }

    pub fn mark_dirty(&mut self) {
        self.dirty = true;
    }

    pub fn export_snapshot(&self) -> WorkbenchSnapshot {
        WorkbenchSnapshot {
            tasks: self.list_tasks(),
            projects: self.list_projects(),
            buckets: self.buckets.clone(),
            today_order: self.today_order.clone(),
            tags: self.list_tags(),
            task_tags: self
                .task_tags
                .iter()
                .map(|(k, v)| {
                    let mut ids: Vec<_> = v.iter().cloned().collect();
                    ids.sort();
                    (k.clone(), ids)
                })
                .collect(),
            notes: self.list_notes(),
            notifications: self.notifications.clone(),
            timed_tasks: self.list_timed_tasks(),
            agent_workspaces: self.list_agent_workspaces(),
            agent_threads: self.list_agent_threads(),
            agent_messages: self.list_agent_messages(),
            agent_approvals: self.list_agent_approvals(),
        }
    }

    pub fn import_snapshot(&mut self, snap: WorkbenchSnapshot) {
        self.tasks = snap.tasks.into_iter().map(|t| (t.id.clone(), t)).collect();
        self.projects = snap
            .projects
            .into_iter()
            .map(|p| (p.id.clone(), p))
            .collect();
        if !self.projects.contains_key(INBOX_PROJECT_ID) {
            self.projects
                .insert(INBOX_PROJECT_ID.into(), create_inbox_project(now_ms()));
        }
        self.buckets = snap.buckets;
        self.today_order = snap.today_order;
        self.tags = snap.tags.into_iter().map(|t| (t.id.clone(), t)).collect();
        self.task_tags = snap
            .task_tags
            .into_iter()
            .map(|(k, v)| (k, v.into_iter().collect()))
            .collect();
        self.notes = snap.notes.into_iter().map(|n| (n.id.clone(), n)).collect();
        self.notifications = snap.notifications;
        self.timed_tasks = snap
            .timed_tasks
            .into_iter()
            .map(|t| (t.id.clone(), t))
            .collect();
        self.agent_workspaces = snap
            .agent_workspaces
            .into_iter()
            .map(|w| (w.id.clone(), w))
            .collect();
        if self.agent_workspaces.is_empty() {
            let now = now_ms();
            let id = create_id(now);
            self.agent_workspaces.insert(
                id.clone(),
                AgentWorkspace {
                    id,
                    title: DEFAULT_AGENT_WORKSPACE_TITLE.into(),
                    root_path: None,
                    created_at: now,
                    updated_at: now,
                },
            );
        }
        self.agent_threads = snap
            .agent_threads
            .into_iter()
            .map(|t| (t.id.clone(), t))
            .collect();
        self.agent_messages = snap
            .agent_messages
            .into_iter()
            .map(|m| (m.id.clone(), m))
            .collect();
        self.agent_approvals = snap
            .agent_approvals
            .into_iter()
            .map(|a| (a.id.clone(), a))
            .collect();
        self.dirty = false;
    }

    pub fn list_tasks(&self) -> Vec<Task> {
        let mut v: Vec<_> = self.tasks.values().cloned().collect();
        v.sort_by_key(|a| a.created_at);
        v
    }

    pub fn get_task(&self, id: &str) -> Option<&Task> {
        self.tasks.get(id)
    }

    pub fn upsert_task(&mut self, task: Task) {
        self.tasks.insert(task.id.clone(), task);
        self.dirty = true;
    }

    pub fn create_task(&mut self, title: &str, project_id: Option<&str>) -> Task {
        let task = create_task_draft(title, project_id, None, None);
        self.upsert_task(task.clone());
        task
    }

    pub fn complete_task(&mut self, id: &str) -> Option<Task> {
        let now = now_ms();
        let task = self.tasks.get_mut(id)?;
        if try_advance_repeat(task, now) {
            let out = task.clone();
            self.dirty = true;
            return Some(out);
        }
        mark_task_complete(task, now);
        let out = task.clone();
        self.dirty = true;
        Some(out)
    }

    pub fn incomplete_task(&mut self, id: &str) -> Option<Task> {
        let now = now_ms();
        let task = self.tasks.get_mut(id)?;
        mark_task_incomplete(task, now);
        let out = task.clone();
        self.dirty = true;
        Some(out)
    }

    pub fn delete_task(&mut self, id: &str) {
        self.tasks.remove(id);
        self.task_tags.remove(id);
        self.today_order.retain(|x| x != id);
        // cascade children
        let children: Vec<_> = self
            .tasks
            .values()
            .filter(|t| t.parent_id.as_deref() == Some(id))
            .map(|t| t.id.clone())
            .collect();
        for cid in children {
            self.delete_task(&cid);
        }
        self.dirty = true;
    }

    pub fn list_projects(&self) -> Vec<Project> {
        let mut v: Vec<_> = self.projects.values().cloned().collect();
        v.sort_by(|a, b| {
            if a.id == INBOX_PROJECT_ID {
                return std::cmp::Ordering::Less;
            }
            if b.id == INBOX_PROJECT_ID {
                return std::cmp::Ordering::Greater;
            }
            a.created_at.cmp(&b.created_at)
        });
        v
    }

    pub fn create_project(&mut self, title: &str) -> Project {
        let now = now_ms();
        let p = Project {
            id: create_id(now),
            title: title.trim().to_string(),
            is_archived: false,
            is_done: false,
            done_on: None,
            created_at: now,
            updated_at: now,
        };
        self.projects.insert(p.id.clone(), p.clone());
        self.buckets.insert(p.id.clone(), ProjectBucket::Active);
        self.dirty = true;
        p
    }

    pub fn rename_project(&mut self, id: &str, title: &str) -> Option<Project> {
        let p = self.projects.get_mut(id)?;
        p.title = title.trim().to_string();
        p.updated_at = now_ms();
        self.dirty = true;
        Some(p.clone())
    }

    pub fn set_project_archived(&mut self, id: &str, archived: bool) -> Option<Project> {
        if id == INBOX_PROJECT_ID {
            return None;
        }
        let p = self.projects.get_mut(id)?;
        p.is_archived = archived;
        p.updated_at = now_ms();
        self.buckets.insert(
            id.to_string(),
            if archived {
                ProjectBucket::Backlog
            } else {
                ProjectBucket::Active
            },
        );
        self.dirty = true;
        Some(p.clone())
    }

    pub fn today_order(&self) -> &[String] {
        &self.today_order
    }

    pub fn set_today_order(&mut self, order: Vec<String>) {
        self.today_order = order;
        self.dirty = true;
    }

    pub fn bucket_of(&self, project_id: &str) -> ProjectBucket {
        self.buckets
            .get(project_id)
            .copied()
            .unwrap_or(ProjectBucket::Active)
    }

    pub fn set_bucket(&mut self, project_id: &str, bucket: ProjectBucket) {
        self.buckets.insert(project_id.to_string(), bucket);
        self.dirty = true;
    }

    pub fn list_tags(&self) -> Vec<Tag> {
        let mut v: Vec<_> = self.tags.values().cloned().collect();
        v.sort_by_key(|a| a.title.clone());
        v
    }

    pub fn create_tag(&mut self, title: &str) -> Tag {
        let title = title.trim();
        if let Some(existing) = self.tags.values().find(|t| t.title == title) {
            return existing.clone();
        }
        let now = now_ms();
        let tag = Tag {
            id: create_id(now),
            title: title.to_string(),
            color: None,
        };
        self.tags.insert(tag.id.clone(), tag.clone());
        self.dirty = true;
        tag
    }

    pub fn tags_for_task(&self, task_id: &str) -> Vec<Tag> {
        let Some(ids) = self.task_tags.get(task_id) else {
            return Vec::new();
        };
        let mut v: Vec<_> = ids
            .iter()
            .filter_map(|id| self.tags.get(id).cloned())
            .collect();
        v.sort_by_key(|a| a.title.clone());
        v
    }

    pub fn add_tag_to_task(&mut self, task_id: &str, tag_id: &str) {
        self.task_tags
            .entry(task_id.to_string())
            .or_default()
            .insert(tag_id.to_string());
        self.dirty = true;
    }

    pub fn remove_tag_from_task(&mut self, task_id: &str, tag_id: &str) {
        if let Some(set) = self.task_tags.get_mut(task_id) {
            set.remove(tag_id);
            self.dirty = true;
        }
    }

    /// Root-level incomplete tasks that carry `tag_id` (or all tagged roots if looking up counts).
    pub fn task_has_tag(&self, task_id: &str, tag_id: &str) -> bool {
        self.task_tags
            .get(task_id)
            .map(|set| set.contains(tag_id))
            .unwrap_or(false)
    }

    pub fn count_tasks_for_tag(&self, tag_id: &str) -> usize {
        self.task_tags
            .values()
            .filter(|set| set.contains(tag_id))
            .count()
    }

    pub fn list_notes(&self) -> Vec<Note> {
        let mut v: Vec<_> = self.notes.values().cloned().collect();
        v.sort_by_key(|a| std::cmp::Reverse(a.updated_at));
        v
    }

    pub fn upsert_note(&mut self, note: Note) {
        self.notes.insert(note.id.clone(), note);
        self.dirty = true;
    }

    pub fn get_note(&self, id: &str) -> Option<&Note> {
        self.notes.get(id)
    }

    pub fn delete_note(&mut self, id: &str) -> bool {
        let removed = self.notes.remove(id).is_some();
        if removed {
            self.dirty = true;
        }
        removed
    }

    pub fn create_note(&mut self, title: &str, body_md: &str) -> Note {
        let now = now_ms();
        let note = Note {
            id: create_id(now),
            project_id: None,
            title: title.to_string(),
            body_md: body_md.to_string(),
            created_at: now,
            updated_at: now,
        };
        self.upsert_note(note.clone());
        note
    }

    pub fn list_notifications(&self) -> Vec<AppNotification> {
        self.notifications.clone()
    }

    pub fn push_notification(
        &mut self,
        kind: NotificationKind,
        title: &str,
        body: &str,
        ref_id: Option<&str>,
    ) -> AppNotification {
        let now = now_ms();
        let n = AppNotification {
            id: create_id(now),
            kind,
            title: title.into(),
            body: body.into(),
            ref_type: None,
            ref_id: ref_id.map(|s| s.to_string()),
            fire_at: now,
            status: NotificationStatus::Delivered,
            snooze_until: None,
            created_at: now,
            updated_at: now,
        };
        self.notifications.insert(0, n.clone());
        self.dirty = true;
        n
    }

    pub fn dismiss_notification(&mut self, id: &str) {
        if let Some(n) = self.notifications.iter_mut().find(|n| n.id == id) {
            n.status = NotificationStatus::Dismissed;
            n.snooze_until = None;
            n.updated_at = now_ms();
            self.dirty = true;
        }
    }

    pub fn snooze_notification(&mut self, id: &str, until_ms: i64) {
        if let Some(n) = self.notifications.iter_mut().find(|n| n.id == id) {
            n.status = NotificationStatus::Snoozed;
            n.snooze_until = Some(until_ms);
            n.fire_at = until_ms;
            n.updated_at = now_ms();
            self.dirty = true;
        }
    }

    /// Bring snoozed notifications back when their snooze window ends.
    pub fn wake_snoozed_notifications(&mut self, now: i64) -> usize {
        let mut woken = 0usize;
        for n in &mut self.notifications {
            if n.status == NotificationStatus::Snoozed
                && n.snooze_until.map(|t| t <= now).unwrap_or(true)
            {
                n.status = NotificationStatus::Delivered;
                n.snooze_until = None;
                n.updated_at = now;
                woken += 1;
            }
        }
        if woken > 0 {
            self.dirty = true;
        }
        woken
    }

    pub fn dismiss_all_notifications(&mut self) {
        let now = now_ms();
        let mut changed = false;
        for n in &mut self.notifications {
            if !matches!(n.status, NotificationStatus::Dismissed) {
                n.status = NotificationStatus::Dismissed;
                n.updated_at = now;
                changed = true;
            }
        }
        if changed {
            self.dirty = true;
        }
    }

    pub fn list_timed_tasks(&self) -> Vec<TimedTask> {
        let mut v: Vec<_> = self.timed_tasks.values().cloned().collect();
        v.sort_by_key(|a| a.created_at);
        v
    }

    pub fn upsert_timed_task(&mut self, task: TimedTask) {
        self.timed_tasks.insert(task.id.clone(), task);
        self.dirty = true;
    }

    pub fn delete_timed_task(&mut self, id: &str) {
        self.timed_tasks.remove(id);
        self.dirty = true;
    }

    pub fn get_timed_task(&self, id: &str) -> Option<&TimedTask> {
        self.timed_tasks.get(id)
    }

    pub fn list_agent_workspaces(&self) -> Vec<AgentWorkspace> {
        let mut v: Vec<_> = self.agent_workspaces.values().cloned().collect();
        v.sort_by_key(|a| a.created_at);
        v
    }

    pub fn list_agent_threads(&self) -> Vec<AgentThread> {
        let mut v: Vec<_> = self.agent_threads.values().cloned().collect();
        v.sort_by_key(|a| std::cmp::Reverse(a.updated_at));
        v
    }

    pub fn upsert_agent_thread(&mut self, thread: AgentThread) {
        self.agent_threads.insert(thread.id.clone(), thread);
        self.dirty = true;
    }

    pub fn delete_agent_thread(&mut self, id: &str) {
        self.agent_threads.remove(id);
        self.agent_messages.retain(|_, m| m.thread_id != id);
        self.dirty = true;
    }

    pub fn upsert_agent_workspace(&mut self, ws: AgentWorkspace) {
        self.agent_workspaces.insert(ws.id.clone(), ws);
        self.dirty = true;
    }

    pub fn list_agent_messages(&self) -> Vec<AgentMessage> {
        let mut v: Vec<_> = self.agent_messages.values().cloned().collect();
        v.sort_by_key(|a| a.created_at);
        v
    }

    pub fn messages_for_thread(&self, thread_id: &str) -> Vec<AgentMessage> {
        let mut v: Vec<_> = self
            .agent_messages
            .values()
            .filter(|m| m.thread_id == thread_id)
            .cloned()
            .collect();
        v.sort_by_key(|a| a.created_at);
        v
    }

    pub fn upsert_agent_message(&mut self, msg: AgentMessage) {
        self.agent_messages.insert(msg.id.clone(), msg);
        self.dirty = true;
    }

    pub fn list_agent_approvals(&self) -> Vec<AgentApproval> {
        let mut v: Vec<_> = self.agent_approvals.values().cloned().collect();
        v.sort_by_key(|a| std::cmp::Reverse(a.created_at));
        v
    }

    pub fn upsert_agent_approval(&mut self, a: AgentApproval) {
        self.agent_approvals.insert(a.id.clone(), a);
        self.dirty = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_round_trip() {
        let mut repo = MemoryWorkbenchRepository::new();
        repo.create_task("hello", None);
        let snap = repo.export_snapshot();
        let json = serde_json::to_string(&snap).unwrap();
        let parsed: WorkbenchSnapshot = serde_json::from_str(&json).unwrap();
        let mut repo2 = MemoryWorkbenchRepository::new();
        repo2.import_snapshot(parsed);
        assert_eq!(repo2.list_tasks().len(), 1);
        assert_eq!(repo2.list_tasks()[0].title, "hello");
    }
}
