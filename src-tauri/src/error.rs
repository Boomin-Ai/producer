use serde::{Serialize, Serializer};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("keychain error: {0}")]
    Vault(#[from] keyring::Error),
    #[error("network error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("endpoint rejected the token: {0}")]
    Unauthorized(String),
    #[error("{0}")]
    Other(String),
}

// Tauri IPC errors must serialize; the UI only ever needs the message.
impl Serialize for EngineError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type EngineResult<T> = Result<T, EngineError>;
