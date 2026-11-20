use crate::date::{add_local_days, at_local_time, format_local_day, parse_local_day};
use crate::reminder::{remind_option_to_milliseconds, shift_remind_at};
use crate::types::{INBOX_PROJECT_ID, ReminderOptionId};
use chrono::Datelike;
use regex::Regex;
use std::sync::LazyLock;

#[derive(Debug, Clone, PartialEq)]
pub struct QuickCaptureResult {
    pub title: String,
    pub project_title: Option<String>,
    pub project_id: Option<String>,
    pub due_day: Option<String>,
    pub due_with_time: Option<i64>,
    pub deadline_day: Option<String>,
    pub deadline_with_time: Option<i64>,
    pub remind_option: ReminderOptionId,
    pub remind_at: Option<i64>,
    pub summary: Vec<String>,
}

static PROJECT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"#([^\s#]+)").unwrap());
static REMIND_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"提前\s*(\d+)\s*分钟").unwrap());
static TIME_HM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(上午|下午)?\s*(\d{1,2})[:：](\d{2})").unwrap());
static TIME_CN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(上午|下午)?\s*(\d{1,2})\s*点(半|(\d{1,2})\s*分?)?").unwrap());
static MD_CN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\d{1,2})月(\d{1,2})日").unwrap());
static MD_DOT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?P<pre>^|[^\d])(?P<m>\d{1,2})[./\-](?P<d>\d{1,2})\s*(?P<hao>号)?").unwrap()
});

fn weekday_num(ch: char) -> Option<u32> {
    match ch {
        '日' | '天' => Some(0),
        '一' => Some(1),
        '二' => Some(2),
        '三' => Some(3),
        '四' => Some(4),
        '五' => Some(5),
        '六' => Some(6),
        _ => None,
    }
}

fn next_weekday(from_day: &str, weekday: u32) -> Option<String> {
    let start = parse_local_day(from_day)?;
    let current = start.weekday().num_days_from_sunday();
    let mut delta = (weekday + 7 - current) % 7;
    if delta == 0 {
        delta = 7;
    }
    add_local_days(from_day, delta as i64)
}

fn parse_time_token(text: &str, day: &str) -> Option<(i64, String)> {
    if let Some(hm) = TIME_HM.find(text) {
        let caps = TIME_HM.captures(hm.as_str())?;
        let mut hour: u32 = caps.get(2)?.as_str().parse().ok()?;
        let minute: u32 = caps.get(3)?.as_str().parse().ok()?;
        if caps.get(1).map(|m| m.as_str()) == Some("下午") && hour < 12 {
            hour += 12;
        }
        if caps.get(1).map(|m| m.as_str()) == Some("上午") && hour == 12 {
            hour = 0;
        }
        if hour > 23 || minute > 59 {
            return None;
        }
        let ms = at_local_time(day, hour, minute)?;
        return Some((ms, hm.as_str().to_string()));
    }
    if let Some(cn) = TIME_CN.find(text) {
        let caps = TIME_CN.captures(cn.as_str())?;
        let mut hour: u32 = caps.get(2)?.as_str().parse().ok()?;
        if caps.get(1).map(|m| m.as_str()) == Some("下午") && hour < 12 {
            hour += 12;
        }
        if caps.get(1).map(|m| m.as_str()) == Some("上午") && hour == 12 {
            hour = 0;
        }
        let mut minute = 0u32;
        if caps.get(3).map(|m| m.as_str()) == Some("半") {
            minute = 30;
        } else if let Some(m) = caps.get(4) {
            minute = m.as_str().parse().ok()?;
        }
        if hour > 23 || minute > 59 {
            return None;
        }
        let ms = at_local_time(day, hour, minute)?;
        return Some((ms, cn.as_str().to_string()));
    }
    None
}

fn parse_month_day_token(text: &str, today: &str) -> Option<(String, String)> {
    if let Some(md) = MD_CN.captures(text) {
        let month: u32 = md.get(1)?.as_str().parse().ok()?;
        let date: u32 = md.get(2)?.as_str().parse().ok()?;
        if !(1..=12).contains(&month) || !(1..=31).contains(&date) {
            return None;
        }
        let y: i32 = today[..4].parse().ok()?;
        return Some((
            format!("{y:04}-{month:02}-{date:02}"),
            md.get(0)?.as_str().to_string(),
        ));
    }
    if let Some(dotted) = MD_DOT.captures(text) {
        let month: u32 = dotted.name("m")?.as_str().parse().ok()?;
        let date: u32 = dotted.name("d")?.as_str().parse().ok()?;
        if !(1..=12).contains(&month) || !(1..=31).contains(&date) {
            return None;
        }
        let full = dotted.get(0)?.as_str();
        let after_start = dotted.get(0)?.end();
        let after = &text[after_start..];
        if dotted.name("hao").is_none()
            && after
                .chars()
                .next()
                .is_some_and(|c| "小时分个万人千百天年周块钱元份两斤".contains(c))
        {
            return None;
        }
        let y: i32 = today[..4].parse().ok()?;
        let consumed = if dotted.name("pre").map(|m| m.as_str()) == Some("") {
            full.to_string()
        } else {
            // drop the non-digit prefix from consumed
            full.chars().skip(1).collect()
        };
        return Some((format!("{y:04}-{month:02}-{date:02}"), consumed));
    }
    None
}

/// Parse a one-line capture. Unrecognized project (#name) stays available via project_title.
pub fn parse_quick_capture(
    input: &str,
    now_ms: i64,
    _workday_start_hour: Option<u32>,
) -> QuickCaptureResult {
    let mut text = input.trim().to_string();
    let today = format_local_day(now_ms);
    let mut summary = Vec::new();

    let mut project_title = None;
    if let Some(caps) = PROJECT_RE.captures(&text) {
        project_title = Some(caps.get(1).unwrap().as_str().to_string());
        text = PROJECT_RE.replace(&text, " ").to_string();
        text = text.split_whitespace().collect::<Vec<_>>().join(" ");
        summary.push(format!("项目 #{}", project_title.as_ref().unwrap()));
    }

    let mut deadline_day = None;
    if let Some(idx) = text.find("截止") {
        let rest = text[idx + "截止".len()..].to_string();
        let rest_trim = rest.trim_start();
        let mut consumed_deadline = String::from("截止");
        if rest_trim.starts_with("今天") {
            deadline_day = Some(today.clone());
            consumed_deadline.push_str("今天");
        } else if rest_trim.starts_with("明天") {
            deadline_day = add_local_days(&today, 1);
            consumed_deadline.push_str("明天");
        } else if rest_trim.starts_with("周五") || rest_trim.starts_with("星期五") {
            let label = if rest_trim.starts_with("星期五") {
                "星期五"
            } else {
                "周五"
            };
            deadline_day = next_weekday(&today, 5);
            consumed_deadline.push_str(label);
        } else if let Some(caps) = Regex::new(r"^下周([日天一二三四五六])")
            .ok()
            .and_then(|re| re.captures(rest_trim))
        {
            let ch = caps.get(1).unwrap().as_str().chars().next().unwrap();
            if let Some(wd) = weekday_num(ch) {
                deadline_day = next_weekday(&today, wd).and_then(|d| add_local_days(&d, 7));
                consumed_deadline.push_str(caps.get(0).unwrap().as_str());
            }
        } else if let Some((day, c)) = parse_month_day_token(rest_trim, &today) {
            deadline_day = Some(day);
            consumed_deadline.push_str(&c);
        }
        if let Some(ref day) = deadline_day {
            text = text.replacen(&consumed_deadline, " ", 1);
            summary.push(format!("截止 {day}"));
        }
    }

    let mut due_day = None;
    let mut due_with_time = None;

    // date tokens
    if text.contains("今天") {
        due_day = Some(today.clone());
        text = text.replace("今天", " ");
        summary.push("今天".into());
    } else if text.contains("明天") {
        due_day = add_local_days(&today, 1);
        text = text.replace("明天", " ");
        summary.push("明天".into());
    } else if let Some((label, wd)) = Regex::new(r"下周([日天一二三四五六])")
        .ok()
        .and_then(|re| re.captures(&text))
        .and_then(|caps| {
            let label = caps.get(0)?.as_str().to_string();
            let ch = caps.get(1)?.as_str().chars().next()?;
            weekday_num(ch).map(|wd| (label, wd))
        })
    {
        due_day = next_weekday(&today, wd).and_then(|d| add_local_days(&d, 7));
        text = text.replacen(&label, " ", 1);
        summary.push(label);
    } else if text.contains("周五") || text.contains("星期五") {
        due_day = next_weekday(&today, 5);
        text = text.replace("星期五", " ").replace("周五", " ");
        summary.push("周五".into());
    } else if let Some((day, c)) = parse_month_day_token(&text, &today) {
        due_day = Some(day);
        text = text.replacen(&c, " ", 1);
        summary.push(due_day.clone().unwrap());
    }

    let day_for_time = due_day.clone().unwrap_or_else(|| today.clone());
    if let Some((ms, consumed)) = parse_time_token(&text, &day_for_time) {
        due_with_time = Some(ms);
        due_day = None;
        text = text.replacen(&consumed, " ", 1);
        summary.push("时刻".into());
    } else if text.contains("上午") {
        if let Some(ms) = at_local_time(&day_for_time, 9, 0) {
            due_with_time = Some(ms);
            due_day = None;
            text = text.replace("上午", " ");
            summary.push("上午".into());
        }
    } else if text.contains("下午") {
        if let Some(ms) = at_local_time(&day_for_time, 14, 0) {
            due_with_time = Some(ms);
            due_day = None;
            text = text.replace("下午", " ");
            summary.push("下午".into());
        }
    }

    let mut remind_option = ReminderOptionId::None;
    let mut remind_at = None;
    if let Some(caps) = REMIND_RE.captures(&text) {
        let mins: i64 = caps.get(1).unwrap().as_str().parse().unwrap_or(0);
        remind_option = match mins {
            5 => ReminderOptionId::M5,
            10 => ReminderOptionId::M10,
            15 => ReminderOptionId::M15,
            30 => ReminderOptionId::M30,
            60 => ReminderOptionId::H1,
            _ => ReminderOptionId::None,
        };
        text = REMIND_RE.replace(&text, " ").to_string();
        if let Some(due) = due_with_time {
            remind_at = shift_remind_at(due, remind_option);
        }
        if remind_option != ReminderOptionId::None {
            summary.push(format!("提前{mins}分钟"));
        }
    }

    let title = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let project_id = if project_title.is_some() {
        None
    } else {
        Some(INBOX_PROJECT_ID.to_string())
    };

    let _ = remind_option_to_milliseconds(remind_option);

    QuickCaptureResult {
        title: if title.is_empty() {
            input.trim().to_string()
        } else {
            title
        },
        project_title,
        project_id,
        due_day,
        due_with_time,
        deadline_day,
        deadline_with_time: None,
        remind_option,
        remind_at,
        summary,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn captures_today() {
        let r = parse_quick_capture("今天 写报告", 1_700_000_000_000, None);
        assert!(r.due_day.is_some());
        assert!(r.title.contains("写报告"));
    }
}
