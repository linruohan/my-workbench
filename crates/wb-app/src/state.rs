use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::JoinHandle;
use wb_domain::{AppPrefs, ThemeModePref, format_local_day, now_ms, settle_timer_segment};
use wb_store::{
    MemoryWorkbenchRepository, SaveStatus, WorkbenchSnapshot, load_prefs, load_store, save_prefs,
    save_snapshot, save_store,
};

fn save_jobs() -> &'static Mutex<Option<JoinHandle<()>>> {
    static JOBS: OnceLock<Mutex<Option<JoinHandle<()>>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(None))
}

fn save_write_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn save_latest() -> &'static AtomicU64 {
    static LATEST: AtomicU64 = AtomicU64::new(0);
    &LATEST
}

/// Crash recovery only counts a short slice. A later relaunch must not add the
/// hours the app was closed onto a running timer.
const TIMER_RECOVER_CAP_MS: i64 = 20_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppNav {
    Today,
    Inbox,
    Done,
    Planner,
    Timed,
    Projects,
    Tags,
    Knowledge,
    Agent,
    Settings,
}

impl AppNav {
    pub fn label(self) -> &'static str {
        match self {
            Self::Today => "今日",
            Self::Inbox => "收件箱",
            Self::Done => "已完成",
            Self::Planner => "计划",
            Self::Timed => "定时任务",
            Self::Projects => "项目",
            Self::Tags => "标签",
            Self::Knowledge => "知识库",
            Self::Agent => "Agent",
            Self::Settings => "设置",
        }
    }

    pub fn from_view_id(id: &str) -> Option<Self> {
        match id.trim().to_lowercase().as_str() {
            "today" => Some(Self::Today),
            "inbox" => Some(Self::Inbox),
            "done" => Some(Self::Done),
            "planner" => Some(Self::Planner),
            "timed" => Some(Self::Timed),
            "projects" => Some(Self::Projects),
            "tags" | "tag" => Some(Self::Tags),
            "knowledge" | "kb" => Some(Self::Knowledge),
            "agent" => Some(Self::Agent),
            "settings" => Some(Self::Settings),
            _ => None,
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Self::Today => "today",
            Self::Inbox => "inbox",
            Self::Done => "done",
            Self::Planner => "planner",
            Self::Timed => "timed",
            Self::Projects => "projects",
            Self::Tags => "tags",
            Self::Knowledge => "knowledge",
            Self::Agent => "agent",
            Self::Settings => "settings",
        }
    }
}

#[derive(Clone)]
pub struct AppState {
    inner: Arc<Mutex<AppStateInner>>,
}

pub struct AppStateInner {
    pub repo: MemoryWorkbenchRepository,
    pub prefs: AppPrefs,
    pub nav: AppNav,
    /// View to restore when leaving Settings.
    pub nav_before_settings: AppNav,
    pub active_project_id: Option<String>,
    pub active_tag_id: Option<String>,
    pub active_thread_id: Option<String>,
    pub save_status: SaveStatus,
    pub palette_open: bool,
    pub notifications_open: bool,
    pub selected_task_id: Option<String>,
    pub kb_current_file: Option<String>,
    /// Query to select in the knowledge editor after the palette opens a file.
    pub kb_pending_query: Option<String>,
    pub last_tick: i64,
    /// Active timer: (task_id, started_at_ms)
    pub active_timer: Option<(String, i64)>,
}

impl AppState {
    pub fn load() -> Self {
        let mut repo = load_store().unwrap_or_else(|e| {
            log::warn!("加载快照失败，使用空库: {e}");
            MemoryWorkbenchRepository::new()
        });
        let mut prefs = load_prefs().unwrap_or_default();
        let now = now_ms();
        let nav = prefs
            .session
            .nav
            .as_deref()
            .and_then(AppNav::from_view_id)
            .or_else(|| {
                AppNav::from_view_id(&prefs.general.startup_view).filter(|nav| {
                    !matches!(
                        nav,
                        AppNav::Settings | AppNav::Projects | AppNav::Tags | AppNav::Done
                    )
                })
            })
            .unwrap_or(AppNav::Today);
        let active_thread_id = prefs
            .session
            .thread_id
            .clone()
            .filter(|id| repo.get_agent_thread(id).is_some());
        let selected_task_id = prefs
            .session
            .task_id
            .clone()
            .filter(|id| repo.get_task(id).is_some());
        let active_project_id = prefs
            .session
            .project_id
            .clone()
            .filter(|id| repo.list_projects().iter().any(|project| &project.id == id));
        let active_tag_id = prefs
            .session
            .tag_id
            .clone()
            .filter(|id| repo.list_tags().iter().any(|tag| &tag.id == id));
        let mut prefs_dirty = false;
        let active_timer = match (
            prefs.session.timer_task_id.clone(),
            prefs.session.timer_started_at,
        ) {
            (Some(id), Some(started)) if repo.get_task(&id).is_some_and(|task| !task.is_done) => {
                let elapsed = now.saturating_sub(started);
                if (0..TIMER_RECOVER_CAP_MS).contains(&elapsed)
                    && let Some(mut task) = repo.get_task(&id).cloned()
                {
                    settle_timer_segment(&mut task, &format_local_day(now), elapsed, now);
                    repo.upsert_task(task);
                }
                prefs.session.timer_task_id = Some(id.clone());
                prefs.session.timer_started_at = Some(now);
                prefs_dirty = true;
                Some((id, now))
            }
            (Some(_), _) | (_, Some(_)) => {
                prefs.session.timer_task_id = None;
                prefs.session.timer_started_at = None;
                prefs_dirty = true;
                None
            }
            _ => None,
        };
        if repo.is_dirty()
            && let Err(e) = save_store(&mut repo)
        {
            log::warn!("启动时写回计时失败: {e}");
        }
        if prefs_dirty && let Err(e) = save_prefs(&prefs) {
            log::warn!("启动时写回会话现场失败: {e}");
        }
        Self {
            inner: Arc::new(Mutex::new(AppStateInner {
                repo,
                prefs,
                nav,
                nav_before_settings: AppNav::Today,
                active_project_id,
                active_tag_id,
                active_thread_id,
                save_status: SaveStatus::default(),
                palette_open: false,
                notifications_open: false,
                selected_task_id,
                kb_current_file: None,
                kb_pending_query: None,
                last_tick: now,
                active_timer,
            })),
        }
    }

    pub fn with<R>(&self, f: impl FnOnce(&AppStateInner) -> R) -> R {
        f(&self.inner.lock().unwrap())
    }

    pub fn with_mut<R>(&self, f: impl FnOnce(&mut AppStateInner) -> R) -> R {
        f(&mut self.inner.lock().unwrap())
    }

    /// Export under the state lock, then serialize and write on a background thread.
    /// A newer export supersedes an older in-flight write.
    pub fn persist_if_dirty(&self) {
        let Some(snap) = self.take_dirty_snapshot() else {
            return;
        };
        let generation = save_latest().fetch_add(1, Ordering::SeqCst) + 1;
        let state = self.clone();
        let handle = std::thread::spawn(move || write_snapshot(state, snap, generation));
        *save_jobs().lock().unwrap_or_else(|e| e.into_inner()) = Some(handle);
    }

    /// Wait for the background save, then write anything still dirty. Used on exit.
    pub fn persist_blocking(&self) {
        if let Some(handle) = save_jobs().lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = handle.join();
        }
        self.with_mut(|s| {
            if !s.repo.is_dirty() {
                return;
            }
            match save_store(&mut s.repo) {
                Ok(status) => s.save_status = status,
                Err(e) => {
                    s.save_status = SaveStatus {
                        ok: false,
                        message: Some(e.to_string()),
                        at: now_ms(),
                        bytes: None,
                        warning: None,
                    };
                }
            }
        });
    }

    fn take_dirty_snapshot(&self) -> Option<WorkbenchSnapshot> {
        self.with_mut(|s| {
            if !s.repo.is_dirty() {
                return None;
            }
            let snap = s.repo.export_snapshot();
            s.repo.clear_dirty();
            Some(snap)
        })
    }

    /// Shell id from General settings. Empty and `auto` follow the host default.
    #[allow(dead_code)]
    pub fn terminal_program(&self) -> String {
        self.with(|s| s.prefs.general.terminal_shell.clone())
    }

    pub fn persist_prefs(&self) {
        self.with(|s| {
            if let Err(e) = save_prefs(&s.prefs) {
                log::warn!("保存 prefs 失败: {e}");
            }
        });
    }

    /// Write the open page, thread, task, and running timer into `prefs.json`.
    pub fn remember_session(&self) {
        let changed = self.with_mut(|s| {
            let next = wb_domain::UiSession {
                nav: Some(s.nav.id().into()),
                thread_id: s.active_thread_id.clone(),
                task_id: s.selected_task_id.clone(),
                project_id: s.active_project_id.clone(),
                tag_id: s.active_tag_id.clone(),
                timer_task_id: s.active_timer.as_ref().map(|(id, _)| id.clone()),
                timer_started_at: s.active_timer.as_ref().map(|(_, started)| *started),
            };
            if s.prefs.session == next {
                false
            } else {
                s.prefs.session = next;
                true
            }
        });
        if changed {
            self.persist_prefs();
        }
    }

    pub fn today(&self) -> String {
        format_local_day(now_ms())
    }

    pub fn theme_mode(&self) -> ThemeModePref {
        self.with(|s| s.prefs.theme_mode)
    }

    /// Push an in-app notification and optionally a desktop toast.
    pub fn push_notification(
        &self,
        kind: wb_domain::NotificationKind,
        title: &str,
        body: &str,
        related_id: Option<&str>,
    ) {
        let want_toast = self.with_mut(|s| {
            s.repo.push_notification(kind, title, body, related_id);
            s.prefs.system_notifications
        });
        if want_toast {
            if let Err(e) = wb_host::show_system_notification(title, body) {
                log::debug!("系统通知失败: {e}");
            }
        }
    }
}

fn write_snapshot(state: AppState, snap: WorkbenchSnapshot, generation: u64) {
    let _guard = save_write_lock().lock().unwrap_or_else(|e| e.into_inner());
    if save_latest().load(Ordering::SeqCst) != generation {
        return;
    }
    match save_snapshot(&snap) {
        Ok(status) => state.with_mut(|s| s.save_status = status),
        Err(e) => {
            log::warn!("保存快照失败: {e}");
            state.with_mut(|s| {
                s.repo.mark_dirty();
                s.save_status = SaveStatus {
                    ok: false,
                    message: Some(e.to_string()),
                    at: now_ms(),
                    bytes: None,
                    warning: None,
                };
            });
        }
    }
}
