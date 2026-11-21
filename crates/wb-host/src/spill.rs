//! Large tool-output spill files under `<workspace>/.wb/spill`.

use anyhow::{Context, Result};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use uuid::Uuid;

pub const SPILL_INLINE_LIMIT: usize = 8_000;
pub const SPILL_PREVIEW_HEAD: usize = 40;
pub const SPILL_PREVIEW_TAIL: usize = 20;
const SPILL_TTL_DAYS: u64 = 30;

pub fn spill_dir(workspace_root: &Path) -> PathBuf {
    workspace_root.join(".wb").join("spill")
}

/// Write `content` to a spill file and return a short preview with the absolute path.
pub fn write_spill(workspace_root: &Path, kind: &str, content: &str) -> Result<(PathBuf, String)> {
    let dir = spill_dir(workspace_root);
    fs::create_dir_all(&dir).context("创建 spill 目录失败")?;
    let name = format!("{}-{}.txt", sanitize_kind(kind), Uuid::new_v4().simple());
    let path = dir.join(&name);
    {
        let mut f = fs::File::create(&path)?;
        f.write_all(content.as_bytes())?;
        f.sync_all()?;
    }
    let preview = preview_text(content, SPILL_PREVIEW_HEAD, SPILL_PREVIEW_TAIL);
    Ok((
        path.clone(),
        format!(
            "{preview}\n\n[完整输出已写入 {} · {} bytes]",
            path.display(),
            content.len()
        ),
    ))
}

/// If `content` exceeds `limit`, spill to disk and return the preview message; else return as-is.
pub fn maybe_spill(workspace_root: Option<&Path>, kind: &str, content: String) -> String {
    let Some(root) = workspace_root.filter(|p| !p.as_os_str().is_empty()) else {
        return truncate_inline(&content, SPILL_INLINE_LIMIT * 2);
    };
    if content.len() <= SPILL_INLINE_LIMIT {
        return content;
    }
    match write_spill(root, kind, &content) {
        Ok((_, msg)) => msg,
        Err(e) => format!(
            "{}\n\n[spill 失败：{e}]",
            truncate_inline(&content, SPILL_INLINE_LIMIT)
        ),
    }
}

/// Delete spill files older than 30 days. Returns number removed.
pub fn cleanup_tool_spill(workspace_root: &Path) -> Result<usize> {
    let dir = spill_dir(workspace_root);
    if !dir.is_dir() {
        return Ok(0);
    }
    let cutoff = SystemTime::now() - Duration::from_secs(SPILL_TTL_DAYS * 24 * 3600);
    let mut removed = 0usize;
    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        let meta = entry.metadata()?;
        if !meta.is_file() {
            continue;
        }
        let old = meta
            .modified()
            .or_else(|_| meta.created())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        if old < cutoff {
            let _ = fs::remove_file(entry.path());
            removed += 1;
        }
    }
    Ok(removed)
}

fn sanitize_kind(kind: &str) -> String {
    let s: String = kind
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(32)
        .collect();
    if s.is_empty() { "out".into() } else { s }
}

fn preview_text(content: &str, head_lines: usize, tail_lines: usize) -> String {
    let lines: Vec<&str> = content.lines().collect();
    if lines.len() <= head_lines + tail_lines + 2 {
        return content.to_string();
    }
    let mut out = String::new();
    for line in lines.iter().take(head_lines) {
        out.push_str(line);
        out.push('\n');
    }
    out.push_str(&format!(
        "…（省略 {} 行）…\n",
        lines.len() - head_lines - tail_lines
    ));
    for line in lines.iter().skip(lines.len() - tail_lines) {
        out.push_str(line);
        out.push('\n');
    }
    out
}

fn truncate_inline(content: &str, max: usize) -> String {
    if content.len() <= max {
        content.to_string()
    } else {
        format!("{}…\n[truncated {} bytes]", &content[..max], content.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spill_and_cleanup_roundtrip() {
        let root = std::env::temp_dir().join(format!("wb-spill-{}", Uuid::new_v4()));
        let _ = fs::create_dir_all(&root);
        let big = "line\n".repeat(SPILL_INLINE_LIMIT);
        let msg = maybe_spill(Some(&root), "shell", big.clone());
        assert!(msg.contains("spill") || msg.contains(".wb"), "{msg}");
        assert!(msg.contains("完整输出"), "{msg}");
        let n = cleanup_tool_spill(&root).unwrap();
        assert_eq!(n, 0);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn small_stays_inline() {
        let msg = maybe_spill(Some(Path::new("/tmp")), "x", "hi".into());
        assert_eq!(msg, "hi");
    }
}
