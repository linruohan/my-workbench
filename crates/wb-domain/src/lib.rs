//! Domain rules for the local-first personal workbench (no IO).

pub mod agent;
pub mod date;
pub mod id;
pub mod kb;
pub mod prefs;
pub mod quick_capture;
pub mod reminder;
pub mod task;
pub mod timed;
pub mod types;

pub use agent::*;
pub use date::*;
pub use id::*;
pub use kb::*;
pub use prefs::*;
pub use quick_capture::*;
pub use reminder::*;
pub use task::*;
pub use timed::*;
pub use types::*;

use thiserror::Error;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum DomainError {
    #[error("{0}")]
    Message(String),
}

impl DomainError {
    pub fn new(msg: impl Into<String>) -> Self {
        Self::Message(msg.into())
    }
}
