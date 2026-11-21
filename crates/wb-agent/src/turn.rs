use crate::execute::{ToolResult, all_tools, check_gate, execute_tool};
use crate::providers::{load_credentials, load_providers};
use anyhow::Result;
use serde_json::{Value, json};
use wb_domain::{
    AgentApproval, AgentMessage, AgentPermissionMode, AgentRole, AgentThread, ApprovalStatus,
    BUILTIN_MODEL_REF, PlannedCall, ToolGate, create_id, now_ms,
};
use wb_host::chat_completions;
use wb_store::MemoryWorkbenchRepository;

const MAX_TOOL_ROUNDS: usize = 4;

#[derive(Debug, Clone)]
pub struct TurnOutcome {
    pub assistant: AgentMessage,
    pub tool_messages: Vec<AgentMessage>,
    pub open_view: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ModelReply {
    pub content: String,
    pub tool_calls: Vec<PlannedCall>,
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

#[derive(Debug, Clone)]
pub struct ContinueTurn {
    pub thread: AgentThread,
    pub workspace_root: Option<String>,
    pub messages: Vec<Value>,
    pub round: usize,
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

/// Resolve the assistant text / tool calls without holding the repository lock.
pub async fn resolve_turn_reply(pending: &PendingTurn, proxy: Option<&str>) -> ModelReply {
    if let Some(ref text) = pending.builtin_reply {
        return ModelReply {
            content: text.clone(),
            tool_calls: Vec::new(),
        };
    }
    call_remote_model(
        &pending.thread,
        &history_to_openai(&pending.history),
        proxy,
        true,
    )
    .await
    .unwrap_or_else(|e| ModelReply {
        content: format!("模型请求失败：{e}"),
        tool_calls: Vec::new(),
    })
}

pub async fn continue_turn_reply(cont: &ContinueTurn, proxy: Option<&str>) -> ModelReply {
    call_remote_model(&cont.thread, &cont.messages, proxy, true)
        .await
        .unwrap_or_else(|e| ModelReply {
            content: format!("模型请求失败：{e}"),
            tool_calls: Vec::new(),
        })
}

#[derive(Debug)]
pub enum TurnPhase {
    Done(TurnOutcome),
    Continue(Box<ContinueTurn>, TurnOutcome),
}

impl TurnPhase {
    pub fn open_view(&self) -> Option<&str> {
        match self {
            Self::Done(out) | Self::Continue(_, out) => out.open_view.as_deref(),
        }
    }
}

/// Apply slash tools + model reply under the repository lock.
pub fn finish_user_turn(
    repo: &mut MemoryWorkbenchRepository,
    pending: &PendingTurn,
    reply: ModelReply,
) -> TurnPhase {
    let mut tool_messages = Vec::new();
    let mut open_view = None;
    let mut openai_messages = history_to_openai(&pending.history);

    // Auto-title on first user message.
    if pending.thread.title == "新会话" {
        let trimmed = pending.user_text.trim();
        if !trimmed.is_empty() {
            let mut thread = pending.thread.clone();
            let mut title: String = trimmed.chars().take(24).collect();
            if trimmed.chars().count() > 24 {
                title.push('…');
            }
            thread.title = title;
            thread.updated_at = now_ms();
            repo.upsert_agent_thread(thread);
        }
    }

    if let Some((tool_name, args)) = parse_slash_invocation(&pending.user_text) {
        let (msgs, view, _) = dispatch_tool_calls(
            repo,
            &pending.thread,
            &[PlannedCall {
                id: format!("slash-{}", create_id(now_ms())),
                name: tool_name.into(),
                args,
            }],
            pending.workspace_root.as_deref(),
        );
        tool_messages.extend(msgs);
        if view.is_some() {
            open_view = view;
        }
    }

    let thread = repo
        .list_agent_threads()
        .into_iter()
        .find(|t| t.id == pending.thread.id)
        .unwrap_or_else(|| pending.thread.clone());

    apply_model_reply_inner(
        repo,
        &thread,
        pending.workspace_root.clone(),
        reply,
        &mut openai_messages,
        &mut tool_messages,
        &mut open_view,
        0,
    )
}

pub fn finish_continue_turn(
    repo: &mut MemoryWorkbenchRepository,
    cont: &ContinueTurn,
    reply: ModelReply,
) -> TurnPhase {
    let mut tool_messages = Vec::new();
    let mut open_view = None;
    let mut openai_messages = cont.messages.clone();
    apply_model_reply_inner(
        repo,
        &cont.thread,
        cont.workspace_root.clone(),
        reply,
        &mut openai_messages,
        &mut tool_messages,
        &mut open_view,
        cont.round,
    )
}

#[allow(clippy::too_many_arguments)]
fn apply_model_reply_inner(
    repo: &mut MemoryWorkbenchRepository,
    thread: &AgentThread,
    workspace_root: Option<String>,
    reply: ModelReply,
    openai_messages: &mut Vec<Value>,
    tool_messages: &mut Vec<AgentMessage>,
    open_view: &mut Option<String>,
    round: usize,
) -> TurnPhase {
    let tool_calls_json = if reply.tool_calls.is_empty() {
        None
    } else {
        Some(serde_json::to_string(&reply.tool_calls).unwrap_or_default())
    };

    let assistant = AgentMessage {
        id: create_id(now_ms()),
        thread_id: thread.id.clone(),
        role: AgentRole::Assistant,
        content: if reply.content.is_empty() && !reply.tool_calls.is_empty() {
            format!("调用工具：{}", tool_names(&reply.tool_calls))
        } else {
            reply.content.clone()
        },
        tool_name: None,
        tool_call_id: None,
        tool_calls_json,
        created_at: now_ms(),
    };
    repo.upsert_agent_message(assistant.clone());

    openai_messages.push(assistant_openai_message(&reply));

    let mut asked = false;
    if !reply.tool_calls.is_empty() {
        let (msgs, view, had_ask) =
            dispatch_tool_calls(repo, thread, &reply.tool_calls, workspace_root.as_deref());
        if view.is_some() {
            *open_view = view;
        }
        asked = had_ask;
        for m in &msgs {
            openai_messages.push(json!({
                "role": "tool",
                "tool_call_id": m.tool_call_id.clone().unwrap_or_default(),
                "content": m.content.clone(),
            }));
        }
        tool_messages.extend(msgs);
    }

    for m in tool_messages.iter() {
        repo.upsert_agent_message(m.clone());
    }

    let mut thread = thread.clone();
    thread.updated_at = now_ms();
    repo.upsert_agent_thread(thread.clone());

    let outcome = TurnOutcome {
        assistant: assistant.clone(),
        tool_messages: tool_messages.clone(),
        open_view: open_view.clone(),
    };

    let can_continue = !asked
        && !reply.tool_calls.is_empty()
        && round + 1 < MAX_TOOL_ROUNDS
        && !thread.model_ref.starts_with("builtin:");

    if can_continue {
        TurnPhase::Continue(
            Box::new(ContinueTurn {
                thread,
                workspace_root,
                messages: openai_messages.clone(),
                round: round + 1,
            }),
            outcome,
        )
    } else {
        TurnPhase::Done(outcome)
    }
}

fn dispatch_tool_calls(
    repo: &mut MemoryWorkbenchRepository,
    thread: &AgentThread,
    calls: &[PlannedCall],
    workspace_root: Option<&str>,
) -> (Vec<AgentMessage>, Option<String>, bool) {
    let mut msgs = Vec::new();
    let mut open_view = None;
    let mut asked = false;
    for call in calls {
        let gate = check_gate(&call.name, thread.permission_mode);
        match gate {
            ToolGate::Block => {
                msgs.push(tool_msg(
                    &thread.id,
                    &call.name,
                    Some(&call.id),
                    "当前权限模式禁止此工具",
                ));
            }
            ToolGate::Ask => {
                asked = true;
                let approval = create_approval(
                    &thread.id,
                    &call.name,
                    &call.args,
                    &format!("请求执行 {}（{}）", call.name, call.id),
                );
                repo.upsert_agent_approval(approval.clone());
                msgs.push(tool_msg(
                    &thread.id,
                    &call.name,
                    Some(&call.id),
                    &format!("等待审批：{}（{}）", approval.summary, approval.id),
                ));
            }
            ToolGate::Run => {
                let args = with_thread_id(&call.args, &thread.id);
                let result =
                    execute_tool(repo, &call.name, &args, workspace_root).unwrap_or_else(|e| {
                        ToolResult {
                            ok: false,
                            content: e.to_string(),
                            open_view: None,
                        }
                    });
                if result.open_view.is_some() {
                    open_view = result.open_view.clone();
                }
                msgs.push(tool_msg(
                    &thread.id,
                    &call.name,
                    Some(&call.id),
                    &result.content,
                ));
            }
        }
    }
    (msgs, open_view, asked)
}

/// Approve or deny a pending tool approval and optionally execute it.
pub fn resolve_approval(
    repo: &mut MemoryWorkbenchRepository,
    approval_id: &str,
    approved: bool,
    workspace_root: Option<&str>,
) -> Result<TurnOutcome> {
    let Some(mut approval) = repo
        .list_agent_approvals()
        .into_iter()
        .find(|a| a.id == approval_id)
    else {
        anyhow::bail!("审批不存在");
    };
    if !matches!(approval.status, ApprovalStatus::Pending) {
        anyhow::bail!("审批已处理");
    }
    let now = now_ms();
    approval.status = if approved {
        ApprovalStatus::Approved
    } else {
        ApprovalStatus::Denied
    };
    approval.resolved_at = Some(now);
    repo.upsert_agent_approval(approval.clone());

    let mut open_view = None;
    let content =
        if approved {
            let mut args: Value =
                serde_json::from_str(&approval.args_json).unwrap_or_else(|_| json!({}));
            args = with_thread_id(&args, &approval.thread_id);
            let result = execute_tool(repo, &approval.tool_name, &args, workspace_root)
                .unwrap_or_else(|e| ToolResult {
                    ok: false,
                    content: e.to_string(),
                    open_view: None,
                });
            open_view = result.open_view.clone();
            format!("已批准并执行 {}：{}", approval.tool_name, result.content)
        } else {
            format!("已拒绝 {}", approval.tool_name)
        };

    let msg = tool_msg(&approval.thread_id, &approval.tool_name, None, &content);
    repo.upsert_agent_message(msg.clone());

    Ok(TurnOutcome {
        assistant: msg.clone(),
        tool_messages: vec![msg],
        open_view,
    })
}

pub fn pending_approvals_for_thread(
    repo: &MemoryWorkbenchRepository,
    thread_id: &str,
) -> Vec<AgentApproval> {
    repo.list_agent_approvals()
        .into_iter()
        .filter(|a| a.thread_id == thread_id && matches!(a.status, ApprovalStatus::Pending))
        .collect()
}

pub fn cycle_permission_mode(mode: AgentPermissionMode) -> AgentPermissionMode {
    match mode {
        AgentPermissionMode::Confirm => AgentPermissionMode::SessionAuto,
        AgentPermissionMode::SessionAuto => AgentPermissionMode::Readonly,
        AgentPermissionMode::Readonly => AgentPermissionMode::Confirm,
    }
}

pub fn permission_mode_label(mode: AgentPermissionMode) -> &'static str {
    match mode {
        AgentPermissionMode::Confirm => "确认",
        AgentPermissionMode::SessionAuto => "会话自动",
        AgentPermissionMode::Readonly => "只读",
    }
}

pub async fn run_user_turn(
    repo: &mut MemoryWorkbenchRepository,
    thread: &AgentThread,
    user_text: &str,
    proxy: Option<&str>,
) -> Result<TurnOutcome> {
    let pending = begin_user_turn(repo, thread, user_text);
    drive_pending_turn(repo, pending, proxy).await
}

/// Drive a turn when the latest user message is already on the thread (no duplicate insert).
pub async fn resume_thread_turn(
    repo: &mut MemoryWorkbenchRepository,
    thread: &AgentThread,
    proxy: Option<&str>,
) -> Result<TurnOutcome> {
    let history = repo.messages_for_thread(&thread.id);
    let user_text = history
        .iter()
        .rev()
        .find(|m| matches!(m.role, AgentRole::User))
        .map(|m| m.content.clone())
        .unwrap_or_default();
    let builtin_reply =
        if thread.model_ref == BUILTIN_MODEL_REF || thread.model_ref.starts_with("builtin:") {
            Some(builtin_reply(&user_text, repo))
        } else {
            None
        };
    let workspace_root = repo
        .list_agent_workspaces()
        .into_iter()
        .find(|w| w.id == thread.workspace_id)
        .and_then(|w| w.root_path);
    let pending = PendingTurn {
        thread: thread.clone(),
        user_text,
        history,
        builtin_reply,
        workspace_root,
    };
    drive_pending_turn(repo, pending, proxy).await
}

async fn drive_pending_turn(
    repo: &mut MemoryWorkbenchRepository,
    pending: PendingTurn,
    proxy: Option<&str>,
) -> Result<TurnOutcome> {
    let reply = resolve_turn_reply(&pending, proxy).await;
    let mut phase = finish_user_turn(repo, &pending, reply);
    loop {
        match phase {
            TurnPhase::Done(out) => return Ok(out),
            TurnPhase::Continue(cont, _) => {
                let reply = continue_turn_reply(cont.as_ref(), proxy).await;
                phase = finish_continue_turn(repo, cont.as_ref(), reply);
            }
        }
    }
}

/// Sync wrapper for nested subagent / background workers.
pub fn run_user_turn_blocking(
    repo: &mut MemoryWorkbenchRepository,
    thread: &AgentThread,
    user_text: &str,
    proxy: Option<&str>,
) -> Result<TurnOutcome> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    rt.block_on(run_user_turn(repo, thread, user_text, proxy))
}

pub fn resume_thread_turn_blocking(
    repo: &mut MemoryWorkbenchRepository,
    thread: &AgentThread,
    proxy: Option<&str>,
) -> Result<TurnOutcome> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    rt.block_on(resume_thread_turn(repo, thread, proxy))
}

fn create_approval(thread_id: &str, tool_name: &str, args: &Value, summary: &str) -> AgentApproval {
    let now = now_ms();
    AgentApproval {
        id: create_id(now),
        thread_id: thread_id.into(),
        tool_call_id: None,
        tool_name: tool_name.into(),
        args_json: args.to_string(),
        summary: summary.into(),
        status: ApprovalStatus::Pending,
        created_at: now,
        resolved_at: None,
    }
}

fn tool_msg(thread_id: &str, tool: &str, call_id: Option<&str>, content: &str) -> AgentMessage {
    AgentMessage {
        id: create_id(now_ms()),
        thread_id: thread_id.into(),
        role: AgentRole::Tool,
        content: content.into(),
        tool_name: Some(tool.into()),
        tool_call_id: call_id.map(|s| s.into()),
        tool_calls_json: None,
        created_at: now_ms(),
    }
}

fn tool_names(calls: &[PlannedCall]) -> String {
    calls
        .iter()
        .map(|c| c.name.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

fn with_thread_id(args: &Value, thread_id: &str) -> Value {
    let mut out = args.clone();
    if let Some(obj) = out.as_object_mut() {
        if !obj.contains_key("threadId") {
            obj.insert("threadId".into(), Value::String(thread_id.into()));
        }
    } else {
        out = json!({ "threadId": thread_id });
        if let Some(obj) = args.as_object() {
            if let Some(merged) = out.as_object_mut() {
                for (k, v) in obj {
                    merged.insert(k.clone(), v.clone());
                }
            }
        }
    }
    out
}

fn parse_slash_invocation(text: &str) -> Option<(&'static str, Value)> {
    let t = text.trim();
    const COMMANDS: &[(&str, &str)] = &[
        ("/task_list", "task_list"),
        ("/project_list", "project_list"),
        ("/tag_list", "tag_list"),
        ("/note_list", "note_list"),
        ("/schedule_list", "schedule_list"),
        ("/notification_list", "notification_list"),
        ("/ui_open", "ui_open"),
        ("/search", "search"),
        ("/host_tool_list", "host_tool_list"),
        ("/get_goal", "get_goal"),
    ];
    for (prefix, name) in COMMANDS {
        if t == *prefix || t.starts_with(&format!("{prefix} ")) {
            let rest = t[prefix.len()..].trim();
            let args = match *name {
                "ui_open" => json!({ "view": rest }),
                "search" => json!({ "query": rest }),
                _ => json!({}),
            };
            return Some((name, args));
        }
    }
    // /goal [status|clear] — map to get_goal / update_goal
    if t == "/goal" || t.starts_with("/goal ") {
        let rest = t.trim_start_matches("/goal").trim();
        return match rest {
            "" | "status" => Some(("get_goal", json!({}))),
            "clear" => Some(("update_goal", json!({ "action": "clear" }))),
            "pause" => Some(("update_goal", json!({ "action": "pause" }))),
            "resume" => Some(("update_goal", json!({ "action": "resume" }))),
            other if other.starts_with("create ") => Some((
                "create_goal",
                json!({ "objective": other.trim_start_matches("create ").trim() }),
            )),
            other => Some(("create_goal", json!({ "objective": other }))),
        };
    }
    None
}

fn builtin_reply(user_text: &str, repo: &MemoryWorkbenchRepository) -> String {
    let tasks = repo.list_tasks();
    let open = tasks.iter().filter(|t| !t.is_done).count();
    let memories = wb_store::load_prefs()
        .ok()
        .map(|p| p.agent.memories)
        .unwrap_or_default();
    let mem = if memories.is_empty() {
        String::new()
    } else {
        format!(
            "\n\n记忆：\n{}",
            memories
                .iter()
                .take(8)
                .enumerate()
                .map(|(i, m)| format!("{}. {m}", i + 1))
                .collect::<Vec<_>>()
                .join("\n")
        )
    };
    format!(
        "（内置通道）已收到：{}\n\n当前未完成任务 {open} 条。可用斜杠：/task_list /project_list /tag_list /note_list /schedule_list /notification_list /ui_open <view> /search <q> /host_tool_list{mem}",
        user_text.trim()
    )
}

fn history_to_openai(history: &[AgentMessage]) -> Vec<Value> {
    let mut messages = Vec::new();
    for m in history.iter().rev().take(30).rev() {
        match m.role {
            AgentRole::User => {
                messages.push(json!({ "role": "user", "content": m.content }));
            }
            AgentRole::Assistant => {
                if let Some(ref calls) = m.tool_calls_json {
                    if let Ok(parsed) = serde_json::from_str::<Vec<PlannedCall>>(calls) {
                        messages.push(assistant_openai_message(&ModelReply {
                            content: m.content.clone(),
                            tool_calls: parsed,
                        }));
                        continue;
                    }
                }
                messages.push(json!({ "role": "assistant", "content": m.content }));
            }
            AgentRole::System => {
                messages.push(json!({ "role": "system", "content": m.content }));
            }
            AgentRole::Tool => {
                messages.push(json!({
                    "role": "tool",
                    "tool_call_id": m.tool_call_id.clone().unwrap_or_default(),
                    "content": m.content,
                }));
            }
        }
    }
    messages
}

fn assistant_openai_message(reply: &ModelReply) -> Value {
    if reply.tool_calls.is_empty() {
        return json!({ "role": "assistant", "content": reply.content });
    }
    let tool_calls: Vec<Value> = reply
        .tool_calls
        .iter()
        .map(|c| {
            json!({
                "id": c.id,
                "type": "function",
                "function": {
                    "name": c.name,
                    "arguments": c.args.to_string(),
                }
            })
        })
        .collect();
    json!({
        "role": "assistant",
        "content": if reply.content.is_empty() { Value::Null } else { Value::String(reply.content.clone()) },
        "tool_calls": tool_calls,
    })
}

fn openai_tools_schema() -> Vec<Value> {
    all_tools()
        .into_iter()
        .map(|t| {
            json!({
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.parameters,
                }
            })
        })
        .collect()
}

async fn call_remote_model(
    thread: &AgentThread,
    messages: &[Value],
    proxy: Option<&str>,
    with_tools: bool,
) -> Result<ModelReply> {
    let providers = load_providers();
    let (provider_id, model_id) = split_model_ref(&thread.model_ref);
    let provider = providers
        .providers
        .iter()
        .find(|p| p.id == provider_id)
        .ok_or_else(|| anyhow::anyhow!("未知 provider: {provider_id}"))?;
    let creds = load_credentials();
    let key = creds.keys.get(&provider.id).map(|s| s.as_str());

    let mut msgs = messages.to_vec();
    if let Ok(prefs) = wb_store::load_prefs() {
        if !prefs.agent.memories.is_empty() {
            let mem = prefs.agent.memories.join("；");
            let personality = prefs
                .agent
                .personality
                .as_deref()
                .unwrap_or("你是工作台助手。");
            msgs.insert(
                0,
                json!({
                    "role": "system",
                    "content": format!("{personality}\n记忆：{mem}")
                }),
            );
        } else if let Some(ref p) = prefs.agent.personality {
            if !p.trim().is_empty() {
                msgs.insert(0, json!({ "role": "system", "content": p }));
            }
        }
    }
    let mut body = json!({
        "model": model_id,
        "messages": msgs,
    });
    if with_tools {
        if let Some(obj) = body.as_object_mut() {
            obj.insert("tools".into(), Value::Array(openai_tools_schema()));
        }
    }

    let resp = chat_completions(&provider.base_url, key, &body, proxy).await?;
    Ok(parse_model_reply(&resp))
}

fn parse_model_reply(resp: &Value) -> ModelReply {
    let message = resp.pointer("/choices/0/message");
    let content = message
        .and_then(|m| m.get("content"))
        .and_then(|v| if v.is_null() { Some("") } else { v.as_str() })
        .unwrap_or("（空响应）")
        .to_string();

    let mut tool_calls = Vec::new();
    if let Some(arr) = message
        .and_then(|m| m.get("tool_calls"))
        .and_then(|v| v.as_array())
    {
        for (i, item) in arr.iter().enumerate() {
            let id = item
                .get("id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("call-{i}"));
            let name = item
                .pointer("/function/name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if name.is_empty() {
                continue;
            }
            let args_raw = item
                .pointer("/function/arguments")
                .and_then(|v| v.as_str())
                .unwrap_or("{}");
            let args = serde_json::from_str(args_raw).unwrap_or_else(|_| json!({}));
            tool_calls.push(PlannedCall { id, name, args });
        }
    }

    ModelReply {
        content,
        tool_calls,
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use wb_domain::AgentWorkspace;

    #[test]
    fn ask_gate_creates_pending_approval() {
        let mut repo = MemoryWorkbenchRepository::default();
        let now = now_ms();
        let ws = AgentWorkspace {
            id: "ws1".into(),
            title: "t".into(),
            root_path: None,
            created_at: now,
            updated_at: now,
        };
        repo.upsert_agent_workspace(ws);
        let thread = create_thread("ws1", "新会话", None);
        repo.upsert_agent_thread(thread.clone());

        let approval = create_approval(&thread.id, "task_create", &json!({"title":"x"}), "create");
        repo.upsert_agent_approval(approval.clone());
        assert_eq!(pending_approvals_for_thread(&repo, &thread.id).len(), 1);

        let out = resolve_approval(&mut repo, &approval.id, true, None).unwrap();
        assert!(out.tool_messages[0].content.contains("已批准"));
        assert_eq!(repo.list_tasks().len(), 1);
        assert!(pending_approvals_for_thread(&repo, &thread.id).is_empty());
    }

    #[test]
    fn parse_tool_calls_from_openai_shape() {
        let resp = json!({
            "choices": [{
                "message": {
                    "content": null,
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "task_list",
                            "arguments": "{}"
                        }
                    }]
                }
            }]
        });
        let reply = parse_model_reply(&resp);
        assert_eq!(reply.tool_calls.len(), 1);
        assert_eq!(reply.tool_calls[0].name, "task_list");
    }

    #[test]
    fn permission_mode_cycles() {
        assert_eq!(
            cycle_permission_mode(AgentPermissionMode::Confirm),
            AgentPermissionMode::SessionAuto
        );
        assert_eq!(
            cycle_permission_mode(AgentPermissionMode::SessionAuto),
            AgentPermissionMode::Readonly
        );
        assert_eq!(
            cycle_permission_mode(AgentPermissionMode::Readonly),
            AgentPermissionMode::Confirm
        );
    }
}
