use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use font_kit::handle::Handle;
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemFont {
    /// CSS font-family value from the font file.
    pub family: String,
    /// Extra search tokens (file stems, full names, etc.).
    pub aliases: Vec<String>,
}

/// Walk OS font directories, read each installed face, then sort by family name.
fn collect_system_fonts() -> Result<Vec<SystemFont>, String> {
    let mut by_key: BTreeMap<String, SystemFont> = BTreeMap::new();
    let mut scanned = 0_usize;
    let mut readable = 0_usize;

    for dir in font_dirs() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !is_font_file(&path) {
                continue;
            }
            scanned += 1;
            let stem_alias = path
                .file_stem()
                .and_then(|s| s.to_str())
                .map(clean_stem_alias)
                .filter(|s| !s.is_empty());

            let mut loaded_any = false;
            for index in 0..32_u32 {
                // from_path builds a lazy handle; load() fails when the face index is OOB.
                let handle = Handle::from_path(path.clone(), index);
                let Ok(font) = handle.load() else {
                    break;
                };
                loaded_any = true;
                let family = font.family_name();
                if !is_safe_family(&family) {
                    continue;
                }
                let mut aliases = Vec::new();
                if let Some(stem) = stem_alias.clone() {
                    aliases.push(stem);
                }
                let full = font.full_name();
                if is_safe_family(&full) && !full.eq_ignore_ascii_case(&family) {
                    aliases.push(full);
                }
                upsert_font(&mut by_key, family, aliases);
            }
            if loaded_any {
                readable += 1;
            }
        }
    }

    if scanned == 0 {
        return Err("未找到系统字体目录或目录为空".into());
    }
    if readable == 0 {
        return Err("字体目录中没有可读的字体文件".into());
    }

    let mut fonts: Vec<SystemFont> = by_key.into_values().collect();
    for font in &mut fonts {
        font.aliases.sort_by(|a, b| {
            a.to_lowercase().cmp(&b.to_lowercase())
        });
    }
    // BTreeMap keys are already lowercased; stable locale-ish display order.
    fonts.sort_by(|a, b| {
        a.family
            .to_lowercase()
            .cmp(&b.family.to_lowercase())
            .then_with(|| a.family.cmp(&b.family))
    });
    Ok(fonts)
}

fn upsert_font(map: &mut BTreeMap<String, SystemFont>, family: String, aliases: Vec<String>) {
    if !is_safe_family(&family) {
        return;
    }
    let key = family.to_lowercase();
    let entry = map.entry(key).or_insert_with(|| SystemFont {
        family: family.clone(),
        aliases: Vec::new(),
    });
    for alias in aliases {
        if !is_safe_family(&alias) {
            continue;
        }
        if alias.eq_ignore_ascii_case(&entry.family) {
            continue;
        }
        if entry
            .aliases
            .iter()
            .any(|existing| existing.eq_ignore_ascii_case(&alias))
        {
            continue;
        }
        entry.aliases.push(alias);
    }
}

fn font_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    #[cfg(windows)]
    {
        if let Ok(windir) = std::env::var("WINDIR") {
            dirs.push(PathBuf::from(windir).join("Fonts"));
        }
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            dirs.push(
                PathBuf::from(local)
                    .join("Microsoft")
                    .join("Windows")
                    .join("Fonts"),
            );
        }
    }

    #[cfg(target_os = "macos")]
    {
        dirs.push(PathBuf::from("/System/Library/Fonts"));
        dirs.push(PathBuf::from("/Library/Fonts"));
        if let Ok(home) = std::env::var("HOME") {
            dirs.push(PathBuf::from(home).join("Library").join("Fonts"));
        }
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        dirs.push(PathBuf::from("/usr/share/fonts"));
        dirs.push(PathBuf::from("/usr/local/share/fonts"));
        if let Ok(home) = std::env::var("HOME") {
            let home = PathBuf::from(home);
            dirs.push(home.join(".local").join("share").join("fonts"));
            dirs.push(home.join(".fonts"));
        }
    }

    dirs
}

fn is_font_file(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase())
            .as_deref(),
        Some("ttf" | "otf" | "ttc" | "otc")
    )
}

fn clean_stem_alias(stem: &str) -> String {
    // LXGWWenKaiGB-Regular → LXGWWenKaiGB
    let base = stem.split('-').next().unwrap_or(stem).trim();
    base.chars()
        .take(80)
        .collect::<String>()
        .trim()
        .to_string()
}

/// Installed fonts discovered by walking font directories. Runs off-thread.
#[tauri::command]
pub async fn list_system_fonts() -> Result<Vec<SystemFont>, String> {
    tauri::async_runtime::spawn_blocking(collect_system_fonts)
        .await
        .map_err(|err| format!("读取系统字体中断：{err}"))?
}

fn is_safe_family(name: &str) -> bool {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.len() > 120 {
        return false;
    }
    !trimmed.chars().any(|c| {
        matches!(
            c,
            '"' | ';' | '{' | '}' | '<' | '>' | '\\' | '\n' | '\r' | '\0'
        )
    })
}

#[cfg(test)]
mod tests {
    use super::{collect_system_fonts, is_safe_family};

    #[test]
    fn rejects_unsafe_family_names() {
        assert!(is_safe_family("Helvetica Neue"));
        assert!(is_safe_family("微软雅黑"));
        assert!(is_safe_family("O'Reilly"));
        assert!(!is_safe_family(""));
        assert!(!is_safe_family("Bad\";color:red"));
    }

    #[test]
    fn walks_font_dirs_and_sorts_families() {
        let fonts = collect_system_fonts().expect("system fonts");
        assert!(
            fonts.len() > 20,
            "expected fonts from directories, got {}",
            fonts.len()
        );
        let names: Vec<_> = fonts.iter().map(|font| font.family.to_lowercase()).collect();
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(names, sorted, "families must be sorted");

        let lxgw = fonts.iter().any(|font| {
            let blob = format!("{} {}", font.family, font.aliases.join(" ")).to_ascii_lowercase();
            blob.contains("lxgw") || font.family.contains("霞鹜")
        });
        assert!(lxgw, "expected LXGW fonts discovered from font directories");
    }
}
