use wb_domain::AgentSessionTodo;
use wb_store::MemoryWorkbenchRepository;

pub type SessionTodo = AgentSessionTodo;

pub fn list_todos(repo: &MemoryWorkbenchRepository, thread_id: &str) -> Vec<SessionTodo> {
    repo.get_agent_thread(thread_id)
        .map(|thread| thread.session_todos.clone())
        .unwrap_or_default()
}

pub fn write_todos(
    repo: &mut MemoryWorkbenchRepository,
    thread_id: &str,
    todos: Vec<SessionTodo>,
    merge: bool,
) -> Result<Vec<SessionTodo>, String> {
    if repo.get_agent_thread(thread_id).is_none() {
        return Err("会话不存在，待办无法保存".into());
    }
    let mut current = list_todos(repo, thread_id);
    if merge {
        for todo in todos {
            if let Some(existing) = current.iter_mut().find(|item| item.id == todo.id) {
                if !todo.content.is_empty() {
                    existing.content = todo.content;
                }
                if !todo.status.is_empty() {
                    existing.status = todo.status;
                }
            } else {
                current.push(todo);
            }
        }
    } else {
        current = todos;
    }
    repo.set_session_todos(thread_id, current.clone());
    Ok(current)
}
