//! Lightweight FS observation: must read/view before overwrite/delete of existing paths.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

fn store() -> &'static Mutex<HashSet<PathBuf>> {
    static OBSERVED: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    OBSERVED.get_or_init(|| Mutex::new(HashSet::new()))
}

fn canon(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

pub fn observe_path(path: &Path) {
    store().lock().unwrap().insert(canon(path));
}

pub fn is_observed(path: &Path) -> bool {
    let key = canon(path);
    store().lock().unwrap().contains(&key)
}

/// Returns an error message if writing/deleting an existing path that was not observed.
pub fn require_observed_for_existing(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    if is_observed(path) {
        return Ok(());
    }
    Err(format!(
        "FS_NOT_OBSERVED：请先 read / read_image / ocr / view 后再修改已存在文件：{}",
        path.display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observe_then_allow() {
        let dir = std::env::temp_dir().join(format!("wb-obs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("x.txt");
        std::fs::write(&file, "hi").unwrap();
        assert!(require_observed_for_existing(&file).is_err());
        observe_path(&file);
        assert!(require_observed_for_existing(&file).is_ok());
        let missing = dir.join("new.txt");
        assert!(require_observed_for_existing(&missing).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
