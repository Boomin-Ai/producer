//! Local, same-user, bounded control path used by both CLI and the native operator UI.
use crate::engine::{Handle, RoomCommand};
use anyhow::{bail, Result};
use std::{
    fs,
    io::{Read, Write},
    os::unix::{
        fs::PermissionsExt,
        io::AsRawFd,
        net::{UnixListener, UnixStream},
    },
    path::Path,
    sync::Arc,
    time::Duration,
};
const MAX_REQUEST: u64 = 256 * 1024;
fn socket(root: &Path) -> std::path::PathBuf {
    use sha2::{Digest, Sha256};
    let hash = format!("{:x}", Sha256::digest(root.as_os_str().as_encoded_bytes()));
    std::path::PathBuf::from(format!(
        "/tmp/producer-native-{}-{}.sock",
        unsafe { libc::geteuid() },
        &hash[..12]
    ))
}
pub fn serve(root: &Path, handle: Arc<Handle>) -> Result<()> {
    let path = socket(root);
    if path.exists() {
        if UnixStream::connect(&path).is_ok() {
            bail!("The native dev room is already running");
        }
        fs::remove_file(&path)?;
    }
    let listener = UnixListener::bind(&path)?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    std::thread::Builder::new()
        .name("producer-room-ipc".into())
        .spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else {
                    break;
                };
                let mut uid = 0;
                let mut gid = 0;
                if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0
                    || uid != unsafe { libc::geteuid() }
                {
                    continue;
                }
                let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
                let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
                let mut bytes = Vec::new();
                let result = (|| -> Result<serde_json::Value> {
                    Read::by_ref(&mut stream)
                        .take(MAX_REQUEST + 1)
                        .read_to_end(&mut bytes)?;
                    if bytes.len() as u64 > MAX_REQUEST {
                        bail!("Control request too large");
                    }
                    let command: RoomCommand = serde_json::from_slice(&bytes)?;
                    if matches!(
                        command,
                        RoomCommand::Imported { .. } | RoomCommand::ImportFailed { .. }
                    ) {
                        bail!("Native asset-import completions are internal");
                    }
                    handle.request(command)
                })();
                let reply = result
                    .unwrap_or_else(|e| serde_json::json!({"ok":false,"error":e.to_string()}));
                let _ = serde_json::to_writer(&mut stream, &reply);
                let _ = stream.write_all(b"\n");
            }
        })?;
    Ok(())
}
pub fn request(root: &Path, json: &str) -> Result<()> {
    if json.len() > MAX_REQUEST as usize {
        bail!("Control request too large");
    }
    let _: RoomCommand = serde_json::from_str(json)?;
    let mut stream = UnixStream::connect(socket(root))?;
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    stream.write_all(json.as_bytes())?;
    stream.shutdown(std::net::Shutdown::Write)?;
    let mut reply = String::new();
    stream.take(12 * 1024 * 1024).read_to_string(&mut reply)?;
    println!("{reply}");
    Ok(())
}
