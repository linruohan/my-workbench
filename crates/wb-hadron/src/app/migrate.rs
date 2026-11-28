//! 旧目录迁移：把历史上的 `.hadron` 目录平滑改名为 `.wb`。
//!
//! 路径品牌统一后，老工作区里的会话、team 配置仍躺在 `.hadron/` 下；
//! 这里在应用启动 / 切换工作区时做一次幂等迁移（目标已存在就跳过）。

use std::path::Path;

/// 把仓库里的旧 `.hadron/` 重命名为 `.wb/`。
///
/// 目标目录已存在（例如已经在新版本里用过）时不做任何事，避免覆盖新数据。
/// 迁移失败只记录日志、不阻塞启动：旧数据仍在原处，用户可手工处理。
pub fn migrate_repo_dir(repo_root: &Path) {
    migrate_dir(&repo_root.join(".hadron"), &repo_root.join(".wb"));
}

/// 把用户主目录下的旧 `~/.hadron/` 重命名为 `~/.wb/`（全局 team / 凭据配置）。
pub fn migrate_global_dir() {
    // `team_config_path()` 是 `~/.wb/team.json`：由它反推出目标目录与主目录。
    let Some(config) = hadron_lattice::team_config_path() else {
        return;
    };
    let Some(target) = config.parent() else {
        return;
    };
    let Some(home) = target.parent() else {
        return;
    };
    migrate_dir(&home.join(".hadron"), target);
}

/// 目录迁移的共用实现：旧目录存在且新目录不存在时才 rename。
fn migrate_dir(legacy: &Path, target: &Path) {
    if !legacy.is_dir() || target.exists() {
        return;
    }
    match std::fs::rename(legacy, target) {
        Ok(()) => hadron_lattice::term::info(
            hadron_lattice::term::Source::Chamber,
            &format!("已迁移目录 {} → {}", legacy.display(), target.display()),
        ),
        Err(err) => hadron_lattice::term::warn(
            hadron_lattice::term::Source::Chamber,
            &format!(
                "迁移目录失败 {} → {}: {err}（旧数据继续留在原处）",
                legacy.display(),
                target.display()
            ),
        ),
    }
}
