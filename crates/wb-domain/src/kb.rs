//! Knowledge-base path helpers, extension whitelist, and wikilinks.

use std::collections::HashSet;

pub fn is_text_extension(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "md" | "markdown"
            | "txt"
            | "json"
            | "jsonc"
            | "yaml"
            | "yml"
            | "toml"
            | "rs"
            | "ts"
            | "tsx"
            | "js"
            | "jsx"
            | "py"
            | "go"
            | "java"
            | "c"
            | "h"
            | "cpp"
            | "hpp"
            | "css"
            | "scss"
            | "html"
            | "xml"
            | "sh"
            | "ps1"
            | "bat"
            | "cmd"
            | "sql"
            | "ini"
            | "cfg"
            | "conf"
            | "log"
            | "csv"
    )
}

pub fn is_image_extension(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg"
    )
}

pub fn is_kb_extension(ext: &str) -> bool {
    is_text_extension(ext) || is_image_extension(ext)
}

pub fn infer_note_title_from_body(body: &str) -> String {
    for line in body.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        let title = t.trim_start_matches('#').trim();
        if !title.is_empty() {
            return title.chars().take(80).collect();
        }
    }
    "未命名笔记".into()
}

/// Extract `[[target]]` / `[[target|alias]]` targets (order preserved, deduped).
pub fn extract_wikilinks(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let bytes = body.as_bytes();
    let mut i = 0usize;
    while i + 3 < bytes.len() {
        if bytes[i] == b'[' && bytes[i + 1] == b'[' {
            if let Some(end) = body[i + 2..].find("]]") {
                let inner = &body[i + 2..i + 2 + end];
                let target = inner.split('|').next().unwrap_or(inner).trim();
                if !target.is_empty() {
                    let key = target.to_string();
                    if seen.insert(normalize_wikilink_key(&key)) {
                        out.push(key);
                    }
                }
                i += 2 + end + 2;
                continue;
            }
        }
        i += 1;
    }
    out
}

pub fn normalize_wikilink_key(raw: &str) -> String {
    let t = raw.trim().replace('\\', "/");
    let t = t.trim_start_matches("./");
    let without_ext = strip_md_ext(t);
    without_ext.to_ascii_lowercase()
}

fn strip_md_ext(s: &str) -> &str {
    let lower = s.to_ascii_lowercase();
    if let Some(stripped) = lower
        .strip_suffix(".md")
        .or_else(|| lower.strip_suffix(".markdown"))
    {
        &s[..stripped.len()]
    } else {
        s
    }
}

/// Matching keys for a vault-relative path (stem, relative without ext, basename).
pub fn wikilink_keys_for_relative(relative: &str) -> Vec<String> {
    let rel = relative.replace('\\', "/");
    let mut keys = Vec::new();
    let mut push = |s: &str| {
        let n = normalize_wikilink_key(s);
        if !n.is_empty() && !keys.contains(&n) {
            keys.push(n);
        }
    };
    push(&rel);
    if let Some(stem) = std::path::Path::new(&rel)
        .file_stem()
        .and_then(|s| s.to_str())
    {
        push(stem);
    }
    if let Some(name) = std::path::Path::new(&rel)
        .file_name()
        .and_then(|s| s.to_str())
    {
        push(name);
    }
    keys
}

/// Resolve a wikilink target to an absolute path. `files` is `(abs_path, relative)`.
pub fn resolve_wikilink<'a>(target: &str, files: &'a [(String, String)]) -> Option<&'a str> {
    let want = normalize_wikilink_key(target);
    if want.is_empty() {
        return None;
    }
    // Prefer exact relative / stem match; first hit wins (stable file order).
    let mut stem_hit: Option<&str> = None;
    for (abs, rel) in files {
        let keys = wikilink_keys_for_relative(rel);
        if keys.iter().any(|k| k == &want) {
            // Prefer full relative equality over bare stem when possible.
            if normalize_wikilink_key(rel) == want {
                return Some(abs.as_str());
            }
            if stem_hit.is_none() {
                stem_hit = Some(abs.as_str());
            }
        }
    }
    stem_hit
}

/// Whether `body` contains a wikilink that resolves to `target_abs` given `files`.
pub fn body_links_to(body: &str, target_abs: &str, files: &[(String, String)]) -> bool {
    let target_norm = target_abs.replace('\\', "/").to_ascii_lowercase();
    for link in extract_wikilinks(body) {
        if let Some(resolved) = resolve_wikilink(&link, files) {
            if resolved.replace('\\', "/").to_ascii_lowercase() == target_norm {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn md_is_text() {
        assert!(is_kb_extension("md"));
        assert!(is_image_extension("PNG"));
    }

    #[test]
    fn extracts_wikilinks_with_alias() {
        let links = extract_wikilinks("见 [[Foo|显示名]] 与 [[bar/Baz]] 再 [[Foo]]");
        assert_eq!(links, vec!["Foo", "bar/Baz"]);
    }

    #[test]
    fn resolves_by_stem_and_relative() {
        let files = vec![
            ("C:/vault/notes/Foo.md".into(), "notes/Foo.md".into()),
            ("C:/vault/Bar.md".into(), "Bar.md".into()),
        ];
        assert_eq!(
            resolve_wikilink("Foo", &files),
            Some("C:/vault/notes/Foo.md")
        );
        assert_eq!(
            resolve_wikilink("notes/Foo", &files),
            Some("C:/vault/notes/Foo.md")
        );
        assert_eq!(resolve_wikilink("Bar.md", &files), Some("C:/vault/Bar.md"));
        assert!(resolve_wikilink("missing", &files).is_none());
    }

    #[test]
    fn body_links_to_target() {
        let files = vec![("C:/v/A.md".into(), "A.md".into())];
        assert!(body_links_to("link [[A]] here", "C:/v/A.md", &files));
        assert!(!body_links_to("no link", "C:/v/A.md", &files));
    }
}
