#[cfg(feature = "gui")]
pub mod app;
#[cfg_attr(not(feature = "gui"), allow(dead_code))]
pub mod config;
pub mod fonts;
#[cfg_attr(not(feature = "gui"), allow(dead_code))]
pub mod headless_runner;
pub mod mermaid;
#[cfg_attr(not(feature = "gui"), allow(dead_code))]
pub mod model;
#[cfg_attr(not(feature = "gui"), allow(dead_code))]
pub mod pty;
#[cfg_attr(not(feature = "gui"), allow(dead_code))]
pub mod rpc_client;
#[cfg_attr(not(feature = "gui"), allow(dead_code))]
pub mod symbols;
#[cfg_attr(not(feature = "gui"), allow(dead_code))]
pub mod syntax;
#[cfg_attr(not(feature = "gui"), allow(dead_code))]
pub mod sys;
#[cfg_attr(not(feature = "gui"), allow(dead_code))]
pub mod text;
#[cfg(feature = "gui")]
pub mod theme;
#[cfg_attr(not(feature = "gui"), allow(dead_code))]
pub mod vcs;
#[cfg(feature = "gui")]
pub mod window_frame;
#[cfg_attr(not(feature = "gui"), allow(dead_code))]
pub mod wsl;
