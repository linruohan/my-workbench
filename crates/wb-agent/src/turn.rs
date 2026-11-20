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

pub async fn run_user_turn(
    repo: &mut MemoryWorkbenchRepository,
    thread: &AgentThread,
    user_text: &str,
    proxy: Option<&str>,
) -> Result<TurnOutcome> {
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
    let reply_text =
        if thread.model_ref == BUILTIN_MODEL_REF || thread.model_ref.starts_with("builtin:") {
            builtin_reply(user_text, repo)
        } else {
            call_remote_model(thread, &history, user_text, proxy)
                .await
                .unwrap_or_else(|e| format!("模型请求失败：{e}"))
        };

    // Simple slash / tool intent: if user says /task_list
    let mut tool_messages = Vec::new();
    if let Some(tool_name) = parse_slash_tool(user_text) {
        let gate = check_gate(tool_name, thread.permission_mode);
        match gate {
            ToolGate::Block => {
                tool_messages.push(system_tool_msg(
                    &thread.id,
                    tool_name,
                    "当前权限模式禁止此工具",
                ));
            }
            ToolGate::Ask | ToolGate::Run => {
                let ws = repo
                    .list_agent_workspaces()
                    .into_iter()
                    .find(|w| w.id == thread.workspace_id);
                let root = ws.as_ref().and_then(|w| w.root_path.as_deref());
                let result = execute_tool(repo, tool_name, &json!({}), root).unwrap_or_else(|e| {
                    ToolResult {
                        ok: false,
                        content: e.to_string(),
                    }
                });
                tool_messages.push(system_tool_msg(&thread.id, tool_name, &result.content));
            }
        }
    }

    let assistant = AgentMessage {
        id: create_id(now_ms()),
        thread_id: thread.id.clone(),
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

    Ok(TurnOutcome {
        assistant,
        tool_messages,
    })
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
    if t.starts_with("/task_list") {
        Some("task_list")
    } else if t.starts_with("/note_list") {
        Some("note_list")
    } else if t.starts_with("/schedule_list") {
        Some("schedule_list")
    } else {
        None
    }
}

fn builtin_reply(user_text: &str, repo: &MemoryWorkbenchRepository) -> String {
    let tasks = repo.list_tasks();
    let open = tasks.iter().filter(|t| !t.is_done).count();
    format!(
        "（内置通道）已收到：{}\n\n当前未完成任务 {open} 条。可用斜杠命令：/task_list /note_list /schedule_list",
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
