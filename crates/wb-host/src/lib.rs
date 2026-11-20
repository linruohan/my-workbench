//! Native host capabilities previously exposed via Tauri invoke.

pub mod fonts;
pub mod kb;
pub mod model_http;
pub mod open_ext;
pub mod paths;
pub mod shell;
pub mod speech;
pub mod voice_ptt;

pub use fonts::*;
pub use kb::*;
pub use model_http::*;
pub use open_ext::*;
pub use paths::*;
pub use shell::*;
pub use speech::*;
pub use voice_ptt::*;
