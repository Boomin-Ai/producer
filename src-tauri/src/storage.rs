//! Read-only local storage inventory. Never follows symlinks or removes user media.
use crate::{
    error::{EngineError, EngineResult},
    AppState,
};
use serde::Serialize;
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};
use tauri::{Manager, State};

#[derive(Debug, Serialize, Default)]
pub struct StorageUsage {
    pub total_bytes: u64,
    pub app_data_bytes: u64,
    pub recording_bytes: u64,
    pub recording_count: u64,
    pub missing_recordings: u64,
    pub unreadable_entries: u64,
}
fn tree_bytes(path: &Path, skipped: &mut u64) -> u64 {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        *skipped += 1;
        return 0;
    };
    if metadata.file_type().is_symlink() {
        return 0;
    }
    if metadata.is_file() {
        return metadata.len();
    }
    let Ok(entries) = std::fs::read_dir(path) else {
        *skipped += 1;
        return 0;
    };
    entries
        .filter_map(|entry| match entry {
            Ok(entry) => Some(tree_bytes(&entry.path(), skipped)),
            Err(_) => {
                *skipped += 1;
                None
            }
        })
        .sum()
}
fn folder_files(path: &Path, paths: &mut Vec<PathBuf>, skipped: &mut u64) {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        *skipped += 1;
        return;
    };
    if metadata.file_type().is_symlink() {
        return;
    }
    if metadata.is_file() {
        paths.push(path.to_owned());
        return;
    }
    match std::fs::read_dir(path) {
        Ok(entries) => {
            for entry in entries {
                match entry {
                    Ok(entry) => folder_files(&entry.path(), paths, skipped),
                    Err(_) => *skipped += 1,
                }
            }
        }
        Err(_) => *skipped += 1,
    }
}
fn measure(app_dir: &Path, mut paths: Vec<PathBuf>, recording_dir: &Path) -> StorageUsage {
    let mut usage = StorageUsage::default();
    // Earlier Producer versions did not register recordings in local_recordings.
    // Include the actual output folder, including renamed files and subfolders.
    if recording_dir.exists() {
        folder_files(recording_dir, &mut paths, &mut usage.unreadable_entries);
    }
    usage.app_data_bytes = tree_bytes(app_dir, &mut usage.unreadable_entries);
    usage.total_bytes = usage.app_data_bytes;
    let app_dir = app_dir
        .canonicalize()
        .unwrap_or_else(|_| app_dir.to_owned());
    let mut seen = HashSet::new();
    for path in paths {
        let Ok(path) = path.canonicalize() else {
            usage.missing_recordings += 1;
            continue;
        };
        if !seen.insert(path.clone()) {
            continue;
        }
        match std::fs::metadata(&path) {
            Ok(metadata) if metadata.is_file() => {
                usage.recording_count += 1;
                usage.recording_bytes += metadata.len();
                if !path.starts_with(&app_dir) {
                    usage.total_bytes += metadata.len();
                }
            }
            _ => usage.unreadable_entries += 1,
        }
    }
    usage
}
#[tauri::command]
pub async fn producer_storage_usage(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> EngineResult<StorageUsage> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| EngineError::Other(e.to_string()))?;
    // Matches live/record.rs on engine and non-engine builds; reading creates no folders.
    let recording_dir = app
        .path()
        .home_dir()
        .map_err(|e| EngineError::Other(e.to_string()))?
        .join(if cfg!(target_os = "windows") {
            "Videos"
        } else {
            "Movies"
        })
        .join("Producer");
    let paths = {
        let db = state.db.lock().expect("db mutex poisoned");
        let mut query = db.prepare("SELECT DISTINCT path FROM local_recordings")?;
        let rows = query
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter().map(PathBuf::from).collect()
    };
    tauri::async_runtime::spawn_blocking(move || measure(&app_dir, paths, &recording_dir))
        .await
        .map_err(|e| EngineError::Other(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recordings_inside_app_data_are_counted_once_and_missing_paths_are_reported() {
        let root = std::env::temp_dir().join(format!("producer-storage-{}", uuid::Uuid::new_v4()));
        let app = root.join("app");
        std::fs::create_dir_all(&app).unwrap();
        let inside = app.join("clip.mp4");
        let outside = root.join("other.mp4");
        std::fs::write(&inside, [0; 20]).unwrap();
        std::fs::write(&outside, [0; 30]).unwrap();
        let result = measure(
            &app,
            vec![inside.clone(), inside, outside, root.join("missing")],
            &root.join("no-folder"),
        );
        assert_eq!(result.total_bytes, 50);
        assert_eq!(result.app_data_bytes, 20);
        assert_eq!(result.recording_bytes, 50);
        assert_eq!(result.recording_count, 2);
        assert_eq!(result.missing_recordings, 1);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn legacy_renamed_recordings_are_included_without_database_rows() {
        let root = std::env::temp_dir().join(format!("producer-storage-{}", uuid::Uuid::new_v4()));
        let app = root.join("app");
        let movies = root.join("Movies/Producer");
        std::fs::create_dir_all(&app).unwrap();
        std::fs::create_dir_all(movies.join("older")).unwrap();
        std::fs::write(app.join("db"), [0; 10]).unwrap();
        let tracked = movies.join("tracked.mp4");
        std::fs::write(&tracked, [0; 20]).unwrap();
        std::fs::write(movies.join("older/renamed.mp4"), [0; 30]).unwrap();
        let result = measure(&app, vec![tracked], &movies);
        assert_eq!(result.total_bytes, 60);
        assert_eq!(result.recording_bytes, 50);
        assert_eq!(result.recording_count, 2);
        std::fs::remove_dir_all(root).unwrap();
    }
}
