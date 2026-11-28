use anyhow::{ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};

const FEED_URL: &str = "https://producer.dev/updates/macos-arm64.json";
const REPO_RELEASES: &str = "https://github.com/Boomin-Ai/Producer/releases/download";
const MAX_FEED: usize = 4096;
const MAX_ARCHIVE: u64 = 512 * 1024 * 1024;
const REQUIREMENT: &str = "=anchor apple generic and identifier \"ai.boomin.producer\" and certificate leaf[subject.OU] = \"9936A69867\"";

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Release {
    pub version: String,
    length: u64,
    sha256: String,
    signature: String,
}

fn version(value: &str) -> Option<[u32; 3]> {
    let mut parts = value.split('.');
    let mut result = [0; 3];
    for item in &mut result {
        let part = parts.next()?;
        *item = part.parse().ok()?;
        if item.to_string() != part {
            return None;
        }
    }
    parts.next().is_none().then_some(result)
}

impl Release {
    fn newer(bytes: &[u8], installed: &str) -> Result<Option<Self>> {
        let release: Self = serde_json::from_slice(bytes).context("Invalid update feed")?;
        let offered = version(&release.version).context("Invalid update version")?;
        let installed = version(installed).context("Invalid installed version")?;
        ensure!(
            (1..=MAX_ARCHIVE).contains(&release.length),
            "Invalid update size"
        );
        ensure!(
            release.sha256.len() == 64 && release.sha256.bytes().all(|b| b.is_ascii_hexdigit()),
            "Invalid update checksum"
        );
        release.signature()?;
        Ok((offered > installed).then_some(release))
    }

    fn archive_url(&self) -> String {
        let version = &self.version;
        format!("{REPO_RELEASES}/native-silicon-{version}/Producer_{version}_aarch64.app.tar.gz")
    }

    fn signature(&self) -> Result<Signature> {
        let bytes = STANDARD.decode(&self.signature)?;
        Signature::decode(std::str::from_utf8(&bytes)?).context("Invalid update signature")
    }
}

fn key() -> Result<PublicKey> {
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../../../../src-tauri/tauri.conf.json"))?;
    let encoded = config["plugins"]["updater"]["pubkey"]
        .as_str()
        .context("Missing Producer updater key")?;
    let bytes = STANDARD.decode(encoded)?;
    PublicKey::decode(std::str::from_utf8(&bytes)?).context("Invalid Producer updater key")
}

pub(super) struct Client {
    runtime: tokio::runtime::Runtime,
    http: reqwest::Client,
}

impl Client {
    pub fn new() -> Result<Self> {
        Ok(Self {
            runtime: tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?,
            http: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(5))
                .redirect(reqwest::redirect::Policy::custom(|attempt| {
                    let url = attempt.url();
                    if attempt.previous().len() < 4
                        && url.scheme() == "https"
                        && matches!(
                            url.host_str(),
                            Some(
                                "release-assets.githubusercontent.com"
                                    | "github-releases.githubusercontent.com"
                            )
                        )
                    {
                        attempt.follow()
                    } else {
                        attempt.error("Unexpected update redirect")
                    }
                }))
                .build()?,
        })
    }

    pub fn check(&self, installed: &str) -> Result<Option<Release>> {
        self.runtime.block_on(async {
            let mut response = self
                .http
                .get(FEED_URL)
                .timeout(Duration::from_secs(8))
                .header(reqwest::header::CACHE_CONTROL, "no-cache")
                .send()
                .await?
                .error_for_status()?;
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await? {
                ensure!(
                    bytes.len() + chunk.len() <= MAX_FEED,
                    "Update feed is too large"
                );
                bytes.extend_from_slice(&chunk);
            }
            Release::newer(&bytes, installed)
        })
    }

    pub fn prepare(&self, app: &Path, release: &Release) -> Result<Prepared> {
        let parent = app
            .parent()
            .context("Missing Producer installation folder")?;
        let stage = tempfile::Builder::new()
            .prefix(".producer-update-")
            .tempdir_in(parent)
            .context("Producer cannot stage an update beside the installed app")?;
        let archive = stage.path().join("update.tar.gz");
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&archive)?;
        let key = key()?;
        let sig = release.signature()?;
        let mut verify = key.verify_stream(&sig)?;
        let mut hash = Sha256::new();
        self.runtime.block_on(async {
            let mut response = self
                .http
                .get(release.archive_url())
                .timeout(Duration::from_secs(600))
                .send()
                .await?
                .error_for_status()?;
            if let Some(length) = response.content_length() {
                ensure!(
                    length == release.length,
                    "Update download size differs from the release"
                );
            }
            let mut remaining = release.length;
            while let Some(chunk) = response.chunk().await? {
                remaining = remaining
                    .checked_sub(chunk.len() as u64)
                    .context("Update download is too large")?;
                verify.update(&chunk);
                hash.update(&chunk);
                file.write_all(&chunk)?;
            }
            ensure!(remaining == 0, "Update download is incomplete");
            verify
                .finalize()
                .context("Update signature verification failed")?;
            ensure!(
                format!("{:x}", hash.finalize()).eq_ignore_ascii_case(&release.sha256),
                "Update checksum mismatch"
            );
            Ok::<_, anyhow::Error>(())
        })?;
        file.sync_all()?;
        drop(file);
        unpack(&archive, stage.path(), &release.version)?;
        fs::remove_file(archive)?;
        Ok(Prepared {
            stage,
            app: app.to_owned(),
            version: release.version.clone(),
        })
    }
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub(super) fn installed_app() -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        return None;
    }
    let exe = std::env::current_exe().ok()?;
    let contents = exe.parent()?.parent()?;
    let app = contents.parent()?;
    (exe.file_name()? == "producer"
        && exe.parent()?.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && app.extension()? == "app"
        && bundle_field(app, "CFBundleIdentifier").ok().as_deref() == Some("ai.boomin.producer")
        && bundle_field(app, "CFBundleShortVersionString")
            .ok()
            .as_deref()
            == Some(env!("CARGO_PKG_VERSION")))
    .then(|| app.to_owned())
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
pub(super) fn installed_app() -> Option<PathBuf> {
    None
}

fn bundle_field(app: &Path, name: &str) -> Result<String> {
    let result = Command::new("/usr/bin/plutil")
        .args(["-extract", name, "raw"])
        .arg(app.join("Contents/Info.plist"))
        .output()?;
    ensure!(
        result.status.success(),
        "Missing {name} in the update bundle"
    );
    Ok(String::from_utf8(result.stdout)?.trim().to_owned())
}

fn command(program: &str) -> Command {
    let mut command = Command::new(program);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

fn unpack(archive: &Path, folder: &Path, expected: &str) -> Result<()> {
    // The archive enters this function only after verification against the embedded Producer key.
    ensure!(
        command("/usr/bin/tar")
            .arg("-xzf")
            .arg(archive)
            .arg("-C")
            .arg(folder)
            .status()?
            .success(),
        "Could not unpack the signed update"
    );
    let app = folder.join("Producer.app");
    ensure!(
        fs::symlink_metadata(&app)?.file_type().is_dir(),
        "Missing Producer app in the update"
    );
    ensure!(
        bundle_field(&app, "CFBundleShortVersionString")? == expected,
        "Update bundle version mismatch"
    );
    ensure!(
        command("/usr/bin/codesign")
            .args(["--verify", "--strict", "--deep", "-R", REQUIREMENT])
            .arg(&app)
            .status()?
            .success(),
        "Update bundle failed Apple signature verification"
    );
    ensure!(
        command("/usr/sbin/spctl")
            .args(["--assess", "--type", "execute"])
            .arg(&app)
            .status()?
            .success(),
        "macOS could not verify the update's notarization"
    );
    Ok(())
}

pub(super) struct Prepared {
    stage: tempfile::TempDir,
    app: PathBuf,
    pub version: String,
}

impl Prepared {
    /// Retain the old bundle in the private staging folder through orderly app shutdown.
    #[cfg(target_os = "macos")]
    pub fn install(&self) -> Result<()> {
        use std::os::{fd::AsRawFd, unix::fs::MetadataExt};
        let bundle = fs::File::open(&self.app)?;
        if unsafe { libc::flock(bundle.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(std::io::Error::last_os_error())
                .context("Producer is already being updated");
        }
        let locked = bundle.metadata()?;
        let current = fs::symlink_metadata(&self.app)?;
        ensure!(
            current.is_dir() && locked.dev() == current.dev() && locked.ino() == current.ino(),
            "The installed app changed while preparing the update"
        );
        let installed = bundle_field(&self.app, "CFBundleShortVersionString")?;
        ensure!(
            version(&self.version)
                .zip(version(&installed))
                .is_some_and(|(new, old)| new > old),
            "A newer version of Producer is already installed"
        );
        swap(&self.stage.path().join("Producer.app"), &self.app)
    }

    #[cfg(not(target_os = "macos"))]
    pub fn install(&self) -> Result<()> {
        anyhow::bail!("Native updates require macOS")
    }
}

#[cfg(target_os = "macos")]
fn swap(staged: &Path, installed: &Path) -> Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let staged = CString::new(staged.as_os_str().as_bytes())?;
    let installed = CString::new(installed.as_os_str().as_bytes())?;
    if unsafe { libc::renamex_np(staged.as_ptr(), installed.as_ptr(), libc::RENAME_SWAP) } != 0 {
        return Err(std::io::Error::last_os_error())
            .context("macOS could not replace the installed Producer app");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const FEED: &[u8] = include_bytes!("../../../../site/updates/macos-arm64.json");

    #[test]
    fn rejects_rollback_and_malformed_manifests() {
        let release = Release::newer(FEED, "0.0.0").unwrap().unwrap();
        assert!(Release::newer(FEED, &release.version).unwrap().is_none());
        assert!(Release::newer(FEED, "10.0.0").unwrap().is_none());
        assert!(release.archive_url().starts_with(REPO_RELEASES));

        let fixture: serde_json::Value = serde_json::from_slice(FEED).unwrap();
        for (field, invalid) in [
            ("version", serde_json::json!("../0.6.0")),
            ("version", serde_json::json!("0.05.2")),
            ("length", serde_json::json!(MAX_ARCHIVE + 1)),
            ("sha256", serde_json::json!("bad hash")),
            ("signature", serde_json::json!("not a signature")),
        ] {
            let mut broken = fixture.clone();
            broken[field] = invalid;
            assert!(Release::newer(&serde_json::to_vec(&broken).unwrap(), "0.0.0").is_err());
        }
        assert!(version("0.5.10").unwrap() > version("0.5.2").unwrap());
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    #[ignore = "downloads and checks a signed public Apple Silicon release"]
    fn public_archive_upgrades_an_isolated_bundle() -> Result<()> {
        let old_version = "0.0.0";
        let release = Release::newer(FEED, old_version)?.unwrap();
        let folder = tempfile::tempdir()?;
        let app = folder.path().join("Producer.app");
        fs::create_dir_all(app.join("Contents"))?;
        fs::write(
            app.join("Contents/Info.plist"),
            format!("<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>CFBundleShortVersionString</key><string>{old_version}</string></dict></plist>"),
        )?;
        let prepared = Client::new()?.prepare(&app, &release)?;
        assert_eq!(
            bundle_field(&app, "CFBundleShortVersionString")?,
            old_version
        );
        prepared.install()?;
        assert_eq!(
            bundle_field(&app, "CFBundleShortVersionString")?,
            release.version
        );
        assert_eq!(
            bundle_field(
                &prepared.stage.path().join("Producer.app"),
                "CFBundleShortVersionString"
            )?,
            old_version
        );
        assert!(
            prepared.install().is_err(),
            "a second install must leave the newer bundle in place"
        );
        Ok(())
    }
}
