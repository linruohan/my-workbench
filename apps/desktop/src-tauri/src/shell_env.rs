//! Allowlist scrub + managed WB_* overlay for agent-spawned shell / PTY.
//! Keep in sync with `packages/domain/src/shell-env.ts`.

use portable_pty::CommandBuilder;
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::process::Command;

/// Marker injected into every scrubbed agent shell environment.
pub const WB_AGENT_SHELL_ENV: &str = "WB_AGENT_SHELL";

/// Keys allowed through from the host process (compared case-insensitively).
const ALLOWLIST: &[&str] = &[
    "PATH",
    "PATHEXT",
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "USER",
    "USERNAME",
    "LOGNAME",
    "SHELL",
    "COMSPEC",
    "SYSTEMROOT",
    "WINDIR",
    "SYSTEMDRIVE",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
    "PROCESSOR_LEVEL",
    "PROCESSOR_REVISION",
    "OS",
    "TMP",
    "TEMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LC_MESSAGES",
    "TZ",
    "TERM",
    "COLORTERM",
    "DISPLAY",
    "WAYLAND_DISPLAY",
];

fn normalize_key(key: &str) -> String {
    key.trim().to_ascii_uppercase()
}

fn is_allowed(key: &str) -> bool {
    let normalized = normalize_key(key);
    if normalized.is_empty() || normalized.starts_with("WB_") {
        return false;
    }
    ALLOWLIST
        .iter()
        .any(|allowed| normalize_key(allowed) == normalized)
}

/// Fresh host allowlist ∩ current process env (no ambient WB_*).
pub fn scrubbed_host_env_vars() -> BTreeMap<OsString, OsString> {
    let mut out: BTreeMap<OsString, OsString> = BTreeMap::new();
    let mut seen: BTreeMap<String, ()> = BTreeMap::new();

    for (key, value) in std::env::vars_os() {
        let Some(key_str) = key.to_str() else {
            continue;
        };
        if !is_allowed(key_str) {
            continue;
        }
        let norm = normalize_key(key_str);
        if seen.contains_key(&norm) {
            continue;
        }
        seen.insert(norm, ());
        out.insert(key, value);
    }
    out
}

fn apply_managed_overlay(
    base: &mut BTreeMap<OsString, OsString>,
    managed: &BTreeMap<String, String>,
) {
    // Drop any ambient WB_* that slipped in, then inject the trusted snapshot.
    base.retain(|key, _| {
        key.to_str()
            .map(|s| !normalize_key(s).starts_with("WB_"))
            .unwrap_or(true)
    });
    for (key, value) in managed {
        let trimmed = key.trim();
        if !trimmed.starts_with("WB_") || value.is_empty() {
            continue;
        }
        base.insert(OsString::from(trimmed), OsString::from(value.as_str()));
    }
    base
        .entry(OsString::from(WB_AGENT_SHELL_ENV))
        .or_insert_with(|| OsString::from("1"));
}

/// Replace inherited env with scrubbed host vars + managed WB_* overlay.
pub fn apply_scrubbed_env(cmd: &mut Command, managed: &BTreeMap<String, String>) {
    let mut env = scrubbed_host_env_vars();
    apply_managed_overlay(&mut env, managed);
    cmd.env_clear();
    for (key, value) in env {
        cmd.env(key, value);
    }
}

/// Replace inherited env on a portable-pty CommandBuilder.
pub fn apply_scrubbed_env_pty(cmd: &mut CommandBuilder, managed: &BTreeMap<String, String>) {
    let mut env = scrubbed_host_env_vars();
    apply_managed_overlay(&mut env, managed);
    cmd.env_clear();
    for (key, value) in env {
        cmd.env(&key, &value);
    }
}

/// Minimal default overlay when the caller passes none.
pub fn default_managed_env() -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    map.insert(WB_AGENT_SHELL_ENV.to_string(), "1".into());
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_keeps_path_drops_secrets_and_ambient_wb() {
        assert!(is_allowed("PATH"));
        assert!(is_allowed("Path"));
        assert!(is_allowed("SYSTEMROOT"));
        assert!(!is_allowed("OPENAI_API_KEY"));
        assert!(!is_allowed("GITHUB_TOKEN"));
        assert!(!is_allowed("NODE_OPTIONS"));
        assert!(!is_allowed("WB_HOME"));
        assert!(!is_allowed("WB_AGENT_SHELL"));
    }

    #[test]
    fn managed_overlay_sets_marker_and_session() {
        let mut env = scrubbed_host_env_vars();
        let mut managed = BTreeMap::new();
        managed.insert("WB_SESSION_ID".into(), "thr_1".into());
        managed.insert("WB_WORKSPACE_ROOT".into(), "D:/ws".into());
        apply_managed_overlay(&mut env, &managed);
        assert_eq!(
            env.get(std::ffi::OsStr::new(WB_AGENT_SHELL_ENV))
                .and_then(|v| v.to_str()),
            Some("1")
        );
        assert_eq!(
            env.get(std::ffi::OsStr::new("WB_SESSION_ID"))
                .and_then(|v| v.to_str()),
            Some("thr_1")
        );
        assert_eq!(
            env.get(std::ffi::OsStr::new("WB_WORKSPACE_ROOT"))
                .and_then(|v| v.to_str()),
            Some("D:/ws")
        );
    }
}
