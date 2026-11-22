use crate::fs_observe::{observe_path, require_observed_for_existing};
use crate::managed_agents::{
    finish_managed_agent, get_managed_agent, interrupt_managed_agent, list_managed_agents,
    register_managed_agent, send_managed_agent_message, take_managed_agent_inbox,
};
use crate::session_goal::{create_goal, get_goal, update_goal};
use crate::session_todo::{SessionTodo, list_todos, write_todos};
use crate::turn::{resume_thread_turn_blocking, run_user_turn_blocking};
use anyhow::Result;
use serde_json::Value;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use wb_domain::{
    AgentMessage, AgentPermissionMode, AgentRole, AgentThread, BUILTIN_MODEL_REF, NotificationKind,
    PatchAction, ReminderOptionId, SchedulePatch, Task, TimedIntervalUnit, TimedSchedulePreset,
    ToolEffect, ToolGate, ToolSpec, apply_hunks, apply_schedule_patch, at_local_time,
    builtin_host_tools, clear_plan_fields, create_id, create_task_draft, create_timed_task_draft,
    format_local_day, gate_tool, is_today_member, make_custom_schedule, make_preset_schedule,
    now_ms, parse_apply_patch, settle_timer_segment, shift_remind_at, workspace_tools,
};
use wb_host::{
    active_skills, cleanup_tool_spill, global_jobs, global_terminals, list_files_recursive,
    list_plugins, list_skills, load_skill, maybe_spill, mcp_http_call, mcp_stdio_call,
    path_is_within, paths_equal, present_path, probe_workspace_dependencies, read_image_info,
    read_text, resolve_agent_cwd, run_shell_in, run_shell_kind, set_agent_cwd, web_fetch,
    web_search, which_bin, write_text,
};
use wb_store::{MemoryWorkbenchRepository, load_prefs, update_prefs};

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

fn effective_root(workspace_root: Option<&str>) -> Result<String> {
    if let Some(cwd) = resolve_agent_cwd(workspace_root) {
        return Ok(cwd.to_string_lossy().to_string());
    }
    workspace_root
        .map(|s| s.to_string())
        .ok_or_else(|| anyhow::anyhow!("未绑定工作区"))
}

fn resolve_thread_id(repo: &MemoryWorkbenchRepository, args: &Value) -> Option<String> {
    args.get("threadId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| repo.list_agent_threads().into_iter().next().map(|t| t.id))
}

/// 1-based seq list; when `before_last_user`, cut off at the last user message (exclusive).
fn thread_events(
    repo: &MemoryWorkbenchRepository,
    thread_id: &str,
    before_last_user: bool,
) -> Vec<(usize, AgentMessage)> {
    let mut msgs = repo.messages_for_thread(thread_id);
    if before_last_user {
        if let Some(pos) = msgs
            .iter()
            .rposition(|m| matches!(m.role, wb_domain::AgentRole::User))
        {
            msgs.truncate(pos);
        }
    }
    msgs.into_iter()
        .enumerate()
        .map(|(i, m)| (i + 1, m))
        .collect()
}

fn format_event(seq: usize, m: &AgentMessage) -> String {
    let role = format!("{:?}", m.role).to_lowercase();
    let tool = m
        .tool_name
        .as_deref()
        .map(|n| format!(" tool={n}"))
        .unwrap_or_default();
    let call = m
        .tool_call_id
        .as_deref()
        .map(|id| format!(" call={id}"))
        .unwrap_or_default();
    format!("#{seq} [{role}]{tool}{call}\n{}", m.content)
}

fn number_lines(text: &str, view_range: Option<&Value>) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let (start, end) = match view_range {
        Some(Value::Array(arr)) if arr.len() >= 2 => {
            let a = arr[0].as_u64().unwrap_or(1).max(1) as usize;
            let b = arr[1].as_i64().unwrap_or(lines.len() as i64);
            let end = if b < 0 {
                lines.len()
            } else {
                (b as usize).min(lines.len())
            };
            (a.min(lines.len().saturating_add(1)), end)
        }
        _ => (1, lines.len()),
    };
    if lines.is_empty() {
        return "（空文件）".into();
    }
    let start = start.max(1);
    let end = end.max(start.saturating_sub(1)).min(lines.len());
    lines[start.saturating_sub(1)..end]
        .iter()
        .enumerate()
        .map(|(i, line)| format!("{:>6}|{}", start + i, line))
        .collect::<Vec<_>>()
        .join("\n")
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
        "task_incomplete" | "task_reopen" => {
            let task = match resolve_task(repo, args) {
                Ok(t) => t,
                Err(msg) => return Ok(ToolResult::err_text(msg)),
            };
            match repo.incomplete_task(&task.id) {
                Some(t) => Ok(ToolResult::ok_text(format!("已重开：{}", t.title))),
                None => Ok(ToolResult::err_text("任务不存在")),
            }
        }
        "task_get" => {
            let task = match resolve_task(repo, args) {
                Ok(t) => t,
                Err(msg) => return Ok(ToolResult::err_text(msg)),
            };
            let subs: Vec<_> = repo
                .list_tasks()
                .into_iter()
                .filter(|t| t.parent_id.as_deref() == Some(task.id.as_str()))
                .map(|t| {
                    format!(
                        "  - [{}] {} ({})",
                        if t.is_done { "x" } else { " " },
                        t.title,
                        t.id
                    )
                })
                .collect();
            let mut text = format_task_detail(&task);
            if !subs.is_empty() {
                text.push_str("\n子任务:\n");
                text.push_str(&subs.join("\n"));
            }
            Ok(ToolResult::ok_text(text))
        }
        "task_list_today" => {
            let today = format_local_day(now_ms());
            let lines: Vec<_> = repo
                .list_tasks()
                .into_iter()
                .filter(|t| !t.is_done && t.parent_id.is_none() && is_today_member(t, &today))
                .map(|t| format!("- {} ({})", t.title, t.id))
                .collect();
            Ok(ToolResult::ok_text(if lines.is_empty() {
                "今日没有任务".into()
            } else {
                format!("今日 {} 项\n{}", lines.len(), lines.join("\n"))
            }))
        }
        "task_update" => {
            let task = match resolve_task(repo, args) {
                Ok(t) => t,
                Err(msg) => return Ok(ToolResult::err_text(msg)),
            };
            let Some(mut next) = repo.get_task(&task.id).cloned() else {
                return Ok(ToolResult::err_text("任务不存在"));
            };
            if let Some(title) = arg_str(args, &["title"]) {
                if args.get("taskId").is_some() || args.get("id").is_some() {
                    next.title = title.to_string();
                }
            }
            if let Some(notes) = args.get("notes").and_then(|v| v.as_str()) {
                next.notes = notes.to_string();
            }
            if let Some(pid) = arg_str(args, &["projectId"]) {
                next.project_id = pid.to_string();
            }
            if let Some(mins) = args.get("timeEstimateMinutes").and_then(|v| v.as_i64()) {
                next.time_estimate = mins * 60_000;
            }
            next.updated_at = now_ms();
            let title = next.title.clone();
            repo.upsert_task(next);
            Ok(ToolResult::ok_text(format!("已修改任务「{title}」")))
        }
        "task_schedule" | "task_set_deadline" => match apply_task_when(repo, args) {
            Ok(text) => Ok(ToolResult::ok_text(text)),
            Err(msg) => Ok(ToolResult::err_text(msg)),
        },
        "task_set_reminder" => match apply_task_reminder(repo, args) {
            Ok(text) => Ok(ToolResult::ok_text(text)),
            Err(msg) => Ok(ToolResult::err_text(msg)),
        },
        "task_move_backlog" => {
            let task = match resolve_task(repo, args) {
                Ok(t) => t,
                Err(msg) => return Ok(ToolResult::err_text(msg)),
            };
            let Some(mut next) = repo.get_task(&task.id).cloned() else {
                return Ok(ToolResult::err_text("任务不存在"));
            };
            clear_plan_fields(&mut next);
            next.updated_at = now_ms();
            let title = next.title.clone();
            repo.upsert_task(next);
            Ok(ToolResult::ok_text(format!("已把「{title}」移入待办")))
        }
        "task_add_subtask" => {
            let title = arg_str(args, &["title", "subtaskTitle"]).unwrap_or("");
            if title.is_empty() {
                return Ok(ToolResult::err_text("子任务标题不能为空"));
            }
            let parent = match resolve_task(
                repo,
                &serde_json::json!({
                    "taskId": args.get("parentId").cloned().unwrap_or(Value::Null),
                    "title": args.get("parentTitle").cloned().unwrap_or(Value::Null),
                }),
            ) {
                Ok(t) => t,
                Err(msg) => return Ok(ToolResult::err_text(msg)),
            };
            let child = create_task_draft(title, Some(&parent.project_id), Some(&parent.id), None);
            let id = child.id.clone();
            let label = child.title.clone();
            repo.upsert_task(child);
            Ok(ToolResult::ok_text(format!(
                "已添加子任务「{label}」({id})"
            )))
        }
        "task_delete" => {
            let task = match resolve_task(repo, args) {
                Ok(t) => t,
                Err(msg) => return Ok(ToolResult::err_text(msg)),
            };
            let title = task.title.clone();
            let id = task.id.clone();
            repo.delete_task(&id);
            Ok(ToolResult::ok_text(format!("已删除任务「{title}」")))
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
        "project_archive" => {
            let archived = args
                .get("archived")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let project = if let Some(id) = arg_str(args, &["projectId", "id"]) {
                repo.list_projects().into_iter().find(|p| p.id == id)
            } else if let Some(title) = arg_str(args, &["title"]) {
                repo.list_projects().into_iter().find(|p| p.title == title)
            } else {
                None
            };
            let Some(project) = project else {
                return Ok(ToolResult::err_text("项目不存在"));
            };
            match repo.set_project_archived(&project.id, archived) {
                Some(p) => Ok(ToolResult::ok_text(format!(
                    "已{}项目「{}」",
                    if archived { "归档" } else { "恢复" },
                    p.title
                ))),
                None => Ok(ToolResult::err_text("收件箱不能归档")),
            }
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
        "tag_assign" => match assign_tag(repo, args) {
            Ok(text) => Ok(ToolResult::ok_text(text)),
            Err(msg) => Ok(ToolResult::err_text(msg)),
        },
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
        "note_get" => {
            let note = match resolve_note(repo, args) {
                Ok(n) => n,
                Err(msg) => return Ok(ToolResult::err_text(msg)),
            };
            Ok(ToolResult::ok_text(format!(
                "{} ({})\n{}",
                note.title, note.id, note.body_md
            )))
        }
        "note_search" => {
            let q = arg_str(args, &["query"]).unwrap_or("").to_lowercase();
            if q.is_empty() {
                return Ok(ToolResult::err_text("请提供搜索词"));
            }
            let lines: Vec<_> = repo
                .list_notes()
                .into_iter()
                .filter(|n| {
                    n.title.to_lowercase().contains(&q) || n.body_md.to_lowercase().contains(&q)
                })
                .map(|n| format!("- {} ({})", n.title, n.id))
                .collect();
            Ok(ToolResult::ok_text(if lines.is_empty() {
                "（无匹配笔记）".into()
            } else {
                lines.join("\n")
            }))
        }
        "note_update" => {
            let note = match resolve_note(repo, args) {
                Ok(n) => n,
                Err(msg) => return Ok(ToolResult::err_text(msg)),
            };
            let Some(mut next) = repo.get_note(&note.id).cloned() else {
                return Ok(ToolResult::err_text("笔记不存在"));
            };
            if let Some(title) = arg_str(args, &["title"]) {
                if args.get("noteId").is_some() || args.get("id").is_some() {
                    next.title = title.to_string();
                }
            }
            if let Some(body) = args
                .get("body")
                .or_else(|| args.get("bodyMd"))
                .and_then(|v| v.as_str())
            {
                next.body_md = body.to_string();
            }
            next.updated_at = now_ms();
            let title = next.title.clone();
            repo.upsert_note(next);
            Ok(ToolResult::ok_text(format!("已更新笔记「{title}」")))
        }
        "note_delete" => {
            let note = match resolve_note(repo, args) {
                Ok(n) => n,
                Err(msg) => return Ok(ToolResult::err_text(msg)),
            };
            let title = note.title.clone();
            repo.delete_note(&note.id);
            Ok(ToolResult::ok_text(format!("已删除笔记「{title}」")))
        }
        "notification_list" => {
            let notes = repo.list_notifications();
            let lines: Vec<_> = notes
                .iter()
                .take(20)
                .map(|n| format!("- {} · {}", n.title, n.body))
                .collect();
            Ok(ToolResult::ok_text(if lines.is_empty() {
                "（无通知）".into()
            } else {
                lines.join("\n")
            }))
        }
        "notification_create" => {
            let title = args
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("通知")
                .trim();
            let body = args.get("body").and_then(|v| v.as_str()).unwrap_or("");
            let kind = match args
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or("agent")
                .to_lowercase()
                .as_str()
            {
                "task" | "task_remind" => NotificationKind::TaskRemind,
                "deadline" | "deadline_remind" => NotificationKind::DeadlineRemind,
                "event" | "event_remind" => NotificationKind::EventRemind,
                "system" => NotificationKind::System,
                _ => NotificationKind::Agent,
            };
            let n = repo.push_notification(kind, title, body, None);
            let _ = wb_host::show_system_notification(title, body);
            Ok(ToolResult::ok_text(format!(
                "已创建通知 {} · {}",
                n.id, n.title
            )))
        }
        "notification_dismiss" => {
            let id = arg_str(args, &["notificationId", "id"]).unwrap_or("");
            if id.is_empty() {
                return Ok(ToolResult::err_text("需要 notificationId"));
            }
            repo.dismiss_notification(id);
            Ok(ToolResult::ok_text("已关闭通知"))
        }
        "notification_snooze" => {
            let id = arg_str(args, &["notificationId", "id"]).unwrap_or("");
            if id.is_empty() {
                return Ok(ToolResult::err_text("需要 notificationId"));
            }
            let minutes = args.get("minutes").and_then(|v| v.as_i64()).unwrap_or(10);
            repo.snooze_notification(id, now_ms() + minutes * 60_000);
            Ok(ToolResult::ok_text(format!("已推迟通知 {minutes} 分钟")))
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
            Ok(ToolResult::ok_text(if lines.is_empty() {
                "（无定时任务）".into()
            } else {
                lines.join("\n")
            }))
        }
        "schedule_view" => {
            let id = args
                .get("scheduleId")
                .or_else(|| args.get("id"))
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 scheduleId"))?;
            match repo.get_timed_task(id) {
                Some(t) => Ok(ToolResult::ok_text(format!(
                    "id: {}\ntitle: {}\nenabled: {}\ncommand: {}\nnext_run_at: {:?}\nlast_run_at: {:?}\nschedule: {}",
                    t.id,
                    t.title,
                    t.enabled,
                    t.command,
                    t.next_run_at,
                    t.last_run_at,
                    t.schedule
                        .as_ref()
                        .map(|s| format!("{s:?}"))
                        .unwrap_or_else(|| "（无）".into())
                ))),
                None => Ok(ToolResult::err_text("定时任务不存在")),
            }
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
        "schedule_edit" => {
            let id = args
                .get("scheduleId")
                .or_else(|| args.get("id"))
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 scheduleId"))?;
            let action = args
                .get("action")
                .and_then(|v| v.as_str())
                .unwrap_or("update")
                .to_lowercase();
            if action == "delete" {
                if repo.get_timed_task(id).is_none() {
                    return Ok(ToolResult::err_text("定时任务不存在"));
                }
                repo.delete_timed_task(id);
                return Ok(ToolResult::ok_text(format!("已删除定时任务 {id}")));
            }
            let Some(mut task) = repo.get_timed_task(id).cloned() else {
                return Ok(ToolResult::err_text("定时任务不存在"));
            };
            if let Some(title) = args.get("title").and_then(|v| v.as_str()) {
                if !title.trim().is_empty() {
                    task.title = title.trim().to_string();
                }
            }
            if let Some(command) = args.get("command").and_then(|v| v.as_str()) {
                task.command = command.to_string();
            }
            if let Some(enabled) = args.get("enabled").and_then(|v| v.as_bool()) {
                task.enabled = enabled;
            }
            task.updated_at = now_ms();
            let title = task.title.clone();
            repo.upsert_timed_task(task);
            Ok(ToolResult::ok_text(format!("已更新定时任务：{title}")))
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
        "timer_start" => match start_tool_timer(repo, args) {
            Ok(text) => Ok(ToolResult::ok_text(text)),
            Err(msg) => Ok(ToolResult::err_text(msg)),
        },
        "timer_stop" => match stop_tool_timer(repo) {
            Ok(text) => Ok(ToolResult::ok_text(text)),
            Err(msg) => Ok(ToolResult::err_text(msg)),
        },
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
        "search" => {
            let q = args
                .get("query")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_lowercase();
            if q.is_empty() {
                return Ok(ToolResult::err_text("缺少 query"));
            }
            let mut hits = Vec::new();
            for t in repo.list_tasks() {
                if t.title.to_lowercase().contains(&q) || t.notes.to_lowercase().contains(&q) {
                    hits.push(format!(
                        "task · {} · {}{}",
                        t.id,
                        t.title,
                        if t.is_done { " [done]" } else { "" }
                    ));
                }
            }
            for n in repo.list_notes() {
                if n.title.to_lowercase().contains(&q) || n.body_md.to_lowercase().contains(&q) {
                    hits.push(format!("note · {} · {}", n.id, n.title));
                }
            }
            for p in repo.list_projects() {
                if p.title.to_lowercase().contains(&q) {
                    hits.push(format!("project · {} · {}", p.id, p.title));
                }
            }
            for t in repo.list_tags() {
                if t.title.to_lowercase().contains(&q) {
                    hits.push(format!("tag · {} · {}", t.id, t.title));
                }
            }
            hits.truncate(40);
            Ok(ToolResult::ok_text(if hits.is_empty() {
                "（无匹配）".into()
            } else {
                hits.join("\n")
            }))
        }
        "settings_get" => {
            let key = args
                .get("key")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            let prefs = load_prefs().unwrap_or_default();
            let value = match key {
                "themeMode" => Some(
                    match prefs.theme_mode {
                        wb_domain::ThemeModePref::Light => "light",
                        wb_domain::ThemeModePref::Dark => "dark",
                        wb_domain::ThemeModePref::System => "system",
                    }
                    .into(),
                ),
                "systemNotifications" => Some(prefs.system_notifications.to_string()),
                "httpProxy" => Some(prefs.http_proxy.clone().unwrap_or_default()),
                "defaultModelRef" => Some(
                    prefs
                        .agent
                        .default_model_ref
                        .clone()
                        .unwrap_or_else(|| wb_domain::BUILTIN_MODEL_REF.to_string()),
                ),
                "personality" => Some(prefs.agent.personality.clone().unwrap_or_default()),
                "skillsDirs" => Some(prefs.agent.skills_dirs.join(";")),
                "pluginsDirs" => Some(prefs.agent.plugins_dirs.join(";")),
                "" => None,
                other => {
                    return Ok(ToolResult::err_text(format!(
                        "不支持的设置键：{other}（白名单：themeMode/systemNotifications/httpProxy/defaultModelRef/personality/skillsDirs/pluginsDirs）"
                    )));
                }
            };
            match value {
                Some(v) => Ok(ToolResult::ok_text(format!("{key} = {v}"))),
                None => Ok(ToolResult::err_text("缺少 key")),
            }
        }
        "settings_set" | "settings_patch" => {
            let key = args
                .get("key")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            let raw = args.get("value").cloned().unwrap_or(Value::Null);
            let as_str = || {
                raw.as_str()
                    .map(|s| s.to_string())
                    .or_else(|| {
                        if raw.is_null() {
                            Some(String::new())
                        } else {
                            Some(raw.to_string().trim_matches('"').to_string())
                        }
                    })
                    .unwrap_or_default()
            };
            let split_dirs = |s: &str| -> Vec<String> {
                s.split([';', ','])
                    .map(str::trim)
                    .filter(|x| !x.is_empty())
                    .map(|x| x.to_string())
                    .collect()
            };
            if key.is_empty() {
                return Ok(ToolResult::err_text("缺少 key"));
            }
            let result = update_prefs(|prefs| {
                match key {
                    "themeMode" => {
                        let Some(mode) = wb_domain::ThemeModePref::parse(&as_str()) else {
                            return Ok(ToolResult::err_text("themeMode 仅支持 light/dark/system"));
                        };
                        prefs.theme_mode = mode;
                    }
                    "systemNotifications" => {
                        let on = raw.as_bool().unwrap_or_else(|| {
                            matches!(
                                as_str().to_lowercase().as_str(),
                                "1" | "true" | "yes" | "on"
                            )
                        });
                        prefs.system_notifications = on;
                    }
                    "httpProxy" => {
                        let v = as_str();
                        prefs.http_proxy = if v.trim().is_empty() {
                            None
                        } else {
                            Some(v.trim().to_string())
                        };
                    }
                    "defaultModelRef" => {
                        let v = as_str();
                        prefs.agent.default_model_ref = if v.trim().is_empty() {
                            None
                        } else {
                            Some(v.trim().to_string())
                        };
                    }
                    "personality" => {
                        let v = as_str();
                        prefs.agent.personality = if v.trim().is_empty() {
                            None
                        } else {
                            Some(v.trim().to_string())
                        };
                    }
                    "skillsDirs" => {
                        prefs.agent.skills_dirs = split_dirs(&as_str());
                        let kept = prefs.agent.skills_dirs.clone();
                        prefs
                            .agent
                            .disabled_skill_dirs
                            .retain(|dir| kept.iter().any(|kept_dir| paths_equal(kept_dir, dir)));
                        prefs
                            .agent
                            .disabled_skills
                            .retain(|path| kept.iter().any(|dir| path_is_within(path, dir)));
                    }
                    "pluginsDirs" => prefs.agent.plugins_dirs = split_dirs(&as_str()),
                    other => {
                        return Ok(ToolResult::err_text(format!(
                            "不支持写入：{other}（白名单同上）"
                        )));
                    }
                }
                Ok(ToolResult::ok_text(format!("已更新 {key}")))
            })?;
            Ok(result)
        }
        "host_tool_list" => {
            let lines: Vec<_> = all_tools()
                .into_iter()
                .map(|t| {
                    format!(
                        "- {} [{}]",
                        t.name,
                        format!("{:?}", t.effect).to_lowercase()
                    )
                })
                .collect();
            Ok(ToolResult::ok_text(lines.join("\n")))
        }
        "host_tool_run" => match run_host_tool(args, workspace_root) {
            Ok(text) => Ok(ToolResult::ok_text(text)),
            Err(msg) => Ok(ToolResult::err_text(msg)),
        },
        "hook_list" => {
            let prefs = load_prefs().unwrap_or_default();
            let lines: Vec<_> = prefs
                .agent
                .hooks
                .iter()
                .filter(|h| h.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true))
                .map(|h| {
                    let event = h.get("event").and_then(|v| v.as_str()).unwrap_or("event");
                    let title = h.get("title").and_then(|v| v.as_str()).unwrap_or("");
                    format!("- {event} · {title}")
                })
                .collect();
            Ok(ToolResult::ok_text(if lines.is_empty() {
                "还没有钩子".into()
            } else {
                format!("有 {} 个钩子\n{}", lines.len(), lines.join("\n"))
            }))
        }
        "session_set_model" => {
            let model_ref = arg_str(args, &["modelRef", "model"]).unwrap_or("");
            if model_ref.is_empty()
                || (!model_ref.contains('/') && !model_ref.starts_with("builtin:"))
            {
                return Ok(ToolResult::err_text(
                    "模型引用无效（形如 providerId/modelId 或 builtin:…）",
                ));
            }
            let thread_id = arg_str(args, &["threadId", "id"]).unwrap_or("");
            if thread_id.is_empty() {
                return Ok(ToolResult::err_text("缺少 threadId"));
            }
            let Some(mut thread) = repo
                .list_agent_threads()
                .into_iter()
                .find(|t| t.id == thread_id)
            else {
                return Ok(ToolResult::err_text("会话不存在"));
            };
            thread.model_ref = model_ref.to_string();
            thread.updated_at = now_ms();
            repo.upsert_agent_thread(thread);
            Ok(ToolResult::ok_text(format!("已切换模型 {model_ref}")))
        }
        "subagent_list" => {
            let prefs = load_prefs().unwrap_or_default();
            let lines: Vec<_> = prefs
                .agent
                .subagents
                .iter()
                .map(|s| {
                    let name = s.get("name").and_then(|v| v.as_str()).unwrap_or("?");
                    let desc = s.get("description").and_then(|v| v.as_str()).unwrap_or("");
                    format!("- `{name}` {desc}")
                })
                .collect();
            Ok(ToolResult::ok_text(if lines.is_empty() {
                "还没有子智能体。可在 prefs.agent.subagents 添加，或由插件注册。".into()
            } else {
                lines.join("\n")
            }))
        }
        "subagent" => match spawn_subagent(repo, args) {
            Ok(text) => Ok(ToolResult::ok_text(text)),
            Err(msg) => Ok(ToolResult::err_text(msg)),
        },
        "list_agents" => {
            let thread_id = arg_str(args, &["threadId"]).unwrap_or("");
            if thread_id.is_empty() {
                return Ok(ToolResult::err_text("缺少 threadId"));
            }
            let descendants = arg_str(args, &["scope"]).is_some_and(|s| s == "descendants");
            let agents = list_managed_agents(thread_id, descendants);
            if agents.is_empty() {
                return Ok(ToolResult::ok_text("没有托管子智能体"));
            }
            let lines: Vec<_> = agents
                .into_iter()
                .map(|a| {
                    format!(
                        "- {} [{}] {} depth={} inbox={}",
                        a.id,
                        a.name,
                        a.status.as_str(),
                        a.depth,
                        a.inbox
                    )
                })
                .collect();
            Ok(ToolResult::ok_text(format!(
                "有 {} 个托管子智能体\n{}",
                lines.len(),
                lines.join("\n")
            )))
        }
        "send_message" => {
            let parent = arg_str(args, &["threadId"]).unwrap_or("");
            let agent_id = arg_str(args, &["agent_id", "agentId", "id"]).unwrap_or("");
            let message = arg_str(args, &["message", "text"]).unwrap_or("");
            match send_managed_agent_message(agent_id, parent, message) {
                Ok(view) => {
                    let drained = take_managed_agent_inbox(agent_id);
                    if let Some(thread) = repo
                        .list_agent_threads()
                        .into_iter()
                        .find(|t| t.id == agent_id)
                    {
                        let proxy = load_prefs()
                            .ok()
                            .and_then(|p| p.http_proxy)
                            .filter(|s| !s.trim().is_empty());
                        for text in &drained {
                            let now = now_ms();
                            repo.upsert_agent_message(AgentMessage {
                                id: create_id(now),
                                thread_id: thread.id.clone(),
                                role: AgentRole::User,
                                content: text.clone(),
                                tool_name: None,
                                tool_call_id: None,
                                tool_calls_json: None,
                                created_at: now,
                            });
                            match resume_thread_turn_blocking(repo, &thread, proxy.as_deref()) {
                                Ok(out) => {
                                    let _ = finish_managed_agent(agent_id, &out.assistant.content);
                                }
                                Err(e) => {
                                    let reply = format!("子智能体续写失败：{e}");
                                    let now = now_ms();
                                    repo.upsert_agent_message(AgentMessage {
                                        id: create_id(now),
                                        thread_id: thread.id.clone(),
                                        role: AgentRole::Assistant,
                                        content: reply.clone(),
                                        tool_name: None,
                                        tool_call_id: None,
                                        tool_calls_json: None,
                                        created_at: now,
                                    });
                                    let _ = finish_managed_agent(agent_id, &reply);
                                }
                            }
                        }
                    }
                    Ok(ToolResult::ok_text(format!(
                        "已向 {} 投递消息（status={}）",
                        view.id,
                        view.status.as_str()
                    )))
                }
                Err(e) => Ok(ToolResult::err_text(e)),
            }
        }
        "interrupt_agent" => {
            let parent = arg_str(args, &["threadId"]).unwrap_or("");
            let agent_id = arg_str(args, &["agent_id", "agentId", "id"]).unwrap_or("");
            match interrupt_managed_agent(agent_id, parent) {
                Ok(view) => Ok(ToolResult::ok_text(format!(
                    "已请求中断 {}（{}）",
                    view.id,
                    view.status.as_str()
                ))),
                Err(e) => Ok(ToolResult::err_text(e)),
            }
        }
        "session_search" => {
            let q = args
                .get("query")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_lowercase();
            if q.is_empty() {
                return Ok(ToolResult::err_text("缺少 query"));
            }
            let thread_id = args.get("threadId").and_then(|v| v.as_str());
            let mut hits = Vec::new();
            for m in repo.list_agent_messages() {
                if let Some(tid) = thread_id {
                    if m.thread_id != tid {
                        continue;
                    }
                }
                if m.content.to_lowercase().contains(&q) {
                    let snippet: String = m.content.chars().take(120).collect();
                    hits.push(format!(
                        "- [{}] {} · {}…",
                        format!("{:?}", m.role).to_lowercase(),
                        m.thread_id,
                        snippet.replace('\n', " ")
                    ));
                }
                if hits.len() >= 40 {
                    break;
                }
            }
            Ok(ToolResult::ok_text(if hits.is_empty() {
                "（无匹配消息）".into()
            } else {
                hits.join("\n")
            }))
        }
        "session_trace" => {
            let thread_id = args
                .get("threadId")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| repo.list_agent_threads().into_iter().next().map(|t| t.id));
            let Some(tid) = thread_id else {
                return Ok(ToolResult::ok_text("（无会话）"));
            };
            let limit = args
                .get("limit")
                .and_then(|v| v.as_u64())
                .unwrap_or(12)
                .clamp(1, 40) as usize;
            let msgs = repo.messages_for_thread(&tid);
            let start = msgs.len().saturating_sub(limit);
            let lines: Vec<_> = msgs[start..]
                .iter()
                .map(|m| {
                    let snippet: String = m.content.chars().take(100).collect();
                    format!(
                        "- [{}] {}",
                        format!("{:?}", m.role).to_lowercase(),
                        snippet.replace('\n', " ")
                    )
                })
                .collect();
            let body = if lines.is_empty() {
                "（无消息）".to_string()
            } else {
                lines.join("\n")
            };
            Ok(ToolResult::ok_text(format!(
                "会话 {tid} 近 {} 条：\n{body}",
                lines.len()
            )))
        }
        "session_event_search" => {
            let q = args
                .get("query")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_lowercase();
            if q.is_empty() {
                return Ok(ToolResult::err_text("缺少 query"));
            }
            let tid = resolve_thread_id(repo, args);
            let Some(tid) = tid else {
                return Ok(ToolResult::ok_text("（无会话）"));
            };
            let before_last_user = args
                .get("beforeLastUser")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let events = thread_events(repo, &tid, before_last_user);
            let mut hits = Vec::new();
            for (seq, m) in events {
                if m.content.to_lowercase().contains(&q)
                    || m.tool_name
                        .as_deref()
                        .is_some_and(|n| n.to_lowercase().contains(&q))
                {
                    let snippet: String = m.content.chars().take(100).collect();
                    hits.push(format!(
                        "#{seq} [{}] {}",
                        format!("{:?}", m.role).to_lowercase(),
                        snippet.replace('\n', " ")
                    ));
                }
                if hits.len() >= 40 {
                    break;
                }
            }
            Ok(ToolResult::ok_text(if hits.is_empty() {
                "（无匹配事件）".into()
            } else {
                hits.join("\n")
            }))
        }
        "session_event_read" => {
            let tid = resolve_thread_id(repo, args);
            let Some(tid) = tid else {
                return Ok(ToolResult::ok_text("（无会话）"));
            };
            let seq = args.get("seq").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
            if seq == 0 {
                return Ok(ToolResult::err_text("缺少 seq（从 1 起）"));
            }
            let neighbors = args
                .get("neighbors")
                .and_then(|v| v.as_u64())
                .unwrap_or(0)
                .clamp(0, 5) as usize;
            let events = thread_events(repo, &tid, false);
            let Some((_, target)) = events.iter().find(|(s, _)| *s == seq) else {
                return Ok(ToolResult::err_text(format!(
                    "seq={seq} 不存在（共 {} 条）",
                    events.len()
                )));
            };
            let mut lines = vec![format_event(seq, target)];
            if neighbors > 0 {
                let start = seq.saturating_sub(neighbors).max(1);
                let end = (seq + neighbors).min(events.len());
                for (s, m) in &events {
                    if *s >= start && *s <= end && *s != seq {
                        lines.push(format_event(*s, m));
                    }
                }
                lines.sort_by(|a, b| {
                    let sa = a
                        .strip_prefix('#')
                        .and_then(|x| x.split_whitespace().next());
                    let sb = b
                        .strip_prefix('#')
                        .and_then(|x| x.split_whitespace().next());
                    sa.cmp(&sb)
                });
            }
            Ok(ToolResult::ok_text(lines.join("\n\n")))
        }
        "session_event_trace" => {
            let tid = resolve_thread_id(repo, args);
            let Some(tid) = tid else {
                return Ok(ToolResult::ok_text("（无会话）"));
            };
            let events = thread_events(repo, &tid, false);
            if events.is_empty() {
                return Ok(ToolResult::ok_text("（无事件）"));
            }
            let seq = args
                .get("seq")
                .and_then(|v| v.as_u64())
                .map(|n| n as usize)
                .unwrap_or_else(|| events.last().map(|(s, _)| *s).unwrap_or(1));
            let window = args
                .get("window")
                .and_then(|v| v.as_u64())
                .unwrap_or(2)
                .clamp(1, 8) as usize;
            let Some((_, center)) = events.iter().find(|(s, _)| *s == seq) else {
                return Ok(ToolResult::err_text(format!("seq={seq} 不存在")));
            };
            let start = seq.saturating_sub(window).max(1);
            let end = (seq + window).min(events.len());
            let mut lines: Vec<_> = events
                .iter()
                .filter(|(s, _)| *s >= start && *s <= end)
                .map(|(s, m)| format_event(*s, m))
                .collect();
            if let Some(ref call_id) = center.tool_call_id {
                let related: Vec<_> = events
                    .iter()
                    .filter(|(s, m)| {
                        *s != seq
                            && (m.tool_call_id.as_deref() == Some(call_id.as_str())
                                || m.content.contains(call_id.as_str()))
                    })
                    .map(|(s, m)| format_event(*s, m))
                    .collect();
                if !related.is_empty() {
                    lines.push("--- 同 toolCallId ---".into());
                    lines.extend(related);
                }
            }
            Ok(ToolResult::ok_text(lines.join("\n\n")))
        }
        "get_goal" => match get_goal() {
            Some(g) => Ok(ToolResult::ok_text(format!(
                "goal [{}] rounds={}/{:?} blockedAfter={} · {}",
                g.status, g.rounds_started, g.max_rounds, g.blocked_after, g.objective
            ))),
            None => Ok(ToolResult::ok_text("（无 goal）")),
        },
        "create_goal" => {
            let objective = args
                .get("objective")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            if objective.is_empty() {
                return Ok(ToolResult::err_text("缺少 objective"));
            }
            let max_rounds = args
                .get("maxRounds")
                .or_else(|| args.get("max_rounds"))
                .and_then(|v| v.as_u64())
                .map(|n| n as u32);
            let g = create_goal(objective, max_rounds);
            Ok(ToolResult::ok_text(format!(
                "已创建 goal · {}{}",
                g.objective,
                max_rounds
                    .map(|m| format!(" · maxRounds={m}"))
                    .unwrap_or_default()
            )))
        }
        "update_goal" => {
            let action = args
                .get("action")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            if action.is_empty() {
                return Ok(ToolResult::err_text("缺少 action"));
            }
            let objective = args.get("objective").and_then(|v| v.as_str());
            match update_goal(action, objective) {
                Ok(g) if g.status == "cleared" => Ok(ToolResult::ok_text("已清除 goal")),
                Ok(g) => Ok(ToolResult::ok_text(format!(
                    "goal [{}] rounds={} · {}",
                    g.status, g.rounds_started, g.objective
                ))),
                Err(e) => Ok(ToolResult::err_text(e)),
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
        "memory_add" | "memory_save" => {
            let text = args
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            if text.is_empty() {
                return Ok(ToolResult::err_text("记忆内容不能为空"));
            }
            update_prefs(|prefs| {
                if !prefs.agent.memories.iter().any(|m| m == text) {
                    prefs.agent.memories.push(text.to_string());
                }
                Ok(())
            })?;
            Ok(ToolResult::ok_text(format!("已记住：{text}")))
        }
        "memory_remove" | "memory_forget" => {
            let result = update_prefs(|prefs| {
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
                Ok(ToolResult::ok_text(format!(
                    "已删除 {} 条记忆",
                    before.saturating_sub(prefs.agent.memories.len())
                )))
            })?;
            Ok(result)
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
            let timed = args
                .get("mode")
                .and_then(|v| v.as_str())
                .is_some_and(|m| m.eq_ignore_ascii_case("timed"));
            let secs = args
                .get("timeout")
                .or_else(|| args.get("seconds"))
                .and_then(|v| v.as_u64())
                .unwrap_or(60)
                .clamp(5, 600);
            let body = if timed {
                format!("（{secs}s 超时后请自行继续）{question}")
            } else {
                question.to_string()
            };
            repo.push_notification(NotificationKind::System, "Agent 提问", &body, None);
            if timed {
                Ok(ToolResult::ok_text(format!(
                    "已向用户提问（通知中心，约 {secs}s 超时）：{question}\n若用户未及时回复，请按合理默认继续。"
                )))
            } else {
                Ok(ToolResult::ok_text(format!(
                    "已向用户提问（见通知中心）：{question}"
                )))
            }
        }
        "read" => {
            let rel = args
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 path"))?;
            let root = effective_root(workspace_root)?;
            let path = safe_join(&root, rel)?;
            let text = read_text(&path)?;
            observe_path(&path);
            Ok(ToolResult::ok_text(text))
        }
        "write" => {
            let rel = args
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 path"))?;
            let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("");
            let root = effective_root(workspace_root)?;
            let path = safe_join(&root, rel)?;
            if let Err(msg) = require_observed_for_existing(&path) {
                return Ok(ToolResult::err_text(msg));
            }
            write_text(&path, content)?;
            observe_path(&path);
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
            let root = effective_root(workspace_root)?;
            let path = safe_join(&root, rel)?;
            if let Err(msg) = require_observed_for_existing(&path) {
                return Ok(ToolResult::err_text(msg));
            }
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
            observe_path(&path);
            Ok(ToolResult::ok_text(format!(
                "已替换 {rel}（{} 处）",
                if replace_all { count } else { 1 }
            )))
        }
        "apply_patch" => {
            let patch = args
                .get("patch")
                .or_else(|| args.get("input"))
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 patch"))?;
            let root = effective_root(workspace_root)?;
            let actions = parse_apply_patch(patch).map_err(|e| anyhow::anyhow!("{e}"))?;
            let mut summary = Vec::new();
            for action in actions {
                match action {
                    PatchAction::Add { path: rel, content } => {
                        let path = safe_join(&root, &rel)?;
                        if let Some(parent) = path.parent() {
                            std::fs::create_dir_all(parent)?;
                        }
                        write_text(&path, &content)?;
                        observe_path(&path);
                        summary.push(format!("+ {rel}"));
                    }
                    PatchAction::Delete { path: rel } => {
                        let path = safe_join(&root, &rel)?;
                        if let Err(msg) = require_observed_for_existing(&path) {
                            return Ok(ToolResult::err_text(msg));
                        }
                        if path.exists() {
                            std::fs::remove_file(&path)?;
                            summary.push(format!("- {rel}"));
                        } else {
                            summary.push(format!("- {rel}（不存在，跳过）"));
                        }
                    }
                    PatchAction::Update { path: rel, hunks } => {
                        let path = safe_join(&root, &rel)?;
                        if let Err(msg) = require_observed_for_existing(&path) {
                            return Ok(ToolResult::err_text(msg));
                        }
                        let text = read_text(&path)?;
                        let next =
                            apply_hunks(&text, &hunks).map_err(|e| anyhow::anyhow!("{e}"))?;
                        write_text(&path, &next)?;
                        observe_path(&path);
                        summary.push(format!("~ {rel}（{} hunk）", hunks.len()));
                    }
                }
            }
            Ok(ToolResult::ok_text(format!(
                "已应用补丁：\n{}",
                summary.join("\n")
            )))
        }
        "str_replace_editor" => {
            let command = args
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_lowercase();
            let rel = args
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 path"))?;
            let root = effective_root(workspace_root)?;
            let path = safe_join(&root, rel)?;
            match command.as_str() {
                "view" => {
                    let text = read_text(&path)?;
                    observe_path(&path);
                    let numbered = number_lines(&text, args.get("view_range"));
                    Ok(ToolResult::ok_text(numbered))
                }
                "create" => {
                    let content = args
                        .get("file_text")
                        .or_else(|| args.get("fileText"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    if path.exists() {
                        if let Err(msg) = require_observed_for_existing(&path) {
                            return Ok(ToolResult::err_text(msg));
                        }
                    }
                    if let Some(parent) = path.parent() {
                        std::fs::create_dir_all(parent)?;
                    }
                    write_text(&path, content)?;
                    observe_path(&path);
                    Ok(ToolResult::ok_text(format!("已创建 {rel}")))
                }
                "str_replace" => {
                    if let Err(msg) = require_observed_for_existing(&path) {
                        return Ok(ToolResult::err_text(msg));
                    }
                    let old = args
                        .get("old_str")
                        .or_else(|| args.get("oldStr"))
                        .or_else(|| args.get("oldString"))
                        .and_then(|v| v.as_str())
                        .ok_or_else(|| anyhow::anyhow!("缺少 old_str"))?;
                    let new = args
                        .get("new_str")
                        .or_else(|| args.get("newStr"))
                        .or_else(|| args.get("newString"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let text = read_text(&path)?;
                    let count = text.matches(old).count();
                    if count == 0 {
                        return Ok(ToolResult::err_text("未找到 old_str"));
                    }
                    if count > 1 {
                        return Ok(ToolResult::err_text(format!(
                            "old_str 出现 {count} 次，请收窄"
                        )));
                    }
                    write_text(&path, &text.replacen(old, new, 1))?;
                    observe_path(&path);
                    Ok(ToolResult::ok_text(format!("已替换 {rel}")))
                }
                "insert" => {
                    if let Err(msg) = require_observed_for_existing(&path) {
                        return Ok(ToolResult::err_text(msg));
                    }
                    let insert_line = args
                        .get("insert_line")
                        .or_else(|| args.get("insertLine"))
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0) as usize;
                    let new = args
                        .get("new_str")
                        .or_else(|| args.get("newStr"))
                        .or_else(|| args.get("file_text"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let text = read_text(&path)?;
                    let mut lines: Vec<&str> = text.lines().collect();
                    let at = insert_line.min(lines.len());
                    lines.insert(at, new);
                    let mut out = lines.join("\n");
                    if text.ends_with('\n') {
                        out.push('\n');
                    }
                    write_text(&path, &out)?;
                    observe_path(&path);
                    Ok(ToolResult::ok_text(format!("已在 {rel} 第 {at} 行后插入")))
                }
                other => Ok(ToolResult::err_text(format!(
                    "未知 command：{other}（view/create/str_replace/insert）"
                ))),
            }
        }
        "shell" => {
            let command = args
                .get("command")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 command"))?;
            let root = effective_root(workspace_root).ok();
            let result = run_shell_in(command, root.as_deref(), workspace_root, 120)?;
            let raw = format!("exit {}\n{}\n{}", result.code, result.stdout, result.stderr);
            let content = maybe_spill(root.as_deref().map(Path::new), "shell", raw);
            Ok(ToolResult {
                ok: result.code == 0,
                content,
                open_view: None,
            })
        }
        "bash" | "pwsh" => {
            let command = args
                .get("command")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 command"))?;
            let root = effective_root(workspace_root).ok();
            let kind = if name == "bash" { "bash" } else { "pwsh" };
            let result = match run_shell_kind(kind, command, root.as_deref(), workspace_root, 120) {
                Ok(r) => r,
                Err(e) => {
                    return Ok(ToolResult::err_text(format!(
                        "{kind} 不可用或执行失败：{e}"
                    )));
                }
            };
            let raw = format!("exit {}\n{}\n{}", result.code, result.stdout, result.stderr);
            let content = maybe_spill(root.as_deref().map(Path::new), kind, raw);
            Ok(ToolResult {
                ok: result.code == 0,
                content,
                open_view: None,
            })
        }
        "load_workspace_dependencies" => {
            let lines: Vec<_> = probe_workspace_dependencies()
                .into_iter()
                .map(|(name, path)| match path {
                    Some(p) => format!("- {name}: {p}"),
                    None => format!("- {name}: （未找到）"),
                })
                .collect();
            Ok(ToolResult::ok_text(lines.join("\n")))
        }
        "read_image" => {
            let rel = args
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 path"))?;
            let root = effective_root(workspace_root)?;
            let path = safe_join(&root, rel)?;
            let info = read_image_info(&path)?;
            observe_path(&path);
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
        "ocr" => {
            let rel = args
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 path"))?;
            let root = effective_root(workspace_root)?;
            let path = safe_join(&root, rel)?;
            observe_path(&path);
            let text = wb_host::ocr_image(&path).map_err(|e| anyhow::anyhow!("{e}"))?;
            Ok(ToolResult::ok_text(text))
        }
        "speech_transcribe" => {
            let rel = args
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 path"))?;
            let lang = args.get("language").and_then(|v| v.as_str());
            let root = effective_root(workspace_root)?;
            let path = safe_join(&root, rel)?;
            observe_path(&path);
            let engine = load_prefs()
                .ok()
                .and_then(|p| p.voice.engine)
                .unwrap_or_else(|| "sensevoice".into());
            let text = wb_host::speech_transcribe(&engine, &path.to_string_lossy(), lang)
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            Ok(ToolResult::ok_text(text))
        }
        "job_start" => {
            let command = args
                .get("command")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 command"))?;
            let root = effective_root(workspace_root).ok();
            let id = global_jobs().start(command, root.as_deref(), workspace_root)?;
            Ok(ToolResult::ok_text(format!("已启动后台任务 {id}")))
        }
        "job_output" => {
            let id = args
                .get("jobId")
                .or_else(|| args.get("id"))
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 jobId"))?;
            match global_jobs().output(id) {
                Some((out, code)) => {
                    let root = effective_root(workspace_root).ok();
                    let body = maybe_spill(root.as_deref().map(Path::new), "job", out);
                    Ok(ToolResult::ok_text(format!("code={code:?}\n{body}")))
                }
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
            let root = effective_root(workspace_root).ok();
            let raw = format!(
                "HTTP {} · {}\n{}",
                result.status,
                result.content_type.unwrap_or_else(|| "unknown".into()),
                body
            );
            let content = maybe_spill(root.as_deref().map(Path::new), "web_fetch", raw);
            Ok(ToolResult {
                ok: result.status < 400,
                content,
                open_view: None,
            })
        }
        "web_search" => {
            let query = args
                .get("query")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            if query.is_empty() {
                return Ok(ToolResult::err_text("缺少 query"));
            }
            let limit = args
                .get("limit")
                .and_then(|v| v.as_u64())
                .unwrap_or(5)
                .clamp(1, 10) as usize;
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?;
            let hits = rt.block_on(web_search(query, None, limit))?;
            let lines: Vec<_> = hits
                .into_iter()
                .enumerate()
                .map(|(i, h)| format!("{}. {} · {}\n   {}", i + 1, h.title, h.url, h.snippet))
                .collect();
            Ok(ToolResult::ok_text(if lines.is_empty() {
                "（无搜索结果；网络或页面结构可能变化）".into()
            } else {
                lines.join("\n")
            }))
        }
        "present" => {
            let rel = args
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 path"))?;
            let root = effective_root(workspace_root)?;
            let path = if Path::new(rel).is_absolute() {
                if !rel.starts_with(root.as_str()) {
                    return Ok(ToolResult::err_text("路径必须在工作区内"));
                }
                Path::new(rel).to_path_buf()
            } else {
                safe_join(&root, rel)?
            };
            let reveal = args.get("reveal").and_then(|v| v.as_bool()).unwrap_or(true);
            present_path(&path, reveal)?;
            Ok(ToolResult::ok_text(format!(
                "已打开{}：{}",
                if reveal { "并选中" } else { "" },
                path.display()
            )))
        }
        "office_to_pdf" => match office_to_pdf(args, workspace_root) {
            Ok(text) => Ok(ToolResult::ok_text(text)),
            Err(msg) => Ok(ToolResult::err_text(msg)),
        },
        "glob" => {
            let pattern = args
                .get("pattern")
                .and_then(|v| v.as_str())
                .unwrap_or("*")
                .to_lowercase();
            let root = effective_root(workspace_root)?;
            let entries = list_files_recursive(Path::new(&root), 500)?;
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
            let root = effective_root(workspace_root)?;
            let base = if sub.is_empty() {
                Path::new(&root).to_path_buf()
            } else {
                safe_join(&root, sub)?
            };
            const INLINE_LIMIT: usize = 250;
            const CAPTURE_LIMIT: usize = 2000;
            let entries = list_files_recursive(&base, 500)?;
            let mut hits = Vec::new();
            'outer: for e in entries {
                if e.is_dir {
                    continue;
                }
                let Ok(text) = read_text(Path::new(&e.path)) else {
                    continue;
                };
                for (i, line) in text.lines().enumerate() {
                    if line.contains(pattern) {
                        hits.push(format!("{}:{}:{}", e.relative, i + 1, line.trim()));
                        if hits.len() >= CAPTURE_LIMIT {
                            break 'outer;
                        }
                    }
                }
            }
            if hits.is_empty() {
                return Ok(ToolResult::ok_text("（无匹配）"));
            }
            if hits.len() <= INLINE_LIMIT {
                return Ok(ToolResult::ok_text(hits.join("\n")));
            }
            let _ = cleanup_tool_spill(Path::new(&root));
            let msg = maybe_spill(Some(Path::new(&root)), "grep", hits.join("\n"));
            Ok(ToolResult::ok_text(msg))
        }
        "skill_list" => {
            let prefs = load_prefs().unwrap_or_default();
            let skills = active_skills(&prefs.agent);
            let lines: Vec<_> = skills
                .into_iter()
                .map(|s| format!("- {} · {} ({})", s.name, s.summary, s.path))
                .collect();
            Ok(ToolResult::ok_text(if lines.is_empty() {
                "（无已启用技能；请在设置 → 技能中添加技能目录）".into()
            } else {
                lines.join("\n")
            }))
        }
        "skill_load" => {
            let name = args
                .get("name")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 name"))?;
            let prefs = load_prefs().unwrap_or_default();
            let enabled = active_skills(&prefs.agent)
                .iter()
                .any(|skill| skill.name.eq_ignore_ascii_case(name));
            if !enabled {
                let known = list_skills(&prefs.agent.skills_dirs)
                    .iter()
                    .any(|skill| skill.name.eq_ignore_ascii_case(name));
                return Ok(ToolResult::err_text(if known {
                    format!("技能已停用：{name}")
                } else {
                    format!("未找到技能：{name}")
                }));
            }
            let text = load_skill(&prefs.agent.skills_dirs, name)?;
            Ok(ToolResult::ok_text(text))
        }
        "plugin_list" => {
            let prefs = load_prefs().unwrap_or_default();
            let plugins = list_plugins(&prefs.agent.plugins_dirs);
            let lines: Vec<_> = plugins
                .into_iter()
                .map(|p| format!("- {} ({})", p.name, p.path))
                .collect();
            Ok(ToolResult::ok_text(if lines.is_empty() {
                "（无插件；请在设置中配置 pluginsDirs）".into()
            } else {
                lines.join("\n")
            }))
        }
        "mcp_list" => {
            let prefs = load_prefs().unwrap_or_default();
            let lines: Vec<_> = prefs
                .agent
                .mcp_servers
                .iter()
                .enumerate()
                .map(|(i, v)| {
                    let name = v
                        .get("name")
                        .or_else(|| v.get("id"))
                        .and_then(|x| x.as_str())
                        .unwrap_or("mcp");
                    format!("{}. {} · {}", i + 1, name, v)
                })
                .collect();
            Ok(ToolResult::ok_text(if lines.is_empty() {
                "（未配置 MCP 服务器）".into()
            } else {
                lines.join("\n")
            }))
        }
        "mcp_add" => {
            let name = args
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            if name.is_empty() {
                return Ok(ToolResult::err_text("缺少 name"));
            }
            let mut entry = serde_json::Map::new();
            entry.insert("name".into(), Value::String(name.to_string()));
            if let Some(cmd) = args.get("command").and_then(|v| v.as_str()) {
                entry.insert("command".into(), Value::String(cmd.to_string()));
            }
            if let Some(url) = args.get("url").and_then(|v| v.as_str()) {
                entry.insert("url".into(), Value::String(url.to_string()));
            }
            if let Some(a) = args.get("args") {
                entry.insert("args".into(), a.clone());
            }
            let result = update_prefs(|prefs| {
                if prefs.agent.mcp_servers.iter().any(|v| {
                    v.get("name")
                        .or_else(|| v.get("id"))
                        .and_then(|x| x.as_str())
                        .is_some_and(|n| n.eq_ignore_ascii_case(name))
                }) {
                    return Ok(ToolResult::err_text(format!("已存在 MCP：{name}")));
                }
                prefs.agent.mcp_servers.push(Value::Object(entry));
                Ok(ToolResult::ok_text(format!(
                    "已添加 MCP 配置 {name}。可用 mcp_call（stdio command 或 HTTP url）"
                )))
            })?;
            Ok(result)
        }
        "mcp_call" => {
            let prefs = load_prefs().unwrap_or_default();
            let wanted = arg_str(args, &["name", "server"]).unwrap_or("");
            let server = prefs.agent.mcp_servers.iter().find(|v| {
                v.get("name")
                    .or_else(|| v.get("id"))
                    .and_then(|x| x.as_str())
                    .is_some_and(|n| wanted.is_empty() || n.eq_ignore_ascii_case(wanted))
            });
            let Some(server) = server else {
                return Ok(ToolResult::err_text("未找到 MCP 配置"));
            };
            let tool = arg_str(args, &["tool", "toolName"]);
            let arguments = args
                .get("arguments")
                .cloned()
                .unwrap_or(serde_json::json!({}));
            let url = server.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let command = server.get("command").and_then(|v| v.as_str()).unwrap_or("");
            if !url.is_empty() && command.is_empty() {
                return match mcp_http_call(url, tool, &arguments, Duration::from_secs(20)) {
                    Ok(text) => Ok(ToolResult::ok_text(text)),
                    Err(e) => Ok(ToolResult::err_text(e.to_string())),
                };
            }
            if command.is_empty() {
                return Ok(ToolResult::err_text(
                    "MCP 配置缺少 command（stdio）或 url（HTTP）",
                ));
            }
            let cmd_args: Vec<String> = server
                .get("args")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default();
            match mcp_stdio_call(
                command,
                &cmd_args,
                tool,
                &arguments,
                Duration::from_secs(20),
            ) {
                Ok(text) => Ok(ToolResult::ok_text(text)),
                Err(e) => Ok(ToolResult::err_text(e.to_string())),
            }
        }
        "mcp_remove" => {
            let result = update_prefs(|prefs| {
                let before = prefs.agent.mcp_servers.len();
                if let Some(idx) = args.get("index").and_then(|v| v.as_u64()) {
                    let i = idx as usize;
                    if i == 0 || i > prefs.agent.mcp_servers.len() {
                        return Ok(ToolResult::err_text("index 无效（从 1 起）"));
                    }
                    prefs.agent.mcp_servers.remove(i - 1);
                } else if let Some(name) = args.get("name").and_then(|v| v.as_str()) {
                    prefs.agent.mcp_servers.retain(|v| {
                        v.get("name")
                            .or_else(|| v.get("id"))
                            .and_then(|x| x.as_str())
                            .map(|n| !n.eq_ignore_ascii_case(name))
                            .unwrap_or(true)
                    });
                } else {
                    return Ok(ToolResult::err_text("需要 index 或 name"));
                }
                if prefs.agent.mcp_servers.len() == before {
                    return Ok(ToolResult::err_text("未找到要删除的 MCP"));
                }
                Ok(ToolResult::ok_text("已删除 MCP 配置"))
            })?;
            Ok(result)
        }
        "working_directory" => {
            let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
            if path.trim().is_empty() {
                let cur = resolve_agent_cwd(workspace_root)
                    .map(|p| p.display().to_string())
                    .unwrap_or_else(|| workspace_root.unwrap_or("（未设置）").to_string());
                return Ok(ToolResult::ok_text(format!("当前工作目录：{cur}")));
            }
            let ws = workspace_root.ok_or_else(|| anyhow::anyhow!("未绑定工作区"))?;
            let next = if Path::new(path).is_absolute() {
                if !path.starts_with(ws) {
                    return Ok(ToolResult::err_text("工作目录必须在工作区内"));
                }
                Path::new(path).to_path_buf()
            } else {
                safe_join(ws, path)?
            };
            set_agent_cwd(Some(next.clone()));
            Ok(ToolResult::ok_text(format!(
                "已设置工作目录：{}",
                next.display()
            )))
        }
        "terminal_open" => {
            let shell = args.get("shell").and_then(|v| v.as_str()).unwrap_or("");
            let cwd = resolve_agent_cwd(workspace_root);
            let id = global_terminals().open(shell, cwd.as_deref())?;
            Ok(ToolResult::ok_text(format!("已打开终端 {id}")))
        }
        "terminal_send" => {
            let id = args
                .get("terminalId")
                .or_else(|| args.get("id"))
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 terminalId"))?;
            let command = args
                .get("command")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 command"))?;
            let buf = global_terminals().send(id, command)?;
            let tail = if buf.len() > 8_000 {
                format!("…\n{}", &buf[buf.len() - 8_000..])
            } else {
                buf
            };
            Ok(ToolResult::ok_text(tail))
        }
        "terminal_read" => {
            let id = args
                .get("terminalId")
                .or_else(|| args.get("id"))
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 terminalId"))?;
            let buf = global_terminals().read(id)?;
            Ok(ToolResult::ok_text(buf))
        }
        "terminal_list" => {
            let lines: Vec<_> = global_terminals()
                .list()
                .into_iter()
                .map(|t| {
                    format!(
                        "- {} [{}] {} · {}",
                        t.id,
                        t.shell,
                        if t.closed { "closed" } else { "open" },
                        t.cwd
                    )
                })
                .collect();
            Ok(ToolResult::ok_text(if lines.is_empty() {
                "（无终端会话）".into()
            } else {
                lines.join("\n")
            }))
        }
        "terminal_close" => {
            let id = args
                .get("terminalId")
                .or_else(|| args.get("id"))
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 terminalId"))?;
            if global_terminals().close(id) {
                Ok(ToolResult::ok_text(format!("已关闭终端 {id}")))
            } else {
                Ok(ToolResult::err_text("终端不存在"))
            }
        }
        "terminal_signal" => {
            let id = args
                .get("terminalId")
                .or_else(|| args.get("id"))
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 terminalId"))?;
            let signal = args
                .get("signal")
                .and_then(|v| v.as_str())
                .unwrap_or("SIGINT");
            let msg = global_terminals().signal(id, signal)?;
            Ok(ToolResult::ok_text(msg))
        }
        other => Ok(ToolResult::err_text(format!("未知工具: {other}"))),
    }
}

fn arg_str<'a>(args: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|k| {
        args.get(*k)
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
    })
}

fn resolve_task(repo: &MemoryWorkbenchRepository, args: &Value) -> Result<Task, String> {
    if let Some(id) = arg_str(args, &["taskId", "id"]) {
        return repo
            .get_task(id)
            .cloned()
            .ok_or_else(|| format!("找不到任务 {id}"));
    }
    let title = arg_str(args, &["title"]).ok_or("需要 taskId 或 title")?;
    repo.list_tasks()
        .into_iter()
        .find(|t| t.title == title)
        .ok_or_else(|| format!("找不到任务「{title}」"))
}

fn resolve_note(repo: &MemoryWorkbenchRepository, args: &Value) -> Result<wb_domain::Note, String> {
    if let Some(id) = arg_str(args, &["noteId", "id"]) {
        return repo
            .get_note(id)
            .cloned()
            .ok_or_else(|| format!("找不到笔记 {id}"));
    }
    let title = arg_str(args, &["title"]).ok_or("需要 noteId 或 title")?;
    repo.list_notes()
        .into_iter()
        .find(|n| n.title == title)
        .ok_or_else(|| format!("找不到笔记「{title}」"))
}

fn format_task_detail(task: &Task) -> String {
    format!(
        "id: {}\ntitle: {}\nproject: {}\ndone: {}\ndueDay: {:?}\ndueWithTime: {:?}\ndeadlineDay: {:?}\nremindAt: {:?}\nnotes: {}",
        task.id,
        task.title,
        task.project_id,
        task.is_done,
        task.due_day,
        task.due_with_time,
        task.deadline_day,
        task.remind_at,
        task.notes
    )
}

fn parse_remind(raw: &str) -> Option<ReminderOptionId> {
    match raw.to_ascii_lowercase().as_str() {
        "none" | "off" | "不提醒" => Some(ReminderOptionId::None),
        "at_start" | "atstart" | "到点" | "到点提醒" => Some(ReminderOptionId::AtStart),
        "m5" | "5" | "5m" | "提前5分钟" | "提前 5 分钟" => Some(ReminderOptionId::M5),
        "m10" | "10" | "10m" | "提前10分钟" | "提前 10 分钟" => Some(ReminderOptionId::M10),
        "m15" | "15" | "15m" | "提前15分钟" | "提前 15 分钟" => Some(ReminderOptionId::M15),
        "m30" | "30" | "30m" => Some(ReminderOptionId::M30),
        "h1" | "60" | "1h" | "提前1小时" | "提前 1 小时" => Some(ReminderOptionId::H1),
        _ => None,
    }
}

fn apply_task_when(repo: &mut MemoryWorkbenchRepository, args: &Value) -> Result<String, String> {
    let task = resolve_task(repo, args)?;
    let due_ms = args.get("dueWithTime").and_then(|v| v.as_i64());
    let due_day = arg_str(args, &["dueDay"]);
    let deadline_ms = args.get("deadlineWithTime").and_then(|v| v.as_i64());
    let deadline_day = arg_str(args, &["deadlineDay"]);
    let remind = arg_str(args, &["remindOption"]).and_then(parse_remind);
    let mut timed = due_ms;
    if timed.is_none() {
        if let (Some(day), Some(opt)) = (due_day, remind) {
            if opt != ReminderOptionId::None {
                timed = at_local_time(day, 9, 0);
            }
        }
    }
    let mut patch = SchedulePatch::default();
    if let Some(ms) = timed {
        patch.due_with_time = Some(Some(ms));
    } else if let Some(day) = due_day {
        patch.due_day = Some(Some(day.to_string()));
    }
    if let Some(ms) = deadline_ms {
        patch.deadline_with_time = Some(Some(ms));
    } else if let Some(day) = deadline_day {
        patch.deadline_day = Some(Some(day.to_string()));
    }
    if let Some(opt) = remind {
        if opt == ReminderOptionId::None {
            patch.remind_at = Some(None);
        } else if let Some(ms) = timed {
            patch.remind_at = Some(shift_remind_at(ms, opt));
        } else if let Some(ms) = deadline_ms {
            patch.deadline_remind_at = Some(shift_remind_at(ms, opt));
        }
    }
    let Some(mut next) = repo.get_task(&task.id).cloned() else {
        return Err("任务不存在".into());
    };
    apply_schedule_patch(&mut next, &patch);
    next.updated_at = now_ms();
    let title = next.title.clone();
    repo.upsert_task(next);
    Ok(format!("已更新「{title}」的时间"))
}

fn apply_task_reminder(
    repo: &mut MemoryWorkbenchRepository,
    args: &Value,
) -> Result<String, String> {
    let task = resolve_task(repo, args)?;
    let Some(mut next) = repo.get_task(&task.id).cloned() else {
        return Err("任务不存在".into());
    };
    let mut patch = SchedulePatch::default();
    if let Some(explicit) = args.get("remindAt").and_then(|v| v.as_i64()) {
        patch.remind_at = Some(Some(explicit));
    } else if let Some(opt) = arg_str(args, &["remindOption"]).and_then(parse_remind) {
        if opt == ReminderOptionId::None {
            patch.remind_at = Some(None);
        } else if let Some(due) = next.due_with_time.or(next.deadline_with_time) {
            let at = shift_remind_at(due, opt);
            if next.due_with_time.is_some() {
                patch.remind_at = Some(at);
            } else {
                patch.deadline_remind_at = Some(at);
            }
        } else {
            return Err("任务没有计划时刻，无法按提前量设置提醒".into());
        }
    } else {
        return Err("需要 remindAt 或 remindOption".into());
    }
    apply_schedule_patch(&mut next, &patch);
    next.updated_at = now_ms();
    let title = next.title.clone();
    repo.upsert_task(next);
    Ok(format!("已更新「{title}」的提醒"))
}

fn assign_tag(repo: &mut MemoryWorkbenchRepository, args: &Value) -> Result<String, String> {
    let task = resolve_task(repo, args)?;
    let tag = if let Some(id) = arg_str(args, &["tagId"]) {
        repo.list_tags()
            .into_iter()
            .find(|t| t.id == id)
            .ok_or_else(|| "标签不存在".to_string())?
    } else if let Some(title) = arg_str(args, &["tagTitle", "title"]) {
        if let Some(existing) = repo.list_tags().into_iter().find(|t| t.title == title) {
            existing
        } else {
            repo.create_tag(title)
        }
    } else {
        return Err("请提供标签".into());
    };
    repo.add_tag_to_task(&task.id, &tag.id);
    Ok(format!("已为「{}」加上标签「{}」", task.title, tag.title))
}

struct RunningTimer {
    task_id: String,
    started: i64,
}

fn tool_timer() -> &'static Mutex<Option<RunningTimer>> {
    static TIMER: OnceLock<Mutex<Option<RunningTimer>>> = OnceLock::new();
    TIMER.get_or_init(|| Mutex::new(None))
}

fn settle_running(repo: &mut MemoryWorkbenchRepository, running: RunningTimer) -> String {
    let now = now_ms();
    let elapsed = (now - running.started).max(0);
    if let Some(mut task) = repo.get_task(&running.task_id).cloned() {
        let day = format_local_day(now);
        settle_timer_segment(&mut task, &day, elapsed, now);
        let title = task.title.clone();
        repo.upsert_task(task);
        format!("已停止「{title}」计时，记入 {elapsed}ms")
    } else {
        "计时任务已不存在，已停止".into()
    }
}

fn start_tool_timer(repo: &mut MemoryWorkbenchRepository, args: &Value) -> Result<String, String> {
    let task = resolve_task(repo, args)?;
    if task.parent_id.is_none()
        && repo
            .list_tasks()
            .iter()
            .any(|t| t.parent_id.as_deref() == Some(task.id.as_str()))
    {
        return Err("有子任务的父任务不能直接计时".into());
    }
    let previous = tool_timer().lock().unwrap().take();
    let settled = if let Some(prev) = previous {
        settle_running(repo, prev)
    } else {
        String::new()
    };
    *tool_timer().lock().unwrap() = Some(RunningTimer {
        task_id: task.id.clone(),
        started: now_ms(),
    });
    let msg = format!("开始为「{}」计时", task.title);
    if settled.is_empty() {
        Ok(msg)
    } else {
        Ok(format!("{settled}\n{msg}"))
    }
}

fn stop_tool_timer(repo: &mut MemoryWorkbenchRepository) -> Result<String, String> {
    let previous = tool_timer().lock().unwrap().take();
    match previous {
        Some(running) => Ok(settle_running(repo, running)),
        None => Err("没有正在进行的计时".into()),
    }
}

fn run_host_tool(args: &Value, workspace_root: Option<&str>) -> Result<String, String> {
    let tool_id = arg_str(args, &["toolId", "id", "name"]).unwrap_or("");
    if tool_id.is_empty() {
        return Err("缺少 toolId".into());
    }
    let tool_key = tool_id.to_ascii_lowercase();
    let bin = match tool_key.as_str() {
        "git" => "git",
        "node" | "nodejs" => "node",
        "npm" => "npm",
        "pnpm" => "pnpm",
        "yarn" => "yarn",
        "python" | "python3" => {
            if which_bin("python").is_some() {
                "python"
            } else {
                "python3"
            }
        }
        "pip" => "pip",
        "cargo" => "cargo",
        "rustc" => "rustc",
        "rg" | "ripgrep" => "rg",
        other => other,
    };
    if which_bin(bin).is_none() {
        return Err(format!("本机未找到工具：{tool_id}（{bin}）"));
    }
    let extra = arg_str(args, &["args", "command"]).unwrap_or("");
    let command = if extra.is_empty() {
        format!("{bin} --version")
    } else {
        format!("{bin} {extra}")
    };
    let cwd = arg_str(args, &["cwd"]).or(workspace_root);
    match run_shell_in(&command, cwd, workspace_root, 60) {
        Ok(r) => {
            let mut out = String::new();
            if !r.stdout.trim().is_empty() {
                out.push_str(r.stdout.trim());
            }
            if !r.stderr.trim().is_empty() {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str("[stderr]\n");
                out.push_str(r.stderr.trim());
            }
            if out.is_empty() {
                out = "(no output)".into();
            }
            out.push_str(&format!("\n[exit code: {}]", r.code));
            Ok(out)
        }
        Err(e) => Err(e.to_string()),
    }
}

fn office_to_pdf(args: &Value, workspace_root: Option<&str>) -> Result<String, String> {
    let rel = arg_str(args, &["path", "input"]).ok_or("缺少 path")?;
    let root = workspace_root.ok_or("未绑定工作区")?;
    let input = if Path::new(rel).is_absolute() {
        if !rel.starts_with(root) {
            return Err("路径必须在工作区内".into());
        }
        Path::new(rel).to_path_buf()
    } else {
        Path::new(root).join(rel)
    };
    if !input.is_file() {
        return Err(format!("文件不存在：{}", input.display()));
    }
    let soffice = which_bin("soffice")
        .or_else(|| which_bin("libreoffice"))
        .ok_or("未找到 LibreOffice/soffice")?;
    let out_dir = if let Some(output) = arg_str(args, &["output", "outdir"]) {
        let p = if Path::new(output).is_absolute() {
            Path::new(output).to_path_buf()
        } else {
            Path::new(root).join(output)
        };
        if p.is_dir() || output.ends_with('/') || output.ends_with('\\') {
            p
        } else {
            p.parent().unwrap_or(Path::new(root)).to_path_buf()
        }
    } else {
        input
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| Path::new(root).to_path_buf())
    };
    let _ = std::fs::create_dir_all(&out_dir);
    let cmd = format!(
        "\"{}\" --headless --convert-to pdf --outdir \"{}\" \"{}\"",
        soffice,
        out_dir.display(),
        input.display()
    );
    let result = run_shell_in(&cmd, Some(root), Some(root), 120).map_err(|e| e.to_string())?;
    if result.code != 0 {
        return Err(format!(
            "转换失败 [exit {}]\n{}{}",
            result.code, result.stdout, result.stderr
        ));
    }
    let stem = input
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("output");
    let pdf = out_dir.join(format!("{stem}.pdf"));
    Ok(format!("已转换：{}", pdf.display()))
}

fn spawn_subagent(repo: &mut MemoryWorkbenchRepository, args: &Value) -> Result<String, String> {
    let parent_id = arg_str(args, &["threadId"]).ok_or("缺少 threadId")?;
    let name = arg_str(args, &["name"]).ok_or("请提供 name")?;
    let task = arg_str(args, &["task", "prompt"]).ok_or("请提供 task")?;
    let wait = args.get("wait").and_then(|v| v.as_bool()).unwrap_or(false);
    let parent = repo
        .list_agent_threads()
        .into_iter()
        .find(|t| t.id == parent_id)
        .ok_or("父会话不存在")?;
    let depth = list_managed_agents(parent_id, true)
        .into_iter()
        .filter(|a| a.id == parent_id)
        .map(|a| a.depth)
        .next()
        .or_else(|| get_managed_agent(parent_id).map(|a| a.depth))
        .unwrap_or(0);
    if depth >= 2 {
        return Err("子智能体嵌套过深".into());
    }
    let prefs = load_prefs().unwrap_or_default();
    let def = prefs.agent.subagents.iter().find(|s| {
        s.get("name")
            .and_then(|v| v.as_str())
            .is_some_and(|n| n.eq_ignore_ascii_case(name))
    });
    let prompt = def
        .and_then(|s| s.get("prompt").and_then(|v| v.as_str()))
        .unwrap_or("你是一个专注的子智能体，请完成交给你的任务。");
    let description = def
        .and_then(|s| s.get("description").and_then(|v| v.as_str()))
        .unwrap_or(name);
    let now = now_ms();
    let child = AgentThread {
        id: create_id(now),
        workspace_id: parent.workspace_id.clone(),
        project_id: None,
        title: format!("subagent:{name}"),
        model_ref: if parent.model_ref.is_empty() {
            BUILTIN_MODEL_REF.into()
        } else {
            parent.model_ref.clone()
        },
        permission_mode: if parent.permission_mode == AgentPermissionMode::Readonly {
            AgentPermissionMode::Readonly
        } else {
            AgentPermissionMode::SessionAuto
        },
        queue_json: None,
        web_url: None,
        archived_at: None,
        pinned_at: None,
        created_at: now,
        updated_at: now,
    };
    let child_id = child.id.clone();
    let child_for_run = child.clone();
    repo.upsert_agent_thread(child);
    register_managed_agent(&child_id, parent_id, name, depth + 1);

    let user_text = format!("【子智能体 {name} · {description}】\n{prompt}\n\n任务：{task}");
    let proxy = load_prefs()
        .ok()
        .and_then(|p| p.http_proxy)
        .filter(|s| !s.trim().is_empty());

    if wait {
        match run_user_turn_blocking(repo, &child_for_run, &user_text, proxy.as_deref()) {
            Ok(out) => {
                let reply = out.assistant.content.clone();
                let _ = finish_managed_agent(&child_id, &reply);
                repo.push_notification(
                    NotificationKind::Agent,
                    &format!("子智能体 {name} 完成"),
                    &reply.chars().take(200).collect::<String>(),
                    Some(parent_id),
                );
                Ok(format!("子智能体 {name} 已同步完成\n{reply}"))
            }
            Err(e) => {
                let _ = finish_managed_agent(&child_id, &format!("失败：{e}"));
                Err(format!("子智能体 {name} 失败：{e}"))
            }
        }
    } else {
        let now = now_ms();
        repo.upsert_agent_message(AgentMessage {
            id: create_id(now),
            thread_id: child_id.clone(),
            role: AgentRole::User,
            content: user_text,
            tool_name: None,
            tool_call_id: None,
            tool_calls_json: None,
            created_at: now,
        });
        let child_id_bg = child_id.clone();
        let parent_bg = parent_id.to_string();
        let name_bg = name.to_string();
        let proxy_bg = proxy.clone();
        let _ = std::thread::Builder::new()
            .name("wb-subagent".into())
            .spawn(move || {
                std::thread::sleep(Duration::from_millis(400));
                let Ok(mut repo) = wb_store::load_store() else {
                    return;
                };
                let Some(thread) = repo
                    .list_agent_threads()
                    .into_iter()
                    .find(|t| t.id == child_id_bg)
                else {
                    return;
                };
                if get_managed_agent(&child_id_bg)
                    .is_some_and(|a| a.status != crate::managed_agents::ManagedAgentStatus::Running)
                {
                    return;
                }
                let has_asst = repo
                    .messages_for_thread(&child_id_bg)
                    .iter()
                    .any(|m| matches!(m.role, AgentRole::Assistant));
                if has_asst {
                    return;
                }
                match resume_thread_turn_blocking(&mut repo, &thread, proxy_bg.as_deref()) {
                    Ok(out) => {
                        let reply = out.assistant.content.clone();
                        let _ = finish_managed_agent(&child_id_bg, &reply);
                        repo.push_notification(
                            NotificationKind::Agent,
                            &format!("子智能体 {name_bg} 完成"),
                            &reply.chars().take(200).collect::<String>(),
                            Some(&parent_bg),
                        );
                        let _ = wb_store::save_store(&mut repo);
                    }
                    Err(e) => {
                        let _ = finish_managed_agent(&child_id_bg, &format!("失败：{e}"));
                        repo.push_notification(
                            NotificationKind::Agent,
                            &format!("子智能体 {name_bg} 失败"),
                            &e.to_string(),
                            Some(&parent_bg),
                        );
                        let _ = wb_store::save_store(&mut repo);
                    }
                }
            });
        Ok(format!(
            "已托管启动子智能体 {name}，agentId={child_id}（后台跑完整回合；可用 list_agents / send_message / interrupt_agent）"
        ))
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

        let blocked = execute_tool(
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
        assert!(!blocked.ok);
        assert!(blocked.content.contains("FS_NOT_OBSERVED"));

        let _ = execute_tool(
            &mut repo,
            "read",
            &json!({ "path": "hello.rs" }),
            Some(&root),
        )
        .unwrap();

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

        let patch = execute_tool(
            &mut repo,
            "apply_patch",
            &json!({
                "patch": "*** Begin Patch\n*** Add File: new.txt\n+alpha\n*** Update File: hello.rs\n@@\n-fn main() { println!(\"done\"); }\n+fn main() { println!(\"patched\"); }\n*** End Patch\n"
            }),
            Some(&root),
        )
        .unwrap();
        assert!(patch.ok);
        assert!(
            std::fs::read_to_string(dir.join("new.txt"))
                .unwrap()
                .contains("alpha")
        );
        assert!(std::fs::read_to_string(&file).unwrap().contains("patched"));

        let viewed = execute_tool(
            &mut repo,
            "str_replace_editor",
            &json!({ "command": "view", "path": "new.txt" }),
            Some(&root),
        )
        .unwrap();
        assert!(viewed.content.contains("alpha"));

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
    fn terminal_and_cwd_roundtrip() {
        let dir = std::env::temp_dir().join(format!("wb-agent-term-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut repo = MemoryWorkbenchRepository::default();
        let root = dir.to_string_lossy().to_string();
        let cwd = execute_tool(
            &mut repo,
            "working_directory",
            &json!({ "path": "." }),
            Some(&root),
        )
        .unwrap();
        assert!(cwd.ok);
        let open = execute_tool(
            &mut repo,
            "terminal_open",
            &json!({ "shell": "cmd" }),
            Some(&root),
        )
        .unwrap();
        assert!(open.ok);
        let id = open.content.split_whitespace().last().unwrap().to_string();
        let sent = execute_tool(
            &mut repo,
            "terminal_send",
            &json!({ "terminalId": id, "command": "echo hi-term" }),
            Some(&root),
        )
        .unwrap();
        assert!(sent.ok);
        let listed = execute_tool(&mut repo, "terminal_list", &json!({}), None).unwrap();
        assert!(listed.content.contains(&id));
        let _ = execute_tool(
            &mut repo,
            "terminal_close",
            &json!({ "terminalId": id }),
            None,
        );
        set_agent_cwd(None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn goal_and_session_trace() {
        use wb_domain::{AgentMessage, AgentRole, AgentThread, now_ms};
        let mut repo = MemoryWorkbenchRepository::default();
        let now = now_ms();
        let thread = AgentThread {
            id: "th-goal".into(),
            workspace_id: "ws".into(),
            project_id: None,
            title: "t".into(),
            model_ref: wb_domain::BUILTIN_MODEL_REF.into(),
            permission_mode: Default::default(),
            queue_json: None,
            web_url: None,
            archived_at: None,
            pinned_at: None,
            created_at: now,
            updated_at: now,
        };
        repo.upsert_agent_thread(thread);
        repo.upsert_agent_message(AgentMessage {
            id: "m1".into(),
            thread_id: "th-goal".into(),
            role: AgentRole::User,
            content: "你好 goal-trace".into(),
            tool_name: None,
            tool_call_id: None,
            tool_calls_json: None,
            created_at: now,
        });
        repo.upsert_agent_message(AgentMessage {
            id: "m2".into(),
            thread_id: "th-goal".into(),
            role: AgentRole::Assistant,
            content: "助手回复 alpha".into(),
            tool_name: None,
            tool_call_id: None,
            tool_calls_json: None,
            created_at: now + 1,
        });
        repo.upsert_agent_message(AgentMessage {
            id: "m3".into(),
            thread_id: "th-goal".into(),
            role: AgentRole::User,
            content: "最新用户".into(),
            tool_name: None,
            tool_call_id: None,
            tool_calls_json: None,
            created_at: now + 2,
        });
        crate::session_goal::clear_goal();
        let created = execute_tool(
            &mut repo,
            "create_goal",
            &json!({ "objective": "完成迁移", "maxRounds": 3 }),
            None,
        )
        .unwrap();
        assert!(created.ok);
        let got = execute_tool(&mut repo, "get_goal", &json!({}), None).unwrap();
        assert!(got.content.contains("完成迁移"));
        let _ = execute_tool(&mut repo, "update_goal", &json!({ "action": "tick" }), None).unwrap();
        let trace = execute_tool(
            &mut repo,
            "session_trace",
            &json!({ "threadId": "th-goal" }),
            None,
        )
        .unwrap();
        assert!(trace.content.contains("goal-trace"));

        let ev = execute_tool(
            &mut repo,
            "session_event_search",
            &json!({ "query": "alpha", "threadId": "th-goal" }),
            None,
        )
        .unwrap();
        assert!(ev.ok);
        assert!(ev.content.contains("alpha"));

        let read = execute_tool(
            &mut repo,
            "session_event_read",
            &json!({ "seq": 2, "threadId": "th-goal", "neighbors": 1 }),
            None,
        )
        .unwrap();
        assert!(read.content.contains("#2"));

        let et = execute_tool(
            &mut repo,
            "session_event_trace",
            &json!({ "seq": 2, "threadId": "th-goal" }),
            None,
        )
        .unwrap();
        assert!(et.ok);

        // Re-assert active goal in case a parallel test cleared the process-global store.
        if crate::get_goal().is_none() {
            let _ = execute_tool(
                &mut repo,
                "create_goal",
                &json!({ "objective": "完成迁移", "maxRounds": 3 }),
                None,
            );
        }
        let idle = crate::prepare_goal_idle_round();
        assert!(idle.is_some(), "goal={:?}", crate::get_goal());

        let _ = execute_tool(
            &mut repo,
            "update_goal",
            &json!({ "action": "clear" }),
            None,
        );
    }

    #[test]
    fn mcp_add_list_remove() {
        let mut repo = MemoryWorkbenchRepository::default();
        let name = format!("demo-mcp-{}", uuid::Uuid::new_v4());
        let add = execute_tool(
            &mut repo,
            "mcp_add",
            &json!({ "name": name, "command": "npx", "args": ["-y", "demo"] }),
            None,
        )
        .unwrap();
        assert!(add.ok, "{}", add.content);
        let list = execute_tool(&mut repo, "mcp_list", &json!({}), None).unwrap();
        assert!(list.content.contains(&name), "{}", list.content);
        let rm = execute_tool(&mut repo, "mcp_remove", &json!({ "name": name }), None).unwrap();
        assert!(rm.ok, "{}", rm.content);
    }

    #[test]
    fn load_workspace_dependencies_lists_tools() {
        let mut repo = MemoryWorkbenchRepository::default();
        let r = execute_tool(&mut repo, "load_workspace_dependencies", &json!({}), None).unwrap();
        assert!(r.ok);
        assert!(r.content.contains("git:") || r.content.contains("cargo:"));
    }

    #[test]
    fn search_settings_and_host_tool_list() {
        let mut repo = MemoryWorkbenchRepository::default();
        let _ = repo.create_task("搜索专用任务 xyz", None);
        let _ = repo.create_note("note", "正文含 xyz 关键字");
        let found = execute_tool(&mut repo, "search", &json!({ "query": "xyz" }), None).unwrap();
        assert!(found.ok);
        assert!(found.content.contains("xyz"));

        let set = execute_tool(
            &mut repo,
            "settings_set",
            &json!({ "key": "personality", "value": "简洁" }),
            None,
        )
        .unwrap();
        assert!(set.ok);
        let get = execute_tool(
            &mut repo,
            "settings_get",
            &json!({ "key": "personality" }),
            None,
        )
        .unwrap();
        assert!(get.content.contains("简洁"));

        let tools = execute_tool(&mut repo, "host_tool_list", &json!({}), None).unwrap();
        assert!(tools.content.contains("search"));
        assert!(tools.content.contains("present"));
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
        let viewed = execute_tool(
            &mut repo,
            "schedule_view",
            &json!({ "scheduleId": id }),
            None,
        )
        .unwrap();
        assert!(viewed.content.contains("晨报"));
        let edited = execute_tool(
            &mut repo,
            "schedule_edit",
            &json!({ "scheduleId": id, "title": "晚报" }),
            None,
        )
        .unwrap();
        assert!(edited.ok);
        assert_eq!(repo.get_timed_task(&id).unwrap().title, "晚报");
        let note = execute_tool(
            &mut repo,
            "notification_create",
            &json!({ "title": "测试通知", "body": "hello" }),
            None,
        )
        .unwrap();
        assert!(note.ok);
        assert!(!repo.list_notifications().is_empty());
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

    #[test]
    fn task_note_schedule_and_timer_tools() {
        let mut repo = MemoryWorkbenchRepository::default();
        execute_tool(
            &mut repo,
            "task_create",
            &json!({ "title": "写文档" }),
            None,
        )
        .unwrap();
        let id = repo.list_tasks()[0].id.clone();
        let updated = execute_tool(
            &mut repo,
            "task_update",
            &json!({ "taskId": id, "notes": "先写大纲", "timeEstimateMinutes": 25 }),
            None,
        )
        .unwrap();
        assert!(updated.ok);
        let scheduled = execute_tool(
            &mut repo,
            "task_schedule",
            &json!({ "taskId": id, "dueDay": "2026-11-21" }),
            None,
        )
        .unwrap();
        assert!(scheduled.ok);
        assert_eq!(
            repo.get_task(&id).unwrap().due_day.as_deref(),
            Some("2026-11-21")
        );
        let child = execute_tool(
            &mut repo,
            "task_add_subtask",
            &json!({ "parentId": id, "title": "小节" }),
            None,
        )
        .unwrap();
        assert!(child.ok);
        let blocked =
            execute_tool(&mut repo, "timer_start", &json!({ "taskId": id }), None).unwrap();
        assert!(!blocked.ok);
        let note = execute_tool(
            &mut repo,
            "note_create",
            &json!({ "title": "备忘", "body": "关键词甲" }),
            None,
        )
        .unwrap();
        assert!(note.ok);
        let found = execute_tool(
            &mut repo,
            "note_search",
            &json!({ "query": "关键词甲" }),
            None,
        )
        .unwrap();
        assert!(found.content.contains("备忘"));
        let got = execute_tool(&mut repo, "task_get", &json!({ "taskId": id }), None).unwrap();
        assert!(got.content.contains("小节"));
    }

    #[test]
    fn subagent_and_aliases() {
        update_prefs(|prefs| {
            prefs.agent.subagents = vec![json!({
                "name": "researcher",
                "description": "调研助手",
                "prompt": "简洁回答"
            })];
            prefs.agent.hooks = vec![json!({
                "event": "task_complete",
                "title": "完成提示",
                "enabled": true
            })];
            Ok(())
        })
        .unwrap();

        let mut repo = MemoryWorkbenchRepository::default();
        let parent = crate::turn::create_thread("ws", "主会话", None);
        let parent_id = parent.id.clone();
        repo.upsert_agent_thread(parent);

        let listed = execute_tool(&mut repo, "subagent_list", &json!({}), None).unwrap();
        assert!(listed.content.contains("researcher"));
        let hooks = execute_tool(&mut repo, "hook_list", &json!({}), None).unwrap();
        assert!(hooks.content.contains("完成提示"));

        let spawned = execute_tool(
            &mut repo,
            "subagent",
            &json!({
                "threadId": parent_id,
                "name": "researcher",
                "task": "查一下缺口",
                "wait": true
            }),
            None,
        )
        .unwrap();
        assert!(spawned.ok);
        assert!(spawned.content.contains("已同步完成"));

        let agents = execute_tool(
            &mut repo,
            "list_agents",
            &json!({ "threadId": parent_id }),
            None,
        )
        .unwrap();
        assert!(agents.content.contains("researcher") || agents.content.contains("托管"));

        let model = execute_tool(
            &mut repo,
            "session_set_model",
            &json!({ "threadId": parent_id, "modelRef": "openai/gpt-4o-mini" }),
            None,
        )
        .unwrap();
        assert!(model.ok);
        assert_eq!(
            repo.list_agent_threads()
                .into_iter()
                .find(|t| t.id == parent_id)
                .unwrap()
                .model_ref,
            "openai/gpt-4o-mini"
        );

        let host = execute_tool(
            &mut repo,
            "host_tool_run",
            &json!({ "toolId": "git", "args": "--version" }),
            None,
        )
        .unwrap();
        assert!(host.ok, "{}", host.content);

        let save = execute_tool(
            &mut repo,
            "memory_save",
            &json!({ "text": "别名记忆" }),
            None,
        )
        .unwrap();
        assert!(save.ok);
    }
}
