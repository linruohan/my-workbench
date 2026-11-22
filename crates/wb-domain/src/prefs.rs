use serde::{Deserialize, Serialize};

pub const SIDEBAR_WIDTH_DEFAULT: f32 = 240.0;
pub const SIDEBAR_WIDTH_MIN: f32 = 180.0;
pub const SIDEBAR_WIDTH_MAX: f32 = 420.0;

pub const RIGHT_SIDEBAR_WIDTH_DEFAULT: f32 = 280.0;
pub const RIGHT_SIDEBAR_WIDTH_MIN: f32 = 200.0;
pub const RIGHT_SIDEBAR_WIDTH_MAX: f32 = 480.0;

pub fn clamp_sidebar_width(w: f32) -> f32 {
    w.clamp(SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX)
}

pub fn clamp_right_sidebar_width(w: f32) -> f32 {
    w.clamp(RIGHT_SIDEBAR_WIDTH_MIN, RIGHT_SIDEBAR_WIDTH_MAX)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppPrefs {
    #[serde(default = "default_sidebar_width")]
    pub sidebar_width: f32,
    #[serde(default = "default_right_sidebar_width")]
    pub right_sidebar_width: f32,
    #[serde(default)]
    pub sidebar_collapsed: bool,
    #[serde(default)]
    pub right_sidebar_collapsed: bool,
    #[serde(default)]
    pub theme_mode: ThemeModePref,
    /// Named theme from the theme registry, for example "Catppuccin Mocha".
    #[serde(default)]
    pub theme_name: Option<String>,
    /// Corner radius in px. Empty keeps the theme file's radius.
    #[serde(default)]
    pub ui_radius: Option<f32>,
    /// Interface font size in px. Empty keeps the theme file's size.
    #[serde(default)]
    pub font_size: Option<f32>,
    /// `scrolling` | `hover` | `always`.
    #[serde(default)]
    pub scrollbar_mode: Option<String>,
    #[serde(default)]
    pub ui_font: Option<String>,
    #[serde(default)]
    pub web_font: Option<String>,
    #[serde(default)]
    pub system_notifications: bool,
    #[serde(default)]
    pub http_proxy: Option<String>,
    #[serde(default)]
    pub voice: VoicePrefs,
    #[serde(default)]
    pub agent: AgentPrefs,
    #[serde(default)]
    pub knowledge_roots: Vec<String>,
    #[serde(default)]
    pub knowledge_current: Option<String>,
    #[serde(default)]
    pub knowledge_recent: Vec<String>,
    /// Planner calendar: omit Sat/Sun when building day columns.
    #[serde(default)]
    pub planner_skip_weekends: bool,
    /// Show a system tray icon while the app runs.
    #[serde(default = "default_true")]
    pub tray_enabled: bool,
    /// Close button minimizes instead of quitting (tray Quit exits).
    #[serde(default = "default_true")]
    pub close_to_tray: bool,
    #[serde(default)]
    pub general: GeneralPrefs,
}

/// Local workspace preferences shown on the General settings page.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GeneralPrefs {
    /// Display name stored on this machine. There is no cloud account.
    #[serde(default = "default_display_name")]
    pub display_name: String,
    /// `system` | `zh-CN` | `en-US`. Interface copy is not fully localized yet.
    #[serde(default = "default_locale")]
    pub locale: String,
    /// `office` | `focus`.
    #[serde(default = "default_interface_mode")]
    pub interface_mode: String,
    /// Suggest today's tasks from the plan. Applies in office mode only.
    #[serde(default)]
    pub proactive_suggestions: bool,
    /// View opened on launch: today, inbox, planner, timed, knowledge, agent.
    #[serde(default = "default_startup_view")]
    pub startup_view: String,
    /// `default` | `maximized` | `remember`. Host window restore is not wired yet.
    #[serde(default = "default_window_restore")]
    pub window_restore: String,
    #[serde(default = "default_true")]
    pub show_empty_hints: bool,
    #[serde(default = "default_true")]
    pub confirm_before_delete: bool,
    /// `monday` | `sunday`.
    #[serde(default = "default_week_start")]
    pub week_starts_on: String,
    /// [`crate::ReminderOptionId`] id used when a task is scheduled with a time.
    #[serde(default = "default_remind")]
    pub default_remind: String,
    #[serde(default = "default_true")]
    pub remember_last_note: bool,
    #[serde(default)]
    pub last_note_path: Option<String>,
}

fn default_display_name() -> String {
    "本地用户".into()
}

fn default_locale() -> String {
    "system".into()
}

fn default_interface_mode() -> String {
    "office".into()
}

fn default_startup_view() -> String {
    "today".into()
}

fn default_window_restore() -> String {
    "default".into()
}

fn default_week_start() -> String {
    "monday".into()
}

fn default_remind() -> String {
    "m15".into()
}

impl Default for GeneralPrefs {
    fn default() -> Self {
        Self {
            display_name: default_display_name(),
            locale: default_locale(),
            interface_mode: default_interface_mode(),
            proactive_suggestions: false,
            startup_view: default_startup_view(),
            window_restore: default_window_restore(),
            show_empty_hints: true,
            confirm_before_delete: true,
            week_starts_on: default_week_start(),
            default_remind: default_remind(),
            remember_last_note: true,
            last_note_path: None,
        }
    }
}

fn default_true() -> bool {
    true
}

fn default_sidebar_width() -> f32 {
    SIDEBAR_WIDTH_DEFAULT
}

fn default_right_sidebar_width() -> f32 {
    RIGHT_SIDEBAR_WIDTH_DEFAULT
}

impl Default for AppPrefs {
    fn default() -> Self {
        Self {
            sidebar_width: SIDEBAR_WIDTH_DEFAULT,
            right_sidebar_width: RIGHT_SIDEBAR_WIDTH_DEFAULT,
            sidebar_collapsed: false,
            right_sidebar_collapsed: false,
            theme_mode: ThemeModePref::Light,
            theme_name: None,
            ui_radius: None,
            font_size: None,
            scrollbar_mode: None,
            ui_font: None,
            web_font: None,
            system_notifications: false,
            http_proxy: None,
            voice: VoicePrefs::default(),
            agent: AgentPrefs::default(),
            knowledge_roots: Vec::new(),
            knowledge_current: None,
            knowledge_recent: Vec::new(),
            planner_skip_weekends: false,
            tray_enabled: true,
            close_to_tray: true,
            general: GeneralPrefs::default(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ThemeModePref {
    #[default]
    Light,
    Dark,
    /// 跟随操作系统浅色 / 深色
    System,
}

impl ThemeModePref {
    pub fn label(self) -> &'static str {
        match self {
            Self::Light => "浅色",
            Self::Dark => "深色",
            Self::System => "跟随系统",
        }
    }

    pub fn cycle(self) -> Self {
        match self {
            Self::Light => Self::Dark,
            Self::Dark => Self::System,
            Self::System => Self::Light,
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "light" | "浅色" => Some(Self::Light),
            "dark" | "深色" => Some(Self::Dark),
            "system" | "auto" | "跟随系统" => Some(Self::System),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct VoicePrefs {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub engine: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub caps_lock_ptt: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentPrefs {
    #[serde(default)]
    pub default_model_ref: Option<String>,
    #[serde(default)]
    pub personality: Option<String>,
    #[serde(default)]
    pub memories: Vec<String>,
    #[serde(default)]
    pub skills_dirs: Vec<String>,
    #[serde(default)]
    pub plugins_dirs: Vec<String>,
    #[serde(default)]
    pub mcp_servers: Vec<serde_json::Value>,
    #[serde(default)]
    pub subagents: Vec<serde_json::Value>,
    #[serde(default)]
    pub hooks: Vec<serde_json::Value>,
}
