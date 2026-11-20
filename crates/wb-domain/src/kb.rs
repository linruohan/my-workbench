//! Knowledge-base path helpers and extension whitelist.

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn md_is_text() {
        assert!(is_kb_extension("md"));
        assert!(is_image_extension("PNG"));
    }
}
