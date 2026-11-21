use crate::session_goal::{create_goal, get_goal, update_goal};
use crate::session_todo::{SessionTodo, list_todos, write_todos};
use anyhow::Result;
use serde_json::Value;
use std::path::Path;
use wb_domain::{
    AgentMessage, AgentPermissionMode, NotificationKind, TimedIntervalUnit, TimedSchedulePreset,
    ToolEffect, ToolGate, ToolSpec, builtin_host_tools, create_timed_task_draft, format_local_day,
    gate_tool, make_custom_schedule, make_preset_schedule, now_ms, settle_timer_segment,
    workspace_tools,
};
use wb_host::{
    global_jobs, global_terminals, list_files_recursive, list_plugins, list_skills, load_skill,
    present_path, probe_workspace_dependencies, read_image_info, read_text, resolve_agent_cwd,
    run_shell, run_shell_kind, set_agent_cwd, web_fetch, web_search, write_text,
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
                "themeMode" => Some(format!("{:?}", prefs.theme_mode).to_lowercase()),
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
        "settings_set" => {
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
            let mut prefs = load_prefs().unwrap_or_default();
            match key {
                "themeMode" => {
                    let v = as_str().to_lowercase();
                    prefs.theme_mode = match v.as_str() {
                        "dark" => wb_domain::ThemeModePref::Dark,
                        "light" => wb_domain::ThemeModePref::Light,
                        _ => {
                            return Ok(ToolResult::err_text("themeMode 仅支持 light/dark"));
                        }
                    };
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
                "skillsDirs" => prefs.agent.skills_dirs = split_dirs(&as_str()),
                "pluginsDirs" => prefs.agent.plugins_dirs = split_dirs(&as_str()),
                "" => return Ok(ToolResult::err_text("缺少 key")),
                other => {
                    return Ok(ToolResult::err_text(format!(
                        "不支持写入：{other}（白名单同上）"
                    )));
                }
            }
            save_prefs(&prefs)?;
            Ok(ToolResult::ok_text(format!("已更新 {key}")))
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
                "goal [{}] rounds={}/{:?} · {}",
                g.status, g.rounds_started, g.max_rounds, g.objective
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
            let root = effective_root(workspace_root)?;
            let path = safe_join(&root, rel)?;
            let text = read_text(&path)?;
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
            let root = effective_root(workspace_root)?;
            let path = safe_join(&root, rel)?;
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
            let root = effective_root(workspace_root).ok();
            let result = run_shell(command, root.as_deref(), 120)?;
            Ok(ToolResult {
                ok: result.code == 0,
                content: format!("exit {}\n{}\n{}", result.code, result.stdout, result.stderr),
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
            let result = match run_shell_kind(kind, command, root.as_deref(), 120) {
                Ok(r) => r,
                Err(e) => {
                    return Ok(ToolResult::err_text(format!(
                        "{kind} 不可用或执行失败：{e}"
                    )));
                }
            };
            Ok(ToolResult {
                ok: result.code == 0,
                content: format!("exit {}\n{}\n{}", result.code, result.stdout, result.stderr),
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
            let root = effective_root(workspace_root).ok();
            let id = global_jobs().start(command, root.as_deref())?;
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
        "skill_list" => {
            let prefs = load_prefs().unwrap_or_default();
            let skills = list_skills(&prefs.agent.skills_dirs);
            let lines: Vec<_> = skills
                .into_iter()
                .map(|s| format!("- {} · {} ({})", s.name, s.summary, s.path))
                .collect();
            Ok(ToolResult::ok_text(if lines.is_empty() {
                "（无技能；请在设置中配置 skillsDirs）".into()
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

        let idle = crate::prepare_goal_idle_round();
        assert!(idle.is_some());

        let _ = execute_tool(
            &mut repo,
            "update_goal",
            &json!({ "action": "clear" }),
            None,
        );
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
