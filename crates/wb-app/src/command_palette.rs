use crate::app::WorkbenchApp;
use crate::state::{AppNav, AppState};
use crate::views::TasksPane;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::*;
use gpui_kit::*;
use std::path::Path;
use wb_agent::permission_mode_label;
use wb_domain::{AgentEvent, AgentPermissionMode, NotificationKind, create_id, now_ms};
use wb_host::{ensure_session_worktree, merge_session_worktree, set_agent_cwd};

#[derive(Clone)]
struct PaletteItem {
    id: String,
    label: String,
    kind: &'static str,
    nav: Option<AppNav>,
    task_id: Option<String>,
    thread_id: Option<String>,
    note_id: Option<String>,
    kb_path: Option<String>,
}

pub struct CommandPalette {
    state: AppState,
    host: WeakEntity<WorkbenchApp>,
    tasks: WeakEntity<TasksPane>,
    query: Entity<InputState>,
    catalog: Vec<PaletteItem>,
    catalog_gen: u64,
    body_hits: Vec<PaletteItem>,
    body_for: String,
    _subs: Vec<Subscription>,
}

impl CommandPalette {
    pub fn new(
        state: AppState,
        host: WeakEntity<WorkbenchApp>,
        tasks: WeakEntity<TasksPane>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let query =
            cx.new(|cx| InputState::new(window, cx).placeholder("搜索任务、会话、笔记、页面…"));
        let mut this = Self {
            state,
            host,
            tasks,
            query: query.clone(),
            catalog: Vec::new(),
            catalog_gen: 0,
            body_hits: Vec::new(),
            body_for: String::new(),
            _subs: Vec::new(),
        };
        this.refresh_catalog(cx);
        this._subs.push(
            cx.subscribe_in(&query, window, |this, _, event, window, cx| {
                if matches!(event, InputEvent::Change) {
                    this.schedule_body_search(cx);
                }
                if matches!(event, InputEvent::Change | InputEvent::PressEnter { .. }) {
                    cx.notify();
                }
                if let InputEvent::PressEnter { .. } = event {
                    if let Some(item) = this.filtered(cx).into_iter().next() {
                        this.activate(item, window, cx);
                    }
                }
            }),
        );
        this
    }

    fn all_items(&self) -> Vec<PaletteItem> {
        let mut items = vec![
            PaletteItem {
                id: "nav-today".into(),
                label: "今日".into(),
                kind: "页面",
                nav: Some(AppNav::Today),
                task_id: None,
                thread_id: None,
                note_id: None,
                kb_path: None,
            },
            PaletteItem {
                id: "nav-inbox".into(),
                label: "收件箱".into(),
                kind: "页面",
                nav: Some(AppNav::Inbox),
                task_id: None,
                thread_id: None,
                note_id: None,
                kb_path: None,
            },
            PaletteItem {
                id: "nav-planner".into(),
                label: "计划".into(),
                kind: "页面",
                nav: Some(AppNav::Planner),
                task_id: None,
                thread_id: None,
                note_id: None,
                kb_path: None,
            },
            PaletteItem {
                id: "nav-timed".into(),
                label: "定时任务".into(),
                kind: "页面",
                nav: Some(AppNav::Timed),
                task_id: None,
                thread_id: None,
                note_id: None,
                kb_path: None,
            },
            PaletteItem {
                id: "nav-tags".into(),
                label: "标签".into(),
                kind: "页面",
                nav: Some(AppNav::Tags),
                task_id: None,
                thread_id: None,
                note_id: None,
                kb_path: None,
            },
            PaletteItem {
                id: "nav-kb".into(),
                label: "知识库".into(),
                kind: "页面",
                nav: Some(AppNav::Knowledge),
                task_id: None,
                thread_id: None,
                note_id: None,
                kb_path: None,
            },
            PaletteItem {
                id: "nav-agent".into(),
                label: "Agent".into(),
                kind: "页面",
                nav: Some(AppNav::Agent),
                task_id: None,
                thread_id: None,
                note_id: None,
                kb_path: None,
            },
            PaletteItem {
                id: "agent-worktree".into(),
                label: "为本会话打开 worktree".into(),
                kind: "操作",
                nav: Some(AppNav::Agent),
                task_id: None,
                thread_id: None,
                note_id: None,
                kb_path: None,
            },
            PaletteItem {
                id: "agent-worktree-merge".into(),
                label: "快进合并当前 worktree".into(),
                kind: "操作",
                nav: Some(AppNav::Agent),
                task_id: None,
                thread_id: None,
                note_id: None,
                kb_path: None,
            },
            PaletteItem {
                id: "perm-ask".into(),
                label: "会话权限：询问".into(),
                kind: "操作",
                nav: Some(AppNav::Agent),
                task_id: None,
                thread_id: None,
                note_id: None,
                kb_path: None,
            },
            PaletteItem {
                id: "perm-write".into(),
                label: "会话权限：可写".into(),
                kind: "操作",
                nav: Some(AppNav::Agent),
                task_id: None,
                thread_id: None,
                note_id: None,
                kb_path: None,
            },
            PaletteItem {
                id: "perm-auto".into(),
                label: "会话权限：自动".into(),
                kind: "操作",
                nav: Some(AppNav::Agent),
                task_id: None,
                thread_id: None,
                note_id: None,
                kb_path: None,
            },
            PaletteItem {
                id: "perm-bypass".into(),
                label: "会话权限：放行".into(),
                kind: "操作",
                nav: Some(AppNav::Agent),
                task_id: None,
                thread_id: None,
                note_id: None,
                kb_path: None,
            },
            PaletteItem {
                id: "perm-readonly".into(),
                label: "会话权限：只读".into(),
                kind: "操作",
                nav: Some(AppNav::Agent),
                task_id: None,
                thread_id: None,
                note_id: None,
                kb_path: None,
            },
            PaletteItem {
                id: "nav-settings".into(),
                label: "设置".into(),
                kind: "页面",
                nav: Some(AppNav::Settings),
                task_id: None,
                thread_id: None,
                note_id: None,
                kb_path: None,
            },
        ];
        self.state.with(|s| {
            for t in s.repo.list_tasks().into_iter().filter(|t| !t.is_done) {
                let nav = if t.project_id == wb_domain::INBOX_PROJECT_ID {
                    AppNav::Inbox
                } else {
                    AppNav::Projects
                };
                items.push(PaletteItem {
                    id: format!("task-{}", t.id),
                    label: t.title.clone(),
                    kind: "任务",
                    nav: Some(nav),
                    task_id: Some(t.id),
                    thread_id: None,
                    note_id: None,
                    kb_path: None,
                });
            }
            for p in s
                .repo
                .list_projects()
                .into_iter()
                .filter(|p| p.id != wb_domain::INBOX_PROJECT_ID && !p.is_archived)
            {
                items.push(PaletteItem {
                    id: format!("project-{}", p.id),
                    label: p.title.clone(),
                    kind: "项目",
                    nav: Some(AppNav::Projects),
                    task_id: None,
                    thread_id: None,
                    note_id: None,
                    kb_path: None,
                });
            }
            for tag in s.repo.list_tags() {
                items.push(PaletteItem {
                    id: format!("tag-{}", tag.id),
                    label: format!("#{}", tag.title),
                    kind: "标签",
                    nav: Some(AppNav::Tags),
                    task_id: None,
                    thread_id: None,
                    note_id: None,
                    kb_path: None,
                });
            }
            for t in s.repo.list_agent_threads() {
                items.push(PaletteItem {
                    id: format!("thread-{}", t.id),
                    label: t.title.clone(),
                    kind: "会话",
                    nav: Some(AppNav::Agent),
                    task_id: None,
                    thread_id: Some(t.id),
                    note_id: None,
                    kb_path: None,
                });
            }
            for n in s.repo.list_notes() {
                items.push(PaletteItem {
                    id: format!("note-{}", n.id),
                    label: n.title.clone(),
                    kind: "笔记",
                    nav: Some(AppNav::Knowledge),
                    task_id: None,
                    thread_id: None,
                    note_id: Some(n.id),
                    kb_path: None,
                });
            }
        });
        items
    }

    pub fn refresh_catalog(&mut self, cx: &mut Context<Self>) {
        self.catalog = self.all_items();
        self.catalog_gen = self.catalog_gen.wrapping_add(1);
        let generation = self.catalog_gen;
        let root = self.state.with(|s| {
            s.prefs
                .knowledge_current
                .clone()
                .or_else(|| s.prefs.knowledge_roots.first().cloned())
        });
        let Some(root) = root else {
            return;
        };
        let root_for_list = root.clone();
        cx.spawn(async move |this, cx| {
            let files = cx
                .background_executor()
                .spawn(async move {
                    wb_host::list_files_recursive(std::path::Path::new(&root_for_list), 400)
                        .unwrap_or_default()
                })
                .await;
            this.update(cx, |this, cx| {
                if this.catalog_gen != generation {
                    return;
                }
                this.catalog.retain(|item| item.kind != "知识库");
                for file in files.into_iter().filter(|entry| !entry.is_dir) {
                    this.catalog.push(PaletteItem {
                        id: format!("kb-{}", file.path),
                        label: file.relative,
                        kind: "知识库",
                        nav: Some(AppNav::Knowledge),
                        task_id: None,
                        thread_id: None,
                        note_id: None,
                        kb_path: Some(file.path),
                    });
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn schedule_body_search(&mut self, cx: &mut Context<Self>) {
        let raw = self.query.read(cx).value().to_string();
        let query = raw.trim().to_string();
        if query.chars().count() < 2 {
            self.body_for.clear();
            self.body_hits.clear();
            return;
        }
        let root = self.state.with(|s| {
            s.prefs
                .knowledge_current
                .clone()
                .or_else(|| s.prefs.knowledge_roots.first().cloned())
        });
        let Some(root) = root else {
            self.body_hits.clear();
            return;
        };
        let query_for_search = query.clone();
        cx.spawn(async move |this, cx| {
            let hits = cx
                .background_executor()
                .spawn(async move {
                    wb_host::search_kb_content(
                        std::path::Path::new(&root),
                        &query_for_search,
                        400,
                        12,
                    )
                    .unwrap_or_default()
                })
                .await;
            this.update(cx, |this, cx| {
                if this.query.read(cx).value().trim() != query {
                    return;
                }
                this.body_for = query;
                this.body_hits = hits
                    .into_iter()
                    .map(|hit| {
                        let label = if hit.line > 0 {
                            format!("{} · L{} · {}", hit.relative, hit.line, hit.snippet)
                        } else {
                            hit.relative.clone()
                        };
                        PaletteItem {
                            id: format!("kb-body-{}", hit.path),
                            label,
                            kind: if hit.line > 0 { "正文" } else { "知识库" },
                            nav: Some(AppNav::Knowledge),
                            task_id: None,
                            thread_id: None,
                            note_id: None,
                            kb_path: Some(hit.path),
                        }
                    })
                    .collect();
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn filtered(&self, cx: &App) -> Vec<PaletteItem> {
        let raw = self.query.read(cx).value().to_string();
        let q = raw.trim().to_lowercase();
        let mut items: Vec<PaletteItem> = self
            .catalog
            .iter()
            .filter(|i| q.is_empty() || i.label.to_lowercase().contains(&q) || i.kind.contains(&q))
            .take(24)
            .cloned()
            .collect();
        if q.chars().count() >= 2 && self.body_for.eq_ignore_ascii_case(raw.trim()) {
            let existing: std::collections::HashSet<String> =
                items.iter().filter_map(|i| i.kb_path.clone()).collect();
            for hit in &self.body_hits {
                let Some(path) = hit.kb_path.clone() else {
                    continue;
                };
                if existing.contains(&path) {
                    if hit.kind == "正文"
                        && let Some(item) = items
                            .iter_mut()
                            .find(|i| i.kb_path.as_deref() == Some(path.as_str()))
                    {
                        item.kind = "正文";
                        item.label = hit.label.clone();
                    }
                    continue;
                }
                items.push(hit.clone());
            }
        }
        items.truncate(30);
        items
    }

    fn activate(&mut self, item: PaletteItem, window: &mut Window, cx: &mut Context<Self>) {
        let opened_task = item.task_id.clone();
        let query = self.query.read(cx).value().to_string();
        self.state.with_mut(|s| {
            if let Some(nav) = item.nav {
                if nav == AppNav::Settings && s.nav != AppNav::Settings {
                    s.nav_before_settings = s.nav;
                }
                s.nav = nav;
            }
            if let Some(id) = item.task_id.clone() {
                if let Some(task) = s.repo.get_task(&id) {
                    if task.project_id != wb_domain::INBOX_PROJECT_ID {
                        s.active_project_id = Some(task.project_id.clone());
                        s.nav = AppNav::Projects;
                    }
                }
                s.selected_task_id = Some(id);
            } else if item.id.starts_with("project-") {
                let pid = item.id.trim_start_matches("project-").to_string();
                s.active_project_id = Some(pid);
                s.active_tag_id = None;
                s.nav = AppNav::Projects;
            } else if item.id.starts_with("tag-") || item.id == "nav-tags" {
                s.active_tag_id = None;
                s.active_project_id = None;
                s.nav = AppNav::Tags;
            }
            if let Some(id) = item.thread_id {
                s.active_thread_id = Some(id);
            }
            if let Some(mode) = match item.id.as_str() {
                "perm-ask" => Some(AgentPermissionMode::Ask),
                "perm-write" => Some(AgentPermissionMode::Write),
                "perm-auto" => Some(AgentPermissionMode::Auto),
                "perm-bypass" => Some(AgentPermissionMode::Bypass),
                "perm-readonly" => Some(AgentPermissionMode::Readonly),
                _ => None,
            } {
                if let Some(id) = s.active_thread_id.clone() {
                    if let Some(mut thread) = s.repo.get_agent_thread(&id).cloned() {
                        thread.permission_mode = mode;
                        s.repo.upsert_agent_thread(thread);
                        let now = now_ms();
                        s.repo.append_agent_event(AgentEvent {
                            id: create_id(now),
                            thread_id: id,
                            kind: "permission".into(),
                            name: "会话权限".into(),
                            detail: permission_mode_label(mode).into(),
                            ok: Some(true),
                            duration_ms: None,
                            created_at: now,
                        });
                    }
                } else {
                    s.repo.push_notification(
                        NotificationKind::System,
                        "会话权限",
                        "先打开一个会话",
                        None,
                    );
                }
            }
            if item.id == "agent-worktree" {
                let thread_id = s.active_thread_id.clone();
                let workspace = thread_id.as_ref().and_then(|id| {
                    let thread = s.repo.get_agent_thread(id)?;
                    s.repo
                        .list_agent_workspaces()
                        .into_iter()
                        .find(|workspace| workspace.id == thread.workspace_id)
                        .and_then(|workspace| workspace.root_path)
                });
                match (thread_id, workspace) {
                    (None, _) => {
                        s.repo.push_notification(
                            NotificationKind::System,
                            "Worktree",
                            "先打开一个会话",
                            None,
                        );
                    }
                    (_, None) => {
                        s.repo.push_notification(
                            NotificationKind::System,
                            "Worktree",
                            "这个会话的工作区没有目录",
                            None,
                        );
                    }
                    (Some(thread_id), Some(workspace)) => {
                        match ensure_session_worktree(Path::new(&workspace), &thread_id) {
                            Ok(dest) => {
                                let shown = dest.display().to_string();
                                set_agent_cwd(Some(dest));
                                s.repo.set_thread_cwd(&thread_id, Some(shown.clone()));
                                let now = now_ms();
                                let detail: String = shown.chars().take(160).collect();
                                s.repo.append_agent_event(AgentEvent {
                                    id: create_id(now),
                                    thread_id: thread_id.clone(),
                                    kind: "cwd".into(),
                                    name: "打开 worktree".into(),
                                    detail,
                                    ok: Some(true),
                                    duration_ms: None,
                                    created_at: now,
                                });
                                s.repo.push_notification(
                                    NotificationKind::System,
                                    "Worktree",
                                    &format!("已打开，不会自动合并：{shown}"),
                                    None,
                                );
                            }
                            Err(err) => {
                                s.repo.push_notification(
                                    NotificationKind::System,
                                    "Worktree",
                                    &err.to_string(),
                                    None,
                                );
                            }
                        }
                    }
                }
            }
            if item.id == "agent-worktree-merge" {
                let cwd = s.active_thread_id.as_ref().and_then(|id| {
                    s.repo
                        .get_agent_thread(id)
                        .and_then(|thread| thread.cwd.clone())
                });
                match cwd {
                    None => {
                        s.repo.push_notification(
                            NotificationKind::System,
                            "合并",
                            "当前会话不在 worktree 里",
                            None,
                        );
                    }
                    Some(cwd) => match merge_session_worktree(Path::new(&cwd)) {
                        Ok(message) => {
                            let line = message.lines().next().unwrap_or("已快进合并");
                            if let Some(thread_id) = s.active_thread_id.clone() {
                                let now = now_ms();
                                let detail: String = line.chars().take(160).collect();
                                s.repo.append_agent_event(AgentEvent {
                                    id: create_id(now),
                                    thread_id,
                                    kind: "merge".into(),
                                    name: "快进合并".into(),
                                    detail,
                                    ok: Some(true),
                                    duration_ms: None,
                                    created_at: now,
                                });
                            }
                            s.repo
                                .push_notification(NotificationKind::System, "合并", line, None);
                        }
                        Err(err) => {
                            s.repo.push_notification(
                                NotificationKind::System,
                                "合并",
                                &err.to_string(),
                                None,
                            );
                        }
                    },
                }
            }
            if let Some(path) = item.kb_path {
                s.kb_current_file = Some(path);
                s.nav = AppNav::Knowledge;
                let q = query.trim();
                s.kb_pending_query = if q.is_empty() {
                    None
                } else {
                    Some(q.to_string())
                };
            }
            if item.note_id.is_some() {
                // Workbench notes live under Knowledge; open the pane.
                s.nav = AppNav::Knowledge;
            }
            s.palette_open = false;
        });
        self.state.persist_if_dirty();
        self.state.remember_session();
        if let Some(id) = opened_task {
            self.tasks
                .update(cx, |tasks, cx| tasks.open_task_dialog(Some(id), window, cx))
                .ok();
        }
        self.host.update(cx, |_, cx| cx.notify()).ok();
        cx.notify();
    }

    pub fn focus_query(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.query.focus_handle(cx).focus(window, cx);
    }
}

impl Render for CommandPalette {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let items = self.filtered(cx);
        let entity = cx.weak_entity();

        div()
            .absolute()
            .inset_0()
            .flex()
            .items_start()
            .justify_center()
            .pt_20()
            .bg(cx.theme().overlay.opacity(0.55))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, _, cx| {
                    this.state.with_mut(|s| s.palette_open = false);
                    cx.notify();
                }),
            )
            .child(
                v_flex()
                    .w(px(560.))
                    .max_h(px(420.))
                    .rounded(cx.theme().radius)
                    .bg(cx.theme().background)
                    .border_1()
                    .border_color(cx.theme().border)
                    .p_3()
                    .gap_2()
                    .on_mouse_down(MouseButton::Left, |_, _, _| {})
                    .child(Input::new(&self.query))
                    .child(v_flex().gap_1().overflow_y_scrollbar().children(
                        items.into_iter().map(|item| {
                            let entity = entity.clone();
                            let label = item.label.clone();
                            let kind = item.kind;
                            div()
                                .id(SharedString::from(item.id.clone()))
                                .p_2()
                                .rounded(cx.theme().radius)
                                .hover(|d| d.bg(cx.theme().accent))
                                .cursor_pointer()
                                .child(
                                    h_flex().justify_between().child(label).child(
                                        div()
                                            .text_xs()
                                            .text_color(cx.theme().muted_foreground)
                                            .child(kind),
                                    ),
                                )
                                .on_mouse_down(MouseButton::Left, move |_, window, app| {
                                    if let Some(e) = entity.upgrade() {
                                        e.update(app, |this, cx| {
                                            this.activate(item.clone(), window, cx);
                                        });
                                    }
                                })
                        }),
                    )),
            )
    }
}
