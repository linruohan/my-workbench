use crate::types::ReminderOptionId;

pub fn remind_option_to_milliseconds(opt: ReminderOptionId) -> Option<i64> {
    match opt {
        ReminderOptionId::None => None,
        ReminderOptionId::AtStart => Some(0),
        ReminderOptionId::M5 => Some(5 * 60_000),
        ReminderOptionId::M10 => Some(10 * 60_000),
        ReminderOptionId::M15 => Some(15 * 60_000),
        ReminderOptionId::M30 => Some(30 * 60_000),
        ReminderOptionId::H1 => Some(60 * 60_000),
    }
}

pub fn milliseconds_diff_to_remind_option(diff_ms: i64) -> ReminderOptionId {
    if diff_ms <= 0 {
        return ReminderOptionId::AtStart;
    }
    let mins = diff_ms / 60_000;
    match mins {
        0..=2 => ReminderOptionId::AtStart,
        3..=7 => ReminderOptionId::M5,
        8..=12 => ReminderOptionId::M10,
        13..=22 => ReminderOptionId::M15,
        23..=45 => ReminderOptionId::M30,
        _ => ReminderOptionId::H1,
    }
}

pub fn shift_remind_at(due_with_time: i64, option: ReminderOptionId) -> Option<i64> {
    remind_option_to_milliseconds(option).map(|offset| due_with_time - offset)
}

pub fn remind_option_label(opt: ReminderOptionId) -> &'static str {
    match opt {
        ReminderOptionId::None => "不提醒",
        ReminderOptionId::AtStart => "到点提醒",
        ReminderOptionId::M5 => "提前 5 分钟",
        ReminderOptionId::M10 => "提前 10 分钟",
        ReminderOptionId::M15 => "提前 15 分钟",
        ReminderOptionId::M30 => "提前 30 分钟",
        ReminderOptionId::H1 => "提前 1 小时",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shift_at_start() {
        assert_eq!(
            shift_remind_at(1_000_000, ReminderOptionId::AtStart),
            Some(1_000_000)
        );
        assert_eq!(
            shift_remind_at(1_000_000, ReminderOptionId::M5),
            Some(1_000_000 - 5 * 60_000)
        );
    }
}
