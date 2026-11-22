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
                    let (note, heading) = split_wikilink_target(target);
                    let mut key = normalize_wikilink_key(note);
                    if let Some(heading) = heading {
                        key.push('#');
                        key.push_str(&heading.to_ascii_lowercase());
                    }
                    if !key.is_empty() && seen.insert(key) {
                        out.push(target.to_string());
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
    let (note, _) = split_wikilink_target(raw);
    let t = note.replace('\\', "/");
    let t = t.trim_start_matches("./");
    let without_ext = strip_md_ext(t);
    without_ext.to_ascii_lowercase()
}

/// Split `note`, `note#Heading`, or `#Heading` into (path, heading).
pub fn split_wikilink_target(target: &str) -> (&str, Option<&str>) {
    let t = target.trim();
    match t.split_once('#') {
        Some((note, heading)) => {
            let heading = heading.trim();
            (
                note.trim(),
                if heading.is_empty() {
                    None
                } else {
                    Some(heading)
                },
            )
        }
        None => (t, None),
    }
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
    let (note, _) = split_wikilink_target(target);
    let want = normalize_wikilink_key(note);
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FindFlags {
    pub whole_word: bool,
    pub match_case: bool,
    pub regex: bool,
}

fn is_word_char(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '_'
}

fn is_word_bounded(text: &str, start: usize, end: usize) -> bool {
    let before_ok = text[..start]
        .chars()
        .next_back()
        .is_none_or(|ch| !is_word_char(ch));
    let after_ok = text[end..]
        .chars()
        .next()
        .is_none_or(|ch| !is_word_char(ch));
    before_ok && after_ok
}

fn match_len_at(hay: &str, needle: &str, match_case: bool) -> Option<usize> {
    if match_case {
        return hay.starts_with(needle).then_some(needle.len());
    }
    let mut hay_chars = hay.chars();
    let mut consumed = 0usize;
    for needle_ch in needle.chars() {
        let hay_ch = hay_chars.next()?;
        if hay_ch.to_lowercase().ne(needle_ch.to_lowercase()) {
            return None;
        }
        consumed += hay_ch.len_utf8();
    }
    Some(consumed)
}

/// Byte ranges of `needle` in `text`.
pub fn find_spans(
    text: &str,
    needle: &str,
    flags: FindFlags,
) -> Result<Vec<(usize, usize)>, String> {
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    if flags.regex {
        let re = regex::RegexBuilder::new(needle)
            .case_insensitive(!flags.match_case)
            .build()
            .map_err(|err| format!("正则无效: {err}"))?;
        let mut out = Vec::new();
        for found in re.find_iter(text) {
            if !flags.whole_word || is_word_bounded(text, found.start(), found.end()) {
                out.push((found.start(), found.end()));
            }
        }
        return Ok(out);
    }
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < text.len() {
        if let Some(len) = match_len_at(&text[i..], needle, flags.match_case) {
            let end = i + len;
            if !flags.whole_word || is_word_bounded(text, i, end) {
                out.push((i, end));
                i = end.max(i + 1);
                continue;
            }
        }
        i += text[i..]
            .chars()
            .next()
            .map(|ch| ch.len_utf8())
            .unwrap_or(1);
    }
    Ok(out)
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
        assert_eq!(
            extract_wikilinks("[[Foo#A]] 与 [[#Here]] 再 [[Foo#B]]"),
            vec!["Foo#A", "#Here", "Foo#B"]
        );
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
        assert_eq!(
            resolve_wikilink("Foo#Heading", &files),
            Some("C:/vault/notes/Foo.md")
        );
        assert_eq!(split_wikilink_target("#Heading"), ("", Some("Heading")));
        assert_eq!(
            split_wikilink_target("Foo#A section"),
            ("Foo", Some("A section"))
        );
        assert!(resolve_wikilink("missing", &files).is_none());
    }

    #[test]
    fn body_links_to_target() {
        let files = vec![("C:/v/A.md".into(), "A.md".into())];
        assert!(body_links_to("link [[A]] here", "C:/v/A.md", &files));
        assert!(!body_links_to("no link", "C:/v/A.md", &files));
    }

    #[test]
    fn find_spans_respects_word_and_case() {
        let flags = FindFlags {
            whole_word: true,
            match_case: false,
            regex: false,
        };
        let spans = find_spans("Note notes NOTE", "note", flags).unwrap();
        assert_eq!(spans, vec![(0, 4), (11, 15)]);
    }
}
