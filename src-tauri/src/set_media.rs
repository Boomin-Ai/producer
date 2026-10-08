//! File-backed reaction clips: opaque saved references and bounded HTTP range reads.
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{Read, Seek, SeekFrom, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
};
use tauri::Manager;
#[derive(Clone, Serialize, Deserialize)]
struct FileEntry {
    path: PathBuf,
    name: String,
    mime: String,
}
struct Registry {
    files: Mutex<HashMap<String, FileEntry>>,
    store: PathBuf,
    origin: String,
    token: String,
}
static REGISTRY: OnceLock<Arc<Registry>> = OnceLock::new();
#[derive(Serialize)]
pub struct Imported {
    pub name: String,
    pub mime: String,
    pub data: String,
}
pub fn init(app: &tauri::AppHandle) -> Result<(), String> {
    if REGISTRY.get().is_some() {
        return Ok(());
    }
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let store = root.join("set-media-files.json");
    let files = std::fs::read(&store)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let origin = format!(
        "http://{}",
        listener.local_addr().map_err(|e| e.to_string())?
    );
    let registry = Arc::new(Registry {
        files: Mutex::new(files),
        store,
        origin,
        token: uuid::Uuid::new_v4().to_string(),
    });
    REGISTRY
        .set(registry.clone())
        .map_err(|_| "Media registry already started")?;
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let r = registry.clone();
            std::thread::spawn(move || {
                let _ = r.serve(stream);
            });
        }
    });
    Ok(())
}
fn reference_id(data: &str) -> Result<&str, String> {
    let id = data
        .strip_prefix("producer-media:")
        .ok_or("Invalid local media reference")?;
    uuid::Uuid::parse_str(id).map_err(|_| "Invalid local media ID")?;
    Ok(id)
}
pub fn validate(data: &str, mime: &str) -> Result<(), String> {
    let id = reference_id(data)?;
    let r = REGISTRY.get().ok_or("Local media service unavailable")?;
    let files = r.files.lock().unwrap();
    let e = files
        .get(id)
        .ok_or("Local clip is not linked on this computer. Load the file again.")?;
    if e.mime != mime {
        return Err("Local clip type differs from its reference".into());
    }
    if !e.path.is_file() {
        return Err(format!("{} is missing. Load the file again.", e.name));
    }
    Ok(())
}
#[tauri::command]
pub fn set_media_resolve(id: String) -> Result<String, String> {
    let key = reference_id(&id)?;
    let r = REGISTRY.get().ok_or("Local media service unavailable")?;
    let files = r.files.lock().unwrap();
    let e = files
        .get(key)
        .ok_or("Local clip is not linked on this computer. Load the file again.")?;
    if !e.path.is_file() {
        return Err(format!("{} is missing. Load the file again.", e.name));
    }
    Ok(format!("{}/{}/{}", r.origin, r.token, key))
}
#[tauri::command]
pub async fn set_media_import(app: tauri::AppHandle) -> Result<Option<Imported>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter(
            "Reaction media",
            &[
                "mp4", "webm", "mov", "m4v", "png", "jpg", "jpeg", "webp", "gif",
            ],
        )
        .pick_file(move |p| {
            let _ = tx.send(p);
        });
    let Some(file) = rx.await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let path = file
        .into_path()
        .map_err(|e| e.to_string())?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    register(path).map(Some)
}
fn register(path: PathBuf) -> Result<Imported, String> {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mime = match ext.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => return Err("Unsupported reaction media format".into()),
    };
    if !path.is_file() {
        return Err("Choose a regular media file".into());
    }
    let name = path
        .file_name()
        .unwrap()
        .to_string_lossy()
        .chars()
        .take(160)
        .collect::<String>();
    let id = uuid::Uuid::new_v4().to_string();
    let r = REGISTRY.get().ok_or("Local media service unavailable")?;
    let mut files = r.files.lock().unwrap();
    files.insert(
        id.clone(),
        FileEntry {
            path,
            name: name.clone(),
            mime: mime.into(),
        },
    );
    let temporary = r.store.with_extension("tmp");
    std::fs::write(
        &temporary,
        serde_json::to_vec(&*files).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(temporary, &r.store).map_err(|e| e.to_string())?;
    Ok(Imported {
        name,
        mime: mime.into(),
        data: format!("producer-media:{id}"),
    })
}
fn byte_range(header: Option<&str>, len: u64) -> Option<(u64, u64)> {
    if len == 0 {
        return None;
    }
    let Some(s) = header else {
        return Some((0, len - 1));
    };
    let (a, b) = s.strip_prefix("bytes=")?.split_once('-')?;
    if a.is_empty() {
        let tail = b.parse::<u64>().ok()?.min(len);
        return (tail > 0).then_some((len - tail, len - 1));
    }
    let start = a.parse::<u64>().ok()?;
    let end = if b.is_empty() {
        len - 1
    } else {
        b.parse::<u64>().ok()?.min(len - 1)
    };
    (start <= end && start < len).then_some((start, end))
}
impl Registry {
    fn serve(&self, mut stream: TcpStream) -> std::io::Result<()> {
        stream.set_read_timeout(Some(std::time::Duration::from_secs(5)))?;
        stream.set_write_timeout(Some(std::time::Duration::from_secs(20)))?;
        let mut bytes = Vec::new();
        let mut buf = [0u8; 2048];
        while !bytes.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = stream.read(&mut buf)?;
            if n == 0 || bytes.len() + n > 16384 {
                return Ok(());
            }
            bytes.extend_from_slice(&buf[..n]);
        }
        let request = String::from_utf8_lossy(&bytes);
        let mut lines = request.split("\r\n");
        let parts = lines
            .next()
            .unwrap_or("")
            .split_whitespace()
            .collect::<Vec<_>>();
        let (mut host, mut range) = (None, None);
        for line in lines {
            if let Some((key, value)) = line.split_once(':') {
                if key.eq_ignore_ascii_case("host") {
                    host = Some(value.trim());
                }
                if key.eq_ignore_ascii_case("range") {
                    range = Some(value.trim());
                }
            }
        }
        let prefix = format!("/{}/", self.token);
        let entry = if parts.len() == 3
            && ["GET", "HEAD"].contains(&parts[0])
            && host == Some(self.origin.trim_start_matches("http://"))
        {
            parts[1]
                .strip_prefix(&prefix)
                .and_then(|id| self.files.lock().unwrap().get(id).cloned())
        } else {
            None
        };
        let Some(e) = entry else {
            stream.write_all(
                b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            )?;
            return Ok(());
        };
        let Ok(mut file) = std::fs::File::open(e.path) else {
            return Ok(());
        };
        let len = file.metadata()?.len();
        let Some((start, end)) = byte_range(range, len) else {
            write!(stream,"HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{len}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")?;
            return Ok(());
        };
        let partial = range.is_some();
        let status = if partial {
            "206 Partial Content"
        } else {
            "200 OK"
        };
        write!(stream,"HTTP/1.1 {status}\r\nContent-Type: {}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-store\r\nConnection: close\r\n",e.mime,end-start+1)?;
        if partial {
            write!(stream, "Content-Range: bytes {start}-{end}/{len}\r\n")?;
        }
        stream.write_all(b"\r\n")?;
        if parts[0] == "HEAD" {
            return Ok(());
        }
        file.seek(SeekFrom::Start(start))?;
        std::io::copy(&mut file.take(end - start + 1), &mut stream)?;
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ranges() {
        assert_eq!(byte_range(None, 100), Some((0, 99)));
        assert_eq!(byte_range(Some("bytes=20-39"), 100), Some((20, 39)));
        assert_eq!(byte_range(Some("bytes=90-"), 100), Some((90, 99)));
        assert_eq!(byte_range(Some("bytes=-10"), 100), Some((90, 99)));
        assert_eq!(byte_range(Some("bytes=100-"), 100), None);
        assert_eq!(byte_range(Some("bytes=0-1,3-4"), 100), None);
    }
    #[test]
    fn saved_references_are_opaque() {
        assert!(reference_id("producer-media:../../etc/passwd").is_err());
        assert!(reference_id("https://example.com/clip.mp4").is_err());
    }
}

#[cfg(test)]
mod http_tests {
    use super::*;
    #[test]
    fn seeks_large_file_without_embedding() {
        let path = std::env::temp_dir().join(format!("producer-range-{}", uuid::Uuid::new_v4()));
        let mut file = std::fs::File::create(&path).unwrap();
        let length = 64 * 1024 * 1024;
        file.set_len(length).unwrap();
        file.seek(SeekFrom::Start(length - 4)).unwrap();
        file.write_all(b"tail").unwrap();
        drop(file);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let registry = Registry {
            files: Mutex::new(HashMap::from([(
                "clip".into(),
                FileEntry {
                    path: path.clone(),
                    name: "test".into(),
                    mime: "video/mp4".into(),
                },
            )])),
            store: path.clone(),
            origin: format!("http://{address}"),
            token: "test-token".into(),
        };
        let worker =
            std::thread::spawn(move || registry.serve(listener.accept().unwrap().0).unwrap());
        let mut client = TcpStream::connect(address).unwrap();
        write!(
            client,
            "GET /test-token/clip HTTP/1.1\r\nHost: {address}\r\nRange: bytes=-4\r\n\r\n"
        )
        .unwrap();
        let mut response = String::new();
        client.read_to_string(&mut response).unwrap();
        worker.join().unwrap();
        std::fs::remove_file(path).unwrap();
        assert!(response.starts_with("HTTP/1.1 206"));
        assert!(response.contains(&format!(
            "Content-Range: bytes {}-{}/{length}",
            length - 4,
            length - 1
        )));
        assert!(response.ends_with("\r\n\r\ntail"));
        assert!(response.len() < 500);
    }
}
