pub mod agent;
pub mod inspector;
pub mod knowledge;
pub mod settings;
pub mod tasks;
pub mod timed;

pub use agent::*;
pub use inspector::*;
pub use knowledge::*;
pub use settings::*;
pub use tasks::*;
pub use timed::*;

use gpui_kit::{Context, PathPromptOptions};
use std::path::PathBuf;

/// Pick a folder the way Zed does: `prompt_for_paths` runs the native dialog on
/// another thread. Calling `rfd` inside a click handler pumps the window
/// procedure while `App` is borrowed and aborts on `RefCell already borrowed`.
pub fn prompt_directory<T: 'static>(
    cx: &mut Context<T>,
    apply: impl FnOnce(&mut T, Option<PathBuf>, &mut Context<T>) + 'static,
) {
    let rx = cx.prompt_for_paths(PathPromptOptions {
        files: false,
        directories: true,
        multiple: false,
        prompt: None,
    });
    cx.spawn(async move |this, async_cx| {
        let picked = match rx.await {
            Ok(Ok(Some(mut paths))) => paths.pop(),
            Ok(Err(err)) => {
                log::warn!("选择目录失败: {err}");
                None
            }
            _ => None,
        };
        this.update(async_cx, |view, cx| apply(view, picked, cx))
            .ok();
    })
    .detach();
}
