use crate::snapshot::WorkbenchSnapshot;
use std::collections::{HashMap, HashSet};
use wb_domain::{
    AgentApproval, AgentMessage, AgentThread, AgentWorkspace, AppNotification,
    DEFAULT_AGENT_WORKSPACE_TITLE, INBOX_PROJECT_ID, Note, NotificationKind, NotificationStatus,
    Project, ProjectBucket, Tag, Task, TimedRunRecord, TimedTask, create_id, create_inbox_project,
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
    timed_runs: Vec<TimedRunRecord>,
    agent_workspaces: HashMap<String, AgentWorkspace>,
    agent_threads: HashMap<String, AgentThread>,
    agent_messages: HashMap<String, AgentMessage>,
    agent_approvals: HashMap<String, AgentApproval>,
    dirty: bool,
    /// Bumps on every mutation so views can reuse a sorted task list.
    revision: u64,
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
            timed_runs: Vec::new(),
            agent_workspaces,
            agent_threads: HashMap::new(),
            agent_messages: HashMap::new(),
            agent_approvals: HashMap::new(),
            dirty: false,
            revision: 0,
        }
    }

    fn touch(&mut self) {
        self.dirty = true;
        self.revision = self.revision.wrapping_add(1);
    }

    pub fn data_revision(&self) -> u64 {
        self.revision
    }

    pub fn is_dirty(&self) -> bool {
        self.dirty
    }

    pub fn clear_dirty(&mut self) {
        self.dirty = false;
    }

    pub fn mark_dirty(&mut self) {
        self.touch();
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
            timed_runs: self.timed_runs.clone(),
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
        self.timed_runs = snap.timed_runs;
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
        self.revision = self.revision.wrapping_add(1);
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
        self.touch();
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
            self.touch();
            return Some(out);
        }
        mark_task_complete(task, now);
        let out = task.clone();
        self.touch();
        Some(out)
    }

    pub fn incomplete_task(&mut self, id: &str) -> Option<Task> {
        let now = now_ms();
        let task = self.tasks.get_mut(id)?;
        mark_task_incomplete(task, now);
        let out = task.clone();
        self.touch();
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
        self.touch();
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
        self.touch();
        p
    }

    pub fn rename_project(&mut self, id: &str, title: &str) -> Option<Project> {
        {
            let p = self.projects.get_mut(id)?;
            p.title = title.trim().to_string();
            p.updated_at = now_ms();
        }
        self.touch();
        self.projects.get(id).cloned()
    }

    pub fn set_project_archived(&mut self, id: &str, archived: bool) -> Option<Project> {
        if id == INBOX_PROJECT_ID {
            return None;
        }
        {
            let p = self.projects.get_mut(id)?;
            p.is_archived = archived;
            p.updated_at = now_ms();
        }
        self.buckets.insert(
            id.to_string(),
            if archived {
                ProjectBucket::Backlog
            } else {
                ProjectBucket::Active
            },
        );
        self.touch();
        self.projects.get(id).cloned()
    }

    /// Removes a project and every task that belongs to it. The inbox cannot be deleted.
    pub fn delete_project(&mut self, id: &str) -> bool {
        if id == INBOX_PROJECT_ID || !self.projects.contains_key(id) {
            return false;
        }
        self.projects.remove(id);
        self.buckets.remove(id);
        let task_ids: Vec<String> = self
            .tasks
            .values()
            .filter(|task| task.project_id == id)
            .map(|task| task.id.clone())
            .collect();
        for task_id in task_ids {
            if self.tasks.contains_key(&task_id) {
                self.delete_task(&task_id);
            }
        }
        self.touch();
        true
    }

    pub fn today_order(&self) -> &[String] {
        &self.today_order
    }

    pub fn set_today_order(&mut self, order: Vec<String>) {
        self.today_order = order;
        self.touch();
    }

    pub fn bucket_of(&self, project_id: &str) -> ProjectBucket {
        self.buckets
            .get(project_id)
            .copied()
            .unwrap_or(ProjectBucket::Active)
    }

    pub fn set_bucket(&mut self, project_id: &str, bucket: ProjectBucket) {
        self.buckets.insert(project_id.to_string(), bucket);
        self.touch();
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
        self.touch();
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
        self.touch();
    }

    pub fn remove_tag_from_task(&mut self, task_id: &str, tag_id: &str) {
        if let Some(set) = self.task_tags.get_mut(task_id) {
            set.remove(tag_id);
            self.touch();
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

    pub fn rename_tag(&mut self, id: &str, title: &str) -> bool {
        let title = title.trim();
        if title.is_empty() || !self.tags.contains_key(id) {
            return false;
        }
        if self
            .tags
            .values()
            .any(|tag| tag.id != id && tag.title == title)
        {
            return false;
        }
        if let Some(tag) = self.tags.get_mut(id) {
            tag.title = title.to_string();
            self.touch();
            return true;
        }
        false
    }

    pub fn delete_tag(&mut self, id: &str) -> bool {
        if self.tags.remove(id).is_none() {
            return false;
        }
        for tags in self.task_tags.values_mut() {
            tags.remove(id);
        }
        self.touch();
        true
    }

    pub fn list_notes(&self) -> Vec<Note> {
        let mut v: Vec<_> = self.notes.values().cloned().collect();
        v.sort_by_key(|a| std::cmp::Reverse(a.updated_at));
        v
    }

    pub fn upsert_note(&mut self, note: Note) {
        self.notes.insert(note.id.clone(), note);
        self.touch();
    }

    pub fn get_note(&self, id: &str) -> Option<&Note> {
        self.notes.get(id)
    }

    pub fn delete_note(&mut self, id: &str) -> bool {
        let removed = self.notes.remove(id).is_some();
        if removed {
            self.touch();
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
        self.touch();
        n
    }

    pub fn dismiss_notification(&mut self, id: &str) {
        if let Some(n) = self.notifications.iter_mut().find(|n| n.id == id) {
            n.status = NotificationStatus::Dismissed;
            n.snooze_until = None;
            n.updated_at = now_ms();
            self.touch();
        }
    }

    pub fn snooze_notification(&mut self, id: &str, until_ms: i64) {
        if let Some(n) = self.notifications.iter_mut().find(|n| n.id == id) {
            n.status = NotificationStatus::Snoozed;
            n.snooze_until = Some(until_ms);
            n.fire_at = until_ms;
            n.updated_at = now_ms();
            self.touch();
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
            self.touch();
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
            self.touch();
        }
    }

    pub fn list_timed_tasks(&self) -> Vec<TimedTask> {
        let mut v: Vec<_> = self.timed_tasks.values().cloned().collect();
        v.sort_by_key(|a| a.created_at);
        v
    }

    pub fn upsert_timed_task(&mut self, task: TimedTask) {
        self.timed_tasks.insert(task.id.clone(), task);
        self.touch();
    }

    pub fn delete_timed_task(&mut self, id: &str) {
        self.timed_tasks.remove(id);
        self.timed_runs.retain(|run| run.task_id != id);
        self.touch();
    }

    pub fn get_timed_task(&self, id: &str) -> Option<&TimedTask> {
        self.timed_tasks.get(id)
    }

    pub fn append_timed_run(&mut self, record: TimedRunRecord) {
        let task_id = record.task_id.clone();
        self.timed_runs.push(record);
        let mut extra = self
            .timed_runs
            .iter()
            .filter(|run| run.task_id == task_id)
            .count()
            .saturating_sub(200);
        while extra > 0 {
            if let Some(index) = self
                .timed_runs
                .iter()
                .position(|run| run.task_id == task_id)
            {
                self.timed_runs.remove(index);
            }
            extra -= 1;
        }
        self.touch();
    }

    pub fn list_timed_runs(&self, task_id: &str) -> Vec<TimedRunRecord> {
        let mut runs: Vec<_> = self
            .timed_runs
            .iter()
            .filter(|run| run.task_id == task_id)
            .cloned()
            .collect();
        runs.sort_by_key(|run| std::cmp::Reverse(run.ran_at));
        runs
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

    pub fn get_agent_thread(&self, id: &str) -> Option<&AgentThread> {
        self.agent_threads.get(id)
    }

    pub fn set_session_todos(&mut self, id: &str, todos: Vec<wb_domain::AgentSessionTodo>) -> bool {
        let Some(thread) = self.agent_threads.get_mut(id) else {
            return false;
        };
        if thread.session_todos == todos {
            return false;
        }
        thread.session_todos = todos;
        thread.updated_at = now_ms();
        self.touch();
        true
    }

    pub fn set_session_goal(
        &mut self,
        id: &str,
        goal: Option<wb_domain::AgentSessionGoal>,
    ) -> bool {
        let Some(thread) = self.agent_threads.get_mut(id) else {
            return false;
        };
        if thread.session_goal == goal {
            return false;
        }
        thread.session_goal = goal;
        thread.updated_at = now_ms();
        self.touch();
        true
    }

    pub fn set_thread_cwd(&mut self, id: &str, cwd: Option<String>) -> bool {
        let Some(thread) = self.agent_threads.get_mut(id) else {
            return false;
        };
        let cwd = cwd.and_then(|path| {
            let path = path.trim().to_string();
            if path.is_empty() { None } else { Some(path) }
        });
        if thread.cwd == cwd {
            return false;
        }
        thread.cwd = cwd;
        thread.updated_at = now_ms();
        self.touch();
        true
    }

    /// Empty text clears the stored draft.
    pub fn set_thread_draft(&mut self, id: &str, draft: &str) -> bool {
        let Some(thread) = self.agent_threads.get_mut(id) else {
            return false;
        };
        let draft = {
            let draft = draft.to_string();
            if draft.is_empty() { None } else { Some(draft) }
        };
        if thread.draft == draft {
            return false;
        }
        thread.draft = draft;
        thread.updated_at = now_ms();
        self.touch();
        true
    }

    pub fn upsert_agent_thread(&mut self, thread: AgentThread) {
        self.agent_threads.insert(thread.id.clone(), thread);
        self.touch();
    }

    pub fn delete_agent_thread(&mut self, id: &str) {
        self.agent_threads.remove(id);
        self.agent_messages.retain(|_, m| m.thread_id != id);
        self.touch();
    }

    pub fn upsert_agent_workspace(&mut self, ws: AgentWorkspace) {
        self.agent_workspaces.insert(ws.id.clone(), ws);
        self.touch();
    }

    pub fn get_agent_message(&self, id: &str) -> Option<AgentMessage> {
        self.agent_messages.get(id).cloned()
    }

    pub fn list_agent_messages(&self) -> Vec<AgentMessage> {
        let mut v: Vec<_> = self.agent_messages.values().cloned().collect();
        v.sort_by_key(|a| a.created_at);
        v
    }

    /// Threads whose message bodies contain `query`.
    ///
    /// Searching by walking this map avoids cloning every message, which for a
    /// large history costs far more than the search itself. Matching ignores
    /// case, so callers may pass the raw query.
    pub fn agent_thread_ids_matching(&self, query: &str) -> std::collections::HashSet<String> {
        let needle = query.trim().to_lowercase();
        if needle.is_empty() {
            return std::collections::HashSet::new();
        }
        self.agent_messages
            .values()
            .filter(|m| !m.content.is_empty() && m.content.to_lowercase().contains(&needle))
            .map(|m| m.thread_id.clone())
            .collect()
    }

    /// A short excerpt around `query` in `thread_id`'s first matching message.
    pub fn agent_message_excerpt(&self, thread_id: &str, query: &str) -> Option<String> {
        let needle = query.trim().to_lowercase();
        if needle.is_empty() {
            return None;
        }
        let hit = self.agent_messages.values().find(|m| {
            m.thread_id == thread_id
                && !m.content.is_empty()
                && m.content.to_lowercase().contains(&needle)
        })?;
        let body = hit.content.replace('\n', " ");
        let at = body.to_lowercase().find(&needle).unwrap_or(0);
        let start = at.saturating_sub(12);
        let text: String = body.chars().skip(start).take(48).collect();
        Some(format!("…{text}"))
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
        self.touch();
    }

    pub fn clear_agent_messages(&mut self, thread_id: &str) {
        self.agent_messages.retain(|_, m| m.thread_id != thread_id);
        self.agent_approvals.retain(|_, a| a.thread_id != thread_id);
        if let Some(thread) = self.agent_threads.get_mut(thread_id) {
            thread.queue_json = None;
            thread.updated_at = now_ms();
        }
        self.touch();
    }

    /// Insert `summary` and drop the messages whose ids are listed in `replaced`.
    pub fn compact_agent_history(
        &mut self,
        thread_id: &str,
        summary: AgentMessage,
        replaced: &[String],
    ) {
        if replaced.is_empty() {
            return;
        }
        self.agent_messages
            .retain(|id, _| !replaced.iter().any(|r| r == id));
        self.agent_approvals
            .retain(|_, a| a.thread_id != thread_id || a.created_at >= summary.created_at);
        self.agent_messages
            .insert(summary.id.clone(), summary.clone());
        if let Some(thread) = self.agent_threads.get_mut(thread_id) {
            thread.updated_at = now_ms();
        }
        self.touch();
    }

    /// Drop messages in `thread_id` created at or after `created_at` (inclusive).
    pub fn truncate_agent_messages_at(&mut self, thread_id: &str, created_at: i64) {
        self.agent_messages
            .retain(|_, m| m.thread_id != thread_id || m.created_at < created_at);
        self.agent_approvals
            .retain(|_, a| a.thread_id != thread_id || a.created_at < created_at);
        if let Some(thread) = self.agent_threads.get_mut(thread_id) {
            thread.updated_at = now_ms();
        }
        self.touch();
    }

    pub fn list_agent_approvals(&self) -> Vec<AgentApproval> {
        let mut v: Vec<_> = self.agent_approvals.values().cloned().collect();
        v.sort_by_key(|a| std::cmp::Reverse(a.created_at));
        v
    }

    pub fn upsert_agent_approval(&mut self, a: AgentApproval) {
        self.agent_approvals.insert(a.id.clone(), a);
        self.touch();
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

    #[test]
    fn tasks_timed_and_agent_session_round_trip() {
        let mut repo = MemoryWorkbenchRepository::new();
        repo.create_task("买菜", None);
        let now = now_ms();
        let timed =
            wb_domain::create_timed_task_draft(Some("晨报"), Some("总结今日"), None, Some(now));
        let timed_id = timed.id.clone();
        repo.upsert_timed_task(timed);
        let ws = repo.list_agent_workspaces()[0].id.clone();
        let thread = AgentThread {
            id: "th-keep".into(),
            workspace_id: ws,
            project_id: None,
            title: "持久会话".into(),
            model_ref: wb_domain::BUILTIN_MODEL_REF.into(),
            permission_mode: Default::default(),
            queue_json: None,
            web_url: None,
            archived_at: None,
            pinned_at: None,
            session_todos: vec![wb_domain::AgentSessionTodo {
                id: "1".into(),
                content: "写测试".into(),
                status: "pending".into(),
            }],
            session_goal: Some(wb_domain::AgentSessionGoal {
                objective: "把数据落盘".into(),
                status: "active".into(),
                max_rounds: Some(3),
                rounds_started: 1,
                blocked_after: 3,
            }),
            cwd: Some("D:/work".into()),
            draft: Some("还没发送".into()),
            created_at: now,
            updated_at: now,
        };
        repo.upsert_agent_thread(thread);
        repo.upsert_agent_message(AgentMessage {
            id: "m-keep".into(),
            thread_id: "th-keep".into(),
            role: wb_domain::AgentRole::User,
            content: "你好".into(),
            tool_name: None,
            tool_call_id: None,
            tool_calls_json: None,
            created_at: now,
            duration_ms: None,
        });

        let snap = repo.export_snapshot();
        let json = serde_json::to_string(&snap).unwrap();
        let parsed: crate::snapshot::WorkbenchSnapshot = serde_json::from_str(&json).unwrap();
        let mut restored = MemoryWorkbenchRepository::new();
        restored.import_snapshot(parsed);

        assert_eq!(restored.list_tasks()[0].title, "买菜");
        assert_eq!(restored.get_timed_task(&timed_id).unwrap().title, "晨报");
        assert_eq!(
            restored.get_timed_task(&timed_id).unwrap().command,
            "总结今日"
        );
        let thread = restored.get_agent_thread("th-keep").unwrap();
        assert_eq!(thread.session_todos[0].content, "写测试");
        assert_eq!(
            thread.session_goal.as_ref().unwrap().objective,
            "把数据落盘"
        );
        assert_eq!(thread.cwd.as_deref(), Some("D:/work"));
        assert_eq!(thread.draft.as_deref(), Some("还没发送"));
        assert_eq!(restored.messages_for_thread("th-keep")[0].content, "你好");
    }

    #[test]
    fn timed_runs_follow_the_task() {
        let mut repo = MemoryWorkbenchRepository::new();
        let now = now_ms();
        let task = wb_domain::create_timed_task_draft(Some("晨报"), None, None, Some(now));
        let id = task.id.clone();
        repo.upsert_timed_task(task);
        repo.append_timed_run(TimedRunRecord {
            id: "run-1".into(),
            task_id: id.clone(),
            ran_at: now,
            status: wb_domain::TimedRunOutcome::Executed,
        });
        repo.append_timed_run(TimedRunRecord {
            id: "run-2".into(),
            task_id: id.clone(),
            ran_at: now + 1,
            status: wb_domain::TimedRunOutcome::Skipped,
        });
        let runs = repo.list_timed_runs(&id);
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0].status, wb_domain::TimedRunOutcome::Skipped);
        let snap = repo.export_snapshot();
        let mut restored = MemoryWorkbenchRepository::new();
        restored.import_snapshot(snap);
        assert_eq!(restored.list_timed_runs(&id).len(), 2);
        restored.delete_timed_task(&id);
        assert!(restored.list_timed_runs(&id).is_empty());
    }

    fn test_message(id: &str, thread: &str, content: &str) -> AgentMessage {
        AgentMessage {
            id: id.into(),
            thread_id: thread.into(),
            role: wb_domain::AgentRole::User,
            content: content.into(),
            tool_name: None,
            tool_call_id: None,
            tool_calls_json: None,
            created_at: now_ms(),
            duration_ms: None,
        }
    }

    #[test]
    fn body_search_finds_threads_and_excerpts() {
        let mut repo = MemoryWorkbenchRepository::new();
        repo.upsert_agent_message(test_message("m1", "t1", "今天讨论语音识别方案"));
        repo.upsert_agent_message(test_message("m2", "t1", "另一条不相关的内容"));
        repo.upsert_agent_message(test_message("m3", "t2", "完全不同的主题"));
        repo.upsert_agent_message(test_message("m4", "t3", ""));

        let hits = repo.agent_thread_ids_matching("语音");
        assert!(hits.contains("t1"), "matching thread must be reported");
        assert!(!hits.contains("t2"));
        // Empty messages must not panic or match everything.
        assert!(!hits.contains("t3"));

        let excerpt = repo.agent_message_excerpt("t1", "语音").unwrap();
        assert!(
            excerpt.contains("语音"),
            "excerpt should show the hit: {excerpt}"
        );
        assert!(repo.agent_message_excerpt("t2", "语音").is_none());

        // An empty query must stay cheap and match nothing.
        assert!(repo.agent_thread_ids_matching("").is_empty());
        assert!(repo.agent_message_excerpt("t1", "").is_none());
    }

    #[test]
    fn body_search_is_case_insensitive() {
        let mut repo = MemoryWorkbenchRepository::new();
        repo.upsert_agent_message(test_message("m1", "t1", "Refactor The Parser"));
        assert!(repo.agent_thread_ids_matching("the parser").contains("t1"));
        assert!(repo.agent_thread_ids_matching("THE PARSER").contains("t1"));
    }

    #[test]
    fn clear_agent_messages_drops_queue_and_approvals() {
        let mut repo = MemoryWorkbenchRepository::new();
        let now = now_ms();
        let ws = AgentWorkspace {
            id: "ws1".into(),
            title: "t".into(),
            root_path: None,
            created_at: now,
            updated_at: now,
        };
        repo.upsert_agent_workspace(ws);
        let thread = AgentThread {
            id: "th1".into(),
            workspace_id: "ws1".into(),
            project_id: None,
            title: "会话".into(),
            model_ref: "builtin:workbench/local".into(),
            permission_mode: Default::default(),
            queue_json: Some(r#"["queued"]"#.into()),
            web_url: None,
            archived_at: None,
            pinned_at: None,
            session_todos: Vec::new(),
            session_goal: None,
            cwd: None,
            draft: None,
            created_at: now,
            updated_at: now,
        };
        repo.upsert_agent_thread(thread);
        repo.upsert_agent_message(AgentMessage {
            id: "m1".into(),
            thread_id: "th1".into(),
            role: wb_domain::AgentRole::User,
            content: "hi".into(),
            tool_name: None,
            tool_call_id: None,
            tool_calls_json: None,
            created_at: now,
            duration_ms: None,
        });
        repo.upsert_agent_approval(AgentApproval {
            id: "a1".into(),
            thread_id: "th1".into(),
            tool_call_id: None,
            tool_name: "task_create".into(),
            args_json: "{}".into(),
            summary: "x".into(),
            status: wb_domain::ApprovalStatus::Pending,
            created_at: now,
            resolved_at: None,
        });
        repo.clear_agent_messages("th1");
        assert!(repo.messages_for_thread("th1").is_empty());
        assert!(repo.list_agent_approvals().is_empty());
        let t = repo
            .list_agent_threads()
            .into_iter()
            .find(|t| t.id == "th1")
            .unwrap();
        assert!(t.queue_json.is_none());
    }

    #[test]
    fn truncate_agent_messages_keeps_earlier_turns() {
        let mut repo = MemoryWorkbenchRepository::new();
        let now = now_ms();
        repo.upsert_agent_message(AgentMessage {
            id: "m1".into(),
            thread_id: "th1".into(),
            role: wb_domain::AgentRole::User,
            content: "one".into(),
            tool_name: None,
            tool_call_id: None,
            tool_calls_json: None,
            created_at: now,
            duration_ms: None,
        });
        repo.upsert_agent_message(AgentMessage {
            id: "m2".into(),
            thread_id: "th1".into(),
            role: wb_domain::AgentRole::Assistant,
            content: "ok".into(),
            tool_name: None,
            tool_call_id: None,
            tool_calls_json: None,
            created_at: now + 1,
            duration_ms: None,
        });
        repo.upsert_agent_message(AgentMessage {
            id: "m3".into(),
            thread_id: "th1".into(),
            role: wb_domain::AgentRole::User,
            content: "two".into(),
            tool_name: None,
            tool_call_id: None,
            tool_calls_json: None,
            created_at: now + 2,
            duration_ms: None,
        });
        repo.upsert_agent_message(AgentMessage {
            id: "m4".into(),
            thread_id: "th1".into(),
            role: wb_domain::AgentRole::Assistant,
            content: "fail".into(),
            tool_name: None,
            tool_call_id: None,
            tool_calls_json: None,
            created_at: now + 3,
            duration_ms: None,
        });
        repo.truncate_agent_messages_at("th1", now + 2);
        let left: Vec<_> = repo
            .messages_for_thread("th1")
            .into_iter()
            .map(|m| m.content)
            .collect();
        assert_eq!(left, vec!["one".to_string(), "ok".to_string()]);
    }
}
