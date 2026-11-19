//! UI/CLI file selection grants a bounded immutable snapshot; document JSON has no paths.
//! Copying runs in a killable helper so a disconnected device cannot hold the room thread.
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};
const LIMIT: u64 = 128 * 1024 * 1024;
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportedAsset {
    pub hash: String,
    pub bytes: u64,
    pub path: PathBuf,
}
pub fn import_worker(source: &Path, dest: &Path) -> Result<()> {
    let mut f = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(source)?;
    let before = f.metadata()?;
    if !before.is_file() || before.len() == 0 || before.len() > LIMIT {
        bail!("Select a local regular MOV up to 128 MiB");
    }
    let mut out = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(dest)?;
    let mut hash = Sha256::new();
    let mut bytes = 0u64;
    let mut buffer = [0u8; 65536];
    loop {
        let n = f.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        bytes += n as u64;
        if bytes > LIMIT {
            bail!("Asset grew beyond import budget");
        }
        hash.update(&buffer[..n]);
        out.write_all(&buffer[..n])?;
    }
    let after = f.metadata()?;
    if before.dev() != after.dev()
        || before.ino() != after.ino()
        || before.len() != bytes
        || after.len() != bytes
        || before.mtime() != after.mtime()
        || before.mtime_nsec() != after.mtime_nsec()
    {
        bail!("Asset changed while importing; select it again");
    }
    out.sync_all()?;
    println!(
        "{}",
        serde_json::to_string(&ImportedAsset {
            hash: format!("{:x}", hash.finalize()),
            bytes,
            path: dest.into()
        })?
    );
    Ok(())
}
pub fn import(source: &Path, root: &Path) -> Result<ImportedAsset> {
    fs::create_dir_all(root)?;
    fs::set_permissions(root, fs::Permissions::from_mode(0o700))?;
    let dest = root.join(format!(
        ".import-{}-{}.pending",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos()
    ));
    let stderr = File::create(root.join("last-import-error.txt"))?;
    let mut child = Command::new(std::env::current_exe()?)
        .arg("--import-worker")
        .arg(source)
        .arg(&dest)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(stderr)
        .spawn()?;
    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if start.elapsed() > Duration::from_secs(5) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = fs::remove_file(&dest);
            bail!("Import timed out; reconnect the drive and select the file again");
        }
        std::thread::sleep(Duration::from_millis(15));
    };
    let mut output = Vec::new();
    child
        .stdout
        .take()
        .context("import reply")?
        .take(2049)
        .read_to_end(&mut output)?;
    if !status.success() || output.len() > 2048 {
        let _ = fs::remove_file(&dest);
        bail!("Import refused; see last-import-error.txt in the dev asset cache");
    }
    let mut grant: ImportedAsset = serde_json::from_slice(&output)?;
    if grant.bytes > LIMIT
        || grant.path != dest
        || grant.hash.len() != 64
        || !grant.hash.bytes().all(|x| x.is_ascii_hexdigit())
    {
        let _ = fs::remove_file(&dest);
        bail!("Invalid asset grant reply");
    }
    let target = root.join(format!("{}.mov", grant.hash));
    if target.exists() {
        fs::remove_file(&dest)?;
    } else {
        fs::rename(&dest, &target)?;
        File::open(root)?.sync_all()?;
    }
    grant.path = target;
    Ok(grant)
}
