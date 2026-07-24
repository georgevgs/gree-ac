use thiserror::Error;

#[derive(Debug, Error)]
#[non_exhaustive]
pub enum Error {
    #[error("socket error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("base64 error: {0}")]
    Base64(#[from] base64::DecodeError),
    #[error("crypto: decryption failed")]
    Decrypt,
    #[error("crypto: encryption failed")]
    Encrypt,
    #[error("not connected")]
    NotConnected,
    #[error("connect timed out")]
    ConnectTimeout,
    #[error("unknown property: {0}")]
    UnknownProperty(String),
    #[error("{0} out of range: must be {1}-{2}")]
    OutOfRange(&'static str, i64, i64),
    #[error("read-only property: {0}")]
    ReadOnly(&'static str),
}

pub type Result<T> = std::result::Result<T, Error>;
