//! Pure text helpers for the agent composer.
//!
//! Kept out of `views::agent` so they stay unit-testable: that module renders a
//! very large view tree and its `#[test]` macro expansion hits the recursion cap.

/// `@path` tokens in the draft, in order of appearance, deduplicated.
pub fn draft_file_refs(draft: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for token in draft.split_whitespace() {
        let Some(rest) = token.strip_prefix('@') else {
            continue;
        };
        if rest.is_empty() || rest.contains('@') {
            continue;
        }
        if !out.iter().any(|existing| existing == rest) {
            out.push(rest.to_string());
        }
    }
    out
}

/// `provider/model` → `model` for compact chips and menus.
pub fn model_label_of(model_ref: &str) -> String {
    model_ref
        .split('/')
        .next_back()
        .unwrap_or(model_ref)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn draft_refs_are_unique_and_ordered() {
        let refs = draft_file_refs("check @src/main.rs and @Cargo.toml then @src/main.rs");
        assert_eq!(refs, vec!["src/main.rs", "Cargo.toml"]);
    }

    #[test]
    fn draft_refs_ignore_bare_at_and_emails() {
        assert!(draft_file_refs("hello @ world").is_empty());
        assert!(draft_file_refs("mail me at user@host").is_empty());
        assert!(draft_file_refs("").is_empty());
    }

    #[test]
    fn model_label_strips_provider() {
        assert_eq!(model_label_of("openai/gpt-4o"), "gpt-4o");
        assert_eq!(model_label_of("builtin"), "builtin");
    }
}
