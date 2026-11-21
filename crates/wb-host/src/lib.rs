//! Native host capabilities previously exposed via Tauri invoke.

pub mod catalog;
pub mod fonts;
pub mod image_util;
pub mod kb;
pub mod mcp;
pub mod model_http;
pub mod notify;
pub mod ocr;
pub mod open_ext;
pub mod paths;
pub mod shell;
pub mod speech;
pub mod spill;
pub mod terminal;
pub mod voice_ptt;
pub mod voice_record;
pub mod web;

pub use catalog::*;
pub use fonts::*;
pub use image_util::*;
pub use kb::*;
pub use mcp::*;
pub use model_http::*;
pub use notify::*;
pub use ocr::*;
pub use open_ext::*;
pub use paths::*;
pub use shell::*;
pub use speech::*;
pub use spill::*;
pub use terminal::*;
pub use voice_ptt::*;
pub use voice_record::*;
pub use web::*;
