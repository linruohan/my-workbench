//! Right-hand inspector: Files and Git tabs for the current folder.

use crate::app::WorkbenchApp;
use crate::state::{AppNav, AppState};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::tab::{Tab, TabBar};
use gpui_kit::component::*;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use wb_domain::is_text_extension;
use wb_host::{GitSnapshot, KbEntry, git_snapshot, list_dir, list_worktree_files};

#[derive(Clone, Copy, PartialEq, Eq)]
enum InspectorTab {
    Files,
    Git,
}

impl InspectorTab {
    fn index(self) -> usize {
        match self {
            Self::Files => 0,
            Self::Git => 1,
        }
    }

    fn from_index(index: usize) -> Self {
        match index {
            1 => Self::Git,
            _ => Self::Files,
        }
    }
}

pub struct InspectorPane {
    state: AppState,
    host: WeakEntity<WorkbenchApp>,
    filter: Entity<InputState>,
    tab: InspectorTab,
    expanded: HashSet<String>,
    dir_cache: HashMap<String, Vec<KbEntry>>,
    root_key: Option<String>,
    scan_root: Option<String>,
    scan: Vec<KbEntry>,
    git: Option<GitSnapshot>,
    git_at: Instant,
}

impl InspectorPane {
    pub fn new(
        state: AppState,
        host: WeakEntity<WorkbenchApp>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let filter = cx.new(|cx| InputState::new(window, cx).placeholder("筛选文件"));
        let pane = Self {
            state,
            host,
            filter,
            tab: InspectorTab::Files,
            expanded: HashSet::new(),
            dir_cache: HashMap::new(),
            root_key: None,
            scan_root: None,
            scan: Vec::new(),
            git: None,
            git_at: Instant::now() - Duration::from_secs(60),
        };
        cx.spawn(async move |this, async_cx| {
            loop {
                async_cx
                    .background_executor()
                    .timer(Duration::from_secs(5))
                    .await;
                let alive = this
                    .update(async_cx, |this, cx| {
                        this.reload_git();
                        cx.notify();
                    })
                    .is_ok();
                if !alive {
                    break;
                }
            }
        })
        .detach();
        pane
    }

    fn root(&self) -> Option<PathBuf> {
        let nav = self.state.with(|s| s.nav);
        if nav == AppNav::Agent {
            if let Some(path) = self.agent_root() {
                return Some(path);
            }
        }
        self.state.with(|s| {
            s.prefs
                .knowledge_current
                .clone()
                .or_else(|| s.prefs.knowledge_roots.first().cloned())
                .or_else(|| {
                    s.repo
                        .list_agent_workspaces()
                        .into_iter()
                        .find_map(|workspace| workspace.root_path)
                })
                .map(PathBuf::from)
        })
    }

    fn agent_root(&self) -> Option<PathBuf> {
        self.state.with(|s| {
            let workspace_id = s.active_thread_id.as_ref().and_then(|id| {
                s.repo
                    .list_agent_threads()
                    .into_iter()
                    .find(|thread| thread.id == *id)
                    .map(|thread| thread.workspace_id)
            });
            let workspaces = s.repo.list_agent_workspaces();
            let chosen = workspace_id
                .as_ref()
                .and_then(|id| workspaces.iter().find(|workspace| workspace.id == *id))
                .or_else(|| {
                    workspaces
                        .iter()
                        .find(|workspace| workspace.root_path.is_some())
                });
            chosen
                .and_then(|workspace| workspace.root_path.clone())
                .map(PathBuf::from)
        })
    }

    fn sync_root(&mut self) {
        let key = self.root().map(|path| path.to_string_lossy().to_string());
        if self.root_key == key {
            return;
        }
        self.root_key = key;
        self.expanded.clear();
        self.dir_cache.clear();
        self.scan_root = None;
        self.scan.clear();
        self.reload_git();
    }

    fn reload_git(&mut self) {
        self.git = self.root().as_deref().and_then(git_snapshot);
        self.git_at = Instant::now();
    }

    fn refresh(&mut self, cx: &mut Context<Self>) {
        self.dir_cache.clear();
        self.scan_root = None;
        self.scan.clear();
        self.reload_git();
        cx.notify();
    }

    fn entries(&mut self, path: &Path) -> Vec<KbEntry> {
        let key = path.to_string_lossy().to_string();
        if let Some(cached) = self.dir_cache.get(&key) {
            return cached.clone();
        }
        let entries = list_dir(path).unwrap_or_default();
        self.dir_cache.insert(key, entries.clone());
        entries
    }

    fn ensure_scan(&mut self, root: &Path) {
        let key = root.to_string_lossy().to_string();
        if self.scan_root.as_deref() == Some(key.as_str()) {
            return;
        }
        self.scan = list_worktree_files(root, 1500).unwrap_or_default();
        self.scan_root = Some(key);
    }

    fn open_entry(&mut self, path: &str, cx: &mut Context<Self>) {
        let file = PathBuf::from(path);
        let ext = file.extension().and_then(|ext| ext.to_str()).unwrap_or("");
        if !is_text_extension(ext) {
            cx.reveal_path(&file);
            return;
        }
        self.state.with_mut(|s| {
            s.nav = AppNav::Knowledge;
            s.kb_current_file = Some(path.to_string());
        });
        self.host.update(cx, |_, cx| cx.notify()).ok();
        cx.notify();
    }

    fn toggle_dir(&mut self, path: &str, cx: &mut Context<Self>) {
        if !self.expanded.remove(path) {
            self.expanded.insert(path.to_string());
        }
        cx.notify();
    }

    fn add_root(&mut self, cx: &mut Context<Self>) {
        super::prompt_directory(cx, |this, dir, cx| {
            let Some(dir) = dir else {
                return;
            };
            let path = dir.to_string_lossy().to_string();
            this.state.with_mut(|s| {
                if !s.prefs.knowledge_roots.contains(&path) {
                    s.prefs.knowledge_roots.push(path.clone());
                }
                s.prefs.knowledge_current = Some(path.clone());
                s.prefs.knowledge_recent.retain(|item| item != &path);
                s.prefs.knowledge_recent.insert(0, path);
                s.prefs.knowledge_recent.truncate(10);
            });
            this.state.persist_prefs();
            this.root_key = None;
            this.sync_root();
            cx.notify();
        });
    }

    fn file_rows(
        &mut self,
        dir: &Path,
        depth: usize,
        current: Option<&str>,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let entries = self.entries(dir);
        let mut rows = Vec::new();
        let accent = cx.theme().accent;
        let muted = cx.theme().muted_foreground;
        let radius = cx.theme().radius;
        for entry in entries {
            let is_dir = entry.is_dir;
            let open = is_dir && self.expanded.contains(&entry.path);
            let active = !is_dir && current == Some(entry.path.as_str());
            let name = entry.name.clone();
            let path = entry.path.clone();
            let entity = cx.weak_entity();
            rows.push(
                h_flex()
                    .id(SharedString::from(format!("insp-{path}")))
                    .items_center()
                    .gap_1()
                    .py_0p5()
                    .pr_2()
                    .pl(px(8. + depth as f32 * 12.))
                    .rounded(radius)
                    .text_sm()
                    .when(active, |row| row.bg(accent))
                    .hover(|row| row.bg(accent))
                    .cursor_pointer()
                    .child(
                        Icon::new(if is_dir {
                            if open {
                                IconName::FolderOpen
                            } else {
                                IconName::Folder
                            }
                        } else {
                            IconName::File
                        })
                        .text_color(muted),
                    )
                    .child(div().flex_1().overflow_hidden().child(name))
                    .on_click(move |_, _, app| {
                        let Some(view) = entity.upgrade() else {
                            return;
                        };
                        let path = path.clone();
                        if is_dir {
                            view.update(app, |this, cx| this.toggle_dir(&path, cx));
                        } else {
                            view.update(app, |this, cx| this.open_entry(&path, cx));
                        }
                    })
                    .into_any_element(),
            );
            if open {
                rows.extend(self.file_rows(Path::new(&entry.path), depth + 1, current, cx));
            }
        }
        rows
    }
}

impl Render for InspectorPane {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_root();
        if self.git_at.elapsed() > Duration::from_secs(5) {
            self.reload_git();
        }
        let collapsed = self.state.with(|s| s.prefs.right_sidebar_collapsed);
        let host = self.host.clone();
        if collapsed {
            return v_flex()
                .size_full()
                .bg(cx.theme().sidebar)
                .border_l_1()
                .border_color(cx.theme().sidebar_border)
                .items_center()
                .pt_2()
                .child(
                    Button::new("insp-expand")
                        .xsmall()
                        .ghost()
                        .icon(IconName::ChevronLeft)
                        .tooltip("展开右侧栏")
                        .on_click(move |_, window, app| {
                            if let Some(e) = host.upgrade() {
                                e.update(app, |this, cx| this.toggle_right_collapsed(window, cx));
                            }
                        }),
                )
                .into_any_element();
        }
        let root = self.root();
        let tab = self.tab;
        let muted = cx.theme().muted_foreground;
        let border = cx.theme().sidebar_border;
        let git = self.git.clone();
        let change_count = git.as_ref().map(|snap| snap.changes.len()).unwrap_or(0);

        let file_body = if tab != InspectorTab::Files {
            div().into_any_element()
        } else if let Some(root) = root.clone() {
            let filter_raw = self.filter.read(cx).value().to_string();
            let filter = filter_raw.trim().to_lowercase();
            let current = self.state.with(|s| s.kb_current_file.clone());
            if filter.is_empty() {
                let rows = self.file_rows(&root, 0, current.as_deref(), cx);
                let mut list = v_flex().gap_0p5();
                if rows.is_empty() {
                    list = list.child(
                        div()
                            .px_3()
                            .text_xs()
                            .text_color(muted)
                            .child("这个目录是空的"),
                    );
                } else {
                    list = list.children(rows);
                }
                list.into_any_element()
            } else {
                self.ensure_scan(&root);
                let hits: Vec<_> = self
                    .scan
                    .iter()
                    .filter(|entry| {
                        entry.relative.to_lowercase().contains(&filter)
                            || entry.name.to_lowercase().contains(&filter)
                    })
                    .take(80)
                    .cloned()
                    .collect();
                let entity = cx.weak_entity();
                let accent = cx.theme().accent;
                let radius = cx.theme().radius;
                let mut list = v_flex().gap_0p5();
                if hits.is_empty() {
                    list = list.child(
                        div()
                            .px_3()
                            .text_xs()
                            .text_color(muted)
                            .child("没有匹配的文件"),
                    );
                } else {
                    list = list.children(hits.into_iter().map(|entry| {
                        let path = entry.path.clone();
                        let entity = entity.clone();
                        let active = current.as_deref() == Some(path.as_str());
                        h_flex()
                            .id(SharedString::from(format!("insp-hit-{path}")))
                            .items_center()
                            .gap_1()
                            .px_2()
                            .py_0p5()
                            .rounded(radius)
                            .text_sm()
                            .when(active, |row| row.bg(accent))
                            .hover(|row| row.bg(accent))
                            .cursor_pointer()
                            .child(Icon::new(IconName::File).text_color(muted))
                            .child(div().flex_1().child(entry.relative))
                            .on_click(move |_, _, app| {
                                let Some(view) = entity.upgrade() else {
                                    return;
                                };
                                let path = path.clone();
                                view.update(app, |this, cx| this.open_entry(&path, cx));
                            })
                    }));
                }
                list.into_any_element()
            }
        } else {
            div()
                .px_3()
                .text_xs()
                .text_color(muted)
                .child("打开知识库或带目录的 Agent 工作区后，这里显示文件。")
                .into_any_element()
        };

        let root_label = root
            .as_ref()
            .and_then(|path| {
                path.file_name()
                    .map(|name| name.to_string_lossy().to_string())
            })
            .unwrap_or_else(|| "未选择目录".into());

        v_flex()
            .size_full()
            .min_w_0()
            .bg(cx.theme().sidebar)
            .text_color(cx.theme().sidebar_foreground)
            .border_l_1()
            .border_color(border)
            .child(
                h_flex()
                    .px_2()
                    .h(px(44.))
                    .items_center()
                    .gap_1()
                    .border_b_1()
                    .border_color(border)
                    .child(Icon::new(IconName::Folder).text_color(muted))
                    .child(
                        div()
                            .flex_1()
                            .text_sm()
                            .font_weight(FontWeight::MEDIUM)
                            .overflow_hidden()
                            .child(root_label),
                    )
                    .child(
                        Button::new("insp-refresh")
                            .xsmall()
                            .ghost()
                            .icon(IconName::RefreshCw)
                            .on_click(cx.listener(|this, _, _, cx| this.refresh(cx))),
                    )
                    .child({
                        let host = self.host.clone();
                        Button::new("insp-collapse")
                            .xsmall()
                            .ghost()
                            .icon(IconName::ChevronRight)
                            .tooltip("收起右侧栏")
                            .on_click(move |_, window, app| {
                                if let Some(e) = host.upgrade() {
                                    e.update(app, |this, cx| {
                                        this.toggle_right_collapsed(window, cx)
                                    });
                                }
                            })
                    })
                    .when(root.is_none(), |row| {
                        row.child(
                            Button::new("insp-add")
                                .xsmall()
                                .ghost()
                                .icon(IconName::Plus)
                                .on_click(cx.listener(|this, _, _, cx| this.add_root(cx))),
                        )
                    }),
            )
            .child(
                div().px_2().border_b_1().border_color(border).child(
                    TabBar::new("insp-tabs")
                        .underline()
                        .small()
                        .w_full()
                        .selected_index(tab.index())
                        .child(Tab::new().label("文件"))
                        .child(Tab::new().label("Git").when(change_count > 0, |tab| {
                            tab.suffix(
                                div()
                                    .text_xs()
                                    .text_color(muted)
                                    .child(change_count.to_string()),
                            )
                        }))
                        .on_click(cx.listener(|this, index, _, cx| {
                            this.tab = InspectorTab::from_index(*index);
                            cx.notify();
                        })),
                ),
            )
            .child(
                v_flex().flex_1().min_h_0().child(match tab {
                    InspectorTab::Files => v_flex()
                        .size_full()
                        .child(
                            div()
                                .px_2()
                                .py_2()
                                .child(Input::new(&self.filter).cleanable(true)),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_h_0()
                                .px_1()
                                .overflow_y_scrollbar()
                                .child(file_body),
                        )
                        .into_any_element(),
                    InspectorTab::Git => self.git_panel(git, muted, cx).into_any_element(),
                }),
            )
            .into_any_element()
    }
}

impl InspectorPane {
    fn git_panel(
        &self,
        git: Option<GitSnapshot>,
        muted: impl Into<Hsla>,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let muted = muted.into();
        let root = self.root();
        let mut body = v_flex()
            .size_full()
            .min_h_0()
            .px_3()
            .py_2()
            .gap_1()
            .overflow_y_scrollbar();
        match git {
            None => {
                body = body.child(div().text_xs().text_color(muted).child(if root.is_some() {
                    "当前目录不是 Git 仓库"
                } else {
                    "选择目录后显示分支和改动"
                }));
            }
            Some(snapshot) => {
                let branch = if snapshot.branch.is_empty() {
                    "未知分支".to_string()
                } else {
                    snapshot.branch
                };
                body = body.child(div().text_sm().child(branch));
                if snapshot.changes.is_empty() {
                    body = body.child(div().text_xs().text_color(muted).child("工作区干净"));
                } else {
                    let entity = cx.weak_entity();
                    let root = root.clone();
                    body = body.child(
                        div()
                            .text_xs()
                            .text_color(muted)
                            .child(format!("{} 个改动", snapshot.changes.len())),
                    );
                    body = body.children(snapshot.changes.into_iter().take(80).map(|change| {
                        let path = change.path.clone();
                        let entity = entity.clone();
                        let root = root.clone();
                        h_flex()
                            .id(SharedString::from(format!("git-{path}")))
                            .gap_2()
                            .items_center()
                            .py_0p5()
                            .text_xs()
                            .cursor_pointer()
                            .hover(|row| row.bg(cx.theme().accent))
                            .child(div().w(px(28.)).text_color(muted).child(
                                if change.status.is_empty() {
                                    "·".to_string()
                                } else {
                                    change.status
                                },
                            ))
                            .child(div().flex_1().child(path.clone()))
                            .on_click(move |_, _, app| {
                                let Some(view) = entity.upgrade() else {
                                    return;
                                };
                                let Some(root) = root.clone() else {
                                    return;
                                };
                                if path.contains(" -> ") {
                                    return;
                                }
                                let abs = root.join(&path);
                                if abs.is_file() {
                                    let abs = abs.to_string_lossy().to_string();
                                    view.update(app, |this, cx| this.open_entry(&abs, cx));
                                }
                            })
                    }));
                }
            }
        }
        body
    }
}
