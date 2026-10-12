//! Real hosted subscription ownership proof, without OBS/device capture.
//! Retains authorized SDK tracks only; does not claim rendering or AV timing.
#[path = "../../../src-tauri/src/rtc_control.rs"]
mod rtc_control;
#[path = "../../../src-tauri/src/rtc_owner.rs"]
mod rtc_owner;
use livekit::prelude::RemoteTrack;
use producer_guest_runtime::{
    authority::{Permission, Snapshot},
    GuestMedia,
};
use producer_guest_session::PublishSource;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
#[derive(Default)]
struct Counts {
    camera: AtomicU64,
    mic: AtomicU64,
    retired: AtomicU64,
    alive: AtomicU64,
    closed: AtomicU64,
}
struct Binding {
    permission: Permission,
    source: PublishSource,
    _track: RemoteTrack,
}
struct Sink {
    counts: Arc<Counts>,
    bindings: HashMap<String, Binding>,
    closed: bool,
}
impl GuestMedia for Sink {
    fn can_receive(&self, _: &Permission, source: PublishSource) -> bool {
        matches!(source, PublishSource::Camera | PublishSource::Microphone)
    }
    fn reconcile(&mut self, authority: Option<&Snapshot>, now: Instant) {
        let mut retired = Vec::new();
        for (sid, b) in &mut self.bindings {
            if let Some(p) =
                authority.and_then(|s| s.permission(b.permission.rtc_identity(), b.source, now))
            {
                b.permission = p.clone();
            } else {
                retired.push(sid.clone());
            }
        }
        for sid in retired {
            self.detach(&sid);
        }
    }
    fn attach(
        &mut self,
        permission: &Permission,
        source: PublishSource,
        sid: &str,
        track: RemoteTrack,
    ) -> Result<(), &'static str> {
        if !self.bindings.contains_key(sid) {
            match source {
                PublishSource::Camera => {
                    self.counts.camera.fetch_add(1, Ordering::Relaxed);
                }
                PublishSource::Microphone => {
                    self.counts.mic.fetch_add(1, Ordering::Relaxed);
                }
                _ => return Err("Unsupported probe source"),
            }
            self.counts.alive.fetch_add(1, Ordering::Relaxed);
        }
        self.bindings.insert(
            sid.to_owned(),
            Binding {
                permission: permission.clone(),
                source,
                _track: track,
            },
        );
        Ok(())
    }
    fn detach(&mut self, sid: &str) {
        if self.bindings.remove(sid).is_some() {
            self.counts.retired.fetch_add(1, Ordering::Relaxed);
            self.counts.alive.fetch_sub(1, Ordering::Relaxed);
        }
    }
    fn close(&mut self) {
        let sids: Vec<_> = self.bindings.keys().cloned().collect();
        for sid in sids {
            self.detach(&sid);
        }
        if !self.closed {
            self.closed = true;
            self.counts.closed.fetch_add(1, Ordering::Relaxed);
        }
    }
}
impl Drop for Sink {
    fn drop(&mut self) {
        self.close();
    }
}
fn write(counts: &Counts, passed: Option<bool>, error: Option<&'static str>) {
    use std::{io::Write, os::unix::fs::OpenOptionsExt};
    let value = serde_json::json!({"camera_attached":counts.camera.load(Ordering::Relaxed),"microphone_attached":counts.mic.load(Ordering::Relaxed),
        "retired":counts.retired.load(Ordering::Relaxed),"alive":counts.alive.load(Ordering::Relaxed),"sink_closed":counts.closed.load(Ordering::Relaxed),
        "passed":passed,"error":error,"obs_rendering_qualified":false,"capture_devices_used":false});
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open("/private/tmp/producer-rtc-staging/native-subscription-owner-result.json")
    {
        let _ = file.write_all(value.to_string().as_bytes());
    }
}
fn main() {
    let counts = Arc::new(Counts::default());
    let result = (|| -> Result<(), &'static str> {
        let bytes = std::fs::read("/private/tmp/producer-rtc-staging/operator.json")
            .map_err(|_| "Operator profile unavailable")?;
        if bytes.len() > 32768 {
            return Err("Operator profile too large");
        }
        let operator = serde_json::from_slice(&bytes).map_err(|_| "Invalid operator profile")?;
        let runtime = tokio::runtime::Runtime::new().map_err(|_| "Runtime unavailable")?;
        runtime.block_on(async {
            let mut owner = rtc_owner::HostOwner::start_with_media(
                rtc_control::Control::new(operator)?,
                Box::new(Sink {
                    counts: counts.clone(),
                    bindings: HashMap::new(),
                    closed: false,
                }),
            )
            .await?;
            let lifetime = owner.task_lifetime();
            let until = Instant::now() + Duration::from_secs(60);
            while Instant::now() < until {
                write(&counts, None, None);
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            owner.close().await?;
            if lifetime.strong_count() != 0
                || counts.alive.load(Ordering::Relaxed) != 0
                || counts.closed.load(Ordering::Relaxed) != 1
            {
                return Err("Subscription owner did not retire");
            }
            Ok(())
        })
    })();
    write(
        &counts,
        Some(result.is_ok()),
        result.as_ref().err().copied(),
    );
    if result.is_err() {
        std::process::exit(1);
    }
}
