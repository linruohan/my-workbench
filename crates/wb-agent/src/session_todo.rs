use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionTodo {
    pub id: String,
    pub content: String,
    pub status: String,
}

fn store() -> &'static Mutex<Vec<SessionTodo>> {
    static TODOS: OnceLock<Mutex<Vec<SessionTodo>>> = OnceLock::new();
    TODOS.get_or_init(|| Mutex::new(Vec::new()))
}

pub fn list_todos() -> Vec<SessionTodo> {
    store().lock().unwrap().clone()
}

pub fn write_todos(todos: Vec<SessionTodo>, merge: bool) -> Vec<SessionTodo> {
    let mut guard = store().lock().unwrap();
    if merge {
        for t in todos {
            if let Some(existing) = guard.iter_mut().find(|x| x.id == t.id) {
                if !t.content.is_empty() {
                    existing.content = t.content;
                }
                if !t.status.is_empty() {
                    existing.status = t.status;
                }
            } else {
                guard.push(t);
            }
        }
    } else {
        *guard = todos;
    }
    guard.clone()
}
