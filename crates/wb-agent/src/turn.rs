use crate::execute::{ToolResult, check_gate, execute_tool};
use crate::providers::{load_credentials, load_providers};
use anyhow::Result;
use serde_json::json;
use wb_domain::{
    AgentMessage, AgentPermissionMode, AgentRole, AgentThread, BUILTIN_MODEL_REF, ToolGate,
    create_id, now_ms,
};
use wb_host::chat_completions;
use wb_store::MemoryWorkbenchRepository;

#[derive(Debug, Clone)]
pub struct TurnOutcome {
    pub assistant: AgentMessage,
    pub tool_messages: Vec<AgentMessage>,
}

/// Prepared turn state that can leave the repo lock before awaiting the model.
#[derive(Debug, Clone)]
pub struct PendingTurn {
    pub thread: AgentThread,
    pub user_text: String,
    pub history: Vec<AgentMessage>,
    pub builtin_reply: Option<String>,
    pub workspace_root: Option<String>,
}

/// Insert the user message and collect everything needed for the model call.
pub fn begin_user_turn(
    repo: &mut MemoryWorkbenchRepository,
    thread: &AgentThread,
    user_text: &str,
) -> PendingTurn {
    let now = now_ms();
    let user_msg = AgentMessage {
        id: create_id(now),
        thread_id: thread.id.clone(),
        role: AgentRole::User,
        content: user_text.to_string(),
        tool_name: None,
        tool_call_id: None,
        tool_calls_json: None,
        created_at: now,
    };
    repo.upsert_agent_message(user_msg);

    let history = repo.messages_for_thread(&thread.id);
    let builtin_reply =
        if thread.model_ref == BUILTIN_MODEL_REF || thread.model_ref.starts_with("builtin:") {
            Some(builtin_reply(user_text, repo))
        } else {
            None
        };
    let workspace_root = repo
        .list_agent_workspaces()
        .into_iter()
        .find(|w| w.id == thread.workspace_id)
        .and_then(|w| w.root_path);

    PendingTurn {
        thread: thread.clone(),
        user_text: user_text.to_string(),
        history,
        builtin_reply,
        workspace_root,
    }
}

/// Resolve the assistant text without holding the repository lock.
pub async fn resolve_turn_reply(pending: &PendingTurn, proxy: Option<&str>) -> String {
    if let Some(ref text) = pending.builtin_reply {
        return text.clone();
    }
    call_remote_model(&pending.thread, &pending.history, &pending.user_text, proxy)
        .await
        .unwrap_or_else(|e| format!("模型请求失败：{e}"))
}

/// Apply slash tools + assistant message under the repository lock.
pub fn finish_user_turn(
    repo: &mut MemoryWorkbenchRepository,
    pending: &PendingTurn,
    reply_text: String,
) -> TurnOutcome {
    let mut tool_messages = Vec::new();
    if let Some(tool_name) = parse_slash_tool(&pending.user_text) {
        let gate = check_gate(tool_name, pending.thread.permission_mode);
        match gate {
            ToolGate::Block => {
                tool_messages.push(system_tool_msg(
                    &pending.thread.id,
                    tool_name,
                    "当前权限模式禁止此工具",
                ));
            }
            ToolGate::Ask | ToolGate::Run => {
                let root = pending.workspace_root.as_deref();
                let result = execute_tool(repo, tool_name, &json!({}), root).unwrap_or_else(|e| {
                    ToolResult {
                        ok: false,
                        content: e.to_string(),
                    }
                });
                tool_messages.push(system_tool_msg(
                    &pending.thread.id,
                    tool_name,
                    &result.content,
                ));
            }
        }
    }

    let assistant = AgentMessage {
        id: create_id(now_ms()),
        thread_id: pending.thread.id.clone(),
        role: AgentRole::Assistant,
        content: reply_text,
        tool_name: None,
        tool_call_id: None,
        tool_calls_json: None,
        created_at: now_ms(),
    };
    repo.upsert_agent_message(assistant.clone());
    for m in &tool_messages {
        repo.upsert_agent_message(m.clone());
    }

    let mut thread = pending.thread.clone();
    thread.updated_at = now_ms();
    if thread.title == "新会话" {
        let trimmed = pending.user_text.trim();
        if !trimmed.is_empty() {
            let mut title: String = trimmed.chars().take(24).collect();
            if trimmed.chars().count() > 24 {
                title.push('…');
            }
            thread.title = title;
        }
    }
    repo.upsert_agent_thread(thread);

    TurnOutcome {
        assistant,
        tool_messages,
    }
}

pub async fn run_user_turn(
    repo: &mut MemoryWorkbenchRepository,
    thread: &AgentThread,
    user_text: &str,
    proxy: Option<&str>,
) -> Result<TurnOutcome> {
    let pending = begin_user_turn(repo, thread, user_text);
    let reply = resolve_turn_reply(&pending, proxy).await;
    Ok(finish_user_turn(repo, &pending, reply))
}

fn system_tool_msg(thread_id: &str, tool: &str, content: &str) -> AgentMessage {
    AgentMessage {
        id: create_id(now_ms()),
        thread_id: thread_id.into(),
        role: AgentRole::Tool,
        content: content.into(),
        tool_name: Some(tool.into()),
        tool_call_id: None,
        tool_calls_json: None,
        created_at: now_ms(),
    }
}

fn parse_slash_tool(text: &str) -> Option<&'static str> {
    let t = text.trim();
    const COMMANDS: &[(&str, &str)] = &[
        ("/task_list", "task_list"),
        ("/project_list", "project_list"),
        ("/tag_list", "tag_list"),
        ("/note_list", "note_list"),
        ("/schedule_list", "schedule_list"),
        ("/notification_list", "notification_list"),
    ];
    for (prefix, name) in COMMANDS {
        if t.starts_with(prefix) {
            return Some(name);
        }
    }
    None
}

fn builtin_reply(user_text: &str, repo: &MemoryWorkbenchRepository) -> String {
    let tasks = repo.list_tasks();
    let open = tasks.iter().filter(|t| !t.is_done).count();
    format!(
        "（内置通道）已收到：{}\n\n当前未完成任务 {open} 条。可用斜杠：/task_list /project_list /tag_list /note_list /schedule_list /notification_list",
        user_text.trim()
    )
}

async fn call_remote_model(
    thread: &AgentThread,
    history: &[AgentMessage],
    user_text: &str,
    proxy: Option<&str>,
) -> Result<String> {
    let providers = load_providers();
    let (provider_id, model_id) = split_model_ref(&thread.model_ref);
    let provider = providers
        .providers
        .iter()
        .find(|p| p.id == provider_id)
        .ok_or_else(|| anyhow::anyhow!("未知 provider: {provider_id}"))?;
    let creds = load_credentials();
    let key = creds.keys.get(&provider.id).map(|s| s.as_str());

    let mut messages = Vec::new();
    for m in history.iter().rev().take(20).rev() {
        let role = match m.role {
            AgentRole::User => "user",
            AgentRole::Assistant => "assistant",
            AgentRole::System => "system",
            AgentRole::Tool => "assistant",
        };
        messages.push(json!({ "role": role, "content": m.content }));
    }
    messages.push(json!({ "role": "user", "content": user_text }));

    let body = json!({
        "model": model_id,
        "messages": messages,
    });
    let resp = chat_completions(&provider.base_url, key, &body, proxy).await?;
    let text = resp
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .unwrap_or("（空响应）")
        .to_string();
    Ok(text)
}

fn split_model_ref(model_ref: &str) -> (String, String) {
    if let Some((a, b)) = model_ref.split_once('/') {
        (a.to_string(), b.to_string())
    } else {
        (model_ref.to_string(), model_ref.to_string())
    }
}

pub fn create_thread(workspace_id: &str, title: &str, model_ref: Option<&str>) -> AgentThread {
    let now = now_ms();
    AgentThread {
        id: create_id(now),
        workspace_id: workspace_id.into(),
        project_id: None,
        title: title.into(),
        model_ref: model_ref.unwrap_or(BUILTIN_MODEL_REF).into(),
        permission_mode: AgentPermissionMode::Confirm,
        queue_json: None,
        web_url: None,
        archived_at: None,
        pinned_at: None,
        created_at: now,
        updated_at: now,
    }
}
