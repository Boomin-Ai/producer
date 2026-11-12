//! The owned, offline starter library. Import is additive and never connects
//! every effect to a room or changes playback. No decoder runs at startup.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, path::Path, sync::Mutex};
use tauri::Manager;
static INSTALL: Mutex<()> = Mutex::new(());

#[derive(Deserialize)]
struct Manifest {
    schema: String,
    version: String,
    assets: Vec<Asset>,
}
#[derive(Deserialize)]
struct Asset {
    id: String,
    kind: String,
    name: String,
    file: String,
    sha256: String,
    bytes: u64,
    duration_ms: u64,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct InstalledAudio {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub path: String,
    pub sha256: String,
    pub duration_ms: u64,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Receipt {
    version: String,
    pub assets: Vec<InstalledAudio>,
}

fn checked(root: &Path, asset: &Asset) -> Result<Vec<u8>, String> {
    if !matches!(asset.kind.as_str(), "music" | "effect")
        || asset.name.is_empty()
        || asset.name.len() > 160
        || asset.bytes == 0
        || asset.bytes > 32 * 1024 * 1024
        || asset.sha256.len() != 64
        || !asset.sha256.bytes().all(|c| c.is_ascii_hexdigit())
        || asset.id.is_empty()
        || !asset
            .id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
    {
        return Err("Invalid starter audio metadata".into());
    }
    let path = root
        .join(&asset.file)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !path.starts_with(root) || path.extension().and_then(|v| v.to_str()) != Some("mp3") {
        return Err("Invalid starter audio path".into());
    }
    if path.metadata().map_err(|e| e.to_string())?.len() != asset.bytes {
        return Err("Starter audio size mismatch".into());
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    if hex::encode(Sha256::digest(&bytes)) != asset.sha256 {
        return Err("Starter audio checksum mismatch".into());
    }
    Ok(bytes)
}

fn install(app: &tauri::AppHandle) -> Result<Receipt, String> {
    let _lock = INSTALL.lock().map_err(|e| e.to_string())?;
    let root = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("starter-audio")
        .canonicalize()
        .map_err(|_| "Starter audio is missing from this build")?;
    let raw = std::fs::read(root.join("manifest.json")).map_err(|e| e.to_string())?;
    if raw.len() > 256 * 1024 {
        return Err("Starter audio manifest is too large".into());
    }
    let manifest: Manifest = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
    let mut ids = HashSet::new();
    if manifest.schema != "producer.audio-library/1"
        || manifest.version.is_empty()
        || manifest.version.len() > 64
        || manifest.assets.is_empty()
        || manifest.assets.len() > 500
        || manifest.assets.iter().any(|a| !ids.insert(&a.id))
    {
        return Err("Invalid starter audio manifest".into());
    }
    let cache = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("starter-audio");
    std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    let receipt_path = cache.join("installed.json");
    if let Ok(raw) = std::fs::read(&receipt_path) {
        if let Ok(receipt) = serde_json::from_slice::<Receipt>(&raw) {
            if receipt.version == manifest.version
                && receipt.assets.iter().all(|a| Path::new(&a.path).is_file())
            {
                return Ok(receipt);
            }
        }
    }
    let mut assets = Vec::new();
    for asset in manifest.assets {
        let bytes = checked(&root, &asset)?;
        let path = cache.join(format!("{}.mp3", asset.sha256));
        let intact = std::fs::read(&path)
            .is_ok_and(|existing| hex::encode(Sha256::digest(existing)) == asset.sha256);
        if !intact {
            let temp = path.with_extension("tmp");
            std::fs::write(&temp, bytes).map_err(|e| e.to_string())?;
            std::fs::rename(temp, &path).map_err(|e| e.to_string())?;
        }
        assets.push(InstalledAudio {
            id: asset.id,
            kind: asset.kind,
            name: asset.name,
            path: path.to_string_lossy().into(),
            sha256: asset.sha256,
            duration_ms: asset.duration_ms,
        });
    }
    crate::dj::install_bundled(app, &mut assets)?;
    crate::soundboard::install_bundled(app, &assets)?;
    let receipt = Receipt {
        version: manifest.version,
        assets,
    };
    let temp = receipt_path.with_extension("tmp");
    std::fs::write(
        &temp,
        serde_json::to_vec(&receipt).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(temp, receipt_path).map_err(|e| e.to_string())?;
    Ok(receipt)
}

#[tauri::command]
pub async fn starter_audio_install(app: tauri::AppHandle) -> Result<Receipt, String> {
    tauri::async_runtime::spawn_blocking(move || install(&app))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bundled_metadata_and_bytes_are_checked() {
        let root = std::env::temp_dir().join(format!("producer-audio-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("test.mp3"), b"test").unwrap();
        let mut asset = Asset {
            id: "effect-one".into(),
            kind: "effect".into(),
            name: "Test".into(),
            file: "test.mp3".into(),
            sha256: hex::encode(Sha256::digest(b"test")),
            bytes: 4,
            duration_ms: 100,
        };
        assert!(checked(&root, &asset).is_ok());
        asset.bytes = 5;
        assert!(checked(&root, &asset).is_err());
        asset.bytes = 4;
        asset.sha256 = "0".repeat(64);
        assert!(checked(&root, &asset).is_err());
        asset.file = "../outside.mp3".into();
        assert!(checked(&root, &asset).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
