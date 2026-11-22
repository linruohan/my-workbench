//! Parsing for tool-result summaries, kept out of `views::agent` so the
//! `#[test]` macro expansion does not hit that module's recursion cap.

/// Read the integer that follows `label` in a summary string.
///
/// `apply_patch` reports counts inline, e.g. `新增 2 · 修改 1（3 处）· 删除 1`,
/// and the patch card turns them into per-file badges.
pub fn count_after(text: &str, label: &str) -> usize {
    let Some(rest) = text.split(label).nth(1) else {
        return 0;
    };
    let digits: String = rest
        .trim_start()
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().unwrap_or(0)
}

/// Aggregate tool calls by name: `(name, calls, total_ms, max_ms, failures)`.
///
/// Messages without a recorded duration still count towards `calls` and
/// `failures`, but contribute 0 ms — old transcripts predate the timing field.
pub fn tool_usage(
    messages: &[(String, Option<u64>, bool)],
) -> Vec<(String, usize, u64, u64, usize)> {
    let mut out: Vec<(String, usize, u64, u64, usize)> = Vec::new();
    for (name, duration, failed) in messages {
        let entry = match out.iter_mut().find(|e| &e.0 == name) {
            Some(entry) => entry,
            None => {
                out.push((name.clone(), 0, 0, 0, 0));
                out.last_mut().expect("just pushed")
            }
        };
        entry.1 += 1;
        let ms = duration.unwrap_or(0);
        entry.2 += ms;
        entry.3 = entry.3.max(ms);
        if *failed {
            entry.4 += 1;
        }
    }
    // Slowest total first: the aggregate is what suggests where to optimise.
    out.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| a.0.cmp(&b.0)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEAD: &str = "新增 2 · 修改 1（3 处）· 删除 4";

    #[test]
    fn reads_each_count() {
        assert_eq!(count_after(HEAD, "新增"), 2);
        assert_eq!(count_after(HEAD, "修改"), 1);
        assert_eq!(count_after(HEAD, "删除"), 4);
    }

    #[test]
    fn missing_label_or_digits_is_zero() {
        assert_eq!(count_after(HEAD, "重命名"), 0);
        assert_eq!(count_after("没有变更", "新增"), 0);
        assert_eq!(count_after("新增 若干", "新增"), 0);
    }

    #[test]
    fn multi_digit_counts_are_read_whole() {
        assert_eq!(count_after("新增 12 个文件", "新增"), 12);
    }

    #[test]
    fn usage_aggregates_by_name_slowest_first() {
        let rows = vec![
            ("read".to_string(), Some(120), false),
            ("shell".to_string(), Some(9_000), false),
            ("read".to_string(), Some(80), false),
            ("shell".to_string(), Some(12_000), true),
        ];
        let usage = tool_usage(&rows);
        assert_eq!(usage[0].0, "shell");
        assert_eq!(usage[0].1, 2);
        assert_eq!(usage[0].2, 21_000);
        assert_eq!(usage[0].3, 12_000);
        assert_eq!(usage[0].4, 1);
        assert_eq!(usage[1].0, "read");
        assert_eq!(usage[1].2, 200);
        assert_eq!(usage[1].4, 0);
    }

    #[test]
    fn usage_counts_messages_without_timing() {
        let usage = tool_usage(&[("glob".to_string(), None, false)]);
        assert_eq!(usage[0].1, 1);
        assert_eq!(usage[0].2, 0);
    }
}
