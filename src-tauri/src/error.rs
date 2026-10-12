use serde::Serializer;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("file error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Activation(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("{0}")]
    Invalid(String),
    #[error("not supported on this platform yet: {0}")]
    Unsupported(String),
    #[error("{0}")]
    Other(String),
}

pub type AppResult<T> = Result<T, AppError>;

// Commands return errors to the UI as plain strings.
impl serde::Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}
