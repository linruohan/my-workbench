//! Lightweight Codex-style `apply_patch` parser/applier (no IO).

use crate::DomainError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PatchAction {
    Add {
        path: String,
        content: String,
    },
    Delete {
        path: String,
    },
    Update {
        path: String,
        /// Each hunk is (old_text, new_text) to replace once in order.
        hunks: Vec<(String, String)>,
    },
}

/// Parse a `*** Begin Patch` … `*** End Patch` document into actions.
pub fn parse_apply_patch(input: &str) -> Result<Vec<PatchAction>, DomainError> {
    let text = input.trim();
    let body = if text.contains("*** Begin Patch") {
        let start = text
            .find("*** Begin Patch")
            .and_then(|i| text[i..].find('\n').map(|n| i + n + 1))
            .unwrap_or(0);
        let end = text.find("*** End Patch").unwrap_or(text.len());
        text[start..end].trim_end()
    } else {
        text
    };

    let mut actions = Vec::new();
    let mut lines = body.lines().peekable();
    while let Some(line) = lines.next() {
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }
        if let Some(path) = line.strip_prefix("*** Add File: ") {
            let path = path.trim().to_string();
            let mut content = String::new();
            while let Some(peek) = lines.peek() {
                let p = peek.trim_end();
                if p.starts_with("*** ") {
                    break;
                }
                let row = lines.next().unwrap();
                if let Some(rest) = row.strip_prefix('+') {
                    content.push_str(rest);
                    content.push('\n');
                } else if row.is_empty() {
                    content.push('\n');
                } else {
                    return Err(DomainError::new(format!("Add File 行必须以 + 开头：{row}")));
                }
            }
            actions.push(PatchAction::Add { path, content });
        } else if let Some(path) = line.strip_prefix("*** Delete File: ") {
            actions.push(PatchAction::Delete {
                path: path.trim().to_string(),
            });
        } else if let Some(path) = line.strip_prefix("*** Update File: ") {
            let path = path.trim().to_string();
            let mut hunk_lines = Vec::new();
            while let Some(peek) = lines.peek() {
                let p = peek.trim_end();
                if p.starts_with("*** ") && !p.starts_with("*** End of File") {
                    break;
                }
                hunk_lines.push(lines.next().unwrap().to_string());
            }
            let hunks = parse_update_hunks(&hunk_lines)?;
            if hunks.is_empty() {
                return Err(DomainError::new(format!("Update File 无有效 hunk：{path}")));
            }
            actions.push(PatchAction::Update { path, hunks });
        } else if line.starts_with("***") {
            // ignore unknown markers like End of File
            continue;
        } else {
            return Err(DomainError::new(format!("无法解析补丁行：{line}")));
        }
    }
    if actions.is_empty() {
        return Err(DomainError::new("补丁为空"));
    }
    Ok(actions)
}

fn parse_update_hunks(lines: &[String]) -> Result<Vec<(String, String)>, DomainError> {
    let mut hunks = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i].trim_end();
        if line.is_empty() {
            i += 1;
            continue;
        }
        if line.starts_with("@@") {
            i += 1;
            let mut old = String::new();
            let mut new = String::new();
            while i < lines.len() {
                let row = lines[i].trim_end();
                if row.starts_with("@@") {
                    break;
                }
                if row.starts_with("*** ") {
                    break;
                }
                if row.is_empty() {
                    old.push('\n');
                    new.push('\n');
                } else {
                    match row.chars().next() {
                        Some(' ') => {
                            let rest = &row[1..];
                            old.push_str(rest);
                            old.push('\n');
                            new.push_str(rest);
                            new.push('\n');
                        }
                        Some('-') => {
                            old.push_str(&row[1..]);
                            old.push('\n');
                        }
                        Some('+') => {
                            new.push_str(&row[1..]);
                            new.push('\n');
                        }
                        _ => {
                            old.push_str(row);
                            old.push('\n');
                            new.push_str(row);
                            new.push('\n');
                        }
                    }
                }
                i += 1;
            }
            if old.is_empty() && new.is_empty() {
                continue;
            }
            hunks.push((old, new));
            continue;
        }
        // Hunk without @@ — single change block until next *** or @@
        let mut old = String::new();
        let mut new = String::new();
        while i < lines.len() {
            let row = lines[i].trim_end();
            if row.starts_with("@@") || row.starts_with("*** ") {
                break;
            }
            if row.is_empty() {
                old.push('\n');
                new.push('\n');
            } else {
                match row.chars().next() {
                    Some(' ') => {
                        let rest = &row[1..];
                        old.push_str(rest);
                        old.push('\n');
                        new.push_str(rest);
                        new.push('\n');
                    }
                    Some('-') => {
                        old.push_str(&row[1..]);
                        old.push('\n');
                    }
                    Some('+') => {
                        new.push_str(&row[1..]);
                        new.push('\n');
                    }
                    _ => {
                        return Err(DomainError::new(format!(
                            "Update hunk 行须以 空格/+/- 开头：{row}"
                        )));
                    }
                }
            }
            i += 1;
        }
        if !old.is_empty() || !new.is_empty() {
            hunks.push((old, new));
        }
    }
    Ok(hunks)
}

/// Apply update hunks to file content.
pub fn apply_hunks(content: &str, hunks: &[(String, String)]) -> Result<String, DomainError> {
    let mut next = content.to_string();
    // Normalize to always search with the file's newline style when possible.
    for (idx, (old, new)) in hunks.iter().enumerate() {
        let old = old.as_str();
        let new = new.as_str();
        if old.is_empty() {
            // pure insertion at start if empty old — append uncommon; treat as error
            return Err(DomainError::new(format!("hunk #{} 的旧文本为空", idx + 1)));
        }
        let candidates = [
            old.to_string(),
            old.trim_end_matches('\n').to_string(),
            old.replace('\n', "\r\n"),
        ];
        let mut applied = false;
        for cand in &candidates {
            if next.contains(cand) {
                let replacement = if cand.contains("\r\n") && !new.contains("\r\n") {
                    new.replace('\n', "\r\n")
                } else {
                    new.to_string()
                };
                next = next.replacen(cand, &replacement, 1);
                applied = true;
                break;
            }
        }
        if !applied {
            return Err(DomainError::new(format!(
                "hunk #{} 未匹配到旧文本",
                idx + 1
            )));
        }
    }
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_update_delete_roundtrip() {
        let patch = r#"*** Begin Patch
*** Add File: a.txt
+hello
+world
*** Update File: b.txt
@@
 foo
-bar
+baz
*** Delete File: c.txt
*** End Patch
"#;
        let actions = parse_apply_patch(patch).unwrap();
        assert_eq!(actions.len(), 3);
        match &actions[0] {
            PatchAction::Add { path, content } => {
                assert_eq!(path, "a.txt");
                assert_eq!(content, "hello\nworld\n");
            }
            _ => panic!("expected add"),
        }
        match &actions[1] {
            PatchAction::Update { path, hunks } => {
                assert_eq!(path, "b.txt");
                let out = apply_hunks("foo\nbar\n", hunks).unwrap();
                assert_eq!(out, "foo\nbaz\n");
            }
            _ => panic!("expected update"),
        }
        assert!(matches!(
            &actions[2],
            PatchAction::Delete { path } if path == "c.txt"
        ));
    }
}
