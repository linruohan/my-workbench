//! 会话（session）级别的轻量元数据操作。
//!
//! 会话名以 `Kind::SessionName` 事件的形式写在对应的 field 里，和聊天里的
//! `/rename` 完全一致：`/clear` 归档 field 时名字会随文件一起被带走，不需要
//! 额外的 sidecar 文件，也不会有两处状态不一致的问题。

use hadron_lattice::{io, Actor, Event, Kind};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

/// 默认会话名的长度（需求：8 位随机字符串）。
pub const SESSION_NAME_LEN: usize = 8;

/// 会话名字符表：小写字母 + 数字，去掉肉眼容易混淆的 `l/o/0/1`。
const NAME_ALPHABET: &[u8] = b"abcdefghijkmnpqrstuvwxyz23456789";

/// 随机数状态：每次取值都推进一次，避免同一毫秒内生成相同名字。
static RAND_STATE: AtomicU64 = AtomicU64::new(0x9E37_79B9_7F4A_7C15);

/// 生成一个 8 位随机会话名。
///
/// 不引入额外随机数依赖：用「纳秒时间 + 进程号」做种子，再走 xorshift64，
/// 已经足够避免同一台机器上的重名（会话名只用于展示与 `/resume` 检索）。
pub fn random_session_name() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let seed = nanos ^ ((std::process::id() as u64) << 32);
    let mut state = RAND_STATE.fetch_add(seed | 1, Ordering::Relaxed) ^ seed;
    let mut name = String::with_capacity(SESSION_NAME_LEN);
    for _ in 0..SESSION_NAME_LEN {
        // xorshift64：位移组合简单，足够打散种子。
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        let index = (state % NAME_ALPHABET.len() as u64) as usize;
        name.push(NAME_ALPHABET[index] as char);
    }
    name
}

/// 读取 field 里记录过的会话名；多次重命名时以最后一次为准。
///
/// 读取失败（文件不存在 / 损坏）时返回 `None`，调用方自行回退到目录 id。
pub fn read_session_name(field_path: &Path) -> Option<String> {
    let events = io::read_events(field_path).ok()?;
    session_name_from_events(&events)
}

/// 从已读入的事件流里取最后一个非空会话名。
pub fn session_name_from_events(events: &[Event]) -> Option<String> {
    events
        .iter()
        .filter_map(|event| match &event.kind {
            Kind::SessionName { name } => Some(name.trim().to_string()),
            _ => None,
        })
        .filter(|name| !name.is_empty())
        .last()
}

/// 给 field 追加一次「会话改名」事件。
///
/// 直接以追加方式写 JSONL 行：field 是只增日志，追加比「读全量 → 重写」更安全，
/// 不会和守护进程并发写入的回复抢占同一份内容。
pub fn rename_session(field_path: &Path, name: &str) -> std::io::Result<()> {
    use std::io::Write as _;

    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    if let Some(parent) = field_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let event = Event::new(
        Actor::Human,
        None,
        Kind::SessionName {
            name: trimmed.to_string(),
        },
    );
    let mut line = serde_json::to_string(&event)
        .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))?;
    line.push('\n');
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(field_path)?;
    file.write_all(line.as_bytes())?;
    file.flush()
}

/// 保证 field 有会话名：已有名字直接返回，没有就生成 8 位随机名写回。
///
/// field 不存在时也会先建好空文件，保证后续追加不会丢。
pub fn ensure_session_name(field_path: &Path) -> Option<String> {
    if let Some(existing) = read_session_name(field_path) {
        return Some(existing);
    }
    if let Some(parent) = field_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let name = random_session_name();
    match rename_session(field_path, &name) {
        Ok(()) => Some(name),
        Err(err) => {
            hadron_lattice::term::warn(
                hadron_lattice::term::Source::Chamber,
                &format!("写入会话默认名失败: {err}"),
            );
            Some(name)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_names_are_eight_chars_and_unique_enough() {
        let a = random_session_name();
        let b = random_session_name();
        assert_eq!(a.len(), SESSION_NAME_LEN);
        assert_ne!(a, b);
        assert!(a.chars().all(|c| NAME_ALPHABET.contains(&(c as u8))));
    }

    #[test]
    fn ensure_then_rename_round_trips() {
        // 不引额外依赖：用系统临时目录 + 进程号拼一个唯一目录。
        let dir = std::env::temp_dir().join(format!(
            "wb-session-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("tempdir");
        let field = dir.join("field.jsonl");
        let generated = ensure_session_name(&field).expect("name");
        assert_eq!(read_session_name(&field).as_deref(), Some(generated.as_str()));
        rename_session(&field, "bugfix-router").expect("rename");
        assert_eq!(
            read_session_name(&field).as_deref(),
            Some("bugfix-router")
        );
        // 已有名字时 ensure 不覆盖。
        assert_eq!(
            ensure_session_name(&field).as_deref(),
            Some("bugfix-router")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
