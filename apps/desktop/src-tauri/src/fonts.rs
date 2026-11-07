use font_kit::source::SystemSource;

/// Family names of fonts installed on this machine, sorted case-insensitively.
#[tauri::command]
pub fn list_system_fonts() -> Result<Vec<String>, String> {
    let source = SystemSource::new();
    let mut families = source
        .all_families()
        .map_err(|err| format!("无法读取系统字体：{err}"))?;
    families.retain(|name| is_safe_family(name));
    families.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    families.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
    Ok(families)
}

fn is_safe_family(name: &str) -> bool {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.len() > 80 {
        return false;
    }
    !trimmed.chars().any(|c| {
        matches!(
            c,
            '"' | '\'' | ';' | '{' | '}' | '<' | '>' | '\\' | '\n' | '\r' | '\0'
        )
    })
}

#[cfg(test)]
mod tests {
    use super::is_safe_family;

    #[test]
    fn rejects_unsafe_family_names() {
        assert!(is_safe_family("Helvetica Neue"));
        assert!(is_safe_family("微软雅黑"));
        assert!(!is_safe_family(""));
        assert!(!is_safe_family("Bad\";color:red"));
    }
}
