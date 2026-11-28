use std::path::{Path, PathBuf};

/// The project root that owns a field path — `<root>/.hadron/field.jsonl` → `<root>`.
/// A field sitting outside a `.hadron/` directory is taken to be in the root already.
///
/// Looks for the nearest ancestor named `.hadron` instead of only the immediate
/// parent, so a session field such as `<root>/.hadron/sessions/<id>/field.jsonl`
/// still resolves to `<root>` (each session lives in its own runtime directory).
///
/// Lives in the lattice because both ends of the two-process architecture need the
/// same rule: the chamber renders a repo's files/changes from it, and the gluon
/// resolves the repo it worktrees quarks into from it. One rule, one place.
pub fn repo_root_of(field_path: &Path) -> &Path {
    if let Some(hadron_dir) = field_path
        .ancestors()
        .skip(1)
        .find(|ancestor| ancestor.file_name() == Some(std::ffi::OsStr::new(".hadron")))
    {
        let root = hadron_dir.parent().unwrap_or(hadron_dir);
        return if root.as_os_str().is_empty() {
            Path::new(".")
        } else {
            root
        };
    }
    let Some(parent) = field_path.parent() else {
        return field_path;
    };
    let root = parent;
    if root.as_os_str().is_empty() {
        Path::new(".")
    } else {
        root
    }
}

/// The `.hadron/` directory that owns a field path.
///
/// If `field_path` is already inside a `.hadron/` directory, returns that `.hadron/` directory.
/// Otherwise, returns `<repo_root>/.hadron`.
///
/// This is the **configuration** directory (`team.json`, nucleus, skills) shared by
/// every session of a repo. Runtime files (`gluon.lock`, `gluon.rpc`, `ledger.db`,
/// `live/`) go to [`runtime_dir_of`] so sessions never fight over one lock.
pub fn hadron_dir_of(field_path: &Path) -> PathBuf {
    if let Some(parent) = field_path.parent() {
        if parent.file_name() == Some(std::ffi::OsStr::new(".hadron")) {
            return parent.to_path_buf();
        }
    }
    repo_root_of(field_path).join(".hadron")
}

/// The directory holding a field's **runtime** files (`gluon.lock`, `gluon.rpc`,
/// `ledger.db`, `live/`).
///
/// A session field at `<repo>/.hadron/sessions/<id>/field.jsonl` gets its own
/// runtime directory (`.../sessions/<id>`), which is what makes several sessions of
/// one repo able to run their own daemon in parallel. Everything else keeps using the
/// shared `<repo>/.hadron`.
pub fn runtime_dir_of(field_path: &Path) -> PathBuf {
    if let Some(dir) = session_dir_of(field_path) {
        return dir.to_path_buf();
    }
    hadron_dir_of(field_path)
}

/// If `field_path` sits in `<repo>/.hadron/sessions/<id>/`, return that `<id>` directory.
pub fn session_dir_of(field_path: &Path) -> Option<&Path> {
    let dir = field_path.parent()?;
    let sessions = dir.parent()?;
    if sessions.file_name() != Some(std::ffi::OsStr::new("sessions")) {
        return None;
    }
    let hadron = sessions.parent()?;
    (hadron.file_name() == Some(std::ffi::OsStr::new(".hadron"))).then_some(dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn the_repo_root_is_the_parent_of_the_hadron_dir() {
        let field = PathBuf::from("/home/user/project/.hadron/field.jsonl");
        assert_eq!(repo_root_of(&field), Path::new("/home/user/project"));
    }

    #[test]
    fn a_field_outside_a_hadron_dir_is_already_in_the_root() {
        let field = PathBuf::from("/tmp/scratch/field.jsonl");
        assert_eq!(repo_root_of(&field), Path::new("/tmp/scratch"));
    }

    #[test]
    fn a_bare_field_name_resolves_to_the_current_dir() {
        let field = PathBuf::from("field.jsonl");
        assert_eq!(repo_root_of(&field), Path::new("."));
    }

    #[test]
    fn hadron_dir_of_resolves_to_hadron_subdir() {
        let field_in_hadron = PathBuf::from("/home/user/project/.hadron/field.jsonl");
        assert_eq!(
            hadron_dir_of(&field_in_hadron),
            PathBuf::from("/home/user/project/.hadron")
        );

        let field_bare = PathBuf::from("field.jsonl");
        assert_eq!(hadron_dir_of(&field_bare), PathBuf::from("./.hadron"));

        let field_custom = PathBuf::from("/tmp/scratch/field.jsonl");
        assert_eq!(
            hadron_dir_of(&field_custom),
            PathBuf::from("/tmp/scratch/.hadron")
        );
    }

    #[test]
    fn a_session_field_still_belongs_to_the_repo_with_its_own_runtime_dir() {
        let field = PathBuf::from("/home/user/project/.hadron/sessions/20260101_120000/field.jsonl");
        assert_eq!(
            repo_root_of(&field),
            Path::new("/home/user/project")
        );
        assert_eq!(
            hadron_dir_of(&field),
            PathBuf::from("/home/user/project/.hadron")
        );
        // 每个会话独占自己的运行目录，才能各跑一个守护进程。
        assert_eq!(
            runtime_dir_of(&field),
            PathBuf::from("/home/user/project/.hadron/sessions/20260101_120000")
        );
        // 普通活动 field 运行时仍落在共享的 `.hadron`。
        let live = PathBuf::from("/home/user/project/.hadron/field.jsonl");
        assert_eq!(
            runtime_dir_of(&live),
            PathBuf::from("/home/user/project/.hadron")
        );
    }
}
