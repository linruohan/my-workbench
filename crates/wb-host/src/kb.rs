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

fn git_output(cwd: &Path, args: &[&str]) -> Result<std::process::Output> {
    Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .with_context(|| format!("无法运行 git {}", args.join(" ")))
}

fn git_ok(cwd: &Path, args: &[&str]) -> Result<String> {
    let out = git_output(cwd, args)?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        bail!(
            "{}",
            if err.is_empty() {
                format!("git {} 失败", args.join(" "))
            } else {
                err
            }
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn worktree_slug(raw: &str) -> String {
    let mut slug: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    slug.truncate(40);
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "session".into()
    } else {
        slug
    }
}

/// Create or reuse a git worktree under `<repo>/.wb-worktrees/<slug>`.
/// The directory is listed in `.git/info/exclude` so the main tree stays clean.
/// This does not merge or rebase.
pub fn ensure_session_worktree(workspace: &Path, raw_slug: &str) -> Result<PathBuf> {
    let top = git_ok(workspace, &["rev-parse", "--show-toplevel"])
        .map_err(|_| anyhow::anyhow!("当前工作区不是 git 仓库，不能开 worktree"))?;
    let top = PathBuf::from(top);
    let slug = worktree_slug(raw_slug);
    let exclude = top.join(".git").join("info").join("exclude");
    if let Ok(mut text) = fs::read_to_string(&exclude) {
        if !text.contains(".wb-worktrees/") {
            if !text.ends_with('\n') && !text.is_empty() {
                text.push('\n');
            }
            text.push_str(".wb-worktrees/\n");
            let _ = fs::write(&exclude, text);
        }
    }
    let dest = top.join(".wb-worktrees").join(&slug);
    if dest.join(".git").exists() {
        return Ok(dest);
    }
    fs::create_dir_all(top.join(".wb-worktrees"))?;
    let branch = format!("wb/{slug}");
    let dest_arg = dest.display().to_string();
    if git_ok(&top, &["worktree", "add", "-b", &branch, &dest_arg, "HEAD"]).is_err() {
        git_ok(&top, &["worktree", "add", &dest_arg, &branch])?;
    }
    Ok(dest)
}

/// Merge the session worktree's branch into the main checkout's current branch.
/// Refuses unless `worktree` is under `.wb-worktrees`, and refuses when the main
/// checkout has uncommitted changes. Does not delete the worktree.
pub fn merge_session_worktree(worktree: &Path) -> Result<String> {
    let under = worktree
        .components()
        .any(|part| part.as_os_str() == ".wb-worktrees");
    if !under {
        bail!("只能合并 .wb-worktrees 里的会话目录");
    }
    let branch = git_ok(worktree, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if branch == "HEAD" {
        bail!("会话目录处于分离头指针，不能合并");
    }
    let common = git_ok(
        worktree,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?;
    let main = Path::new(&common)
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| anyhow::anyhow!("找不到主工作区"))?;
    if !git_ok(&main, &["status", "--porcelain"])?.is_empty() {
        bail!("主工作区有未提交改动，先处理后再合并");
    }
    let target = git_ok(&main, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if target == branch {
        bail!("主工作区已经在 {branch}");
    }
    let message = git_ok(&main, &["merge", "--ff-only", &branch])?;
    Ok(format!(
        "已将 {branch} 快进合并到 {target}{}",
        if message.is_empty() {
            String::new()
        } else {
            format!("\n{message}")
        }
    ))
}

pub fn git_branches(root: &Path) -> Result<Vec<String>> {
    let text = git_ok(root, &["branch", "--format=%(refname:short)"])?;
    Ok(text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect())
}

pub fn git_worktree_list(root: &Path) -> Result<Vec<(String, String)>> {
    let text = git_ok(root, &["worktree", "list", "--porcelain"])?;
    let mut rows = Vec::new();
    let mut path = String::new();
    let mut branch = String::new();
    let flush = |rows: &mut Vec<(String, String)>, path: &mut String, branch: &mut String| {
        if path.is_empty() {
            return;
        }
        rows.push((path.clone(), branch.clone()));
        path.clear();
        branch.clear();
    };
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("worktree ") {
            flush(&mut rows, &mut path, &mut branch);
            path = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("branch ") {
            branch = rest.trim().trim_start_matches("refs/heads/").to_string();
        }
    }
    flush(&mut rows, &mut path, &mut branch);
    Ok(rows)
}

pub fn git_commit_show(root: &Path, rev: &str) -> Result<String> {
    if rev.len() < 4 || !rev.chars().all(|ch| ch.is_ascii_hexdigit()) {
        bail!("提交号无效");
    }
    let text = git_ok(root, &["show", "--stat", "-p", "--format=%h %s", rev])?;
    const LIMIT: usize = 40_000;
    if text.len() > LIMIT {
        Ok(format!("{}…\n（提交内容已截断）", &text[..LIMIT]))
    } else {
        Ok(text)
    }
}

pub fn git_recent_log(root: &Path) -> Result<Vec<String>> {
    let text = git_ok(root, &["log", "-12", "--oneline"])?;
    Ok(text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect())
}

pub fn git_checkout(root: &Path, branch: &str) -> Result<String> {
    if branch.is_empty()
        || branch.contains("..")
        || branch
            .chars()
            .any(|ch| ch.is_whitespace() || ch == ';' || ch == '&')
    {
        bail!("分支名无效");
    }
    git_ok(root, &["checkout", branch])
}

pub fn git_fetch(root: &Path) -> Result<String> {
    let text = git_ok(root, &["fetch", "--prune"])?;
    if text.is_empty() {
        Ok("已获取远程更新".into())
    } else {
        Ok(text)
    }
}

pub fn git_diff_head(root: &Path) -> Result<String> {
    let text = git_ok(root, &["diff", "--stat", "HEAD"])?;
    let text = if text.trim().is_empty() {
        "工作区与 HEAD 没有差异".to_string()
    } else {
        text
    };
    const LIMIT: usize = 40_000;
    if text.len() > LIMIT {
        Ok(format!("{}…\n（差异已截断）", &text[..LIMIT]))
    } else {
        Ok(text)
    }
}

pub fn git_remotes(root: &Path) -> Result<Vec<String>> {
    let text = git_ok(root, &["remote", "-v"])?;
    Ok(text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect())
}

pub fn git_init(root: &Path) -> Result<String> {
    git_ok(root, &["init"])?;
    Ok("已初始化 Git 仓库".into())
}

/// Unstaged diff for one path, falling back to the staged diff.
pub fn git_file_diff(root: &Path, path: &str) -> Result<String> {
    if path.contains('\0') || path.contains(" -> ") {
        bail!("路径无效");
    }
    let unstaged = git_ok(root, &["diff", "--", path])?;
    let text = if unstaged.trim().is_empty() {
        git_ok(root, &["diff", "--cached", "--", path])?
    } else {
        unstaged
    };
    let text = if text.trim().is_empty() {
        "没有未提交的差异".to_string()
    } else {
        text
    };
    const LIMIT: usize = 40_000;
    if text.len() > LIMIT {
        Ok(format!("{}…\n（差异已截断）", &text[..LIMIT]))
    } else {
        Ok(text)
    }
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

fn skip_walk_dir(name: &str) -> bool {
    name.starts_with('.')
        || matches!(
            name,
            "node_modules" | "target" | "dist" | "build" | "vendor" | ".git"
        )
}

pub fn list_files_recursive(root: &Path, max: usize) -> Result<Vec<KbEntry>> {
    let mut out = Vec::new();
    let walker = WalkDir::new(root).into_iter().filter_entry(|entry| {
        entry.depth() == 0 || !skip_walk_dir(&entry.file_name().to_string_lossy())
    });
    for entry in walker.filter_map(|e| e.ok()) {
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

const MAX_SEARCH_BYTES: u64 = 512 * 1024;

fn contains_ignore_case(haystack: &str, needle_lower: &str) -> bool {
    if needle_lower.is_empty() {
        return true;
    }
    let needle = needle_lower.as_bytes();
    if !needle.is_ascii() {
        return haystack.to_lowercase().contains(needle_lower);
    }
    let hay = haystack.as_bytes();
    if hay.is_ascii() {
        return hay.len() >= needle.len()
            && hay.windows(needle.len()).any(|window| {
                window
                    .iter()
                    .zip(needle)
                    .all(|(a, b)| a.to_ascii_lowercase() == *b)
            });
    }
    haystack.to_lowercase().contains(needle_lower)
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
        let name_hit = rel_l.contains(&q_lower);
        if path
            .metadata()
            .is_ok_and(|meta| meta.len() > MAX_SEARCH_BYTES)
        {
            if name_hit {
                hits.push(KbSearchHit {
                    path: entry.path.clone(),
                    relative: entry.relative.clone(),
                    line: 0,
                    snippet: entry.relative.clone(),
                });
            }
            continue;
        }
        let Ok(text) = read_text(path) else {
            if name_hit {
                hits.push(KbSearchHit {
                    path: entry.path.clone(),
                    relative: entry.relative.clone(),
                    line: 0,
                    snippet: entry.relative.clone(),
                });
            }
            continue;
        };
        let mut body_hit = None;
        for (idx, line) in text.lines().enumerate() {
            if contains_ignore_case(line, &q_lower) {
                body_hit = Some(KbSearchHit {
                    path: entry.path.clone(),
                    relative: entry.relative.clone(),
                    line: idx + 1,
                    snippet: trim_snippet(line, 80),
                });
                break;
            }
        }
        if let Some(hit) = body_hit {
            hits.push(hit);
        } else if name_hit {
            hits.push(KbSearchHit {
                path: entry.path.clone(),
                relative: entry.relative.clone(),
                line: 0,
                snippet: entry.relative.clone(),
            });
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
        fs::write(dir.join("unique-token.md"), "no match in body\n").unwrap();
        let named = search_kb_content(&dir, "unique-token", 50, 10).unwrap();
        assert!(
            named
                .iter()
                .any(|h| h.relative == "unique-token.md" && h.line == 0)
        );
        assert!(named.iter().any(|h| h.relative == "a.md" && h.line == 2));
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

    #[test]
    fn session_worktree_reuses_the_same_directory() {
        let dir = std::env::temp_dir().join(format!(
            "wb-wt-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
        ));
        fs::create_dir_all(&dir).unwrap();
        let git = |args: &[&str]| {
            let status = Command::new("git")
                .args(args)
                .current_dir(&dir)
                .env("GIT_AUTHOR_NAME", "wb")
                .env("GIT_AUTHOR_EMAIL", "wb@example.com")
                .env("GIT_COMMITTER_NAME", "wb")
                .env("GIT_COMMITTER_EMAIL", "wb@example.com")
                .status()
                .unwrap();
            assert!(status.success(), "git {args:?}");
        };
        git(&["init"]);
        git(&["commit", "--allow-empty", "-m", "init"]);
        let first = ensure_session_worktree(&dir, "thread/1").unwrap();
        let second = ensure_session_worktree(&dir, "thread/1").unwrap();
        assert_eq!(first, second);
        assert!(first.join(".git").exists());
        fs::write(first.join("note.txt"), "from-session").unwrap();
        let status = Command::new("git")
            .args(["add", "note.txt"])
            .current_dir(&first)
            .status()
            .unwrap();
        assert!(status.success());
        let status = Command::new("git")
            .args(["commit", "-m", "note"])
            .current_dir(&first)
            .env("GIT_AUTHOR_NAME", "wb")
            .env("GIT_AUTHOR_EMAIL", "wb@example.com")
            .env("GIT_COMMITTER_NAME", "wb")
            .env("GIT_COMMITTER_EMAIL", "wb@example.com")
            .status()
            .unwrap();
        assert!(status.success());
        let merged = merge_session_worktree(&first).unwrap();
        assert!(merged.contains("合并"));
        assert_eq!(
            fs::read_to_string(dir.join("note.txt")).unwrap(),
            "from-session"
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
