use crate::session_todo::{SessionTodo, list_todos, write_todos};
use anyhow::Result;
use serde_json::Value;
use std::path::Path;
use wb_domain::{
    AgentPermissionMode, NotificationKind, TimedIntervalUnit, TimedSchedulePreset, ToolEffect,
    ToolGate, ToolSpec, builtin_host_tools, create_timed_task_draft, format_local_day, gate_tool,
    make_custom_schedule, make_preset_schedule, now_ms, settle_timer_segment, workspace_tools,
};
use wb_host::{
    global_jobs, list_files_recursive, read_image_info, read_text, run_shell, web_fetch, write_text,
};
use wb_store::{MemoryWorkbenchRepository, load_prefs, save_prefs};

#[derive(Debug, Clone, Default)]
pub struct ToolResult {
    pub ok: bool,
    pub content: String,
    /// When set, the app should navigate to this view id (e.g. `today`).
    pub open_view: Option<String>,
}

impl ToolResult {
    pub fn ok_text(content: impl Into<String>) -> Self {
        Self {
            ok: true,
            content: content.into(),
            open_view: None,
        }
    }

    pub fn err_text(content: impl Into<String>) -> Self {
        Self {
            ok: false,
            content: content.into(),
            open_view: None,
        }
    }
}

fn safe_join(root: &str, rel: &str) -> Result<std::path::PathBuf> {
    if rel.split(['/', '\\']).any(|p| p == "..") {
        anyhow::bail!("路径越界：不允许 ..");
    }
    Ok(Path::new(root).join(rel))
}

pub fn all_tools() -> Vec<ToolSpec> {
    let mut tools = builtin_host_tools();
    tools.extend(workspace_tools());
    tools
}

pub fn find_tool(name: &str) -> Option<ToolSpec> {
    all_tools().into_iter().find(|t| t.name == name)
}

pub fn check_gate(name: &str, mode: AgentPermissionMode) -> ToolGate {
    let effect = find_tool(name)
        .map(|t| t.effect)
        .unwrap_or(ToolEffect::Write);
    gate_tool(effect, mode)
}

pub fn execute_tool(
    repo: &mut MemoryWorkbenchRepository,
    name: &str,
    args: &Value,
    workspace_root: Option<&str>,
) -> Result<ToolResult> {
    match name {
        "task_list" => {
            let q = args.get("query").and_then(|v| v.as_str());
            let pid = args.get("projectId").and_then(|v| v.as_str());
            let tasks = repo.list_tasks();
            let filtered: Vec<_> = tasks
                .iter()
                .filter(|t| pid.map(|p| t.project_id == p).unwrap_or(true))
                .filter(|t| {
                    q.map(|q| t.title.contains(q) || t.notes.contains(q))
                        .unwrap_or(true)
                })
                .map(|t| {
                    format!(
                        "- [{}] {} ({})",
                        if t.is_done { "x" } else { " " },
                        t.title,
                        t.id
                    )
                })
                .collect();
            Ok(ToolResult::ok_text(if filtered.is_empty() {
                "（无任务）".into()
            } else {
                filtered.join("\n")
            }))
        }
        "task_create" => {
            let title = args
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("未命名");
            let pid = args.get("projectId").and_then(|v| v.as_str());
            let t = repo.create_task(title, pid);
            Ok(ToolResult::ok_text(format!(
                "已创建任务 {} · {}",
                t.id, t.title
            )))
        }
        "task_complete" => {
            let id = args
                .get("taskId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 taskId"))?;
            match repo.complete_task(id) {
                Some(t) => Ok(ToolResult::ok_text(format!("已完成：{}", t.title))),
                None => Ok(ToolResult::err_text("任务不存在")),
            }
        }
        "task_incomplete" => {
            let id = args
                .get("taskId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 taskId"))?;
            match repo.incomplete_task(id) {
                Some(t) => Ok(ToolResult::ok_text(format!("已重开：{}", t.title))),
                None => Ok(ToolResult::err_text("任务不存在")),
            }
        }
        "project_list" => {
            let lines: Vec<_> = repo
                .list_projects()
                .into_iter()
                .filter(|p| !p.is_archived)
                .map(|p| format!("- {} ({})", p.title, p.id))
                .collect();
            Ok(ToolResult::ok_text(if lines.is_empty() {
                "（无项目）".into()
            } else {
                lines.join("\n")
            }))
        }
        "project_create" => {
            let title = args
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("未命名项目");
            let p = repo.create_project(title);
            Ok(ToolResult::ok_text(format!(
                "已创建项目 {} · {}",
                p.id, p.title
            )))
        }
        "tag_list" => {
            let lines: Vec<_> = repo
                .list_tags()
                .into_iter()
                .map(|t| format!("- #{} ({})", t.title, t.id))
                .collect();
            Ok(ToolResult::ok_text(if lines.is_empty() {
                "（无标签）".into()
            } else {
                lines.join("\n")
            }))
        }
        "tag_create" => {
            let title = args
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("未命名");
            let t = repo.create_tag(title);
            Ok(ToolResult::ok_text(format!(
                "已创建标签 #{} · {}",
                t.title, t.id
            )))
        }
        "tag_add" => {
            let task_id = args
                .get("taskId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 taskId"))?;
            let tag_id = args
                .get("tagId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 tagId"))?;
            if repo.get_task(task_id).is_none() {
                return Ok(ToolResult::err_text("任务不存在"));
            }
            if !repo.list_tags().iter().any(|t| t.id == tag_id) {
                return Ok(ToolResult::err_text("标签不存在"));
            }
            repo.add_tag_to_task(task_id, tag_id);
            Ok(ToolResult::ok_text(format!(
                "已将标签 {tag_id} 加到任务 {task_id}"
            )))
        }
        "note_list" => {
            let notes = repo.list_notes();
            let lines: Vec<_> = notes
                .iter()
                .map(|n| format!("- {} ({})", n.title, n.id))
                .collect();
            Ok(ToolResult::ok_text(if lines.is_empty() {
                "（无笔记）".into()
            } else {
                lines.join("\n")
            }))
        }
        "note_create" => {
            let title = args
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("未命名笔记");
            let body = args.get("body").and_then(|v| v.as_str()).unwrap_or("");
            let n = repo.create_note(title, body);
            Ok(ToolResult::ok_text(format!(
                "已创建笔记 {} · {}",
                n.id, n.title
            )))
        }
        "notification_list" => {
            let notes = repo.list_notifications();
            let lines: Vec<_> = notes
                .iter()
                .take(20)
                .map(|n| format!("- {} · {}", n.title, n.body))
                .collect();
            Ok(ToolResult::ok_text(lines.join("\n")))
        }
        "schedule_list" => {
            let tasks = repo.list_timed_tasks();
            let lines: Vec<_> = tasks
                .iter()
                .map(|t| {
                    format!(
                        "- {} [{}] next={:?} ({})",
                        t.title,
                        if t.enabled { "on" } else { "off" },
                        t.next_run_at,
                        t.id
                    )
                })
                .collect();
            Ok(ToolResult::ok_text(lines.join("\n")))
        }
        "schedule_create" => {
            let title = args
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("定时任务");
            let command = args.get("command").and_then(|v| v.as_str()).unwrap_or("");
            let at_time = args
                .get("atTime")
                .or_else(|| args.get("at_time"))
                .and_then(|v| v.as_str())
                .unwrap_or("09:00");
            let schedule = if let Some(every) = args.get("every").and_then(|v| v.as_i64()) {
                let unit = match args
                    .get("unit")
                    .and_then(|v| v.as_str())
                    .unwrap_or("day")
                    .to_lowercase()
                    .as_str()
                {
                    "minute" | "分钟" => TimedIntervalUnit::Minute,
                    "hour" | "小时" => TimedIntervalUnit::Hour,
                    "week" | "周" => TimedIntervalUnit::Week,
                    "month" | "月" | "个月" => TimedIntervalUnit::Month,
                    "year" | "年" => TimedIntervalUnit::Year,
                    _ => TimedIntervalUnit::Day,
                };
                make_custom_schedule(every, unit, at_time)
            } else {
                let preset = match args
                    .get("preset")
                    .and_then(|v| v.as_str())
                    .unwrap_or("daily")
                    .to_lowercase()
                    .as_str()
                {
                    "hourly" | "每小时" => TimedSchedulePreset::Hourly,
                    "weekdays" | "工作日" | "每工作日" => TimedSchedulePreset::Weekdays,
                    "weekly" | "每周" => TimedSchedulePreset::Weekly,
                    "monthly" | "每月" => TimedSchedulePreset::Monthly,
                    _ => TimedSchedulePreset::Daily,
                };
                make_preset_schedule(preset, at_time)
            };
            let task = create_timed_task_draft(Some(title), Some(command), Some(schedule), None);
            let id = task.id.clone();
            let label = task.title.clone();
            repo.upsert_timed_task(task);
            Ok(ToolResult::ok_text(format!(
                "已创建定时任务 {id} · {label}"
            )))
        }
        "schedule_enable" => {
            let id = args
                .get("scheduleId")
                .or_else(|| args.get("id"))
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 scheduleId"))?;
            let enabled = args
                .get("enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let Some(mut task) = repo.get_timed_task(id).cloned() else {
                return Ok(ToolResult::err_text("定时任务不存在"));
            };
            task.enabled = enabled;
            let title = task.title.clone();
            repo.upsert_timed_task(task);
            Ok(ToolResult::ok_text(format!(
                "已{}：{title}",
                if enabled { "启用" } else { "停用" }
            )))
        }
        "schedule_delete" => {
            let id = args
                .get("scheduleId")
                .or_else(|| args.get("id"))
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 scheduleId"))?;
            if repo.get_timed_task(id).is_none() {
                return Ok(ToolResult::err_text("定时任务不存在"));
            }
            repo.delete_timed_task(id);
            Ok(ToolResult::ok_text(format!("已删除定时任务 {id}")))
        }
        "timer_status" => {
            let id = args
                .get("taskId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 taskId"))?;
            match repo.get_task(id) {
                Some(t) => {
                    let today = format_local_day(now_ms());
                    let today_ms = t.time_spent_on_day.get(&today).copied().unwrap_or(0);
                    Ok(ToolResult::ok_text(format!(
                        "{} · 合计 {}ms · 今日 {}ms",
                        t.title, t.time_spent, today_ms
                    )))
                }
                None => Ok(ToolResult::err_text("任务不存在")),
            }
        }
        "timer_add" => {
            let id = args
                .get("taskId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 taskId"))?;
            let ms = args
                .get("elapsedMs")
                .and_then(|v| v.as_i64())
                .or_else(|| {
                    args.get("minutes")
                        .and_then(|v| v.as_i64())
                        .map(|m| m * 60_000)
                })
                .unwrap_or(0);
            if ms <= 0 {
                return Ok(ToolResult::err_text("elapsedMs / minutes 须为正数"));
            }
            let Some(mut task) = repo.get_task(id).cloned() else {
                return Ok(ToolResult::err_text("任务不存在"));
            };
            let now = now_ms();
            let day = format_local_day(now);
            settle_timer_segment(&mut task, &day, ms, now);
            let title = task.title.clone();
            let spent = task.time_spent;
            repo.upsert_task(task);
            Ok(ToolResult::ok_text(format!(
                "已为「{title}」记入 {ms}ms · 合计 {spent}ms"
            )))
        }
        "ui_open" => {
            let view = args
                .get("view")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_lowercase();
            let normalized = match view.as_str() {
                "today" | "今日" => Some("today"),
                "inbox" | "收件箱" => Some("inbox"),
                "done" | "已完成" => Some("done"),
                "planner" | "计划" => Some("planner"),
                "timed" | "定时" | "定时任务" => Some("timed"),
                "projects" | "项目" => Some("projects"),
                "knowledge" | "知识库" | "kb" => Some("knowledge"),
                "agent" => Some("agent"),
                "settings" | "设置" => Some("settings"),
                _ => None,
            };
            match normalized {
                Some(v) => Ok(ToolResult {
                    ok: true,
                    content: format!("已打开视图：{v}"),
                    open_view: Some(v.into()),
                }),
                None => Ok(ToolResult::err_text(format!(
                    "未知视图：{view}（可用 today/inbox/done/planner/timed/projects/knowledge/agent/settings）"
                ))),
            }
        }
        "memory_list" => {
            let prefs = load_prefs().unwrap_or_default();
            let lines: Vec<_> = prefs
                .agent
                .memories
                .iter()
                .enumerate()
                .map(|(i, m)| format!("{}. {m}", i + 1))
                .collect();
            Ok(ToolResult::ok_text(if lines.is_empty() {
                "（无记忆）".into()
            } else {
                lines.join("\n")
            }))
        }
        "memory_add" => {
            let text = args
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            if text.is_empty() {
                return Ok(ToolResult::err_text("记忆内容不能为空"));
            }
            let mut prefs = load_prefs().unwrap_or_default();
            if !prefs.agent.memories.iter().any(|m| m == text) {
                prefs.agent.memories.push(text.to_string());
                save_prefs(&prefs)?;
            }
            Ok(ToolResult::ok_text(format!("已记住：{text}")))
        }
        "memory_remove" => {
            let mut prefs = load_prefs().unwrap_or_default();
            let before = prefs.agent.memories.len();
            if let Some(idx) = args.get("index").and_then(|v| v.as_u64()) {
                let i = idx.saturating_sub(1) as usize;
                if i < prefs.agent.memories.len() {
                    prefs.agent.memories.remove(i);
                }
            } else if let Some(text) = args.get("text").and_then(|v| v.as_str()) {
                prefs.agent.memories.retain(|m| m != text);
            } else {
                return Ok(ToolResult::err_text("需要 index 或 text"));
            }
            save_prefs(&prefs)?;
            Ok(ToolResult::ok_text(format!(
                "已删除 {} 条记忆",
                before.saturating_sub(prefs.agent.memories.len())
            )))
        }
        "todo_list" => {
            let lines: Vec<_> = list_todos()
                .into_iter()
                .map(|t| format!("- [{}] {} ({})", t.status, t.content, t.id))
                .collect();
            Ok(ToolResult::ok_text(if lines.is_empty() {
                "（无待办）".into()
            } else {
                lines.join("\n")
            }))
        }
        "todo_write" => {
            let merge = args.get("merge").and_then(|v| v.as_bool()).unwrap_or(true);
            let mut parsed = Vec::new();
            if let Some(arr) = args.get("todos").and_then(|v| v.as_array()) {
                for (i, item) in arr.iter().enumerate() {
                    let id = item
                        .get("id")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| format!("todo-{}", i + 1));
                    let content = item
                        .get("content")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let status = item
                        .get("status")
                        .and_then(|v| v.as_str())
                        .unwrap_or("pending")
                        .to_string();
                    if !content.is_empty() {
                        parsed.push(SessionTodo {
                            id,
                            content,
                            status,
                        });
                    }
                }
            }
            let out = write_todos(parsed, merge);
            Ok(ToolResult::ok_text(format!(
                "待办已更新，共 {} 条",
                out.len()
            )))
        }
        "ask_user_question" => {
            let question = args
                .get("question")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            if question.is_empty() {
                return Ok(ToolResult::err_text("问题不能为空"));
            }
            repo.push_notification(NotificationKind::System, "Agent 提问", question, None);
            Ok(ToolResult::ok_text(format!(
                "已向用户提问（见通知中心）：{question}"
            )))
        }
        "read" => {
            let rel = args
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 path"))?;
            let root = workspace_root.ok_or_else(|| anyhow::anyhow!("未绑定工作区"))?;
            let path = safe_join(root, rel)?;
            let text = read_text(&path)?;
            Ok(ToolResult::ok_text(text))
        }
        "write" => {
            let rel = args
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 path"))?;
            let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("");
            let root = workspace_root.ok_or_else(|| anyhow::anyhow!("未绑定工作区"))?;
            let path = safe_join(root, rel)?;
            write_text(&path, content)?;
            Ok(ToolResult::ok_text(format!("已写入 {rel}")))
        }
        "str_replace" | "edit" => {
            let rel = args
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 path"))?;
            let old = args
                .get("oldString")
                .or_else(|| args.get("old_string"))
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 oldString"))?;
            let new = args
                .get("newString")
                .or_else(|| args.get("new_string"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let replace_all = args
                .get("replaceAll")
                .or_else(|| args.get("replace_all"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let root = workspace_root.ok_or_else(|| anyhow::anyhow!("未绑定工作区"))?;
            let path = safe_join(root, rel)?;
            let text = read_text(&path)?;
            if old.is_empty() {
                return Ok(ToolResult::err_text("oldString 不能为空"));
            }
            let count = text.matches(old).count();
            if count == 0 {
                return Ok(ToolResult::err_text("未找到 oldString"));
            }
            if !replace_all && count > 1 {
                return Ok(ToolResult::err_text(format!(
                    "oldString 出现 {count} 次；请收窄或设 replaceAll=true"
                )));
            }
            let next = if replace_all {
                text.replace(old, new)
            } else {
                text.replacen(old, new, 1)
            };
            write_text(&path, &next)?;
            Ok(ToolResult::ok_text(format!(
                "已替换 {rel}（{} 处）",
                if replace_all { count } else { 1 }
            )))
        }
        "shell" => {
            let command = args
                .get("command")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 command"))?;
            let result = run_shell(command, workspace_root, 120)?;
            Ok(ToolResult {
                ok: result.code == 0,
                content: format!("exit {}\n{}\n{}", result.code, result.stdout, result.stderr),
                open_view: None,
            })
        }
        "read_image" => {
            let rel = args
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 path"))?;
            let root = workspace_root.ok_or_else(|| anyhow::anyhow!("未绑定工作区"))?;
            let path = safe_join(root, rel)?;
            let info = read_image_info(&path)?;
            Ok(ToolResult::ok_text(format!(
                "{} · {} · {} bytes · {}x{} · {}",
                info.path,
                info.format,
                info.bytes,
                info.width.unwrap_or(0),
                info.height.unwrap_or(0),
                info.note
            )))
        }
        "job_start" => {
            let command = args
                .get("command")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 command"))?;
            let id = global_jobs().start(command, workspace_root)?;
            Ok(ToolResult::ok_text(format!("已启动后台任务 {id}")))
        }
        "job_output" => {
            let id = args
                .get("jobId")
                .or_else(|| args.get("id"))
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 jobId"))?;
            match global_jobs().output(id) {
                Some((out, code)) => Ok(ToolResult::ok_text(format!(
                    "code={:?}\n{}",
                    code,
                    if out.len() > 20_000 {
                        format!("{}…\n[truncated {} bytes]", &out[..20_000], out.len())
                    } else {
                        out
                    }
                ))),
                None => Ok(ToolResult::err_text("任务不存在")),
            }
        }
        "job_list" => {
            let lines: Vec<_> = global_jobs()
                .list()
                .into_iter()
                .map(|j| {
                    format!(
                        "- {} [{}] code={:?} · {}",
                        j.id,
                        if j.done { "done" } else { "run" },
                        j.code,
                        j.command
                    )
                })
                .collect();
            Ok(ToolResult::ok_text(if lines.is_empty() {
                "（无后台任务）".into()
            } else {
                lines.join("\n")
            }))
        }
        "job_kill" => {
            let id = args
                .get("jobId")
                .or_else(|| args.get("id"))
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 jobId"))?;
            if global_jobs().kill(id) {
                Ok(ToolResult::ok_text(format!("已终止 {id}")))
            } else {
                Ok(ToolResult::err_text("任务不存在"))
            }
        }
        "web_fetch" => {
            let url = args
                .get("url")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 url"))?;
            if !(url.starts_with("http://") || url.starts_with("https://")) {
                return Ok(ToolResult::err_text("仅支持 http/https"));
            }
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?;
            let result = rt.block_on(web_fetch(url, None))?;
            let mut body = result.body;
            if result.truncated {
                body.push_str("\n…[truncated]");
            }
            Ok(ToolResult {
                ok: result.status < 400,
                content: format!(
                    "HTTP {} · {}\n{}",
                    result.status,
                    result.content_type.unwrap_or_else(|| "unknown".into()),
                    body
                ),
                open_view: None,
            })
        }
        "glob" => {
            let pattern = args
                .get("pattern")
                .and_then(|v| v.as_str())
                .unwrap_or("*")
                .to_lowercase();
            let root = workspace_root.ok_or_else(|| anyhow::anyhow!("未绑定工作区"))?;
            let entries = list_files_recursive(Path::new(root), 500)?;
            let lines: Vec<_> = entries
                .into_iter()
                .filter(|e| {
                    let rel = e.relative.to_lowercase();
                    if pattern == "*" || pattern == "**/*" {
                        true
                    } else if let Some(ext) = pattern.strip_prefix("*.") {
                        rel.ends_with(&format!(".{ext}"))
                    } else {
                        rel.contains(&pattern.trim_matches('*').to_string())
                    }
                })
                .take(100)
                .map(|e| e.relative)
                .collect();
            Ok(ToolResult::ok_text(if lines.is_empty() {
                "（无匹配文件）".into()
            } else {
                lines.join("\n")
            }))
        }
        "grep" => {
            let pattern = args
                .get("pattern")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 pattern"))?;
            let sub = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
            let root = workspace_root.ok_or_else(|| anyhow::anyhow!("未绑定工作区"))?;
            let base = if sub.is_empty() {
                Path::new(root).to_path_buf()
            } else {
                safe_join(root, sub)?
            };
            let entries = list_files_recursive(&base, 200)?;
            let mut hits = Vec::new();
            for e in entries {
                if e.is_dir {
                    continue;
                }
                let Ok(text) = read_text(Path::new(&e.path)) else {
                    continue;
                };
                for (i, line) in text.lines().enumerate() {
                    if line.contains(pattern) {
                        hits.push(format!("{}:{}:{}", e.relative, i + 1, line.trim()));
                        if hits.len() >= 50 {
                            break;
                        }
                    }
                }
                if hits.len() >= 50 {
                    break;
                }
            }
            Ok(ToolResult::ok_text(if hits.is_empty() {
                "（无匹配）".into()
            } else {
                hits.join("\n")
            }))
        }
        other => Ok(ToolResult::err_text(format!("未知工具: {other}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn task_project_tag_note_roundtrip() {
        let mut repo = MemoryWorkbenchRepository::default();
        let t = execute_tool(
            &mut repo,
            "task_create",
            &json!({ "title": "写工具" }),
            None,
        )
        .unwrap();
        assert!(t.ok);
        let task_id = repo.list_tasks()[0].id.clone();

        let p = execute_tool(
            &mut repo,
            "project_create",
            &json!({ "title": "Agent" }),
            None,
        )
        .unwrap();
        assert!(p.ok);

        let tag = execute_tool(&mut repo, "tag_create", &json!({ "title": "核心" }), None).unwrap();
        assert!(tag.ok);
        let tag_id = repo.list_tags()[0].id.clone();

        let add = execute_tool(
            &mut repo,
            "tag_add",
            &json!({ "taskId": task_id, "tagId": tag_id }),
            None,
        )
        .unwrap();
        assert!(add.ok);

        let note = execute_tool(
            &mut repo,
            "note_create",
            &json!({ "title": "备忘", "body": "hello" }),
            None,
        )
        .unwrap();
        assert!(note.ok);

        let incomplete = execute_tool(
            &mut repo,
            "task_complete",
            &json!({ "taskId": task_id }),
            None,
        )
        .unwrap();
        assert!(incomplete.ok);
        let reopen = execute_tool(
            &mut repo,
            "task_incomplete",
            &json!({ "taskId": task_id }),
            None,
        )
        .unwrap();
        assert!(reopen.ok);
        assert!(!repo.get_task(&task_id).unwrap().is_done);

        let list = execute_tool(&mut repo, "project_list", &json!({}), None).unwrap();
        assert!(list.content.contains("Agent"));
    }

    #[test]
    fn glob_grep_str_replace_and_ui_open() {
        let dir = std::env::temp_dir().join(format!("wb-agent-glob-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("hello.rs");
        std::fs::write(&file, "fn main() { println!(\"gap\"); }\n").unwrap();
        let mut repo = MemoryWorkbenchRepository::default();
        let root = dir.to_string_lossy().to_string();

        let g = execute_tool(
            &mut repo,
            "glob",
            &json!({ "pattern": "*.rs" }),
            Some(&root),
        )
        .unwrap();
        assert!(g.ok);
        assert!(g.content.contains("hello.rs"));

        let hits =
            execute_tool(&mut repo, "grep", &json!({ "pattern": "gap" }), Some(&root)).unwrap();
        assert!(hits.ok);
        assert!(hits.content.contains("gap"));

        let edited = execute_tool(
            &mut repo,
            "str_replace",
            &json!({
                "path": "hello.rs",
                "oldString": "gap",
                "newString": "done"
            }),
            Some(&root),
        )
        .unwrap();
        assert!(edited.ok);
        assert!(std::fs::read_to_string(&file).unwrap().contains("done"));

        let nav = execute_tool(&mut repo, "ui_open", &json!({ "view": "今日" }), None).unwrap();
        assert!(nav.ok);
        assert_eq!(nav.open_view.as_deref(), Some("today"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn timer_add_updates_spent() {
        let mut repo = MemoryWorkbenchRepository::default();
        let t = repo.create_task("计时", None);
        let id = t.id.clone();
        let r = execute_tool(
            &mut repo,
            "timer_add",
            &json!({ "taskId": id, "minutes": 2 }),
            None,
        )
        .unwrap();
        assert!(r.ok);
        assert_eq!(repo.get_task(&id).unwrap().time_spent, 120_000);
    }

    #[test]
    fn read_image_and_job_roundtrip() {
        let dir = std::env::temp_dir().join(format!("wb-agent-img-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // 1x1 PNG
        let png: &[u8] = &[
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00,
            0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08,
            0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe,
            0xd4, 0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
        ];
        std::fs::write(dir.join("dot.png"), png).unwrap();
        let mut repo = MemoryWorkbenchRepository::default();
        let root = dir.to_string_lossy().to_string();
        let img = execute_tool(
            &mut repo,
            "read_image",
            &json!({ "path": "dot.png" }),
            Some(&root),
        )
        .unwrap();
        assert!(img.ok);
        assert!(img.content.contains("png"));

        let job = execute_tool(
            &mut repo,
            "job_start",
            &json!({ "command": "echo hello-job" }),
            Some(&root),
        )
        .unwrap();
        assert!(job.ok);
        let id = job.content.split_whitespace().last().unwrap().to_string();
        for _ in 0..50 {
            if let Some((_, Some(_))) = global_jobs().output(&id) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let out = execute_tool(&mut repo, "job_output", &json!({ "jobId": id }), None).unwrap();
        assert!(out.ok);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn memory_and_todo_tools() {
        let mut repo = MemoryWorkbenchRepository::default();
        let add = execute_tool(
            &mut repo,
            "memory_add",
            &json!({ "text": "喜欢简洁回复" }),
            None,
        )
        .unwrap();
        assert!(add.ok);
        let list = execute_tool(&mut repo, "memory_list", &json!({}), None).unwrap();
        assert!(list.content.contains("喜欢简洁回复"));

        let todos = execute_tool(
            &mut repo,
            "todo_write",
            &json!({
                "merge": false,
                "todos": [{ "id": "1", "content": "写测试", "status": "pending" }]
            }),
            None,
        )
        .unwrap();
        assert!(todos.ok);
        let listed = execute_tool(&mut repo, "todo_list", &json!({}), None).unwrap();
        assert!(listed.content.contains("写测试"));
    }

    #[test]
    fn schedule_create_enable_delete() {
        let mut repo = MemoryWorkbenchRepository::default();
        let created = execute_tool(
            &mut repo,
            "schedule_create",
            &json!({
                "title": "晨报",
                "command": "总结今日任务",
                "preset": "daily",
                "atTime": "08:30"
            }),
            None,
        )
        .unwrap();
        assert!(created.ok);
        let id = repo.list_timed_tasks()[0].id.clone();
        let off = execute_tool(
            &mut repo,
            "schedule_enable",
            &json!({ "scheduleId": id, "enabled": false }),
            None,
        )
        .unwrap();
        assert!(off.ok);
        assert!(!repo.get_timed_task(&id).unwrap().enabled);
        let del = execute_tool(
            &mut repo,
            "schedule_delete",
            &json!({ "scheduleId": id }),
            None,
        )
        .unwrap();
        assert!(del.ok);
        assert!(repo.list_timed_tasks().is_empty());
    }
}
