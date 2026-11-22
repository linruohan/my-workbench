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
}
