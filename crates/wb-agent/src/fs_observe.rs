//! Lightweight FS observation: must read/view before overwrite/delete of existing paths.
//! A successful read also stores a SHA-256 of the bytes. A later write is rejected
//! when the file no longer matches that snapshot.

use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

struct Observed {
    paths: HashSet<PathBuf>,
    hashes: HashMap<PathBuf, String>,
}

fn store() -> &'static Mutex<Observed> {
    static OBSERVED: OnceLock<Mutex<Observed>> = OnceLock::new();
    OBSERVED.get_or_init(|| {
        Mutex::new(Observed {
            paths: HashSet::new(),
            hashes: HashMap::new(),
        })
    })
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn canon(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

pub fn observe_path(path: &Path) {
    let key = canon(path);
    let mut guard = store().lock().unwrap();
    guard.paths.insert(key.clone());
    if let Ok(bytes) = std::fs::read(&key) {
        guard.hashes.insert(key, sha256_hex(&bytes));
    }
}

pub fn is_observed(path: &Path) -> bool {
    let key = canon(path);
    store().lock().unwrap().paths.contains(&key)
}

/// Returns an error message if writing/deleting an existing path that was not observed,
/// or if the file bytes no longer match the hash captured at the last read.
pub fn require_observed_for_existing(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let key = canon(path);
    let guard = store().lock().unwrap();
    if !guard.paths.contains(&key) {
        return Err(format!(
            "FS_NOT_OBSERVED：请先 read / read_image / ocr / view 后再修改已存在文件：{}",
            path.display()
        ));
    }
    if let Some(expected) = guard.hashes.get(&key) {
        if let Ok(bytes) = std::fs::read(&key) {
            let current = sha256_hex(&bytes);
            if &current != expected {
                return Err(format!(
                    "FS_STALE：文件在读取后已变化，请重新 read 再修改：{}",
                    path.display()
                ));
            }
        }
    }
    Ok(())
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
        std::fs::write(&file, "changed").unwrap();
        let stale = require_observed_for_existing(&file).unwrap_err();
        assert!(stale.contains("FS_STALE"));
        observe_path(&file);
        assert!(require_observed_for_existing(&file).is_ok());
        let missing = dir.join("new.txt");
        assert!(require_observed_for_existing(&missing).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
