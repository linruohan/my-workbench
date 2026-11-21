use serde::{Deserialize, Serialize};

pub const SIDEBAR_WIDTH_DEFAULT: f32 = 240.0;
pub const SIDEBAR_WIDTH_MIN: f32 = 180.0;
pub const SIDEBAR_WIDTH_MAX: f32 = 420.0;

pub fn clamp_sidebar_width(w: f32) -> f32 {
    w.clamp(SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppPrefs {
    #[serde(default = "default_sidebar_width")]
    pub sidebar_width: f32,
    #[serde(default)]
    pub sidebar_collapsed: bool,
    #[serde(default)]
    pub theme_mode: ThemeModePref,
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
}

fn default_sidebar_width() -> f32 {
    SIDEBAR_WIDTH_DEFAULT
}

impl Default for AppPrefs {
    fn default() -> Self {
        Self {
            sidebar_width: SIDEBAR_WIDTH_DEFAULT,
            sidebar_collapsed: false,
            theme_mode: ThemeModePref::Light,
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
