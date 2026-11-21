use crate::state::{AppNav, AppState};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::*;
use gpui_kit::*;

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
    query: Entity<InputState>,
    _subs: Vec<Subscription>,
}

impl CommandPalette {
    pub fn new(state: AppState, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let query =
            cx.new(|cx| InputState::new(window, cx).placeholder("搜索任务、会话、笔记、页面…"));
        let mut this = Self {
            state,
            query: query.clone(),
            _subs: Vec::new(),
        };
        this._subs.push(
            cx.subscribe_in(&query, window, |this, _, event, _window, cx| {
                if matches!(event, InputEvent::Change | InputEvent::PressEnter { .. }) {
                    cx.notify();
                }
                if let InputEvent::PressEnter { .. } = event {
                    if let Some(item) = this.filtered(cx).into_iter().next() {
                        this.activate(item, cx);
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
            if let Some(root) = s
                .prefs
                .knowledge_current
                .clone()
                .or_else(|| s.prefs.knowledge_roots.first().cloned())
            {
                if let Ok(files) = wb_host::list_files_recursive(std::path::Path::new(&root), 400) {
                    for f in files.into_iter().filter(|e| !e.is_dir) {
                        items.push(PaletteItem {
                            id: format!("kb-{}", f.path),
                            label: f.relative.clone(),
                            kind: "知识库",
                            nav: Some(AppNav::Knowledge),
                            task_id: None,
                            thread_id: None,
                            note_id: None,
                            kb_path: Some(f.path),
                        });
                    }
                }
            }
        });
        items
    }

    fn filtered(&self, cx: &App) -> Vec<PaletteItem> {
        let q = self.query.read(cx).value().to_lowercase();
        self.all_items()
            .into_iter()
            .filter(|i| q.is_empty() || i.label.to_lowercase().contains(&q) || i.kind.contains(&q))
            .take(30)
            .collect()
    }

    fn activate(&mut self, item: PaletteItem, cx: &mut Context<Self>) {
        self.state.with_mut(|s| {
            if let Some(nav) = item.nav {
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
                s.nav = AppNav::Projects;
            }
            if let Some(id) = item.thread_id {
                s.active_thread_id = Some(id);
            }
            if let Some(path) = item.kb_path {
                s.kb_current_file = Some(path);
                s.nav = AppNav::Knowledge;
            }
            if item.note_id.is_some() {
                // Workbench notes live under Knowledge; open the pane.
                s.nav = AppNav::Knowledge;
            }
            s.palette_open = false;
        });
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
                                .on_mouse_down(MouseButton::Left, move |_, _, app| {
                                    if let Some(e) = entity.upgrade() {
                                        e.update(app, |this, cx| {
                                            this.activate(item.clone(), cx);
                                        });
                                    }
                                })
                        }),
                    )),
            )
    }
}
