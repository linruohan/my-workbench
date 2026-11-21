use std::sync::{Arc, Mutex};
use wb_domain::{AppPrefs, ThemeModePref, format_local_day, now_ms};
use wb_store::{
    MemoryWorkbenchRepository, SaveStatus, load_prefs, load_store, save_prefs, save_store,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppNav {
    Today,
    Inbox,
    Done,
    Planner,
    Timed,
    Projects,
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
            Self::Knowledge => "知识库",
            Self::Agent => "Agent",
            Self::Settings => "设置",
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
    pub active_project_id: Option<String>,
    pub active_thread_id: Option<String>,
    pub save_status: SaveStatus,
    pub palette_open: bool,
    pub notifications_open: bool,
    pub selected_task_id: Option<String>,
    pub kb_current_file: Option<String>,
    pub last_tick: i64,
    /// Active timer: (task_id, started_at_ms)
    pub active_timer: Option<(String, i64)>,
}

impl AppState {
    pub fn load() -> Self {
        let repo = load_store().unwrap_or_else(|e| {
            log::warn!("加载快照失败，使用空库: {e}");
            MemoryWorkbenchRepository::new()
        });
        let prefs = load_prefs().unwrap_or_default();
        Self {
            inner: Arc::new(Mutex::new(AppStateInner {
                repo,
                prefs,
                nav: AppNav::Today,
                active_project_id: None,
                active_thread_id: None,
                save_status: SaveStatus::default(),
                palette_open: false,
                notifications_open: false,
                selected_task_id: None,
                kb_current_file: None,
                last_tick: now_ms(),
                active_timer: None,
            })),
        }
    }

    pub fn with<R>(&self, f: impl FnOnce(&AppStateInner) -> R) -> R {
        f(&self.inner.lock().unwrap())
    }

    pub fn with_mut<R>(&self, f: impl FnOnce(&mut AppStateInner) -> R) -> R {
        f(&mut self.inner.lock().unwrap())
    }

    pub fn persist_if_dirty(&self) {
        self.with_mut(|s| {
            if s.repo.is_dirty() {
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
            }
        });
    }

    pub fn persist_prefs(&self) {
        self.with(|s| {
            if let Err(e) = save_prefs(&s.prefs) {
                log::warn!("保存 prefs 失败: {e}");
            }
        });
    }

    pub fn today(&self) -> String {
        format_local_day(now_ms())
    }

    pub fn theme_is_dark(&self) -> bool {
        self.with(|s| matches!(s.prefs.theme_mode, ThemeModePref::Dark))
    }
}
