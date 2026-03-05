use crate::protocol::PersistedWorldRepository;
use std::fmt::{Display, Formatter};
use std::path::{Path, PathBuf};
use tokio::fs;

#[derive(Debug)]
pub enum DatastoreError {
    Io(std::io::Error),
    Serde(serde_json::Error),
}

impl Display for DatastoreError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            DatastoreError::Io(error) => write!(formatter, "io error: {}", error),
            DatastoreError::Serde(error) => write!(formatter, "serialization error: {}", error),
        }
    }
}

impl std::error::Error for DatastoreError {}

pub struct FileWorldDatastore {
    path: PathBuf,
}

impl FileWorldDatastore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub async fn load(&self) -> Result<Option<PersistedWorldRepository>, DatastoreError> {
        let payload = match fs::read_to_string(&self.path).await {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(DatastoreError::Io(error)),
        };

        if payload.trim().is_empty() {
            return Ok(None);
        }

        let persisted = serde_json::from_str::<PersistedWorldRepository>(&payload)
            .map_err(DatastoreError::Serde)?;
        Ok(Some(persisted))
    }

    pub async fn save(&self, state: &PersistedWorldRepository) -> Result<(), DatastoreError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)
                .await
                .map_err(DatastoreError::Io)?;
        }

        let payload = serde_json::to_string_pretty(state).map_err(DatastoreError::Serde)?;
        fs::write(&self.path, payload)
            .await
            .map_err(DatastoreError::Io)?;
        Ok(())
    }
}
