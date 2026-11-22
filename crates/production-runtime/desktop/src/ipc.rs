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
#[derive(serde::Deserialize)]
#[serde(tag="op", rename_all="camelCase",deny_unknown_fields)]
pub enum AssistantRequest {AssistantStatus,AssistantReview{generation:u64},AssistantStop{generation:u64},AssistantSend{prompt:String}}
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
pub struct RoomListener{listener:UnixListener,_owner:fs::File}
pub fn reserve(root:&Path)->Result<RoomListener>{
    use std::os::unix::fs::OpenOptionsExt;
    fs::create_dir_all(root)?;
    let owner=fs::OpenOptions::new().read(true).write(true).create(true).mode(0o600).open(root.join("studio.lock"))?;
    if unsafe{libc::flock(owner.as_raw_fd(),libc::LOCK_EX|libc::LOCK_NB)}!=0{bail!("This room is open in another studio");}
    let path = socket(root);
    if path.exists() {
        if UnixStream::connect(&path).is_ok() {
            bail!("The native dev room is already running");
        }
        fs::remove_file(&path)?;
    }
    let listener = UnixListener::bind(&path)?;
    listener.set_nonblocking(true)?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    Ok(RoomListener{listener,_owner:owner})
}
pub fn serve(reserved:RoomListener,handle:Arc<Handle>)->Result<()>{
    std::thread::Builder::new()
        .name("producer-room-ipc".into())
        .spawn(move || {
            let RoomListener{listener,_owner}=reserved;
            let active=Arc::new(std::sync::atomic::AtomicUsize::new(0));
            while !handle.closed.load(std::sync::atomic::Ordering::Acquire) {
                let mut stream=match listener.accept(){Ok((s,_))=>s,Err(e) if e.kind()==std::io::ErrorKind::WouldBlock=>{std::thread::sleep(Duration::from_millis(25));continue},Err(_)=>break};
                let _=stream.set_nonblocking(false);
                let mut uid = 0;
                let mut gid = 0;
                if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0
                    || uid != unsafe { libc::geteuid() }
                {
                    continue;
                }
                use std::sync::atomic::Ordering;
                if active.fetch_add(1,Ordering::AcqRel)>=16 {
                    active.fetch_sub(1,Ordering::Release);continue;
                }
                let count=active.clone();let handle=handle.clone();
                if std::thread::Builder::new().name("room-ipc-client".into()).spawn(move||{
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
                    if let Ok(command)=serde_json::from_slice::<AssistantRequest>(&bytes){
                        let (tx,rx)=std::sync::mpsc::sync_channel(1);
                        let mut queue=handle.assistant_requests.lock().unwrap();
                        anyhow::ensure!(queue.len()<16,"Assistant queue is full");
                        queue.push_back((command,tx,std::time::Instant::now()));
                        drop(queue);
                        return Ok(rx.recv_timeout(Duration::from_secs(4))?);
                    }
                    let command: RoomCommand = serde_json::from_slice(&bytes)?;
                    if matches!(
                        command,
                        RoomCommand::Imported { .. } | RoomCommand::ImportFailed { .. }
                    ) {
                        bail!("Native asset-import completions are internal");
                    }
                    match command {
                        RoomCommand::OperationOutcome{operation_id}=>Ok(serde_json::json!({"ok":true,"outcome":handle.journal.outcome(&operation_id)?})),
                        RoomCommand::RevokePermission{permission,permission_epoch,..}=>handle.journal.permission(&permission,permission_epoch,false),
                        RoomCommand::GrantPermission{permission,permission_epoch}=>handle.journal.permission(&permission,permission_epoch,true),
                        c=>handle.request(c)
                    }
                })();
                let reply = result
                    .unwrap_or_else(|e| serde_json::json!({"ok":false,"error":e.to_string()}));
                let _ = serde_json::to_writer(&mut stream, &reply);
                let _ = stream.write_all(b"\n");
                count.fetch_sub(1,Ordering::Release);
                }).is_err(){active.fetch_sub(1,Ordering::Release);}
            }
        })?;
    Ok(())
}
pub fn request(root: &Path, json: &str) -> Result<()> {
    if json.len() > MAX_REQUEST as usize {
        bail!("Control request too large");
    }
    if serde_json::from_str::<AssistantRequest>(json).is_err(){let _:RoomCommand=serde_json::from_str(json)?;}
    let mut stream = UnixStream::connect(socket(root))?;
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    stream.write_all(json.as_bytes())?;
    stream.shutdown(std::net::Shutdown::Write)?;
    let mut reply = String::new();
    stream.take(12 * 1024 * 1024).read_to_string(&mut reply)?;
    println!("{reply}");
    Ok(())
}
