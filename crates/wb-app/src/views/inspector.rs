//! Right-hand inspector: Files and Git tabs for the current folder.

use crate::app::WorkbenchApp;
use crate::state::{AppNav, AppState};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::menu::{ContextMenuExt as _, PopupMenuItem};
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::*;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::{Duration, Instant};
use wb_domain::{AgentEvent, create_id, is_text_extension, now_ms};
use wb_host::{
    GitSnapshot, KbEntry, ensure_session_worktree, git_branches, git_checkout, git_commit_show,
    git_diff_head, git_fetch, git_file_diff, git_init, git_recent_log, git_remote_branches,
    git_remotes, git_snapshot, git_worktree_list, global_terminals, list_dir, list_worktree_files,
    merge_session_worktree, set_agent_cwd, spill_dir,
};

/// Agent 会话右侧栏，对齐参考应用的可切换轨道：终端、文件、Git、任务。
#[derive(Clone, Copy, PartialEq, Eq)]
enum GitSection {
    Changes,
    Branches,
    Log,
    Worktrees,
    Diff3,
    Remote,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum BranchScope {
    All,
    Local,
    Remote,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum MissionTab {
    Goal,
    Todos,
    Gate,
    Log,
    Artifacts,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum AgentRailTab {
    Terminal,
    Files,
    Git,
    Mission,
    Visualizer,
}

impl AgentRailTab {
    fn index(self) -> usize {
        match self {
            Self::Terminal => 0,
            Self::Files => 1,
            Self::Git => 2,
            Self::Mission => 3,
            Self::Visualizer => 4,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Terminal => "终端",
            Self::Files => "文件",
            Self::Git => "Git",
            Self::Mission => "任务",
            Self::Visualizer => "可视化",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum InspectorTab {
    Files,
    Git,
    Events,
}

impl InspectorTab {
    fn index(self) -> usize {
        match self {
            Self::Files => 0,
            Self::Git => 1,
            Self::Events => 2,
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
    git_note: Option<String>,
    agent_tab: AgentRailTab,
    term_id: Option<String>,
    term_input: Entity<InputState>,
    term_note: Option<String>,
    /// Path and text of the file opened inside the agent file tab.
    file_preview: Option<(String, String)>,
    git_diff: Option<(String, String)>,
    git_section: GitSection,
    git_branches: Vec<String>,
    git_remote_branches: Vec<String>,
    branch_scope: BranchScope,
    /// 时间线回放到第几条（从新到旧）。None 表示看到最新。
    event_cursor: Option<usize>,
    git_log: Vec<String>,
    git_worktrees: Vec<(String, String)>,
    git_remotes: Vec<String>,
    rename_from: Option<String>,
    /// 0 蜂群三维，1 依赖图，2 核图谱。
    viz_mode: u8,
    viz_yaw: f32,
    viz_pitch: f32,
    viz_drag: Option<(f32, f32, f32, f32)>,
    viz_focus: Option<String>,
    dep_focus: Option<String>,
    nucleus_focus: Option<String>,
    nucleus_zoom: f32,
    /// 0 全部，1 孤立，2 断链。
    nucleus_filter: u8,
    dep_key: Option<String>,
    dep_graph: crate::views::visualizer::VizGraph,
    nucleus_key: Option<String>,
    nucleus_graph: crate::views::visualizer::VizGraph,
    viz_hits: crate::views::visualizer::VizHits,
    mission_tab: MissionTab,
    _subs: Vec<Subscription>,
}

impl InspectorPane {
    pub fn new(
        state: AppState,
        host: WeakEntity<WorkbenchApp>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let filter = cx.new(|cx| InputState::new(window, cx).placeholder("筛选文件"));
        let term_input = cx.new(|cx| InputState::new(window, cx).placeholder("输入命令，回车发送"));
        let mut pane = Self {
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
            git_note: None,
            agent_tab: AgentRailTab::Terminal,
            term_id: None,
            term_input,
            term_note: None,
            file_preview: None,
            git_diff: None,
            git_section: GitSection::Changes,
            git_branches: Vec::new(),
            git_remote_branches: Vec::new(),
            branch_scope: BranchScope::All,
            event_cursor: None,
            git_log: Vec::new(),
            git_worktrees: Vec::new(),
            git_remotes: Vec::new(),
            rename_from: None,
            viz_mode: 0,
            viz_yaw: 0.4,
            viz_pitch: 0.2,
            viz_drag: None,
            viz_focus: None,
            dep_focus: None,
            nucleus_focus: None,
            nucleus_zoom: 1.0,
            nucleus_filter: 0,
            dep_key: None,
            dep_graph: crate::views::visualizer::VizGraph::default(),
            nucleus_key: None,
            nucleus_graph: crate::views::visualizer::VizGraph::default(),
            viz_hits: Rc::new(RefCell::new(Vec::new())),
            mission_tab: MissionTab::Goal,
            _subs: Vec::new(),
        };
        pane._subs.push(cx.subscribe_in(
            &pane.term_input,
            window,
            |this, input, event, window, cx| {
                if let InputEvent::PressEnter { .. } = event {
                    let text = input.read(cx).value().to_string();
                    if text.trim().is_empty() {
                        return;
                    }
                    this.send_terminal(&text, cx);
                    input.update(cx, |input, cx| input.set_value("", window, cx));
                }
            },
        ));
        cx.spawn(async move |this, async_cx| {
            loop {
                async_cx
                    .background_executor()
                    .timer(Duration::from_millis(400))
                    .await;
                let alive = this
                    .update(async_cx, |this, cx| {
                        let agent = this.state.with(|s| s.nav) == AppNav::Agent;
                        if agent
                            && (this.agent_tab == AgentRailTab::Terminal
                                || this.agent_tab == AgentRailTab::Visualizer)
                        {
                            if this.agent_tab == AgentRailTab::Visualizer && this.viz_drag.is_none()
                            {
                                this.viz_yaw += 0.03;
                            }
                            cx.notify();
                        }
                    })
                    .is_ok();
                if !alive {
                    break;
                }
            }
        })
        .detach();
        cx.spawn(async move |this, async_cx| {
            loop {
                async_cx
                    .background_executor()
                    .timer(Duration::from_secs(5))
                    .await;
                let alive = this
                    .update(async_cx, |this, cx| {
                        this.reload_git(cx);
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
                .or_else(|| s.repo.agent_workspace_with_root())
                .map(PathBuf::from)
        })
    }

    fn agent_root(&self) -> Option<PathBuf> {
        self.state.with(|s| {
            let thread = s
                .active_thread_id
                .as_ref()
                .and_then(|id| s.repo.get_agent_thread(id));
            if let Some(cwd) = thread.as_ref().and_then(|thread| thread.cwd.clone()) {
                let path = PathBuf::from(&cwd);
                if path.is_dir() {
                    return Some(path);
                }
            }
            let workspace_id = thread.as_ref().map(|thread| thread.workspace_id.clone());
            workspace_id
                .as_deref()
                .and_then(|id| s.repo.get_agent_workspace(id))
                .and_then(|workspace| workspace.root_path.clone())
                .or_else(|| {
                    s.repo
                        .earliest_agent_workspace()
                        .and_then(|workspace| workspace.root_path.clone())
                })
                .or_else(|| s.repo.agent_workspace_with_root())
                .map(PathBuf::from)
        })
    }

    fn merge_worktree(&mut self, cx: &mut Context<Self>) {
        let Some(root) = self.root() else {
            return;
        };
        match merge_session_worktree(&root) {
            Ok(message) => {
                if let Some(thread_id) = self.state.with(|s| s.active_thread_id.clone()) {
                    let line = message.lines().next().unwrap_or("已快进合并");
                    self.note_session(&thread_id, "merge", "快进合并", line);
                }
                self.git_note = Some(message);
            }
            Err(err) => self.git_note = Some(err.to_string()),
        }
        self.reload_git(cx);
        self.host.update(cx, |_, cx| cx.notify()).ok();
        cx.notify();
    }

    fn open_session_worktree(&mut self, cx: &mut Context<Self>) {
        let (thread_id, workspace) = self.state.with(|s| {
            let thread_id = s.active_thread_id.clone();
            let workspace = thread_id.as_ref().and_then(|id| {
                let thread = s.repo.get_agent_thread(id)?;
                s.repo
                    .list_agent_workspaces()
                    .into_iter()
                    .find(|workspace| workspace.id == thread.workspace_id)
                    .and_then(|workspace| workspace.root_path)
            });
            (thread_id, workspace)
        });
        let Some(thread_id) = thread_id else {
            self.git_note = Some("先打开一个会话".into());
            cx.notify();
            return;
        };
        let Some(workspace) = workspace else {
            self.git_note = Some("这个会话的工作区没有目录".into());
            cx.notify();
            return;
        };
        match ensure_session_worktree(Path::new(&workspace), &thread_id) {
            Ok(dest) => {
                let shown = dest.display().to_string();
                set_agent_cwd(Some(dest));
                self.state.with_mut(|s| {
                    s.repo.set_thread_cwd(&thread_id, Some(shown.clone()));
                });
                self.note_session(&thread_id, "cwd", "打开 worktree", &shown);
                self.state.persist_if_dirty();
                self.root_key = None;
                self.git_note = Some(format!("已打开 worktree，不会自动合并：{shown}"));
            }
            Err(err) => self.git_note = Some(err.to_string()),
        }
        self.reload_git(cx);
        self.host
            .update(cx, |app, cx| {
                app.refresh_agent_branch(cx);
                cx.notify();
            })
            .ok();
        cx.notify();
    }

    fn use_worktree(&mut self, path: String, cx: &mut Context<Self>) {
        let dir = PathBuf::from(&path);
        if !dir.is_dir() {
            self.git_note = Some("这个工作树目录不存在".into());
            cx.notify();
            return;
        }
        let thread_id = self.state.with(|s| s.active_thread_id.clone());
        let Some(thread_id) = thread_id else {
            self.git_note = Some("先打开一个会话".into());
            cx.notify();
            return;
        };
        set_agent_cwd(Some(dir));
        self.state.with_mut(|s| {
            s.repo.set_thread_cwd(&thread_id, Some(path.clone()));
        });
        self.note_session(&thread_id, "cwd", "切换目录", &path);
        self.state.persist_if_dirty();
        self.root_key = None;
        self.git_note = Some(format!("会话目录已切到 {path}"));
        self.git_section = GitSection::Changes;
        self.reload_git(cx);
        self.host
            .update(cx, |app, cx| {
                app.refresh_agent_branch(cx);
                cx.notify();
            })
            .ok();
        cx.notify();
    }

    fn note_session(&mut self, thread_id: &str, kind: &str, name: &str, detail: &str) {
        let detail: String = detail.chars().take(160).collect();
        let now = now_ms();
        self.state.with_mut(|s| {
            s.repo.append_agent_event(AgentEvent {
                id: create_id(now),
                thread_id: thread_id.to_string(),
                kind: kind.to_string(),
                name: name.to_string(),
                detail,
                ok: Some(true),
                duration_ms: None,
                created_at: now,
            });
        });
        self.state.persist_if_dirty();
    }

    fn sync_root(&mut self, cx: &mut Context<Self>) {
        let key = self.root().map(|path| path.to_string_lossy().to_string());
        if self.root_key == key {
            return;
        }
        self.root_key = key;
        self.term_id = None;
        self.expanded.clear();
        self.dir_cache.clear();
        self.scan_root = None;
        self.scan.clear();
        self.reload_git(cx);
    }

    fn reload_git(&mut self, cx: &mut Context<Self>) {
        let Some(root) = self.root() else {
            self.git = None;
            self.git_at = Instant::now();
            return;
        };
        // Stamp first so a paint during the scan does not start another `git` process.
        self.git_at = Instant::now();
        let root_key = root.to_string_lossy().to_string();
        cx.spawn(async move |this, cx| {
            let snap = cx
                .background_executor()
                .spawn(async move { git_snapshot(&root) })
                .await;
            this.update(cx, |this, cx| {
                let current = this.root().map(|path| path.to_string_lossy().to_string());
                if current.as_deref() != Some(root_key.as_str()) {
                    return;
                }
                this.git = snap;
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn load_git_diff(&mut self, root: PathBuf, path: String, cx: &mut Context<Self>) {
        self.git_note = Some("正在读取差异…".into());
        cx.notify();
        cx.spawn(async move |this, async_cx| {
            let result = async_cx
                .background_executor()
                .spawn(async move { git_file_diff(&root, &path).map(|text| (path, text)) })
                .await;
            let _ = this.update(async_cx, |this, cx| {
                match result {
                    Ok(pair) => {
                        this.git_diff = Some(pair);
                        this.git_note = None;
                    }
                    Err(err) => this.git_note = Some(err.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn load_git_lists(&mut self, cx: &mut Context<Self>) {
        let Some(root) = self.root() else {
            return;
        };
        cx.spawn(async move |this, async_cx| {
            let result = async_cx
                .background_executor()
                .spawn(async move {
                    let branches = git_branches(&root);
                    let remote_branches = git_remote_branches(&root);
                    let log = git_recent_log(&root);
                    let worktrees = git_worktree_list(&root);
                    let remotes = git_remotes(&root);
                    (branches, remote_branches, log, worktrees, remotes)
                })
                .await;
            let _ = this.update(async_cx, |this, cx| {
                match result.0 {
                    Ok(rows) => this.git_branches = rows,
                    Err(err) => this.git_note = Some(err.to_string()),
                }
                if let Ok(rows) = result.1 {
                    this.git_remote_branches = rows;
                }
                if let Ok(rows) = result.2 {
                    this.git_log = rows;
                }
                if let Ok(rows) = result.3 {
                    this.git_worktrees = rows;
                }
                if let Ok(rows) = result.4 {
                    this.git_remotes = rows;
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn load_diff_head(&mut self, cx: &mut Context<Self>) {
        let Some(root) = self.root() else {
            return;
        };
        self.git_note = Some("正在比较工作区与 HEAD…".into());
        cx.notify();
        cx.spawn(async move |this, async_cx| {
            let result = async_cx
                .background_executor()
                .spawn(async move { git_diff_head(&root) })
                .await;
            let _ = this.update(async_cx, |this, cx| {
                match result {
                    Ok(text) => {
                        this.git_diff = Some(("工作区 / HEAD".into(), text));
                        this.git_note = None;
                    }
                    Err(err) => this.git_note = Some(err.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn fetch_remote(&mut self, cx: &mut Context<Self>) {
        let Some(root) = self.root() else {
            return;
        };
        self.git_note = Some("正在获取远程…".into());
        cx.notify();
        cx.spawn(async move |this, async_cx| {
            let result = async_cx
                .background_executor()
                .spawn(async move { git_fetch(&root) })
                .await;
            let _ = this.update(async_cx, |this, cx| {
                this.git_note = Some(match result {
                    Ok(message) => message,
                    Err(err) => err.to_string(),
                });
                this.load_git_lists(cx);
                this.reload_git(cx);
                cx.notify();
            });
        })
        .detach();
    }

    fn load_commit(&mut self, rev: String, cx: &mut Context<Self>) {
        let Some(root) = self.root() else {
            return;
        };
        self.git_note = Some("正在读取提交…".into());
        cx.notify();
        cx.spawn(async move |this, async_cx| {
            let result = async_cx
                .background_executor()
                .spawn(async move { git_commit_show(&root, &rev).map(|text| (rev, text)) })
                .await;
            let _ = this.update(async_cx, |this, cx| {
                match result {
                    Ok(pair) => {
                        this.git_diff = Some(pair);
                        this.git_section = GitSection::Changes;
                        this.git_note = None;
                    }
                    Err(err) => this.git_note = Some(err.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn checkout_branch(&mut self, branch: String, cx: &mut Context<Self>) {
        let Some(root) = self.root() else {
            return;
        };
        cx.spawn(async move |this, async_cx| {
            let result = async_cx
                .background_executor()
                .spawn(async move { git_checkout(&root, &branch) })
                .await;
            let _ = this.update(async_cx, |this, cx| {
                let note = match &result {
                    Ok(message) if message.is_empty() => "已切换分支".to_string(),
                    Ok(message) => message.clone(),
                    Err(err) => err.to_string(),
                };
                if result.is_ok() {
                    if let Some(thread_id) = this.state.with(|s| s.active_thread_id.clone()) {
                        this.note_session(&thread_id, "branch", "切换分支", &note);
                    }
                    this.host
                        .update(cx, |app, cx| app.refresh_agent_branch(cx))
                        .ok();
                }
                this.git_note = Some(note);
                this.reload_git(cx);
                this.load_git_lists(cx);
                cx.notify();
            });
        })
        .detach();
    }

    fn init_git(&mut self, cx: &mut Context<Self>) {
        let Some(root) = self.root() else {
            return;
        };
        self.git_note = Some(match git_init(&root) {
            Ok(message) => message,
            Err(err) => err.to_string(),
        });
        self.reload_git(cx);
        cx.notify();
    }

    fn send_terminal(&mut self, text: &str, cx: &mut Context<Self>) {
        let cwd = self.root();
        let id = if let Some(id) = self.term_id.clone() {
            id
        } else {
            let shell = self.state.terminal_program();
            match global_terminals().open(&shell, cwd.as_deref()) {
                Ok(id) => {
                    self.term_id = Some(id.clone());
                    id
                }
                Err(err) => {
                    self.term_note = Some(err.to_string());
                    cx.notify();
                    return;
                }
            }
        };
        let text = text.to_string();
        self.term_note = Some("正在发送…".into());
        cx.notify();
        cx.spawn(async move |this, async_cx| {
            let result = async_cx
                .background_executor()
                .spawn(async move { global_terminals().send(&id, &text) })
                .await;
            let _ = this.update(async_cx, |this, cx| {
                match result {
                    Ok(_) => this.term_note = None,
                    Err(err) => {
                        this.term_id = None;
                        this.term_note = Some(err.to_string());
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn close_terminal(&mut self, id: &str, cx: &mut Context<Self>) {
        global_terminals().close(id);
        if self.term_id.as_deref() == Some(id) {
            self.term_id = None;
        }
        cx.notify();
    }

    fn create_agent_path(&mut self, folder: bool, cx: &mut Context<Self>) {
        let Some(root) = self.root() else {
            self.git_note = Some("先选择会话目录".into());
            cx.notify();
            return;
        };
        let name = self.filter.read(cx).value().trim().replace('\\', "/");
        if name.is_empty() || name.contains("..") || name.starts_with('/') {
            self.git_note = Some("在筛选框输入相对路径，再点新建".into());
            cx.notify();
            return;
        }
        let dest = root.join(&name);
        let result = if folder {
            std::fs::create_dir_all(&dest)
        } else {
            if let Some(parent) = dest.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&dest)
                .map(|_| ())
        };
        match result {
            Ok(()) => {
                self.git_note = None;
                self.refresh(cx);
                if !folder {
                    self.open_agent_file(&dest.to_string_lossy(), cx);
                }
            }
            Err(err) => {
                self.git_note = Some(err.to_string());
                cx.notify();
            }
        }
    }

    fn refresh(&mut self, cx: &mut Context<Self>) {
        self.dir_cache.clear();
        self.scan_root = None;
        self.scan.clear();
        self.reload_git(cx);
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
        if self.state.with(|s| s.nav) == AppNav::Agent {
            self.open_agent_file(path, cx);
            return;
        }
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
            this.sync_root(cx);
            cx.notify();
        });
    }

    fn file_rows(
        &mut self,
        dir: &Path,
        depth: usize,
        current: Option<&str>,
        agent_nav: bool,
        root: Option<&Path>,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let entries = self.entries(dir);
        let mut rows = Vec::new();
        let accent = cx.theme().accent;
        let muted = cx.theme().muted_foreground;
        let surface = cx.theme().secondary;
        for entry in entries {
            let is_dir = entry.is_dir;
            let open = is_dir && self.expanded.contains(&entry.path);
            let active = !is_dir && current == Some(entry.path.as_str());
            let name = entry.name.clone();
            let path = entry.path.clone();
            let entity = cx.weak_entity();
            let row = h_flex()
                .id(SharedString::from(format!("insp-{path}")))
                .items_center()
                .gap_1()
                .py_1()
                .pr_2()
                .pl(px(8. + depth as f32 * 12.))
                .rounded_md()
                .text_xs()
                .when(active, |row| row.bg(surface).text_color(accent))
                .hover(|row| row.bg(surface))
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
                .on_click({
                    let entity = entity.clone();
                    let path = path.clone();
                    move |_, _, app| {
                        let Some(view) = entity.upgrade() else {
                            return;
                        };
                        let path = path.clone();
                        if is_dir {
                            view.update(app, |this, cx| this.toggle_dir(&path, cx));
                        } else {
                            view.update(app, |this, cx| this.open_entry(&path, cx));
                        }
                    }
                });
            let row = if agent_nav {
                let menu_path = path.clone();
                let relative = root
                    .and_then(|root| {
                        Path::new(&path)
                            .strip_prefix(root)
                            .ok()
                            .map(|rel| rel.to_string_lossy().replace('\\', "/"))
                    })
                    .filter(|rel| !rel.is_empty())
                    .unwrap_or_else(|| path.clone());
                let mention = if is_dir {
                    relative
                } else {
                    format!("@{relative}")
                };
                let reveal_path = path.clone();
                let delete_path = path.clone();
                let entity_reveal = entity.clone();
                let entity_delete = entity.clone();
                row.context_menu(move |menu, _, _| {
                    let copy_path = menu_path.clone();
                    menu.item(PopupMenuItem::new("复制路径").on_click(move |_, _, app| {
                        app.write_to_clipboard(gpui::ClipboardItem::new_string(copy_path.clone()));
                    }))
                    .item({
                        let mention = mention.clone();
                        PopupMenuItem::new("复制引用").on_click(move |_, _, app| {
                            app.write_to_clipboard(gpui::ClipboardItem::new_string(
                                mention.clone(),
                            ));
                        })
                    })
                    .item({
                        let reveal_path = reveal_path.clone();
                        let entity_reveal = entity_reveal.clone();
                        PopupMenuItem::new("在资源管理器中显示").on_click(move |_, _, app| {
                            let Some(view) = entity_reveal.upgrade() else {
                                return;
                            };
                            let reveal_path = reveal_path.clone();
                            view.update(app, |_, cx| {
                                cx.reveal_path(Path::new(&reveal_path));
                            });
                        })
                    })
                    .item({
                        let rename_path = menu_path.clone();
                        let entity_rename = entity_reveal.clone();
                        PopupMenuItem::new("重命名").on_click(move |_, _, app| {
                            let Some(view) = entity_rename.upgrade() else {
                                return;
                            };
                            let rename_path = rename_path.clone();
                            view.update(app, |this, cx| {
                                this.rename_from = Some(rename_path);
                                this.git_note = Some("在筛选框填写新文件名，再点确认重命名".into());
                                cx.notify();
                            });
                        })
                    })
                    .item({
                        let delete_path = delete_path.clone();
                        let entity_delete = entity_delete.clone();
                        PopupMenuItem::new(if is_dir {
                            "删除文件夹"
                        } else {
                            "删除文件"
                        })
                        .on_click(move |_, _, app| {
                            let Some(view) = entity_delete.upgrade() else {
                                return;
                            };
                            let delete_path = delete_path.clone();
                            view.update(app, |this, cx| {
                                this.delete_agent_entry(&delete_path, is_dir, cx);
                            });
                        })
                    })
                })
                .into_any_element()
            } else {
                row.into_any_element()
            };
            rows.push(row);
            if open {
                rows.extend(self.file_rows(
                    Path::new(&entry.path),
                    depth + 1,
                    current,
                    agent_nav,
                    root,
                    cx,
                ));
            }
        }
        rows
    }
}

impl Render for InspectorPane {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_root(cx);
        if self.git_at.elapsed() > Duration::from_secs(5) {
            self.reload_git(cx);
        }
        let nav = self.state.with(|s| s.nav);
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

        let file_body = if nav != AppNav::Agent && tab != InspectorTab::Files {
            div().into_any_element()
        } else if let Some(root) = root.clone() {
            let filter_raw = self.filter.read(cx).value().to_string();
            let filter = filter_raw.trim().to_lowercase();
            let current = self.state.with(|s| s.kb_current_file.clone());
            if filter.is_empty() {
                let rows = self.file_rows(
                    &root,
                    0,
                    current.as_deref(),
                    nav == AppNav::Agent,
                    Some(&root),
                    cx,
                );
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
                            .py_1()
                            .rounded_md()
                            .text_xs()
                            .when(active, |row| {
                                row.bg(cx.theme().secondary).text_color(accent)
                            })
                            .hover(|row| row.bg(cx.theme().secondary))
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

        if nav == AppNav::Agent {
            return self
                .render_agent_rail(
                    root,
                    root_label,
                    git,
                    change_count,
                    file_body,
                    muted,
                    border,
                    cx,
                )
                .into_any_element();
        }

        let host = self.host.clone();
        let accent = cx.theme().accent;
        let tabs = h_flex()
            .id("inspector-capsule-tabs")
            .items_center()
            .gap_1()
            .p_1()
            .rounded_full()
            .bg(cx.theme().secondary)
            .border_1()
            .border_color(border)
            .flex_1()
            .min_w_0()
            .overflow_x_scrollbar()
            .children(
                [
                    (InspectorTab::Files, "文件".to_string()),
                    (
                        InspectorTab::Git,
                        if change_count > 0 {
                            format!("Git {change_count}")
                        } else {
                            "Git".into()
                        },
                    ),
                    (InspectorTab::Events, "事件".into()),
                ]
                .into_iter()
                .map(|(item, label)| {
                    let selected = item == tab;
                    div()
                        .id(("insp-tab-pill", item.index()))
                        .flex_shrink_0()
                        .px_3()
                        .py_1()
                        .rounded_full()
                        .text_xs()
                        .cursor_pointer()
                        .when(selected, |pill| {
                            pill.bg(border)
                                .text_color(accent)
                                .font_weight(gpui::FontWeight::BOLD)
                        })
                        .when(!selected, |pill| {
                            pill.text_color(muted).hover(|pill| pill.text_color(accent))
                        })
                        .child(label)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.tab = item;
                            cx.notify();
                        }))
                }),
            );
        let card = v_flex()
            .flex_1()
            .min_h_0()
            .min_w_0()
            .rounded_lg()
            .overflow_hidden()
            .bg(cx.theme().sidebar)
            .text_color(cx.theme().sidebar_foreground)
            .border_1()
            .border_color(border)
            .child(
                h_flex()
                    .w_full()
                    .justify_between()
                    .items_center()
                    .px_3()
                    .py_2()
                    .gap_2()
                    .child(tabs)
                    .child(
                        Button::new("insp-collapse")
                            .xsmall()
                            .ghost()
                            .icon(IconName::PanelRight)
                            .tooltip("收起右侧栏")
                            .on_click(move |_, window, app| {
                                if let Some(e) = host.upgrade() {
                                    e.update(app, |this, cx| {
                                        this.toggle_right_collapsed(window, cx)
                                    });
                                }
                            }),
                    ),
            )
            .child(match tab {
                InspectorTab::Files => v_flex()
                    .flex_1()
                    .min_h_0()
                    .child(
                        h_flex()
                            .id("file-tree-toolbar")
                            .w_full()
                            .px_2()
                            .py_1()
                            .gap_2()
                            .items_center()
                            .border_b_1()
                            .border_color(border)
                            .bg(cx.theme().secondary)
                            .child(
                                div()
                                    .flex_1()
                                    .min_w(px(80.))
                                    .child(Input::new(&self.filter).cleanable(true)),
                            )
                            .child(
                                div()
                                    .id("insp-refresh")
                                    .flex_shrink_0()
                                    .px_1()
                                    .text_xs()
                                    .cursor_pointer()
                                    .text_color(muted)
                                    .hover(|item| item.text_color(accent))
                                    .child("刷新")
                                    .on_click(cx.listener(|this, _, _, cx| this.refresh(cx))),
                            )
                            .when(root.is_none(), |row| {
                                row.child(
                                    div()
                                        .id("insp-add")
                                        .flex_shrink_0()
                                        .px_1()
                                        .text_xs()
                                        .cursor_pointer()
                                        .text_color(muted)
                                        .hover(|item| item.text_color(accent))
                                        .child("添加目录")
                                        .on_click(cx.listener(|this, _, _, cx| this.add_root(cx))),
                                )
                            }),
                    )
                    .child(
                        div()
                            .px_3()
                            .py_1()
                            .text_xs()
                            .text_color(muted)
                            .truncate()
                            .child(root_label),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_h_0()
                            .p_2()
                            .overflow_y_scrollbar()
                            .child(file_body),
                    )
                    .into_any_element(),
                InspectorTab::Git => self.git_panel(git, muted, cx).into_any_element(),
                InspectorTab::Events => self.events_panel(muted, cx).into_any_element(),
            });

        v_flex()
            .size_full()
            .min_h_0()
            .min_w_0()
            .p_2()
            .child(card)
            .into_any_element()
    }
}

impl InspectorPane {
    #[allow(clippy::too_many_arguments)]
    fn render_agent_rail(
        &mut self,
        root: Option<PathBuf>,
        _root_label: String,
        git: Option<GitSnapshot>,
        change_count: usize,
        file_body: AnyElement,
        muted: Hsla,
        border: Hsla,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let tab = self.agent_tab;
        let host = self.host.clone();
        let surface = cx.theme().secondary;
        let accent = cx.theme().accent;
        let tabs = h_flex()
            .id("right-rail-capsule-tabs")
            .items_center()
            .gap_1()
            .p_1()
            .rounded_full()
            .bg(surface)
            .border_1()
            .border_color(border)
            .flex_1()
            .min_w_0()
            .overflow_x_scrollbar()
            .children(
                [
                    AgentRailTab::Terminal,
                    AgentRailTab::Files,
                    AgentRailTab::Git,
                    AgentRailTab::Mission,
                    AgentRailTab::Visualizer,
                ]
                .into_iter()
                .map(|item| {
                    let selected = item == tab;
                    let label = if item == AgentRailTab::Git && change_count > 0 {
                        format!("Git {change_count}")
                    } else {
                        item.label().to_string()
                    };
                    div()
                        .id(("right-rail-tab-pill", item.index()))
                        .flex_shrink_0()
                        .px_3()
                        .py_1()
                        .rounded_full()
                        .text_xs()
                        .cursor_pointer()
                        .when(selected, |pill| {
                            pill.bg(border)
                                .text_color(accent)
                                .font_weight(gpui::FontWeight::BOLD)
                        })
                        .when(!selected, |pill| {
                            pill.text_color(muted).hover(|pill| pill.text_color(accent))
                        })
                        .child(label)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.agent_tab = item;
                            cx.notify();
                        }))
                }),
            );

        let card = v_flex()
            .flex_1()
            .min_h_0()
            .min_w_0()
            .rounded_lg()
            .overflow_hidden()
            .bg(cx.theme().sidebar)
            .text_color(cx.theme().sidebar_foreground)
            .border_1()
            .border_color(border)
            .child(
                h_flex()
                    .id("inspector-header")
                    .w_full()
                    .justify_between()
                    .items_center()
                    .px_3()
                    .py_2()
                    .gap_2()
                    .child(tabs)
                    .child(
                        Button::new("inspector-close-btn")
                            .xsmall()
                            .ghost()
                            .icon(IconName::PanelRight)
                            .tooltip("关闭右侧栏")
                            .on_click(move |_, window, app| {
                                if let Some(e) = host.upgrade() {
                                    e.update(app, |this, cx| {
                                        this.set_right_collapsed(true, window, cx)
                                    });
                                }
                            }),
                    ),
            )
            .child(match tab {
                AgentRailTab::Terminal => self
                    .terminal_panel(root, muted, border, cx)
                    .into_any_element(),
                AgentRailTab::Files => self
                    .agent_files(file_body, muted, border, cx)
                    .into_any_element(),
                AgentRailTab::Git => self.git_panel(git, muted, cx).into_any_element(),
                AgentRailTab::Mission => self.mission_panel(muted, cx).into_any_element(),
                AgentRailTab::Visualizer => {
                    self.visualizer_panel(root, muted, cx).into_any_element()
                }
            });

        v_flex().size_full().min_h_0().min_w_0().p_2().child(card)
    }

    fn terminal_panel(
        &mut self,
        root: Option<PathBuf>,
        muted: Hsla,
        border: Hsla,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let terms = global_terminals().list();
        if self
            .term_id
            .as_ref()
            .is_none_or(|id| !terms.iter().any(|info| info.id == *id))
        {
            self.term_id = terms
                .iter()
                .find(|info| !info.closed)
                .map(|info| info.id.clone());
        }
        let output = self
            .term_id
            .as_deref()
            .and_then(|id| global_terminals().read(id).ok())
            .unwrap_or_default();
        let preview: String = output
            .lines()
            .rev()
            .take(120)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        let cwd = terms
            .iter()
            .find(|info| self.term_id.as_deref() == Some(info.id.as_str()))
            .map(|info| info.cwd.clone());
        let preview_copy = preview.clone();
        let entity = cx.weak_entity();
        let root_open = root.clone();
        let accent = cx.theme().accent;
        let surface = cx.theme().secondary;
        let screen_bg = cx.theme().background;
        let cwd_label = cwd.clone().unwrap_or_default();
        let sub_tab_bar = h_flex()
            .id("terminal-capsule-tabs")
            .items_center()
            .gap_1()
            .p_1()
            .rounded_full()
            .bg(surface)
            .border_1()
            .border_color(border)
            .max_w_full()
            .overflow_x_scrollbar()
            .child(
                div()
                    .id("add-terminal-tab")
                    .flex_shrink_0()
                    .px_3()
                    .py_1()
                    .rounded_full()
                    .cursor_pointer()
                    .text_xs()
                    .bg(accent)
                    .text_color(cx.theme().accent_foreground)
                    .child("新终端")
                    .on_click(move |_, _, app| {
                        let Some(view) = entity.upgrade() else { return };
                        let root = root_open.clone();
                        view.update(app, |this, cx| {
                            this.open_agent_terminal(root.as_deref(), cx)
                        });
                    }),
            )
            .children(terms.into_iter().map(|info| {
                let id = info.id.clone();
                let selected = self.term_id.as_deref() == Some(id.as_str());
                let entity = cx.weak_entity();
                let close_entity = entity.clone();
                let label = info.shell.rsplit(['/', '\\']).next().unwrap_or(&info.shell);
                let title = if info.closed {
                    format!("{label} · 已关")
                } else {
                    label.to_string()
                };
                let close_id = id.clone();
                h_flex()
                    .id(SharedString::from(format!("terminal-tab-{id}")))
                    .flex_shrink_0()
                    .items_center()
                    .gap_1()
                    .px_3()
                    .py_1()
                    .rounded_full()
                    .cursor_pointer()
                    .text_xs()
                    .when(selected, |tab| {
                        tab.bg(border)
                            .text_color(accent)
                            .font_weight(gpui::FontWeight::BOLD)
                    })
                    .when(!selected, |tab| {
                        tab.text_color(muted).hover(|tab| tab.text_color(accent))
                    })
                    .on_click(move |_, _, app| {
                        let Some(view) = entity.upgrade() else { return };
                        let id = id.clone();
                        view.update(app, |this, cx| {
                            this.term_id = Some(id);
                            cx.notify();
                        });
                    })
                    .child(title)
                    .child(
                        div()
                            .id(SharedString::from(format!("close-terminal-tab-{close_id}")))
                            .px_1()
                            .rounded_full()
                            .text_color(muted)
                            .hover(|tab| tab.bg(surface))
                            .child("×")
                            .on_click(move |_, _, app| {
                                let Some(view) = close_entity.upgrade() else {
                                    return;
                                };
                                let close_id = close_id.clone();
                                view.update(app, |this, cx| this.close_terminal(&close_id, cx));
                            }),
                    )
            }))
            .child(
                div()
                    .id("terminal-paste")
                    .flex_shrink_0()
                    .px_2()
                    .py_1()
                    .rounded_full()
                    .cursor_pointer()
                    .text_xs()
                    .text_color(muted)
                    .hover(|tab| tab.text_color(accent))
                    .child("粘贴")
                    .on_click(cx.listener(|this, _, _, cx| this.paste_terminal(cx))),
            )
            .child(
                div()
                    .id("terminal-copy-output")
                    .flex_shrink_0()
                    .px_2()
                    .py_1()
                    .rounded_full()
                    .cursor_pointer()
                    .text_xs()
                    .text_color(muted)
                    .hover(|tab| tab.text_color(accent))
                    .child("复制")
                    .on_click(move |_, _, app| {
                        app.write_to_clipboard(gpui::ClipboardItem::new_string(
                            preview_copy.clone(),
                        ));
                    }),
            );
        v_flex()
            .flex_1()
            .min_h_0()
            .p_3()
            .gap_2()
            .child(
                div()
                    .id("terminal-screen")
                    .flex_1()
                    .min_h_0()
                    .relative()
                    .rounded_lg()
                    .overflow_hidden()
                    .border_1()
                    .border_color(border)
                    .bg(screen_bg)
                    .child(
                        v_flex()
                            .size_full()
                            .child(
                                div()
                                    .flex_1()
                                    .min_h_0()
                                    .p_3()
                                    .overflow_y_scrollbar()
                                    .font_family("monospace")
                                    .text_xs()
                                    .child(if preview.is_empty() {
                                        cwd_label
                                    } else {
                                        preview
                                    }),
                            )
                            .child(div().px_3().pb_2().child(Input::new(&self.term_input))),
                    ),
            )
            .when_some(self.term_note.clone(), |col, note| {
                col.child(div().text_xs().text_color(muted).child(note))
            })
            .child(sub_tab_bar)
    }

    fn confirm_rename(&mut self, cx: &mut Context<Self>) {
        let Some(from) = self.rename_from.clone() else {
            return;
        };
        let name = self.filter.read(cx).value().trim().to_string();
        if name.is_empty()
            || name.contains("..")
            || name.contains('/')
            || name.contains('\\')
            || name.contains('\0')
        {
            self.git_note = Some("筛选框里只填写新的文件名".into());
            cx.notify();
            return;
        }
        let dest = Path::new(&from).with_file_name(&name);
        match std::fs::rename(&from, &dest) {
            Ok(()) => {
                let dest_s = dest.to_string_lossy().to_string();
                if self
                    .file_preview
                    .as_ref()
                    .is_some_and(|(open, _)| open == &from)
                {
                    self.file_preview = None;
                }
                self.rename_from = None;
                self.git_note = Some(format!("已重命名为 {dest_s}"));
                self.refresh(cx);
            }
            Err(err) => {
                self.git_note = Some(err.to_string());
                cx.notify();
            }
        }
    }

    fn paste_terminal(&mut self, cx: &mut Context<Self>) {
        let Some(id) = self.term_id.clone() else {
            self.term_note = Some("还没有终端".into());
            cx.notify();
            return;
        };
        let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) else {
            self.term_note = Some("剪贴板里没有文本".into());
            cx.notify();
            return;
        };
        if text.trim().is_empty() {
            self.term_note = Some("剪贴板里没有文本".into());
            cx.notify();
            return;
        }
        self.term_note = Some(match global_terminals().paste(&id, &text) {
            Ok(()) => "已粘贴，回车才会执行".into(),
            Err(err) => err.to_string(),
        });
        cx.notify();
    }

    fn delete_agent_entry(&mut self, path: &str, is_dir: bool, cx: &mut Context<Self>) {
        let result = if is_dir {
            std::fs::remove_dir(path)
        } else {
            std::fs::remove_file(path)
        };
        if self
            .file_preview
            .as_ref()
            .is_some_and(|(open, _)| open == path)
        {
            self.file_preview = None;
        }
        self.git_note = Some(match result {
            Ok(()) => "已删除".into(),
            Err(err) => err.to_string(),
        });
        self.refresh(cx);
    }

    fn open_agent_terminal(&mut self, root: Option<&Path>, cx: &mut Context<Self>) {
        let shell = self.state.terminal_program();
        match global_terminals().open(&shell, root) {
            Ok(id) => {
                self.term_id = Some(id);
                self.term_note = None;
            }
            Err(err) => self.term_note = Some(err.to_string()),
        }
        cx.notify();
    }

    fn agent_files(
        &mut self,
        file_body: AnyElement,
        muted: Hsla,
        border: Hsla,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if let Some((path, content)) = self.file_preview.clone() {
            let title = Path::new(&path)
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or(path);
            let raised = cx.theme().secondary;
            return v_flex()
                .flex_1()
                .min_h_0()
                .child(
                    h_flex()
                        .justify_between()
                        .items_center()
                        .p_2()
                        .gap_2()
                        .bg(raised)
                        .child(div().flex_1().min_w_0().text_xs().truncate().child(title))
                        .child(
                            div()
                                .id("close-file")
                                .px_2()
                                .py_1()
                                .rounded_md()
                                .text_xs()
                                .cursor_pointer()
                                .text_color(muted)
                                .hover(|item| item.text_color(cx.theme().foreground))
                                .child("关闭")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.file_preview = None;
                                    cx.notify();
                                })),
                        ),
                )
                .child(
                    div()
                        .id("file-tree-open")
                        .flex_1()
                        .min_h_0()
                        .p_3()
                        .overflow_y_scrollbar()
                        .bg(cx.theme().background)
                        .font_family("monospace")
                        .text_xs()
                        .child(content),
                )
                .into_any_element();
        }
        let note = self.git_note.clone();
        let renaming = self.rename_from.clone();
        let accent = cx.theme().accent;
        v_flex()
            .flex_1()
            .min_h_0()
            .child(
                h_flex()
                    .id("file-tree-toolbar")
                    .w_full()
                    .px_2()
                    .py_1()
                    .gap_2()
                    .items_center()
                    .border_b_1()
                    .border_color(border)
                    .bg(cx.theme().secondary)
                    .child(
                        div()
                            .flex_1()
                            .min_w(px(80.))
                            .child(Input::new(&self.filter).cleanable(true)),
                    )
                    .child(Self::file_tool(
                        cx,
                        "file-tree-new-file",
                        "新建文件",
                        muted,
                        |this, cx| this.create_agent_path(false, cx),
                    ))
                    .child(Self::file_tool(
                        cx,
                        "file-tree-new-folder",
                        "新建文件夹",
                        muted,
                        |this, cx| this.create_agent_path(true, cx),
                    ))
                    .child(Self::file_tool(
                        cx,
                        "file-tree-collapse-all",
                        "折叠",
                        muted,
                        |this, cx| {
                            this.expanded.clear();
                            cx.notify();
                        },
                    ))
                    .child(Self::file_tool(
                        cx,
                        "file-tree-refresh",
                        "刷新",
                        muted,
                        |this, cx| this.refresh(cx),
                    )),
            )
            .when(renaming.is_some(), |col| {
                col.child(
                    h_flex()
                        .id("file-tree-pending-op-bar")
                        .w_full()
                        .px_2()
                        .py_1()
                        .gap_2()
                        .items_center()
                        .border_b_1()
                        .border_color(accent)
                        .bg(cx.theme().secondary)
                        .child(
                            div()
                                .flex_1()
                                .text_xs()
                                .text_color(accent)
                                .truncate()
                                .child("在筛选框里填写新文件名"),
                        )
                        .child(Self::file_tool(
                            cx,
                            "file-tree-rename-ok",
                            "确认重命名",
                            accent,
                            |this, cx| this.confirm_rename(cx),
                        )),
                )
            })
            .when_some(note, |col, note| {
                col.child(div().px_2().py_1().text_xs().text_color(muted).child(note))
            })
            .child(
                div()
                    .id("file-tree-scroll-content")
                    .flex_1()
                    .min_h_0()
                    .p_2()
                    .overflow_y_scrollbar()
                    .child(file_body),
            )
            .into_any_element()
    }

    fn file_tool(
        cx: &mut Context<Self>,
        id: &'static str,
        label: &'static str,
        color: Hsla,
        action: fn(&mut Self, &mut Context<Self>),
    ) -> impl IntoElement {
        div()
            .id(id)
            .flex_shrink_0()
            .px_1()
            .text_xs()
            .cursor_pointer()
            .text_color(color)
            .hover(|item| item.text_color(cx.theme().foreground))
            .child(label)
            .on_click(cx.listener(move |this, _, _, cx| action(this, cx)))
    }

    fn open_agent_file(&mut self, path: &str, cx: &mut Context<Self>) {
        let file = PathBuf::from(path);
        let ext = file.extension().and_then(|ext| ext.to_str()).unwrap_or("");
        if !ext.is_empty() && !is_text_extension(ext) {
            cx.reveal_path(&file);
            return;
        }
        let bytes = std::fs::read(&file).unwrap_or_default();
        if bytes.len() > 80_000 || bytes.contains(&0) {
            self.file_preview = Some((
                path.to_string(),
                "文件过大或不是文本，已用系统程序打开。".into(),
            ));
            cx.reveal_path(&file);
            self.agent_tab = AgentRailTab::Files;
            cx.notify();
            return;
        }
        let text = String::from_utf8_lossy(&bytes).to_string();
        self.file_preview = Some((path.to_string(), text));
        self.agent_tab = AgentRailTab::Files;
        cx.notify();
    }

    fn mission_panel(&self, muted: Hsla, cx: &mut Context<Self>) -> impl IntoElement {
        let (goal, todos, allowed) = self.state.with(|s| {
            let thread = s
                .active_thread_id
                .as_ref()
                .and_then(|id| s.repo.get_agent_thread(id));
            (
                thread
                    .as_ref()
                    .and_then(|thread| thread.session_goal.clone()),
                thread
                    .map(|thread| thread.session_todos.clone())
                    .unwrap_or_default(),
                thread
                    .filter(|thread| thread.permission_mode == wb_domain::AgentPermissionMode::Auto)
                    .map(|thread| thread.allowed_commands.clone())
                    .unwrap_or_default(),
            )
        });
        let accent = cx.theme().accent;
        let current = self.mission_tab;
        let border = cx.theme().border;
        let pills = h_flex()
            .id("mission-capsule-subtabs")
            .items_center()
            .gap_1()
            .p_1()
            .rounded_full()
            .bg(cx.theme().secondary)
            .border_1()
            .border_color(border)
            .overflow_x_scrollbar()
            .children(
                [
                    (MissionTab::Goal, "计划"),
                    (MissionTab::Todos, "待办"),
                    (MissionTab::Gate, "门禁"),
                    (MissionTab::Log, "时间线"),
                    (MissionTab::Artifacts, "产物"),
                ]
                .into_iter()
                .map(|(tab, label)| {
                    let selected = tab == current;
                    div()
                        .id(SharedString::from(format!("mission-{label}")))
                        .flex_shrink_0()
                        .px_3()
                        .py_1()
                        .rounded_full()
                        .text_xs()
                        .cursor_pointer()
                        .when(selected, |pill| {
                            pill.bg(border)
                                .text_color(accent)
                                .font_weight(gpui::FontWeight::BOLD)
                        })
                        .when(!selected, |pill| {
                            pill.text_color(muted).hover(|pill| pill.text_color(accent))
                        })
                        .child(label)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.mission_tab = tab;
                            cx.notify();
                        }))
                }),
            );
        let mut body = v_flex().flex_1().min_h_0();
        body = match current {
            MissionTab::Log => body.child(self.timeline_panel(muted, cx)),
            MissionTab::Gate => body.child(self.gate_panel(muted, cx)),
            MissionTab::Artifacts => body.child(self.artifacts_panel(muted, cx)),
            MissionTab::Todos => body.child(
                v_flex()
                    .mx_3()
                    .mb_3()
                    .p_3()
                    .gap_2()
                    .rounded_lg()
                    .border_1()
                    .border_color(border)
                    .bg(cx.theme().secondary)
                    .child(
                        div()
                            .text_xs()
                            .text_color(muted)
                            .child(if todos.is_empty() {
                                "这个会话还没有待办".to_string()
                            } else {
                                format!("{} 项待办", todos.len())
                            }),
                    )
                    .children(todos.into_iter().map(|todo| {
                        let mark = match todo.status.as_str() {
                            "completed" => "✓",
                            "in_progress" => "▸",
                            _ => "·",
                        };
                        let color = if todo.status == "in_progress" {
                            accent
                        } else {
                            muted
                        };
                        h_flex()
                            .gap_2()
                            .items_start()
                            .child(div().text_xs().text_color(color).child(mark))
                            .child(div().flex_1().text_xs().child(todo.content))
                    })),
            ),
            MissionTab::Goal => {
                let mut col = v_flex()
                    .mx_3()
                    .mb_3()
                    .p_3()
                    .gap_2()
                    .rounded_lg()
                    .border_1()
                    .border_color(border)
                    .bg(cx.theme().secondary);
                col = match goal {
                    Some(goal) => col.child(div().text_sm().child(goal.objective)).child(
                        div().text_xs().text_color(muted).child(format!(
                            "{} · 已进行 {} 轮",
                            goal.status, goal.rounds_started
                        )),
                    ),
                    None => col.child(
                        div()
                            .text_xs()
                            .text_color(muted)
                            .child("这个会话还没有目标"),
                    ),
                };
                if !allowed.is_empty() {
                    col = col.child(
                        div()
                            .pt_2()
                            .text_xs()
                            .text_color(muted)
                            .child(format!("自动模式已记住 {} 条命令", allowed.len())),
                    );
                    let entity = cx.weak_entity();
                    col = col.children(allowed.into_iter().take(20).map(|key| {
                        let shown = key
                            .split_once(':')
                            .map(|(_, command)| command.to_string())
                            .unwrap_or_else(|| key.clone());
                        let forget = key.clone();
                        let entity = entity.clone();
                        h_flex()
                            .gap_2()
                            .items_center()
                            .child(div().flex_1().text_xs().child(shown))
                            .child(
                                Button::new(SharedString::from(format!("forget-{key}")))
                                    .xsmall()
                                    .ghost()
                                    .label("忘掉")
                                    .on_click(move |_, _, app| {
                                        let Some(view) = entity.upgrade() else {
                                            return;
                                        };
                                        let forget = forget.clone();
                                        view.update(app, |this, cx| {
                                            this.forget_command(&forget, cx)
                                        });
                                    }),
                            )
                    }));
                }
                body.child(col)
            }
        };
        v_flex()
            .size_full()
            .min_h_0()
            .child(h_flex().flex_none().px_3().py_2().child(pills))
            .child(div().flex_1().min_h_0().overflow_y_scrollbar().child(body))
    }

    fn forget_command(&mut self, key: &str, cx: &mut Context<Self>) {
        let thread_id = self.state.with(|s| s.active_thread_id.clone());
        let Some(thread_id) = thread_id else {
            return;
        };
        self.state.with_mut(|s| {
            let Some(mut thread) = s.repo.get_agent_thread(&thread_id).cloned() else {
                return;
            };
            thread.allowed_commands.retain(|item| item != key);
            s.repo.upsert_agent_thread(thread);
        });
        self.state.persist_if_dirty();
        cx.notify();
    }

    fn gate_panel(&self, muted: Hsla, cx: &mut Context<Self>) -> impl IntoElement {
        let events = self.state.with(|s| {
            s.active_thread_id
                .as_ref()
                .map(|id| s.repo.agent_events_for_thread(id))
                .unwrap_or_default()
        });
        let rows: Vec<_> = events
            .into_iter()
            .rev()
            .filter(|event| {
                matches!(
                    event.kind.as_str(),
                    "tool_blocked" | "tool_pending" | "approval_granted" | "approval_denied"
                )
            })
            .take(40)
            .collect();
        let mut body = v_flex()
            .mx_3()
            .mb_3()
            .p_3()
            .gap_2()
            .rounded_lg()
            .border_1()
            .border_color(cx.theme().border)
            .bg(cx.theme().secondary);
        if rows.is_empty() {
            body = body.child(
                div()
                    .text_xs()
                    .text_color(muted)
                    .child("还没有拦住或审批的记录"),
            );
        }
        body.children(rows.into_iter().map(|event| {
            div()
                .text_xs()
                .child(format!("{} · {}", event.kind, event.name))
        }))
    }

    fn artifacts_panel(&self, muted: Hsla, cx: &mut Context<Self>) -> impl IntoElement {
        let dir = self.root().map(|root| spill_dir(&root));
        let files = dir
            .as_ref()
            .and_then(|dir| std::fs::read_dir(dir).ok())
            .map(|read| {
                let mut names: Vec<_> = read
                    .filter_map(|entry| entry.ok())
                    .map(|entry| entry.file_name().to_string_lossy().to_string())
                    .collect();
                names.sort();
                names.truncate(40);
                names
            });
        let mut body = v_flex()
            .mx_3()
            .mb_3()
            .p_3()
            .gap_2()
            .rounded_lg()
            .border_1()
            .border_color(cx.theme().border)
            .bg(cx.theme().secondary);
        match files {
            None => {
                body = body.child(
                    div()
                        .text_xs()
                        .text_color(muted)
                        .child("还没有工具溢出文件"),
                );
            }
            Some(names) if names.is_empty() => {
                body = body.child(div().text_xs().text_color(muted).child("溢出目录是空的"));
            }
            Some(names) => {
                body = body.children(names.into_iter().map(|name| div().text_xs().child(name)));
            }
        }
        body
    }

    fn visualizer_panel(
        &mut self,
        root: Option<PathBuf>,
        muted: Hsla,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        use crate::views::visualizer;
        let mode = self.viz_mode;
        let accent = cx.theme().accent;
        let border = cx.theme().border;
        let pills = h_flex()
            .gap_1()
            .items_center()
            .p_1()
            .rounded_full()
            .bg(cx.theme().secondary)
            .border_1()
            .border_color(border)
            .children(
                [(0u8, "蜂群三维"), (1, "依赖图"), (2, "核图谱")]
                    .into_iter()
                    .map(|(id, label)| {
                        div()
                            .id(("viz-mode", id as usize))
                            .px_3()
                            .py_1()
                            .rounded_full()
                            .text_xs()
                            .cursor_pointer()
                            .when(mode == id, |pill| {
                                pill.bg(border)
                                    .text_color(accent)
                                    .font_weight(gpui::FontWeight::BOLD)
                            })
                            .when(mode != id, |pill| {
                                pill.text_color(muted).hover(|pill| pill.text_color(accent))
                            })
                            .child(label)
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.viz_mode = id;
                                cx.notify();
                            }))
                    }),
            );
        let (summary, canvas_view, detail) = match mode {
            1 => {
                let key = root.as_ref().map(|path| path.display().to_string());
                if self.dep_key != key {
                    self.dep_graph = root
                        .as_ref()
                        .map(|path| visualizer::dependency_graph(path))
                        .unwrap_or_default();
                    self.dep_key = key;
                }
                let graph = self.dep_graph.clone();
                let focus = self.dep_focus.clone();
                let summary = format!("{} 个包 · {} 条依赖", graph.nodes.len(), graph.edges.len());
                let detail = Self::focused_detail(&graph, focus.as_deref());
                let hits = self.viz_hits.clone();
                let view = visualizer::paint_flat(
                    &graph,
                    1.0,
                    focus.as_deref(),
                    &hits,
                    accent,
                    muted,
                    true,
                );
                (summary, view.into_any_element(), detail)
            }
            2 => {
                let key = root.as_ref().map(|path| path.display().to_string());
                if self.nucleus_key != key {
                    self.nucleus_graph = root
                        .as_ref()
                        .map(|path| visualizer::nucleus_graph(path))
                        .unwrap_or_default();
                    self.nucleus_key = key;
                }
                let mut graph = self.nucleus_graph.clone();
                if self.nucleus_filter == 1 {
                    graph.nodes.retain(|node| node.hot);
                    let ids: HashSet<_> = graph.nodes.iter().map(|node| node.id.clone()).collect();
                    graph.edges.retain(|edge| ids.contains(&edge.from));
                } else if self.nucleus_filter == 2 {
                    let broken: HashSet<_> = graph
                        .edges
                        .iter()
                        .filter(|edge| edge.broken)
                        .map(|edge| edge.from.clone())
                        .collect();
                    graph.nodes.retain(|node| broken.contains(&node.id));
                    graph.edges.retain(|edge| edge.broken);
                }
                let orphans = self
                    .nucleus_graph
                    .nodes
                    .iter()
                    .filter(|node| node.hot)
                    .count();
                let dead = self
                    .nucleus_graph
                    .edges
                    .iter()
                    .filter(|edge| edge.broken)
                    .count();
                let summary = format!(
                    "{} 篇笔记 · {} 孤立 · {} 断链",
                    self.nucleus_graph.nodes.len(),
                    orphans,
                    dead
                );
                let focus = self.nucleus_focus.clone();
                let detail = Self::focused_detail(&graph, focus.as_deref());
                let hits = self.viz_hits.clone();
                let zoom = self.nucleus_zoom;
                let view = visualizer::paint_flat(
                    &graph,
                    zoom,
                    focus.as_deref(),
                    &hits,
                    accent,
                    muted,
                    false,
                );
                (summary, view.into_any_element(), detail)
            }
            _ => {
                let graph = self.state.with(|s| {
                    let threads: Vec<_> = s
                        .repo
                        .list_agent_threads()
                        .into_iter()
                        .filter(|thread| thread.archived_at.is_none())
                        .map(|thread| {
                            let busy = thread
                                .session_goal
                                .as_ref()
                                .is_some_and(|goal| goal.status == "active");
                            (thread.id, thread.title, busy)
                        })
                        .collect();
                    visualizer::swarm_nodes(&threads, s.active_thread_id.as_deref())
                });
                let summary = format!("{} 个会话", graph.nodes.len());
                let focus = self.viz_focus.clone();
                let detail = Self::focused_detail(&graph, focus.as_deref());
                let hits = self.viz_hits.clone();
                let view = visualizer::paint_swarm(
                    &graph,
                    self.viz_yaw,
                    self.viz_pitch,
                    focus.as_deref(),
                    &hits,
                    accent,
                    muted,
                );
                (summary, view.into_any_element(), detail)
            }
        };
        let filter_row = mode == 2;
        let border = cx.theme().border;
        v_flex()
            .flex_1()
            .min_h_0()
            .child(
                h_flex()
                    .w_full()
                    .min_w_0()
                    .flex_wrap()
                    .gap_2()
                    .justify_between()
                    .items_center()
                    .px_3()
                    .py_2()
                    .border_b_1()
                    .border_color(border)
                    .child(pills)
                    .child(div().text_xs().text_color(muted).child(summary))
                    .child(
                        h_flex()
                            .gap_2()
                            .items_center()
                            .when(filter_row, |row| row.child(self.nucleus_filters(cx)))
                            .child(
                                div()
                                    .id("vis-reset-cam")
                                    .px_2()
                                    .py_1()
                                    .rounded_md()
                                    .cursor_pointer()
                                    .bg(cx.theme().secondary)
                                    .border_1()
                                    .border_color(border)
                                    .text_xs()
                                    .text_color(muted)
                                    .hover(|item| item.text_color(accent))
                                    .child("复位")
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.viz_yaw = 0.0;
                                        this.viz_pitch = 0.25;
                                        this.viz_focus = None;
                                        this.dep_focus = None;
                                        this.nucleus_focus = None;
                                        cx.notify();
                                    })),
                            ),
                    ),
            )
            .child(
                div()
                    .flex_1()
                    .min_h(px(220.0))
                    .child(canvas_view)
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|this, event: &MouseDownEvent, _, cx| {
                            this.viz_drag = Some((
                                f32::from(event.position.x),
                                f32::from(event.position.y),
                                this.viz_yaw,
                                this.viz_pitch,
                            ));
                            cx.notify();
                        }),
                    )
                    .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, _, cx| {
                        let Some((x0, y0, yaw, pitch)) = this.viz_drag else {
                            return;
                        };
                        if this.viz_mode != 0 {
                            return;
                        }
                        let dx = f32::from(event.position.x) - x0;
                        let dy = f32::from(event.position.y) - y0;
                        this.viz_yaw = yaw + dx * 0.01;
                        this.viz_pitch = (pitch - dy * 0.01).clamp(-1.2, 1.2);
                        cx.notify();
                    }))
                    .on_mouse_up(
                        MouseButton::Left,
                        cx.listener(|this, event: &MouseUpEvent, _, cx| {
                            let dragged = this.viz_drag.take().is_some_and(|(x0, y0, _, _)| {
                                let dx = f32::from(event.position.x) - x0;
                                let dy = f32::from(event.position.y) - y0;
                                dx * dx + dy * dy > 16.0
                            });
                            if !dragged {
                                let x = f32::from(event.position.x);
                                let y = f32::from(event.position.y);
                                let hit =
                                    this.viz_hits.borrow().iter().find_map(|(id, hx, hy, r)| {
                                        let dx = x - hx;
                                        let dy = y - hy;
                                        (dx * dx + dy * dy <= r * r).then(|| id.clone())
                                    });
                                match this.viz_mode {
                                    1 => this.dep_focus = hit,
                                    2 => this.nucleus_focus = hit,
                                    _ => this.viz_focus = hit,
                                }
                            }
                            cx.notify();
                        }),
                    ),
            )
            .child(
                div()
                    .px_3()
                    .py_2()
                    .border_t_1()
                    .border_color(border)
                    .text_xs()
                    .text_color(muted)
                    .child(detail),
            )
    }

    fn focused_detail(graph: &crate::views::visualizer::VizGraph, focus: Option<&str>) -> String {
        let Some(id) = focus else {
            return "拖动旋转蜂群。点一个节点查看它。".into();
        };
        graph
            .nodes
            .iter()
            .find(|node| node.id == id)
            .map(|node| format!("{} · {}", node.label, node.detail))
            .unwrap_or_else(|| "没有选中节点".into())
    }

    fn nucleus_filters(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let current = self.nucleus_filter;
        h_flex()
            .gap_1()
            .children(
                [(0u8, "全部"), (1, "孤立"), (2, "断链")]
                    .into_iter()
                    .map(|(id, label)| {
                        div()
                            .id(("nucleus-filter", id as usize))
                            .px_2()
                            .rounded_md()
                            .text_xs()
                            .cursor_pointer()
                            .when(current == id, |pill| pill.text_color(cx.theme().accent))
                            .child(label)
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.nucleus_filter = id;
                                if id == 0 {
                                    this.nucleus_zoom = 1.0;
                                } else {
                                    this.nucleus_zoom = 1.15;
                                }
                                cx.notify();
                            }))
                    }),
            )
    }

    fn timeline_panel(&self, muted: Hsla, cx: &mut Context<Self>) -> impl IntoElement {
        let events = self.state.with(|s| {
            s.active_thread_id
                .as_ref()
                .map(|id| s.repo.agent_events_for_thread(id))
                .unwrap_or_default()
        });
        let total = events.len();
        let shown = self.event_cursor.unwrap_or(total).min(total);
        let cursor = self.event_cursor;
        let accent = cx.theme().accent;
        v_flex()
            .flex_1()
            .min_h_0()
            .child(
                h_flex()
                    .w_full()
                    .px_3()
                    .py_2()
                    .gap_3()
                    .items_center()
                    .border_b_1()
                    .border_color(cx.theme().border)
                    .child(
                        div()
                            .id("timeline-older")
                            .text_xs()
                            .cursor_pointer()
                            .text_color(muted)
                            .when(shown == 0, |item| item.opacity(0.4))
                            .hover(|item| item.text_color(accent))
                            .child("更早")
                            .on_click(cx.listener(|this, _, _, cx| {
                                let total = this.state.with(|s| {
                                    s.active_thread_id
                                        .as_ref()
                                        .map(|id| s.repo.agent_events_for_thread(id).len())
                                        .unwrap_or(0)
                                });
                                let shown = this.event_cursor.unwrap_or(total);
                                if shown == 0 {
                                    return;
                                }
                                this.event_cursor = Some(shown.saturating_sub(1));
                                cx.notify();
                            })),
                    )
                    .child(
                        div()
                            .flex_1()
                            .text_xs()
                            .text_color(muted)
                            .child(if total == 0 {
                                "还没有记录".to_string()
                            } else {
                                format!("看到最近 {shown} / {total} 条")
                            }),
                    )
                    .child(
                        div()
                            .id("timeline-newer")
                            .text_xs()
                            .cursor_pointer()
                            .text_color(muted)
                            .hover(|item| item.text_color(accent))
                            .child("更新")
                            .on_click(cx.listener(|this, _, _, cx| {
                                let total = this.state.with(|s| {
                                    s.active_thread_id
                                        .as_ref()
                                        .map(|id| s.repo.agent_events_for_thread(id).len())
                                        .unwrap_or(0)
                                });
                                match this.event_cursor {
                                    Some(n) if n + 1 >= total => this.event_cursor = None,
                                    Some(n) => this.event_cursor = Some(n + 1),
                                    None => {}
                                }
                                cx.notify();
                            })),
                    )
                    .child(
                        div()
                            .id("timeline-live")
                            .text_xs()
                            .cursor_pointer()
                            .text_color(if cursor.is_none() { muted } else { accent })
                            .when(cursor.is_none(), |item| item.opacity(0.4))
                            .hover(|item| item.text_color(accent))
                            .child("回到最新")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.event_cursor = None;
                                cx.notify();
                            })),
                    ),
            )
            .child(self.events_panel_limited(muted, shown, cx))
    }

    fn events_panel(&self, muted: impl Into<Hsla>, cx: &mut Context<Self>) -> impl IntoElement {
        self.events_panel_limited(muted, usize::MAX, cx)
    }

    fn events_panel_limited(
        &self,
        muted: impl Into<Hsla>,
        limit: usize,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let muted = muted.into();
        let events = self.state.with(|s| {
            s.active_thread_id
                .as_ref()
                .map(|id| s.repo.agent_events_for_thread(id))
                .unwrap_or_default()
        });
        let mut body = v_flex()
            .mx_3()
            .mb_3()
            .p_3()
            .gap_2()
            .rounded_lg()
            .border_1()
            .border_color(cx.theme().border)
            .bg(cx.theme().secondary);
        if events.is_empty() {
            body = body.child(
                div()
                    .text_xs()
                    .text_color(muted)
                    .child("这个会话还没有工具或审批记录"),
            );
        } else {
            body = body.children(events.into_iter().rev().take(limit.min(80)).map(|event| {
                let mark = match event.ok {
                    Some(true) => "完成",
                    Some(false) => "失败",
                    None => "等待",
                };
                let timing = event
                    .duration_ms
                    .map(|ms| format!(" · {ms} ms"))
                    .unwrap_or_default();
                let kind = match event.kind.as_str() {
                    "tool_blocked" => "拦住",
                    "tool_pending" => "待审批",
                    "tool_ran" => "执行",
                    "approval_granted" => "同意",
                    "approval_denied" => "拒绝",
                    "model_usage" => "用量",
                    "permission" => "权限",
                    "branch" => "分支",
                    "cwd" => "目录",
                    "merge" => "合并",
                    other => other,
                };
                v_flex()
                    .py_0p5()
                    .text_xs()
                    .child(div().child(format!("{kind} · {} · {mark}{timing}", event.name)))
                    .child(div().text_color(muted).child(if event.detail.is_empty() {
                        " ".to_string()
                    } else {
                        event.detail
                    }))
            }));
        }
        body
    }

    fn commit_rev(line: &str) -> String {
        line.split_whitespace()
            .find_map(|token| {
                let token = token.trim_matches(|ch: char| !ch.is_ascii_hexdigit());
                (token.len() >= 4 && token.chars().all(|ch| ch.is_ascii_hexdigit()))
                    .then(|| token.to_string())
            })
            .unwrap_or_default()
    }

    fn git_panel(
        &self,
        git: Option<GitSnapshot>,
        muted: impl Into<Hsla>,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let muted = muted.into();
        let root = self.root();
        let mut git_tabs = None;
        let mut body = v_flex().w_full().px_3().pt_1().pb_3().gap_1();
        match git {
            None => {
                body = body.child(div().text_xs().text_color(muted).child(if root.is_some() {
                    "当前目录不是 Git 仓库"
                } else {
                    "选择目录后显示分支和改动"
                }));
                if root.is_some() && self.state.with(|s| s.nav) == AppNav::Agent {
                    body = body.child(
                        Button::new("git-init")
                            .xsmall()
                            .label("初始化 Git")
                            .on_click(cx.listener(|this, _, _, cx| this.init_git(cx))),
                    );
                }
            }
            Some(snapshot) => {
                let branch = if snapshot.branch.is_empty() {
                    "未知分支".to_string()
                } else {
                    snapshot.branch
                };
                body = body.child(div().text_sm().child(branch.clone()));
                let on_agent = self.state.with(|s| s.nav) == AppNav::Agent;
                if on_agent {
                    let section = self.git_section;
                    let accent = cx.theme().accent;
                    let border = cx.theme().border;
                    git_tabs = Some(
                        h_flex()
                            .id("git-capsule-subtabs")
                            .items_center()
                            .gap_1()
                            .p_1()
                            .rounded_full()
                            .bg(cx.theme().secondary)
                            .border_1()
                            .border_color(border)
                            .overflow_x_scrollbar()
                            .children(
                                [
                                    (GitSection::Changes, "改动"),
                                    (GitSection::Branches, "分支"),
                                    (GitSection::Worktrees, "工作树"),
                                    (GitSection::Log, "图谱"),
                                    (GitSection::Diff3, "三方差异"),
                                    (GitSection::Remote, "远程"),
                                ]
                                .into_iter()
                                .map(|(item, label)| {
                                    let selected = item == section;
                                    div()
                                        .id(SharedString::from(format!("git-sec-{label}")))
                                        .flex_shrink_0()
                                        .px_3()
                                        .py_1()
                                        .rounded_full()
                                        .text_xs()
                                        .cursor_pointer()
                                        .when(selected, |pill| {
                                            pill.bg(border)
                                                .text_color(accent)
                                                .font_weight(gpui::FontWeight::BOLD)
                                        })
                                        .when(!selected, |pill| {
                                            pill.text_color(muted)
                                                .hover(|pill| pill.text_color(accent))
                                        })
                                        .child(label)
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            this.git_section = item;
                                            if item == GitSection::Diff3 {
                                                this.load_diff_head(cx);
                                            } else if item != GitSection::Changes {
                                                this.load_git_lists(cx);
                                            }
                                            cx.notify();
                                        }))
                                }),
                            ),
                    );
                    if section == GitSection::Branches {
                        let scope = self.branch_scope;
                        let accent = cx.theme().accent;
                        body = body.child(
                            h_flex()
                                .gap_1()
                                .p_1()
                                .rounded_full()
                                .bg(cx.theme().secondary)
                                .border_1()
                                .border_color(cx.theme().border)
                                .children(
                                    [
                                        (BranchScope::All, "全部"),
                                        (BranchScope::Local, "本地"),
                                        (BranchScope::Remote, "远程"),
                                    ]
                                    .into_iter()
                                    .map(|(item, label)| {
                                        let selected = item == scope;
                                        div()
                                            .id(SharedString::from(format!("branch-scope-{label}")))
                                            .px_2()
                                            .py_0p5()
                                            .rounded_full()
                                            .text_xs()
                                            .cursor_pointer()
                                            .when(selected, |pill| {
                                                pill.bg(accent)
                                                    .text_color(cx.theme().accent_foreground)
                                            })
                                            .when(!selected, |pill| pill.text_color(muted))
                                            .child(label)
                                            .on_click(cx.listener(move |this, _, _, cx| {
                                                this.branch_scope = item;
                                                this.load_git_lists(cx);
                                                cx.notify();
                                            }))
                                    }),
                                ),
                        );
                        body = body.child(
                            Button::new("git-fetch-branches")
                                .xsmall()
                                .label("获取远程")
                                .on_click(cx.listener(|this, _, _, cx| this.fetch_remote(cx))),
                        );
                        let local = self.git_branches.clone();
                        let remote = self.git_remote_branches.clone();
                        let rows: Vec<(String, bool)> = match scope {
                            BranchScope::Local => {
                                local.into_iter().map(|name| (name, true)).collect()
                            }
                            BranchScope::Remote => {
                                remote.into_iter().map(|name| (name, false)).collect()
                            }
                            BranchScope::All => local
                                .into_iter()
                                .map(|name| (name, true))
                                .chain(remote.into_iter().map(|name| (name, false)))
                                .collect(),
                        };
                        if rows.is_empty() {
                            body = body.child(div().text_xs().text_color(muted).child("没有分支"));
                        }
                        let entity = cx.weak_entity();
                        body = body.children(rows.into_iter().map(|(name, checkout)| {
                            let entity = entity.clone();
                            let current = branch.contains(name.as_str());
                            div()
                                .id(SharedString::from(format!("git-branch-{name}")))
                                .py_0p5()
                                .text_xs()
                                .cursor_pointer()
                                .child(if current {
                                    format!("{name} · 当前")
                                } else if checkout {
                                    name.clone()
                                } else {
                                    format!("{name} · 远程")
                                })
                                .when(checkout, |row| {
                                    row.on_click(move |_, _, app| {
                                        let Some(view) = entity.upgrade() else { return };
                                        let name = name.clone();
                                        view.update(app, |this, cx| this.checkout_branch(name, cx));
                                    })
                                })
                        }));
                        // Fall through so the section keeps the tab bar and scroll pane.
                    }
                    if section == GitSection::Log {
                        let rows = self.git_log.clone();
                        let entity = cx.weak_entity();
                        body = body.child(
                            div()
                                .text_xs()
                                .text_color(muted)
                                .child("点一条提交，在改动页查看内容"),
                        );
                        body = body.children(rows.into_iter().map(|line| {
                            let rev = Self::commit_rev(&line);
                            let entity = entity.clone();
                            div()
                                .id(SharedString::from(format!("git-log-{rev}")))
                                .py_0p5()
                                .text_xs()
                                .cursor_pointer()
                                .child(line)
                                .on_click(move |_, _, app| {
                                    let Some(view) = entity.upgrade() else { return };
                                    let rev = rev.clone();
                                    view.update(app, |this, cx| this.load_commit(rev, cx));
                                })
                        }));
                        // Fall through so the section keeps the tab bar and scroll pane.
                    }
                    if section == GitSection::Diff3 {
                        if let Some(note) = self.git_note.clone() {
                            body = body.child(div().text_xs().text_color(muted).child(note));
                        }
                        if let Some((title, diff)) = self.git_diff.clone() {
                            body = body
                                .child(div().text_xs().child(title))
                                .child(div().font_family("monospace").text_xs().child(diff));
                        } else {
                            body = body.child(
                                div()
                                    .text_xs()
                                    .text_color(muted)
                                    .child("这里比较工作区、HEAD，以及已暂存的内容统计"),
                            );
                        }
                        // Fall through so the section keeps the tab bar and scroll pane.
                    }
                    if section == GitSection::Worktrees {
                        let rows = self.git_worktrees.clone();
                        if rows.is_empty() {
                            body =
                                body.child(div().text_xs().text_color(muted).child("没有工作树"));
                        }
                        let current = self
                            .root()
                            .map(|path| path.to_string_lossy().to_string())
                            .unwrap_or_default();
                        let entity = cx.weak_entity();
                        body = body.children(rows.into_iter().map(|(path, branch)| {
                            let here = path == current;
                            let short = path
                                .rsplit(['\\', '/'])
                                .find(|part| !part.is_empty())
                                .unwrap_or(path.as_str());
                            let text = if path.contains(".wb-worktrees") {
                                if branch.is_empty() {
                                    format!("会话 · {short}")
                                } else {
                                    format!("会话 · {short} · {branch}")
                                }
                            } else if branch.is_empty() {
                                "主工作区".to_string()
                            } else {
                                format!("主工作区 · {branch}")
                            };
                            let entity = entity.clone();
                            div()
                                .id(SharedString::from(format!("git-wt-{path}")))
                                .py_0p5()
                                .text_xs()
                                .cursor_pointer()
                                .child(if here {
                                    format!("{text} · 当前")
                                } else {
                                    text
                                })
                                .on_click(move |_, _, app| {
                                    let Some(view) = entity.upgrade() else {
                                        return;
                                    };
                                    let path = path.clone();
                                    view.update(app, |this, cx| this.use_worktree(path, cx));
                                })
                        }));
                        // Fall through so the section keeps the tab bar and scroll pane.
                    }
                    if section == GitSection::Remote {
                        let mut seen = HashSet::new();
                        let rows: Vec<(String, String)> = self
                            .git_remotes
                            .iter()
                            .filter_map(|line| {
                                let mut parts = line.split_whitespace();
                                let name = parts.next()?.to_string();
                                let url = parts.next()?.to_string();
                                if seen.insert(format!("{name} {url}")) {
                                    Some((name, url))
                                } else {
                                    None
                                }
                            })
                            .collect();
                        body = body.child(
                            Button::new("git-fetch")
                                .xsmall()
                                .label("获取远程")
                                .on_click(cx.listener(|this, _, _, cx| this.fetch_remote(cx))),
                        );
                        if let Some(note) = self.git_note.clone() {
                            body = body.child(div().text_xs().text_color(muted).child(note));
                        }
                        if rows.is_empty() {
                            body =
                                body.child(div().text_xs().text_color(muted).child("没有远程仓库"));
                        }
                        if let Some(note) = self.git_note.clone() {
                            body = body.child(div().text_xs().text_color(muted).child(note));
                        }
                        let entity = cx.weak_entity();
                        body = body.children(rows.into_iter().map(|(name, url)| {
                            let entity = entity.clone();
                            let copy = url.clone();
                            div()
                                .id(SharedString::from(format!("git-remote-{name}-{url}")))
                                .py_0p5()
                                .text_xs()
                                .cursor_pointer()
                                .child(format!("{name} · {url}"))
                                .on_click(move |_, _, app| {
                                    app.write_to_clipboard(gpui::ClipboardItem::new_string(
                                        copy.clone(),
                                    ));
                                    let Some(view) = entity.upgrade() else {
                                        return;
                                    };
                                    view.update(app, |this, cx| {
                                        this.git_note = Some("已复制远程地址".into());
                                        cx.notify();
                                    });
                                })
                        }));
                        // Fall through so the section keeps the tab bar and scroll pane.
                    }
                }
                let session_tree = root.as_ref().is_some_and(|path| {
                    path.components()
                        .any(|part| part.as_os_str() == ".wb-worktrees")
                });
                let on_agent = self.state.with(|s| s.nav) == AppNav::Agent;
                if on_agent && !session_tree {
                    let entity = cx.weak_entity();
                    body = body.child(
                        Button::new("open-session-worktree")
                            .xsmall()
                            .label("为本会话打开 worktree")
                            .on_click(move |_, _, app| {
                                let Some(view) = entity.upgrade() else {
                                    return;
                                };
                                view.update(app, |this, cx| this.open_session_worktree(cx));
                            }),
                    );
                }
                if session_tree {
                    let entity = cx.weak_entity();
                    body = body.child(
                        Button::new("merge-session-worktree")
                            .xsmall()
                            .label("合并到主分支")
                            .on_click(move |_, _, app| {
                                let Some(view) = entity.upgrade() else {
                                    return;
                                };
                                view.update(app, |this, cx| this.merge_worktree(cx));
                            }),
                    );
                }
                if let Some(note) = self.git_note.clone() {
                    body = body.child(div().text_xs().text_color(muted).child(note));
                }
                if let Some((path, diff)) = self.git_diff.clone() {
                    body = body.child(
                        v_flex()
                            .max_h(px(240.))
                            .p_3()
                            .gap_2()
                            .rounded_lg()
                            .border_1()
                            .border_color(cx.theme().border)
                            .bg(cx.theme().secondary)
                            .child(
                                h_flex()
                                    .justify_between()
                                    .items_center()
                                    .child(div().text_xs().child(path))
                                    .child(
                                        Button::new("git-diff-close")
                                            .xsmall()
                                            .ghost()
                                            .label("关闭差异")
                                            .on_click(cx.listener(|this, _, _, cx| {
                                                this.git_diff = None;
                                                cx.notify();
                                            })),
                                    ),
                            )
                            .child(
                                div()
                                    .flex_1()
                                    .min_h_0()
                                    .overflow_y_scrollbar()
                                    .font_family("monospace")
                                    .text_xs()
                                    .child(diff),
                            ),
                    );
                }
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
                        let mention = {
                            let file = path
                                .split(" -> ")
                                .next()
                                .unwrap_or(path.as_str())
                                .trim()
                                .replace('\\', "/");
                            format!("@{file}")
                        };
                        h_flex()
                            .id(SharedString::from(format!("git-{path}")))
                            .gap_2()
                            .items_center()
                            .px_2()
                            .py_1()
                            .rounded_md()
                            .text_xs()
                            .cursor_pointer()
                            .hover(|row| row.bg(cx.theme().secondary))
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
                                view.update(app, |this, cx| {
                                    if this.state.with(|s| s.nav) == AppNav::Agent {
                                        this.load_git_diff(root.clone(), path.clone(), cx);
                                        return;
                                    }
                                    let abs = root.join(&path);
                                    if abs.is_file() {
                                        let abs = abs.to_string_lossy().to_string();
                                        this.open_entry(&abs, cx);
                                    }
                                });
                            })
                            .context_menu(move |menu, _, _| {
                                let mention = mention.clone();
                                menu.item(PopupMenuItem::new("复制引用").on_click(
                                    move |_, _, app| {
                                        app.write_to_clipboard(gpui::ClipboardItem::new_string(
                                            mention.clone(),
                                        ));
                                    },
                                ))
                            })
                    }));
                }
            }
        }
        v_flex()
            .id("git-tab-panel")
            .size_full()
            .min_h_0()
            .when_some(git_tabs, |col, tabs| {
                col.child(h_flex().flex_none().px_3().py_2().child(tabs))
            })
            .child(div().flex_1().min_h_0().overflow_y_scrollbar().child(body))
    }
}
