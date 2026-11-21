//! Discover skills / plugins / MCP entries from prefs paths.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillEntry {
    pub name: String,
    pub path: String,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginEntry {
    pub name: String,
    pub path: String,
}

pub fn list_skills(dirs: &[String]) -> Vec<SkillEntry> {
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
                let skill_md = path.join("SKILL.md");
                if skill_md.is_file() {
                    let name = path
                        .file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or("skill")
                        .to_string();
                    let summary = read_summary(&skill_md);
                    out.push(SkillEntry {
                        name,
                        path: skill_md.display().to_string(),
                        summary,
                    });
                }
            } else if path
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("md"))
            {
                let name = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("skill")
                    .to_string();
                let summary = read_summary(&path);
                out.push(SkillEntry {
                    name,
                    path: path.display().to_string(),
                    summary,
                });
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
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

fn read_summary(path: &Path) -> String {
    let Ok(text) = fs::read_to_string(path) else {
        return String::new();
    };
    text.lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with('#'))
        .or_else(|| text.lines().next())
        .unwrap_or("")
        .chars()
        .take(120)
        .collect()
}
