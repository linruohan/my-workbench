use chrono::{Datelike, Local, NaiveDate, TimeZone, Timelike, Weekday};

pub fn now_ms() -> i64 {
    Local::now().timestamp_millis()
}

pub fn format_local_day(ms: i64) -> String {
    let dt = Local
        .timestamp_millis_opt(ms)
        .single()
        .unwrap_or_else(Local::now);
    format!("{:04}-{:02}-{:02}", dt.year(), dt.month(), dt.day())
}

/// Compact local stamp for backup folder names: `2026-11-21_164512`.
pub fn format_local_stamp(ms: i64) -> String {
    let dt = Local
        .timestamp_millis_opt(ms)
        .single()
        .unwrap_or_else(Local::now);
    format!(
        "{:04}-{:02}-{:02}_{:02}{:02}{:02}",
        dt.year(),
        dt.month(),
        dt.day(),
        dt.hour(),
        dt.minute(),
        dt.second()
    )
}

pub fn parse_local_day(day: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(day, "%Y-%m-%d").ok()
}

pub fn add_local_days(day: &str, delta: i64) -> Option<String> {
    let d = parse_local_day(day)?;
    let next = d + chrono::Duration::days(delta);
    Some(format!(
        "{:04}-{:02}-{:02}",
        next.year(),
        next.month(),
        next.day()
    ))
}

pub fn at_local_time(day: &str, hour: u32, minute: u32) -> Option<i64> {
    let d = parse_local_day(day)?;
    let dt = d.and_hms_opt(hour, minute, 0)?;
    let local = Local.from_local_datetime(&dt).single()?;
    Some(local.timestamp_millis())
}

pub fn weekday_of_day(day: &str) -> Option<Weekday> {
    parse_local_day(day).map(|d| d.weekday())
}

pub fn is_weekend(day: &str) -> bool {
    matches!(weekday_of_day(day), Some(Weekday::Sat) | Some(Weekday::Sun))
}

/// Chinese weekday short label: 一…日.
pub fn weekday_cn_short(day: &str) -> &'static str {
    match weekday_of_day(day) {
        Some(Weekday::Mon) => "一",
        Some(Weekday::Tue) => "二",
        Some(Weekday::Wed) => "三",
        Some(Weekday::Thu) => "四",
        Some(Weekday::Fri) => "五",
        Some(Weekday::Sat) => "六",
        Some(Weekday::Sun) => "日",
        None => "?",
    }
}

/// First day of the week that contains `day`.
///
/// `monday` starts the week on Monday; otherwise it starts on Sunday.
pub fn start_of_week(day: &str, monday: bool) -> String {
    let Some(date) = parse_local_day(day) else {
        return day.to_string();
    };
    let offset = if monday {
        date.weekday().num_days_from_monday() as i64
    } else {
        date.weekday().num_days_from_sunday() as i64
    };
    add_local_days(day, -offset).unwrap_or_else(|| day.to_string())
}

/// Build `count` planner day columns starting at `start` (inclusive).
/// When `skip_weekends` is true, Saturday/Sunday are omitted until enough weekdays are collected.
pub fn planner_day_columns(start: &str, count: usize, skip_weekends: bool) -> Vec<String> {
    if count == 0 {
        return Vec::new();
    }
    let mut out = Vec::with_capacity(count);
    let mut cursor = start.to_string();
    let mut guard = 0usize;
    while out.len() < count && guard < count.saturating_mul(4).saturating_add(14) {
        guard += 1;
        if !(skip_weekends && is_weekend(&cursor)) {
            out.push(cursor.clone());
        }
        match add_local_days(&cursor, 1) {
            Some(next) => cursor = next,
            None => break,
        }
    }
    out
}

pub fn local_hour_minute(ms: i64) -> (u32, u32) {
    let dt = Local
        .timestamp_millis_opt(ms)
        .single()
        .unwrap_or_else(Local::now);
    (dt.hour(), dt.minute())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_day() {
        let day = format_local_day(1_700_000_000_000);
        assert_eq!(day.len(), 10);
        assert!(parse_local_day(&day).is_some());
    }

    #[test]
    fn week_starts_on_monday_or_sunday() {
        // 2026-11-21 is Saturday.
        assert_eq!(start_of_week("2026-11-21", true), "2026-11-16");
        assert_eq!(start_of_week("2026-11-21", false), "2026-11-15");
    }

    #[test]
    fn planner_columns_include_weekends_by_default() {
        // 2026-11-20 is Friday → 3 days: Fri Sat Sun
        let cols = planner_day_columns("2026-11-20", 3, false);
        assert_eq!(cols, vec!["2026-11-20", "2026-11-21", "2026-11-22"]);
        assert!(is_weekend("2026-11-21"));
        assert_eq!(weekday_cn_short("2026-11-20"), "五");
    }

    #[test]
    fn planner_columns_skip_weekends() {
        // Fri → next weekdays Mon Tue (skip Sat/Sun)
        let cols = planner_day_columns("2026-11-20", 3, true);
        assert_eq!(cols, vec!["2026-11-20", "2026-11-23", "2026-11-24"]);
        assert!(!cols.iter().any(|d| is_weekend(d)));
    }
}
