use uuid::Uuid;

/// Create a time-sortable unique id (ms + uuid suffix).
pub fn create_id(now_ms: i64) -> String {
    let u = Uuid::new_v4().simple().to_string();
    format!("{now_ms}-{}", &u[..8])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_has_timestamp_prefix() {
        let id = create_id(1_700_000_000_000);
        assert!(id.starts_with("1700000000000-"));
    }
}
