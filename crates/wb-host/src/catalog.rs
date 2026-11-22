//! Discover skills / plugins / MCP entries from prefs paths.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use wb_domain::AgentPrefs;

const MAX_SKILL_DEPTH: usize = 5;
const MAX_SKILLS: usize = 400;
const MAX_VISITED_DIRS: usize = 2_000;
const SUMMARY_CHARS: usize = 160;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillEntry {
    pub name: String,
    pub path: String,
    pub summary: String,
    /// Skills directory this entry was discovered under.
    #[serde(default)]
    pub root: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginEntry {
    pub name: String,
    pub path: String,
}

pub fn list_skills(dirs: &[String]) -> Vec<SkillEntry> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for dir in dirs {
        for skill in list_skills_in(dir) {
            if seen.insert(path_key(&skill.path)) {
                out.push(skill);
            }
        }
    }
    sort_skills(&mut out);
    out
}

/// Skills contained in one directory: the directory itself when it has
/// `SKILL.md`, otherwise nested packages and loose markdown at the top level.
pub fn list_skills_in(dir: &str) -> Vec<SkillEntry> {
    let mut out = Vec::new();
    let root = Path::new(dir);
    if root.is_dir() {
        let mut scan = Scan {
            out: &mut out,
            root: dir,
            visited: 0,
        };
        walk_skills(root, 0, &mut scan);
    }
    sort_skills(&mut out);
    out
}

/// Skills whose directory and the skill itself are switched on.
pub fn active_skills(agent: &AgentPrefs) -> Vec<SkillEntry> {
    list_skills(&agent.skills_dirs)
        .into_iter()
        .filter(|skill| skill_is_active(skill, agent))
        .collect()
}

pub fn skill_is_active(skill: &SkillEntry, agent: &AgentPrefs) -> bool {
    !agent
        .disabled_skill_dirs
        .iter()
        .any(|dir| paths_equal(dir, &skill.root))
        && !agent
            .disabled_skills
            .iter()
            .any(|path| paths_equal(path, &skill.path))
}

pub fn paths_equal(a: &str, b: &str) -> bool {
    let a = normalize_path(a);
    let b = normalize_path(b);
    #[cfg(windows)]
    {
        a.eq_ignore_ascii_case(&b)
    }
    #[cfg(not(windows))]
    {
        a == b
    }
}

/// `path` is `dir` or a file/folder inside it.
pub fn path_is_within(path: &str, dir: &str) -> bool {
    if paths_equal(path, dir) {
        return true;
    }
    let path = normalize_path(path);
    let dir = normalize_path(dir);
    let prefix = format!("{dir}{}", std::path::MAIN_SEPARATOR);
    #[cfg(windows)]
    {
        path.to_ascii_lowercase()
            .starts_with(&prefix.to_ascii_lowercase())
    }
    #[cfg(not(windows))]
    {
        path.starts_with(&prefix)
    }
}

pub fn load_skill(dirs: &[String], name: &str) -> Result<String> {
    let name = name.trim();
    for skill in list_skills(dirs) {
        if skill.name.eq_ignore_ascii_case(name) {
            return Ok(fs::read_to_string(&skill.path)?);
        }
    }
    anyhow::bail!("未找到技能：{name}");
}

pub fn list_plugins(dirs: &[String]) -> Vec<PluginEntry> {
    let mut out = Vec::new();
    for dir in dirs {
        let root = Path::new(dir);
        if !root.is_dir() {
            continue;
        }
        let Ok(entries) = fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let name = path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("plugin")
                    .to_string();
                out.push(PluginEntry {
                    name,
                    path: path.display().to_string(),
                });
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

struct Scan<'a> {
    out: &'a mut Vec<SkillEntry>,
    root: &'a str,
    visited: usize,
}

fn walk_skills(dir: &Path, depth: usize, scan: &mut Scan<'_>) {
    if scan.out.len() >= MAX_SKILLS || scan.visited >= MAX_VISITED_DIRS || depth > MAX_SKILL_DEPTH {
        return;
    }
    scan.visited += 1;
    if let Some(skill_md) = find_skill_md(dir) {
        push_skill(dir, &skill_md, scan);
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut children = Vec::new();
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if file_type.is_dir() {
            if !skip_dir(name) {
                children.push(path);
            }
        } else if depth == 0 && file_type.is_file() && is_loose_skill_file(&path) {
            push_loose(&path, scan);
        }
    }
    children.sort();
    for child in children {
        walk_skills(&child, depth + 1, scan);
        if scan.out.len() >= MAX_SKILLS || scan.visited >= MAX_VISITED_DIRS {
            break;
        }
    }
}

fn find_skill_md(dir: &Path) -> Option<std::path::PathBuf> {
    let direct = dir.join("SKILL.md");
    if direct.is_file() {
        return Some(direct);
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return None;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path
            .file_name()
            .and_then(|s| s.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("SKILL.md"))
            && path.is_file()
        {
            return Some(path);
        }
    }
    None
}

fn push_skill(dir: &Path, skill_md: &Path, scan: &mut Scan<'_>) {
    if scan.out.len() >= MAX_SKILLS {
        return;
    }
    let name = dir
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("skill")
        .to_string();
    scan.out.push(SkillEntry {
        name,
        summary: read_summary(skill_md),
        path: skill_md.display().to_string(),
        root: scan.root.to_string(),
    });
}

fn push_loose(path: &Path, scan: &mut Scan<'_>) {
    if scan.out.len() >= MAX_SKILLS {
        return;
    }
    let name = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("skill")
        .to_string();
    scan.out.push(SkillEntry {
        name,
        summary: read_summary(path),
        path: path.display().to_string(),
        root: scan.root.to_string(),
    });
}

fn is_loose_skill_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
        return false;
    };
    if name.eq_ignore_ascii_case("readme.md") || name.eq_ignore_ascii_case("skill.md") {
        return false;
    }
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
}

fn skip_dir(name: &str) -> bool {
    name.starts_with('.')
        || matches!(
            name.to_ascii_lowercase().as_str(),
            "node_modules" | "target" | "dist" | "vendor" | "__pycache__"
        )
}

fn sort_skills(skills: &mut [SkillEntry]) {
    skills.sort_by(|a, b| {
        a.name
            .to_ascii_lowercase()
            .cmp(&b.name.to_ascii_lowercase())
            .then_with(|| a.path.cmp(&b.path))
    });
}

fn path_key(path: &str) -> String {
    let path = normalize_path(path);
    #[cfg(windows)]
    {
        path.to_ascii_lowercase()
    }
    #[cfg(not(windows))]
    {
        path
    }
}

fn normalize_path(path: &str) -> String {
    let trimmed = path.trim().trim_end_matches(['\\', '/']);
    let mut out = String::with_capacity(trimmed.len());
    for ch in trimmed.chars() {
        if ch == '\\' || ch == '/' {
            if !out.ends_with(std::path::MAIN_SEPARATOR) {
                out.push(std::path::MAIN_SEPARATOR);
            }
        } else {
            out.push(ch);
        }
    }
    out
}

fn read_summary(path: &Path) -> String {
    let Ok(text) = fs::read_to_string(path) else {
        return String::new();
    };
    if let Some(desc) = frontmatter_description(&text)
        && !desc.is_empty()
    {
        return clip(&desc, SUMMARY_CHARS);
    }
    let body = body_after_frontmatter(&text);
    let line = body
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('#'))
        .unwrap_or("");
    clip(line, SUMMARY_CHARS)
}

fn frontmatter_description(text: &str) -> Option<String> {
    let rest = text
        .strip_prefix("---\r\n")
        .or_else(|| text.strip_prefix("---\n"))?;
    let end = rest.find("\n---")?;
    let front = &rest[..end];
    let mut lines = front.lines();
    while let Some(line) = lines.next() {
        let Some(value) = line.trim().strip_prefix("description:") else {
            continue;
        };
        let value = value.trim();
        if value.is_empty() || is_yaml_block(value) {
            return join_block(&mut lines);
        }
        let value = value.trim_matches('"').trim_matches('\'');
        if value.is_empty() {
            return None;
        }
        return Some(value.to_string());
    }
    None
}

fn is_yaml_block(value: &str) -> bool {
    matches!(value, ">" | "|" | ">-" | "|-" | ">+" | "|+")
}

fn join_block<'a>(lines: &mut impl Iterator<Item = &'a str>) -> Option<String> {
    let mut parts = Vec::new();
    for next in lines {
        if next.starts_with(' ') || next.starts_with('\t') {
            let piece = next.trim();
            if !piece.is_empty() {
                parts.push(piece);
            }
        } else if next.trim().is_empty() {
            continue;
        } else {
            break;
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" "))
    }
}

fn body_after_frontmatter(text: &str) -> &str {
    let Some(rest) = text
        .strip_prefix("---\r\n")
        .or_else(|| text.strip_prefix("---\n"))
    else {
        return text;
    };
    let Some(end) = rest.find("\n---") else {
        return text;
    };
    rest[end + 4..].trim_start_matches(['\r', '\n'])
}

fn clip(text: &str, max: usize) -> String {
    let mut out: String = text.chars().take(max).collect();
    if text.chars().count() > max {
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn scratch() -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("wb-skills-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn discovers_nested_skill_md_and_frontmatter() {
        let root = scratch();
        let skill = root.join("algorithmic-art");
        fs::create_dir_all(&skill).unwrap();
        fs::write(
            skill.join("SKILL.md"),
            "---\nname: algorithmic-art\ndescription: Creating algorithmic art using p5.js.\n---\n\n# Title\n",
        )
        .unwrap();
        let nested = root.join("group").join("canvas");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("SKILL.md"), "# canvas\n\nDraw things.\n").unwrap();
        fs::create_dir_all(root.join(".hidden").join("secret")).unwrap();
        fs::write(
            root.join(".hidden").join("secret").join("SKILL.md"),
            "---\ndescription: no\n---\n",
        )
        .unwrap();
        fs::write(root.join("notes.md"), "# notes\n\nA loose skill.\n").unwrap();
        fs::write(root.join("README.md"), "# readme\n\nSkip me.\n").unwrap();

        let found = list_skills(&[root.display().to_string()]);
        let names: Vec<_> = found.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"algorithmic-art"), "{names:?}");
        assert!(names.contains(&"canvas"), "{names:?}");
        assert!(names.contains(&"notes"), "{names:?}");
        assert!(
            !names
                .iter()
                .any(|name| *name == "secret" || *name == "README")
        );
        let art = found.iter().find(|s| s.name == "algorithmic-art").unwrap();
        assert_eq!(art.summary, "Creating algorithmic art using p5.js.");
        let canvas = found.iter().find(|s| s.name == "canvas").unwrap();
        assert_eq!(canvas.summary, "Draw things.");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn root_directory_itself_is_a_skill() {
        let root = scratch();
        fs::write(
            root.join("SKILL.md"),
            "---\ndescription: Root skill body.\n---\n# Inside\n",
        )
        .unwrap();
        let inner = root.join("extra");
        fs::create_dir_all(&inner).unwrap();
        fs::write(inner.join("SKILL.md"), "---\ndescription: inner\n---\n").unwrap();
        let found = list_skills(&[root.display().to_string()]);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, root.file_name().unwrap().to_str().unwrap());
        assert_eq!(found[0].summary, "Root skill body.");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn folded_description_is_joined() {
        let root = scratch();
        let skill = root.join("writer");
        fs::create_dir_all(&skill).unwrap();
        fs::write(
            skill.join("SKILL.md"),
            "---\ndescription: >\n  Writes clearly\n  and briefly.\n---\n",
        )
        .unwrap();
        let found = list_skills_in(&root.display().to_string());
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].summary, "Writes clearly and briefly.");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn paths_ignore_trailing_separator() {
        assert!(paths_equal(r"D:\skills", r"D:\skills\"));
        assert!(paths_equal(r"D:\skills", "D:/skills"));
        assert!(path_is_within(r"D:\skills\a\SKILL.md", r"D:\skills"));
        assert!(!path_is_within(r"D:\skills-extra\a", r"D:\skills"));
    }
}
