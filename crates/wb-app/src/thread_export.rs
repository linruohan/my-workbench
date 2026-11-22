//! Render an agent thread as a standalone Markdown document.
//!
//! Kept outside `views::agent` so the formatting rules are unit-testable without
//! dragging in the whole GPUI view tree.

use wb_domain::{AgentMessage, AgentRole};

/// Render `title` and `messages` as Markdown.
///
/// Roles become headings, tool results become fenced blocks (so their output is
/// not re-flowed), and everything else keeps the text the model wrote.
pub fn thread_to_markdown(title: &str, messages: &[AgentMessage]) -> String {
    let mut out = String::new();
    out.push_str(&format!("# {title}\n\n"));
    if messages.is_empty() {
        out.push_str("_（会话为空）_\n");
        return out;
    }
    for m in messages {
        let stamp = format_local_stamp(m.created_at);
        match m.role {
            AgentRole::User => out.push_str(&format!("## 你 · {stamp}\n\n{}\n\n", m.content)),
            AgentRole::Assistant => {
                out.push_str(&format!("## Agent · {stamp}\n\n{}\n\n", m.content));
            }
            AgentRole::Tool => {
                let name = m.tool_name.as_deref().unwrap_or("tool");
                let fence = fence_for(&m.content);
                // Timing and failure state go in the heading so the export keeps
                // the same scan-ability as the chat transcript.
                let mut meta = String::new();
                if m.is_tool_error() {
                    meta.push_str(" · ❌ 失败");
                }
                if let Some(ms) = m.duration_ms {
                    meta.push_str(&format!(" · {}", format_duration(ms)));
                }
                out.push_str(&format!(
                    "### 工具 `{name}` · {stamp}{meta}\n\n{fence}text\n"
                ));
                out.push_str(&m.content);
                if !m.content.ends_with('\n') {
                    out.push('\n');
                }
                out.push_str(&format!("{fence}\n\n"));
            }
            AgentRole::System => {
                out.push_str(&format!(
                    "> **系统** · {stamp}\n>\n> {}\n\n",
                    m.content.replace('\n', "\n> ")
                ));
            }
        }
    }
    out
}

/// `320 ms` under a second, `1.4 s` above, matching the chat transcript.
pub fn format_duration(ms: u64) -> String {
    if ms < 1_000 {
        format!("{ms} ms")
    } else {
        format!("{:.1} s", ms as f64 / 1000.0)
    }
}

/// A backtick fence longer than any run inside `body`, so the body cannot close it.
fn fence_for(body: &str) -> String {
    let mut longest = 0usize;
    let mut run = 0usize;
    for ch in body.chars() {
        if ch == '`' {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 0;
        }
    }
    "`".repeat(longest.max(2) + 1)
}

/// `wb-agent-<title>-<stamp>.md`, with characters Windows rejects replaced.
pub fn export_file_name(title: &str, stamp: &str) -> String {
    let mut safe: String = title
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '-' | '_' | ' ') {
                c
            } else {
                '_'
            }
        })
        .collect();
    safe = safe.trim().replace(' ', "-");
    if safe.is_empty() {
        safe = "thread".into();
    }
    let safe: String = safe.chars().take(40).collect();
    format!("wb-agent-{safe}-{stamp}.md")
}

/// Timestamp used in export file names: `20261122-1531`.
fn format_local_stamp(ms: i64) -> String {
    wb_domain::format_local_stamp(ms)
}

/// The first of `base`, `base (2)`, `base (3)`… that is not in `taken`.
///
/// Exporting twice within the same second would otherwise overwrite the
/// previous file with no warning.
pub fn unique_name(base: &str, taken: impl Fn(&str) -> bool) -> String {
    if !taken(base) {
        return base.to_string();
    }
    let (stem, ext) = match base.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem, format!(".{ext}")),
        _ => (base, String::new()),
    };
    for n in 2.. {
        let candidate = format!("{stem} ({n}){ext}");
        if !taken(&candidate) {
            return candidate;
        }
    }
    unreachable!("an unused name always exists")
}

#[cfg(test)]
mod tests {
    use super::*;
    use wb_domain::{create_id, now_ms};

    fn msg(role: AgentRole, content: &str) -> AgentMessage {
        let now = now_ms();
        AgentMessage {
            id: create_id(now),
            thread_id: "t".into(),
            role,
            content: content.into(),
            tool_name: None,
            tool_call_id: None,
            tool_calls_json: None,
            created_at: now,
            duration_ms: None,
        }
    }

    #[test]
    fn renders_roles_as_headings() {
        let md = thread_to_markdown("测试会话", &[msg(AgentRole::User, "你好")]);
        assert!(md.starts_with("# 测试会话\n"));
        assert!(md.contains("## 你 ·"));
        assert!(md.contains("你好"));
    }

    #[test]
    fn tool_output_is_fenced_and_cannot_close_the_fence() {
        let mut m = msg(AgentRole::Tool, "line with ``` inside");
        m.tool_name = Some("read".into());
        let md = thread_to_markdown("t", &[m]);
        assert!(md.contains("### 工具 `read` ·"));
        // The fence must be longer than the three backticks in the body.
        assert!(md.contains("````text"));
    }

    #[test]
    fn tool_heading_carries_duration_and_failure() {
        let mut m = msg(AgentRole::Tool, "失败：文件不存在");
        m.tool_name = Some("read".into());
        m.duration_ms = Some(1_450);
        let md = thread_to_markdown("t", &[m]);
        assert!(md.contains("❌ 失败"), "{md}");
        assert!(md.contains("1.4 s"), "{md}");
    }

    #[test]
    fn duration_formatting_matches_chat() {
        assert_eq!(format_duration(320), "320 ms");
        assert_eq!(format_duration(1_000), "1.0 s");
        assert_eq!(format_duration(12_345), "12.3 s");
    }

    #[test]
    fn empty_thread_says_so() {
        assert!(thread_to_markdown("空会话", &[]).contains("会话为空"));
    }

    #[test]
    fn file_name_is_windows_safe() {
        let name = export_file_name("今日/复盘: 语音?", "20261122-1531");
        assert_eq!(name, "wb-agent-今日_复盘_-语音_-20261122-1531.md");
    }

    #[test]
    fn blank_title_falls_back() {
        assert_eq!(export_file_name("   ", "s"), "wb-agent-thread-s.md");
    }

    #[test]
    fn unique_name_avoids_overwriting() {
        // Free name is used as is.
        assert_eq!(unique_name("a.md", |_| false), "a.md");

        // The second export in the same second must not clobber the first.
        let taken = |name: &str| name == "a.md";
        assert_eq!(unique_name("a.md", taken), "a (2).md");

        // And keeps counting past an existing suffix.
        let taken2 = |name: &str| name == "a.md" || name == "a (2).md";
        assert_eq!(unique_name("a.md", taken2), "a (3).md");

        // Names without an extension must not lose characters.
        assert_eq!(unique_name("noext", |n| n == "noext"), "noext (2)");
    }
}
