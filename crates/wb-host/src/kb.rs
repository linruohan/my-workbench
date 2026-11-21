use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use walkdir::WalkDir;
use wb_domain::{is_kb_extension, is_text_extension};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KbEntry {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub relative: String,
}

/// One content / path hit from a lightweight vault scan (no SQLite FTS).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KbSearchHit {
    pub path: String,
    pub relative: String,
    pub line: usize,
    pub snippet: String,
}

pub fn pick_directory() -> Option<PathBuf> {
    rfd::FileDialog::new().pick_folder()
}

pub fn pick_file() -> Option<PathBuf> {
    rfd::FileDialog::new().pick_file()
}

pub fn list_dir(path: &Path) -> Result<Vec<KbEntry>> {
    let mut out = Vec::new();
    for entry in fs::read_dir(path).with_context(|| format!("读取目录失败: {}", path.display()))?
    {
        let entry = entry?;
        let meta = entry.metadata()?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        out.push(KbEntry {
            path: entry.path().to_string_lossy().to_string(),
            name,
            is_dir: meta.is_dir(),
            relative: entry
                .path()
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default(),
        });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(out)
}

pub fn read_text(path: &Path) -> Result<String> {
    fs::read_to_string(path).with_context(|| format!("读取失败: {}", path.display()))
}

pub fn write_text(path: &Path, contents: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, contents).with_context(|| format!("写入失败: {}", path.display()))
}

pub fn read_base64(path: &Path) -> Result<String> {
    let bytes = fs::read(path)?;
    Ok(B64.encode(bytes))
}

pub fn write_base64(path: &Path, b64: &str) -> Result<()> {
    let bytes = B64.decode(b64).context("base64 解码失败")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, bytes)?;
    Ok(())
}

pub fn exists(path: &Path) -> bool {
    path.exists()
}

pub fn mkdir(path: &Path) -> Result<()> {
    fs::create_dir_all(path)?;
    Ok(())
}

pub fn remove_path(path: &Path) -> Result<()> {
    if path.is_dir() {
        fs::remove_dir_all(path)?;
    } else if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

pub fn rename_path(from: &Path, to: &Path) -> Result<()> {
    fs::rename(from, to)?;
    Ok(())
}

pub fn reveal_in_explorer(path: &Path) -> Result<()> {
    if path.is_dir() {
        crate::open_ext::open_path(path)
    } else {
        crate::open_ext::reveal_in_file_manager(path)
    }
}

pub fn git_branch(root: &Path) -> Option<String> {
    let out = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(root)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitChange {
    pub status: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitSnapshot {
    pub branch: String,
    pub changes: Vec<GitChange>,
}

/// Parse `git status --porcelain -b` output.
pub fn parse_git_status(text: &str) -> GitSnapshot {
    let mut branch = String::new();
    let mut changes = Vec::new();
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("## ") {
            branch = rest.trim().to_string();
            continue;
        }
        if line.len() < 4 {
            continue;
        }
        let status = line[..2].trim().to_string();
        let path = line[3..].trim().to_string();
        if path.is_empty() {
            continue;
        }
        changes.push(GitChange { status, path });
    }
    GitSnapshot { branch, changes }
}

pub fn git_snapshot(root: &Path) -> Option<GitSnapshot> {
    let out = Command::new("git")
        .args(["status", "--porcelain", "-b"])
        .current_dir(root)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(parse_git_status(&String::from_utf8_lossy(&out.stdout)))
}

/// Files under `root`, skipping hidden and heavy build directories.
pub fn list_worktree_files(root: &Path, max: usize) -> Result<Vec<KbEntry>> {
    let mut out = Vec::new();
    let walker = WalkDir::new(root).into_iter().filter_entry(|entry| {
        if entry.depth() == 0 {
            return true;
        }
        let name = entry.file_name().to_string_lossy();
        if name.starts_with('.') {
            return false;
        }
        !matches!(
            name.as_ref(),
            "node_modules" | "target" | "dist" | "build" | "vendor"
        )
    });
    for entry in walker.filter_map(|entry| entry.ok()) {
        if out.len() >= max {
            break;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let name = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let relative = path
            .strip_prefix(root)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| name.clone());
        out.push(KbEntry {
            path: path.to_string_lossy().to_string(),
            name,
            is_dir: false,
            relative,
        });
    }
    Ok(out)
}

pub fn list_files_recursive(root: &Path, max: usize) -> Result<Vec<KbEntry>> {
    let mut out = Vec::new();
    for entry in WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
        if out.len() >= max {
            break;
        }
        let path = entry.path();
        if path == root {
            continue;
        }
        let meta = entry.metadata()?;
        if meta.is_dir() {
            continue;
        }
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if !is_kb_extension(ext) {
            continue;
        }
        let name = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let relative = path
            .strip_prefix(root)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| name.clone());
        out.push(KbEntry {
            path: path.to_string_lossy().to_string(),
            name,
            is_dir: false,
            relative,
        });
    }
    Ok(out)
}

pub fn create_markdown(dir: &Path, name: &str) -> Result<PathBuf> {
    let file = if name.ends_with(".md") {
        dir.join(name)
    } else {
        dir.join(format!("{name}.md"))
    };
    if file.exists() {
        bail!("文件已存在: {}", file.display());
    }
    write_text(&file, "# \n")?;
    Ok(file)
}

fn trim_snippet(line: &str, max: usize) -> String {
    let t = line.trim();
    if t.chars().count() <= max {
        t.to_string()
    } else {
        format!("{}…", t.chars().take(max).collect::<String>())
    }
}

/// Scan text files under `root` for `query` (case-insensitive).
/// Returns at most one hit per file, capped by `max_hits`. Skips binaries/images.
pub fn search_kb_content(
    root: &Path,
    query: &str,
    max_files: usize,
    max_hits: usize,
) -> Result<Vec<KbSearchHit>> {
    let q = query.trim();
    if q.is_empty() || max_hits == 0 {
        return Ok(Vec::new());
    }
    let q_lower = q.to_lowercase();
    let entries = list_files_recursive(root, max_files)?;
    let mut hits = Vec::with_capacity(max_hits.min(32));
    for entry in entries {
        if hits.len() >= max_hits {
            break;
        }
        let path = Path::new(&entry.path);
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if !is_text_extension(ext) {
            continue;
        }
        let rel_l = entry.relative.to_lowercase();
        if rel_l.contains(&q_lower) {
            hits.push(KbSearchHit {
                path: entry.path.clone(),
                relative: entry.relative.clone(),
                line: 0,
                snippet: entry.relative.clone(),
            });
            continue;
        }
        let Ok(text) = read_text(path) else {
            continue;
        };
        for (idx, line) in text.lines().enumerate() {
            if line.to_lowercase().contains(&q_lower) {
                hits.push(KbSearchHit {
                    path: entry.path.clone(),
                    relative: entry.relative.clone(),
                    line: idx + 1,
                    snippet: trim_snippet(line, 80),
                });
                break;
            }
        }
    }
    Ok(hits)
}

#[cfg(test)]
mod search_tests {
    use super::*;

    #[test]
    fn finds_body_and_skips_when_empty_query() {
        let dir = std::env::temp_dir().join(format!("wb-kb-search-{}", wb_domain::now_ms()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.md"), "# Hello\nfindme unique-token\n").unwrap();
        fs::write(dir.join("b.md"), "nothing here\n").unwrap();
        assert!(search_kb_content(&dir, "  ", 50, 10).unwrap().is_empty());
        let hits = search_kb_content(&dir, "unique-token", 50, 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].relative, "a.md");
        assert_eq!(hits[0].line, 2);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_branch_and_porcelain_lines() {
        let snap = parse_git_status("## main...origin/main [ahead 1]\n M src/a.rs\n?? new.txt\n");
        assert_eq!(snap.branch, "main...origin/main [ahead 1]");
        assert_eq!(snap.changes.len(), 2);
        assert_eq!(snap.changes[0].status, "M");
        assert_eq!(snap.changes[0].path, "src/a.rs");
        assert_eq!(snap.changes[1].status, "??");
        assert_eq!(snap.changes[1].path, "new.txt");
    }
}
