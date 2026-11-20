use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const INBOX_PROJECT_ID: &str = "inbox";
pub const FORBIDDEN_TODAY_TAG_ID: &str = "TODAY";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectBucket {
    Active,
    Backlog,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReminderOptionId {
    None,
    AtStart,
    M5,
    M10,
    M15,
    M30,
    H1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NotificationKind {
    TaskRemind,
    DeadlineRemind,
    EventRemind,
    Agent,
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NotificationStatus {
    Pending,
    Delivered,
    Snoozed,
    Dismissed,
    Acted,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub is_archived: bool,
    #[serde(default)]
    pub is_done: bool,
    #[serde(default)]
    pub done_on: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub project_id: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub is_done: bool,
    #[serde(default)]
    pub done_on: Option<i64>,
    #[serde(default)]
    pub due_day: Option<String>,
    #[serde(default)]
    pub due_with_time: Option<i64>,
    #[serde(default)]
    pub deadline_day: Option<String>,
    #[serde(default)]
    pub deadline_with_time: Option<i64>,
    #[serde(default)]
    pub remind_at: Option<i64>,
    #[serde(default)]
    pub deadline_remind_at: Option<i64>,
    #[serde(default)]
    pub time_estimate: i64,
    #[serde(default)]
    pub time_spent: i64,
    #[serde(default)]
    pub time_spent_on_day: HashMap<String, i64>,
    #[serde(default)]
    pub repeat_cfg_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    #[serde(default)]
    pub project_id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub body_md: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NoteEditorMode {
    Live,
    Source,
    Preview,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimedSchedulePreset {
    Hourly,
    Daily,
    Weekdays,
    Weekly,
    Monthly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimedIntervalUnit {
    Minute,
    Hour,
    Day,
    Week,
    Month,
    Year,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TimedSchedule {
    Once {
        at: i64,
    },
    Preset {
        preset: TimedSchedulePreset,
        #[serde(rename = "atTime")]
        at_time: String,
    },
    Custom {
        every: i64,
        unit: TimedIntervalUnit,
        #[serde(rename = "atTime")]
        at_time: String,
        #[serde(rename = "endMode", default)]
        end_mode: EndMode,
        #[serde(rename = "endDate", default)]
        end_date: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum EndMode {
    #[default]
    Never,
    OnDate,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TimedTask {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub schedule: Option<TimedSchedule>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub last_run_at: Option<i64>,
    #[serde(default)]
    pub next_run_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppNotification {
    pub id: String,
    pub kind: NotificationKind,
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub ref_type: Option<String>,
    #[serde(default)]
    pub ref_id: Option<String>,
    pub fire_at: i64,
    pub status: NotificationStatus,
    #[serde(default)]
    pub snooze_until: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SchedulePatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due_day: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due_with_time: Option<Option<i64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline_day: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline_with_time: Option<Option<i64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remind_at: Option<Option<i64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline_remind_at: Option<Option<i64>>,
}
