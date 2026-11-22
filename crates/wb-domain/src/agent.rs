use serde::{Deserialize, Serialize};

pub const BUILTIN_PROVIDER_ID: &str = "builtin:workbench";
pub const BUILTIN_MODEL_REF: &str = "builtin:workbench/local";
pub const DEFAULT_AGENT_WORKSPACE_TITLE: &str = "默认工作区";
pub const WEB_AGENT_THREAD_TITLE: &str = "网页会话";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum AgentPermissionMode {
    #[default]
    Confirm,
    SessionAuto,
    Readonly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRole {
    User,
    Assistant,
    Tool,
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolEffect {
    None,
    Read,
    Write,
    Destructive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolGate {
    Run,
    Ask,
    Block,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderKind {
    Builtin,
    OpenaiChatCompletions,
    OpenaiResponses,
    AnthropicMessages,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentWorkspace {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub root_path: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentThread {
    pub id: String,
    pub workspace_id: String,
    #[serde(default)]
    pub project_id: Option<String>,
    pub title: String,
    #[serde(default = "default_model_ref")]
    pub model_ref: String,
    #[serde(default)]
    pub permission_mode: AgentPermissionMode,
    #[serde(default)]
    pub queue_json: Option<String>,
    #[serde(default)]
    pub web_url: Option<String>,
    #[serde(default)]
    pub archived_at: Option<i64>,
    #[serde(default)]
    pub pinned_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

fn default_model_ref() -> String {
    BUILTIN_MODEL_REF.to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessage {
    pub id: String,
    pub thread_id: String,
    pub role: AgentRole,
    pub content: String,
    #[serde(default)]
    pub tool_name: Option<String>,
    #[serde(default)]
    pub tool_call_id: Option<String>,
    #[serde(default)]
    pub tool_calls_json: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentApproval {
    pub id: String,
    pub thread_id: String,
    #[serde(default)]
    pub tool_call_id: Option<String>,
    pub tool_name: String,
    pub args_json: String,
    pub summary: String,
    pub status: ApprovalStatus,
    pub created_at: i64,
    #[serde(default)]
    pub resolved_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalStatus {
    Pending,
    Approved,
    Denied,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelCaps {
    pub context: u32,
    pub output: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub smart: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub kind: ProviderKind,
    #[serde(rename = "baseURL")]
    pub base_url: String,
    pub api_key_required: bool,
    pub enabled: bool,
    pub models: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolSpec {
    pub name: String,
    pub effect: ToolEffect,
    pub description: String,
    pub parameters: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PlannedCall {
    pub id: String,
    pub name: String,
    pub args: serde_json::Value,
}

pub fn gate_tool(effect: ToolEffect, mode: AgentPermissionMode) -> ToolGate {
    match mode {
        AgentPermissionMode::Readonly => match effect {
            ToolEffect::None | ToolEffect::Read => ToolGate::Run,
            _ => ToolGate::Block,
        },
        AgentPermissionMode::SessionAuto => match effect {
            ToolEffect::Destructive => ToolGate::Ask,
            _ => ToolGate::Run,
        },
        AgentPermissionMode::Confirm => match effect {
            ToolEffect::None | ToolEffect::Read => ToolGate::Run,
            _ => ToolGate::Ask,
        },
    }
}

pub fn normalize_agent_web_url(raw: &str) -> Option<String> {
    let t = raw.trim();
    if t.is_empty() {
        return None;
    }
    if t.starts_with("http://") || t.starts_with("https://") {
        Some(t.to_string())
    } else if t.contains('.') {
        Some(format!("https://{t}"))
    } else {
        None
    }
}

pub fn agent_workspace_title_from_path(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("工作区")
        .to_string()
}

pub fn builtin_host_tools() -> Vec<ToolSpec> {
    vec![
        tool(
            "task_list",
            ToolEffect::Read,
            "列出任务",
            serde_json::json!({
                "projectId": { "type": "string" },
                "query": { "type": "string" }
            }),
        ),
        tool(
            "task_create",
            ToolEffect::Write,
            "创建任务",
            serde_json::json!({
                "title": { "type": "string" },
                "projectId": { "type": "string" }
            }),
        ),
        tool(
            "task_complete",
            ToolEffect::Write,
            "完成任务",
            serde_json::json!({
                "taskId": { "type": "string" }
            }),
        ),
        tool(
            "task_incomplete",
            ToolEffect::Write,
            "取消完成任务",
            serde_json::json!({
                "taskId": { "type": "string" }
            }),
        ),
        tool(
            "task_reopen",
            ToolEffect::Write,
            "重新打开任务（同 task_incomplete）",
            serde_json::json!({
                "taskId": { "type": "string" },
                "title": { "type": "string" }
            }),
        ),
        tool(
            "task_get",
            ToolEffect::Read,
            "查看单个任务（含子任务）",
            serde_json::json!({
                "taskId": { "type": "string" },
                "title": { "type": "string" }
            }),
        ),
        tool(
            "task_list_today",
            ToolEffect::Read,
            "列出今日任务",
            serde_json::json!({}),
        ),
        tool(
            "task_update",
            ToolEffect::Write,
            "修改任务标题、备注、项目或预估",
            serde_json::json!({
                "taskId": { "type": "string" },
                "title": { "type": "string" },
                "notes": { "type": "string" },
                "projectId": { "type": "string" },
                "timeEstimateMinutes": { "type": "number" }
            }),
        ),
        tool(
            "task_schedule",
            ToolEffect::Write,
            "设置计划日或计划时刻",
            serde_json::json!({
                "taskId": { "type": "string" },
                "dueDay": { "type": "string" },
                "dueWithTime": { "type": "integer" },
                "remindOption": { "type": "string" }
            }),
        ),
        tool(
            "task_set_deadline",
            ToolEffect::Write,
            "设置截止日期或时刻",
            serde_json::json!({
                "taskId": { "type": "string" },
                "deadlineDay": { "type": "string" },
                "deadlineWithTime": { "type": "integer" }
            }),
        ),
        tool(
            "task_set_reminder",
            ToolEffect::Write,
            "设置提醒：remindAt 或 remindOption",
            serde_json::json!({
                "taskId": { "type": "string" },
                "remindOption": { "type": "string" },
                "remindAt": { "type": "integer" }
            }),
        ),
        tool(
            "task_move_backlog",
            ToolEffect::Write,
            "清除计划，移入待办",
            serde_json::json!({
                "taskId": { "type": "string" }
            }),
        ),
        tool(
            "task_add_subtask",
            ToolEffect::Write,
            "为任务添加子任务",
            serde_json::json!({
                "parentId": { "type": "string" },
                "title": { "type": "string" }
            }),
        ),
        tool(
            "task_delete",
            ToolEffect::Write,
            "删除任务及其子任务",
            serde_json::json!({
                "taskId": { "type": "string" }
            }),
        ),
        tool(
            "project_list",
            ToolEffect::Read,
            "列出项目",
            serde_json::json!({}),
        ),
        tool(
            "project_create",
            ToolEffect::Write,
            "创建项目",
            serde_json::json!({
                "title": { "type": "string" }
            }),
        ),
        tool(
            "project_archive",
            ToolEffect::Write,
            "归档或取消归档项目",
            serde_json::json!({
                "projectId": { "type": "string" },
                "title": { "type": "string" },
                "archived": { "type": "boolean" }
            }),
        ),
        tool(
            "tag_list",
            ToolEffect::Read,
            "列出标签",
            serde_json::json!({}),
        ),
        tool(
            "tag_create",
            ToolEffect::Write,
            "创建标签",
            serde_json::json!({
                "title": { "type": "string" }
            }),
        ),
        tool(
            "tag_add",
            ToolEffect::Write,
            "给任务添加标签",
            serde_json::json!({
                "taskId": { "type": "string" },
                "tagId": { "type": "string" }
            }),
        ),
        tool(
            "tag_assign",
            ToolEffect::Write,
            "按标签名或 id 给任务打标，不存在则创建",
            serde_json::json!({
                "taskId": { "type": "string" },
                "tagId": { "type": "string" },
                "tagTitle": { "type": "string" }
            }),
        ),
        tool(
            "note_list",
            ToolEffect::Read,
            "列出应用内笔记",
            serde_json::json!({}),
        ),
        tool(
            "note_create",
            ToolEffect::Write,
            "创建应用内笔记",
            serde_json::json!({
                "title": { "type": "string" },
                "body": { "type": "string" }
            }),
        ),
        tool(
            "note_get",
            ToolEffect::Read,
            "读取一条应用内笔记",
            serde_json::json!({
                "noteId": { "type": "string" },
                "title": { "type": "string" }
            }),
        ),
        tool(
            "note_search",
            ToolEffect::Read,
            "按标题或正文搜索笔记",
            serde_json::json!({
                "query": { "type": "string" }
            }),
        ),
        tool(
            "note_update",
            ToolEffect::Write,
            "更新笔记标题或正文",
            serde_json::json!({
                "noteId": { "type": "string" },
                "title": { "type": "string" },
                "body": { "type": "string" }
            }),
        ),
        tool(
            "note_delete",
            ToolEffect::Write,
            "删除应用内笔记",
            serde_json::json!({
                "noteId": { "type": "string" }
            }),
        ),
        tool(
            "notification_list",
            ToolEffect::Read,
            "列出通知",
            serde_json::json!({}),
        ),
        tool(
            "notification_dismiss",
            ToolEffect::Write,
            "关闭一条通知",
            serde_json::json!({
                "notificationId": { "type": "string" }
            }),
        ),
        tool(
            "notification_snooze",
            ToolEffect::Write,
            "稍后提醒一条通知",
            serde_json::json!({
                "notificationId": { "type": "string" },
                "minutes": { "type": "integer" }
            }),
        ),
        tool(
            "notification_create",
            ToolEffect::Write,
            "创建一条通知（写入通知中心）",
            serde_json::json!({
                "title": { "type": "string" },
                "body": { "type": "string" },
                "kind": { "type": "string" }
            }),
        ),
        tool(
            "schedule_list",
            ToolEffect::Read,
            "列出定时任务",
            serde_json::json!({}),
        ),
        tool(
            "schedule_view",
            ToolEffect::Read,
            "查看单个定时任务详情",
            serde_json::json!({
                "scheduleId": { "type": "string" }
            }),
        ),
        tool(
            "schedule_create",
            ToolEffect::Write,
            "创建定时任务（preset: hourly/daily/weekdays/weekly/monthly，或 every+unit）",
            serde_json::json!({
                "title": { "type": "string" },
                "command": { "type": "string" },
                "preset": { "type": "string" },
                "atTime": { "type": "string" },
                "every": { "type": "integer" },
                "unit": { "type": "string" }
            }),
        ),
        tool(
            "schedule_edit",
            ToolEffect::Write,
            "编辑定时任务标题/命令；action=delete 时删除",
            serde_json::json!({
                "scheduleId": { "type": "string" },
                "action": { "type": "string" },
                "title": { "type": "string" },
                "command": { "type": "string" },
                "enabled": { "type": "boolean" }
            }),
        ),
        tool(
            "schedule_enable",
            ToolEffect::Write,
            "启用或停用定时任务",
            serde_json::json!({
                "scheduleId": { "type": "string" },
                "enabled": { "type": "boolean" }
            }),
        ),
        tool(
            "schedule_delete",
            ToolEffect::Destructive,
            "删除定时任务",
            serde_json::json!({
                "scheduleId": { "type": "string" }
            }),
        ),
        tool(
            "timer_start",
            ToolEffect::Write,
            "开始为任务计时（有子任务的父任务不可计时）",
            serde_json::json!({
                "taskId": { "type": "string" }
            }),
        ),
        tool(
            "timer_stop",
            ToolEffect::Write,
            "停止当前计时并记入当日用时",
            serde_json::json!({}),
        ),
        tool(
            "timer_status",
            ToolEffect::Read,
            "查看任务累计计时",
            serde_json::json!({
                "taskId": { "type": "string" }
            }),
        ),
        tool(
            "timer_add",
            ToolEffect::Write,
            "为任务记入一段用时（毫秒或分钟）",
            serde_json::json!({
                "taskId": { "type": "string" },
                "elapsedMs": { "type": "integer" },
                "minutes": { "type": "integer" }
            }),
        ),
        tool(
            "ui_open",
            ToolEffect::None,
            "打开界面视图（today/inbox/done/planner/timed/projects/knowledge/agent/settings）",
            serde_json::json!({
                "view": { "type": "string" }
            }),
        ),
        tool(
            "search",
            ToolEffect::Read,
            "在任务/笔记/项目/标签中全文搜索",
            serde_json::json!({
                "query": { "type": "string" }
            }),
        ),
        tool(
            "settings_get",
            ToolEffect::Read,
            "读取安全设置项（themeMode/systemNotifications/httpProxy/defaultModelRef/personality/skillsDirs/pluginsDirs）",
            serde_json::json!({
                "key": { "type": "string" }
            }),
        ),
        tool(
            "settings_set",
            ToolEffect::Write,
            "写入安全设置项（同上 key 白名单）",
            serde_json::json!({
                "key": { "type": "string" },
                "value": {}
            }),
        ),
        tool(
            "host_tool_list",
            ToolEffect::Read,
            "列出已注册的 Agent 工具名与效果",
            serde_json::json!({}),
        ),
        tool(
            "session_search",
            ToolEffect::Read,
            "在 Agent 会话消息中搜索",
            serde_json::json!({
                "query": { "type": "string" },
                "threadId": { "type": "string" }
            }),
        ),
        tool(
            "session_trace",
            ToolEffect::Read,
            "摘要指定/最近会话的近期消息",
            serde_json::json!({
                "threadId": { "type": "string" },
                "limit": { "type": "integer" }
            }),
        ),
        tool(
            "session_event_search",
            ToolEffect::Read,
            "单会话消息事件搜索（1-based seq）；beforeLastUser 默认 true",
            serde_json::json!({
                "query": { "type": "string" },
                "threadId": { "type": "string" },
                "beforeLastUser": { "type": "boolean" }
            }),
        ),
        tool(
            "session_event_read",
            ToolEffect::Read,
            "按 1-based seq 读取消息，可选前后邻居",
            serde_json::json!({
                "seq": { "type": "integer" },
                "threadId": { "type": "string" },
                "neighbors": { "type": "integer" }
            }),
        ),
        tool(
            "session_event_trace",
            ToolEffect::Read,
            "围绕 seq 的邻居与同 toolCallId 关联",
            serde_json::json!({
                "seq": { "type": "integer" },
                "threadId": { "type": "string" },
                "window": { "type": "integer" }
            }),
        ),
        tool(
            "get_goal",
            ToolEffect::Read,
            "查看当前会话 goal",
            serde_json::json!({}),
        ),
        tool(
            "create_goal",
            ToolEffect::Write,
            "创建会话 goal",
            serde_json::json!({
                "objective": { "type": "string" },
                "maxRounds": { "type": "integer" }
            }),
        ),
        tool(
            "update_goal",
            ToolEffect::Write,
            "更新 goal：edit/pause/resume/complete/blocked/clear/tick",
            serde_json::json!({
                "action": { "type": "string" },
                "objective": { "type": "string" }
            }),
        ),
        tool(
            "memory_list",
            ToolEffect::Read,
            "列出 Agent 记忆短事实",
            serde_json::json!({}),
        ),
        tool(
            "memory_add",
            ToolEffect::Write,
            "添加一条 Agent 记忆",
            serde_json::json!({
                "text": { "type": "string" }
            }),
        ),
        tool(
            "memory_save",
            ToolEffect::Write,
            "同 memory_add",
            serde_json::json!({
                "text": { "type": "string" }
            }),
        ),
        tool(
            "memory_remove",
            ToolEffect::Write,
            "按序号或全文删除一条记忆（index 从 1 起）",
            serde_json::json!({
                "index": { "type": "integer" },
                "text": { "type": "string" }
            }),
        ),
        tool(
            "memory_forget",
            ToolEffect::Write,
            "同 memory_remove",
            serde_json::json!({
                "index": { "type": "integer" },
                "text": { "type": "string" }
            }),
        ),
        tool(
            "hook_list",
            ToolEffect::Read,
            "列出已启用的钩子",
            serde_json::json!({}),
        ),
        tool(
            "session_set_model",
            ToolEffect::Write,
            "切换当前会话模型（providerId/modelId）",
            serde_json::json!({
                "modelRef": { "type": "string" },
                "threadId": { "type": "string" }
            }),
        ),
        tool(
            "subagent_list",
            ToolEffect::Read,
            "列出 prefs 中登记的子智能体定义",
            serde_json::json!({}),
        ),
        tool(
            "subagent",
            ToolEffect::Write,
            "托管启动子智能体；wait=true 同步完成，否则立即返回 agentId",
            serde_json::json!({
                "name": { "type": "string" },
                "task": { "type": "string" },
                "wait": { "type": "boolean" },
                "threadId": { "type": "string" }
            }),
        ),
        tool(
            "list_agents",
            ToolEffect::Read,
            "列出本会话托管的子智能体",
            serde_json::json!({
                "scope": { "type": "string" },
                "threadId": { "type": "string" }
            }),
        ),
        tool(
            "send_message",
            ToolEffect::Write,
            "向托管子智能体发送消息",
            serde_json::json!({
                "agent_id": { "type": "string" },
                "message": { "type": "string" },
                "threadId": { "type": "string" }
            }),
        ),
        tool(
            "interrupt_agent",
            ToolEffect::Write,
            "中断托管子智能体",
            serde_json::json!({
                "agent_id": { "type": "string" },
                "threadId": { "type": "string" }
            }),
        ),
        tool(
            "host_tool_run",
            ToolEffect::Write,
            "运行本机白名单工具（如 git/node/python）",
            serde_json::json!({
                "toolId": { "type": "string" },
                "args": { "type": "string" },
                "cwd": { "type": "string" }
            }),
        ),
        tool(
            "todo_write",
            ToolEffect::Write,
            "写入/合并 Agent 会话待办",
            serde_json::json!({
                "todos": { "type": "array" },
                "merge": { "type": "boolean" }
            }),
        ),
        tool(
            "todo_list",
            ToolEffect::Read,
            "列出 Agent 会话待办",
            serde_json::json!({}),
        ),
        tool(
            "ask_user_question",
            ToolEffect::None,
            "向用户提问并等待回复",
            serde_json::json!({
                "question": { "type": "string" }
            }),
        ),
        tool(
            "skill_list",
            ToolEffect::Read,
            "列出已启用的技能",
            serde_json::json!({}),
        ),
        tool(
            "skill_load",
            ToolEffect::Read,
            "加载已启用技能的全文",
            serde_json::json!({
                "name": { "type": "string" }
            }),
        ),
        tool(
            "plugin_list",
            ToolEffect::Read,
            "列出插件目录",
            serde_json::json!({}),
        ),
        tool(
            "mcp_list",
            ToolEffect::Read,
            "列出已配置的 MCP 服务器",
            serde_json::json!({}),
        ),
        tool(
            "mcp_add",
            ToolEffect::Write,
            "添加 MCP 服务器配置（仅 prefs，无协议运行时）",
            serde_json::json!({
                "name": { "type": "string" },
                "command": { "type": "string" },
                "args": { "type": "array" },
                "url": { "type": "string" }
            }),
        ),
        tool(
            "mcp_remove",
            ToolEffect::Write,
            "按序号或名称删除 MCP 配置",
            serde_json::json!({
                "index": { "type": "integer" },
                "name": { "type": "string" }
            }),
        ),
        tool(
            "mcp_call",
            ToolEffect::Write,
            "连接已配置的 stdio MCP：不传 tool 时列出工具，否则调用",
            serde_json::json!({
                "name": { "type": "string" },
                "tool": { "type": "string" },
                "arguments": { "type": "object" }
            }),
        ),
    ]
}

pub fn workspace_tools() -> Vec<ToolSpec> {
    vec![
        tool(
            "read",
            ToolEffect::Read,
            "读取工作区文件",
            serde_json::json!({ "path": { "type": "string" } }),
        ),
        tool(
            "write",
            ToolEffect::Write,
            "写入工作区文件",
            serde_json::json!({
                "path": { "type": "string" },
                "content": { "type": "string" }
            }),
        ),
        tool(
            "str_replace",
            ToolEffect::Write,
            "精确替换工作区文件中的字符串",
            serde_json::json!({
                "path": { "type": "string" },
                "oldString": { "type": "string" },
                "newString": { "type": "string" },
                "replaceAll": { "type": "boolean" }
            }),
        ),
        tool(
            "edit",
            ToolEffect::Write,
            "同 str_replace（字面量替换）",
            serde_json::json!({
                "path": { "type": "string" },
                "oldString": { "type": "string" },
                "newString": { "type": "string" },
                "replaceAll": { "type": "boolean" }
            }),
        ),
        tool(
            "apply_patch",
            ToolEffect::Write,
            "应用 Codex 风格补丁（Add/Update/Delete File）",
            serde_json::json!({
                "patch": { "type": "string" },
                "input": { "type": "string" }
            }),
        ),
        tool(
            "str_replace_editor",
            ToolEffect::Write,
            "Claude Code 风格编辑器：view/create/str_replace/insert",
            serde_json::json!({
                "command": { "type": "string" },
                "path": { "type": "string" },
                "file_text": { "type": "string" },
                "old_str": { "type": "string" },
                "new_str": { "type": "string" },
                "insert_line": { "type": "integer" },
                "view_range": { "type": "array" }
            }),
        ),
        tool(
            "glob",
            ToolEffect::Read,
            "按 glob 查找文件",
            serde_json::json!({ "pattern": { "type": "string" } }),
        ),
        tool(
            "grep",
            ToolEffect::Read,
            "搜索文件内容",
            serde_json::json!({
                "pattern": { "type": "string" },
                "path": { "type": "string" }
            }),
        ),
        tool(
            "shell",
            ToolEffect::Write,
            "在工作区执行 shell（平台默认：Windows=cmd，其它=bash）",
            serde_json::json!({
                "command": { "type": "string" }
            }),
        ),
        tool(
            "bash",
            ToolEffect::Write,
            "强制用 bash -lc 执行命令",
            serde_json::json!({
                "command": { "type": "string" }
            }),
        ),
        tool(
            "pwsh",
            ToolEffect::Write,
            "强制用 pwsh -Command 执行命令",
            serde_json::json!({
                "command": { "type": "string" }
            }),
        ),
        tool(
            "load_workspace_dependencies",
            ToolEffect::Read,
            "探测 PATH 上的 node/python/pnpm/cargo/git 等工具路径",
            serde_json::json!({}),
        ),
        tool(
            "read_image",
            ToolEffect::Read,
            "读取工作区图片元数据（格式/尺寸）",
            serde_json::json!({ "path": { "type": "string" } }),
        ),
        tool(
            "ocr",
            ToolEffect::Read,
            "对工作区图片做 OCR 文字识别（内置 PaddleOCR ONNX；可回退 tesseract / CLI）",
            serde_json::json!({ "path": { "type": "string" } }),
        ),
        tool(
            "speech_transcribe",
            ToolEffect::Read,
            "转写本机 WAV 录音（SenseVoice：wb-asr 子进程 / sherpa CLI）",
            serde_json::json!({
                "path": { "type": "string" },
                "language": { "type": "string" }
            }),
        ),
        tool(
            "job_start",
            ToolEffect::Write,
            "后台启动 shell 任务",
            serde_json::json!({ "command": { "type": "string" } }),
        ),
        tool(
            "job_output",
            ToolEffect::Read,
            "读取后台任务输出",
            serde_json::json!({ "jobId": { "type": "string" } }),
        ),
        tool(
            "job_list",
            ToolEffect::Read,
            "列出后台任务",
            serde_json::json!({}),
        ),
        tool(
            "job_kill",
            ToolEffect::Destructive,
            "终止后台任务",
            serde_json::json!({ "jobId": { "type": "string" } }),
        ),
        tool(
            "web_fetch",
            ToolEffect::Read,
            "抓取网页/HTTP 文本（有体积上限）",
            serde_json::json!({
                "url": { "type": "string" }
            }),
        ),
        tool(
            "web_search",
            ToolEffect::Read,
            "网页搜索（DuckDuckGo HTML，无需 API Key）",
            serde_json::json!({
                "query": { "type": "string" },
                "limit": { "type": "integer" }
            }),
        ),
        tool(
            "present",
            ToolEffect::None,
            "用系统默认应用打开工作区路径；reveal=true 时在资源管理器选中",
            serde_json::json!({
                "path": { "type": "string" },
                "reveal": { "type": "boolean" }
            }),
        ),
        tool(
            "office_to_pdf",
            ToolEffect::Write,
            "用本机 LibreOffice/soffice 把文档转为 PDF",
            serde_json::json!({
                "path": { "type": "string" },
                "output": { "type": "string" }
            }),
        ),
        tool(
            "working_directory",
            ToolEffect::None,
            "设置或查看会话工作目录（相对工作区）",
            serde_json::json!({
                "path": { "type": "string" }
            }),
        ),
        tool(
            "terminal_open",
            ToolEffect::Write,
            "打开交互终端会话（portable-pty / ConPTY）",
            serde_json::json!({
                "shell": { "type": "string" }
            }),
        ),
        tool(
            "terminal_send",
            ToolEffect::Write,
            "向终端会话发送命令",
            serde_json::json!({
                "terminalId": { "type": "string" },
                "command": { "type": "string" }
            }),
        ),
        tool(
            "terminal_read",
            ToolEffect::Read,
            "读取终端会话输出缓冲",
            serde_json::json!({
                "terminalId": { "type": "string" }
            }),
        ),
        tool(
            "terminal_list",
            ToolEffect::Read,
            "列出终端会话",
            serde_json::json!({}),
        ),
        tool(
            "terminal_close",
            ToolEffect::Write,
            "关闭终端会话",
            serde_json::json!({
                "terminalId": { "type": "string" }
            }),
        ),
        tool(
            "terminal_signal",
            ToolEffect::Write,
            "向终端记录信号（轻量实现无进程组）",
            serde_json::json!({
                "terminalId": { "type": "string" },
                "signal": { "type": "string" }
            }),
        ),
    ]
}

fn tool(
    name: &str,
    effect: ToolEffect,
    description: &str,
    properties: serde_json::Value,
) -> ToolSpec {
    ToolSpec {
        name: name.into(),
        effect,
        description: description.into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": properties,
            "additionalProperties": false
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_readonly_blocks_write() {
        assert_eq!(
            gate_tool(ToolEffect::Write, AgentPermissionMode::Readonly),
            ToolGate::Block
        );
    }
}
