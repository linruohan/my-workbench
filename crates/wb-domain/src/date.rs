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
}
