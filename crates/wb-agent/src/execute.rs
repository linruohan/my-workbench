use anyhow::Result;
use serde_json::Value;
use std::path::Path;
use wb_domain::{
    AgentPermissionMode, ToolEffect, ToolGate, ToolSpec, builtin_host_tools, gate_tool,
    workspace_tools,
};
use wb_host::{read_text, run_shell, write_text};
use wb_store::MemoryWorkbenchRepository;

#[derive(Debug, Clone)]
pub struct ToolResult {
    pub ok: bool,
    pub content: String,
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
            Ok(ToolResult {
                ok: true,
                content: if filtered.is_empty() {
                    "（无任务）".into()
                } else {
                    filtered.join("\n")
                },
            })
        }
        "task_create" => {
            let title = args
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("未命名");
            let pid = args.get("projectId").and_then(|v| v.as_str());
            let t = repo.create_task(title, pid);
            Ok(ToolResult {
                ok: true,
                content: format!("已创建任务 {} · {}", t.id, t.title),
            })
        }
        "task_complete" => {
            let id = args
                .get("taskId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 taskId"))?;
            match repo.complete_task(id) {
                Some(t) => Ok(ToolResult {
                    ok: true,
                    content: format!("已完成：{}", t.title),
                }),
                None => Ok(ToolResult {
                    ok: false,
                    content: "任务不存在".into(),
                }),
            }
        }
        "note_list" => {
            let notes = repo.list_notes();
            let lines: Vec<_> = notes
                .iter()
                .map(|n| format!("- {} ({})", n.title, n.id))
                .collect();
            Ok(ToolResult {
                ok: true,
                content: if lines.is_empty() {
                    "（无笔记）".into()
                } else {
                    lines.join("\n")
                },
            })
        }
        "notification_list" => {
            let notes = repo.list_notifications();
            let lines: Vec<_> = notes
                .iter()
                .take(20)
                .map(|n| format!("- {} · {}", n.title, n.body))
                .collect();
            Ok(ToolResult {
                ok: true,
                content: lines.join("\n"),
            })
        }
        "schedule_list" => {
            let tasks = repo.list_timed_tasks();
            let lines: Vec<_> = tasks
                .iter()
                .map(|t| {
                    format!(
                        "- {} [{}] next={:?}",
                        t.title,
                        if t.enabled { "on" } else { "off" },
                        t.next_run_at
                    )
                })
                .collect();
            Ok(ToolResult {
                ok: true,
                content: lines.join("\n"),
            })
        }
        "ui_open" => Ok(ToolResult {
            ok: true,
            content: format!("ui_open: {:?}", args.get("view")),
        }),
        "read" => {
            let rel = args
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 path"))?;
            let root = workspace_root.ok_or_else(|| anyhow::anyhow!("未绑定工作区"))?;
            let path = Path::new(root).join(rel);
            let text = read_text(&path)?;
            Ok(ToolResult {
                ok: true,
                content: text,
            })
        }
        "write" => {
            let rel = args
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺少 path"))?;
            let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("");
            let root = workspace_root.ok_or_else(|| anyhow::anyhow!("未绑定工作区"))?;
            let path = Path::new(root).join(rel);
            write_text(&path, content)?;
            Ok(ToolResult {
                ok: true,
                content: format!("已写入 {rel}"),
            })
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
            })
        }
        "glob" | "grep" => Ok(ToolResult {
            ok: true,
            content: format!("{name} 已注册；完整索引扫描将在后续迭代增强"),
        }),
        other => Ok(ToolResult {
            ok: false,
            content: format!("未知工具: {other}"),
        }),
    }
}
