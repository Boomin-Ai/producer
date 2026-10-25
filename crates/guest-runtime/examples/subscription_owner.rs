//! Real hosted subscription ownership proof, without OBS/device capture.
//! Retains authorized SDK tracks only; does not claim rendering or AV timing.
#[cfg(feature = "obs-proof")]
#[path = "support/obs_scene.rs"]
mod obs_scene;
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
    receiver: Option<producer_guest_runtime::media::Receiver>,
}
impl GuestMedia for Sink {
    fn can_receive(&self, permission: &Permission, source: PublishSource) -> bool {
        matches!(source, PublishSource::Camera | PublishSource::Microphone)
            && self
                .receiver
                .as_ref()
                .is_none_or(|receiver| receiver.can_receive(permission, source))
    }
    fn reconcile(&mut self, authority: Option<&Snapshot>, now: Instant) {
        if let Some(receiver) = &mut self.receiver {
            receiver.reconcile(authority, now);
        }
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
        if let Some(receiver) = &mut self.receiver {
            receiver.attach(permission, source, sid, track.clone())?;
        }
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
        if let Some(receiver) = &mut self.receiver {
            receiver.detach(sid);
        }
        if self.bindings.remove(sid).is_some() {
            self.counts.retired.fetch_add(1, Ordering::Relaxed);
            self.counts.alive.fetch_sub(1, Ordering::Relaxed);
        }
    }
    fn close(&mut self) {
        if let Some(receiver) = &mut self.receiver {
            receiver.close();
        }
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
fn write(
    counts: &Counts,
    media: Option<&producer_guest_runtime::media::Counters>,
    passed: Option<bool>,
    error: Option<&'static str>,
) {
    use std::{io::Write, os::unix::fs::OpenOptionsExt};
    let value = serde_json::json!({"camera_attached":counts.camera.load(Ordering::Relaxed),"microphone_attached":counts.mic.load(Ordering::Relaxed),
        "retired":counts.retired.load(Ordering::Relaxed),"alive":counts.alive.load(Ordering::Relaxed),"sink_closed":counts.closed.load(Ordering::Relaxed),
        "passed":passed,"error":error,"decoded_media":media.map(|m|m.report()),"obs_endpoint_used":cfg!(feature="obs-proof"),"obs_rendering_qualified":false,"capture_devices_used":false});
    const REPORT: &str = "/private/tmp/producer-rtc-staging/native-subscription-owner-result.json";
    const PENDING: &str =
        "/private/tmp/producer-rtc-staging/native-subscription-owner-result.pending";
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(PENDING)
    {
        if file.write_all(value.to_string().as_bytes()).is_ok() {
            // Concurrent proof reads must observe one whole snapshot. Direct
            // truncation can turn a passing media run into a JSON parse failure.
            drop(file);
            let _ = std::fs::rename(PENDING, REPORT);
        }
    }
}
fn main() {
    let counts = Arc::new(Counts::default());
    let mut media = None;
    let result = (|| -> Result<(), &'static str> {
        let bytes = std::fs::read("/private/tmp/producer-rtc-staging/operator.json")
            .map_err(|_| "Operator profile unavailable")?;
        if bytes.len() > 32768 {
            return Err("Operator profile too large");
        }
        let operator = serde_json::from_slice(&bytes).map_err(|_| "Invalid operator profile")?;
        let runtime = tokio::runtime::Runtime::new().map_err(|_| "Runtime unavailable")?;
        let receiver = if std::env::var("PRODUCER_RTC_DECODED_PROOF").as_deref() == Ok("1") {
            #[cfg(feature = "obs-proof")]
            let outputs: Arc<dyn producer_guest_runtime::media::Outputs> =
                Arc::new(obs_scene::Scenes::start()?);
            #[cfg(not(feature = "obs-proof"))]
            let outputs: Arc<dyn producer_guest_runtime::media::Outputs> = Arc::new(ProofOutputs);
            let receiver = producer_guest_runtime::media::Receiver::new(outputs)?;
            media = Some(receiver.counters());
            Some(receiver)
        } else {
            None
        };
        runtime.block_on(async {
            let mut owner = rtc_owner::HostOwner::start_with_media(
                rtc_control::Control::new(operator)?,
                Box::new(Sink {
                    counts: counts.clone(),
                    bindings: HashMap::new(),
                    closed: false,
                    receiver,
                }),
            )
            .await?;
            let lifetime = owner.task_lifetime();
            let seconds = if media.is_some() { 90 } else { 60 };
            let until = Instant::now() + Duration::from_secs(seconds);
            while Instant::now() < until {
                if std::env::var("PRODUCER_RTC_COMMAND_PROOF").as_deref()==Ok("1") {
                    const INPUT:&str="/private/tmp/producer-rtc-staging/native-room-command.json";
                    if let Ok(bytes)=std::fs::read(INPUT) {
                        let _=std::fs::remove_file(INPUT);
                        #[derive(serde::Deserialize)]
                        #[serde(deny_unknown_fields)]
                        struct Request {request_id:String,command:rtc_control::RoomCommand}
                        if bytes.len()>16384 {return Err("Native proof command too large");}
                        let request:Request=serde_json::from_slice(&bytes).map_err(|_|"Invalid native proof command")?;
                        uuid::Uuid::parse_str(&request.request_id).map_err(|_|"Invalid native proof request ID")?;
                        let result=owner.room_command(request.command).await;
                        let value=match result {
                            Ok(body)=>serde_json::json!({"request_id":request.request_id,"status":200,"body":body}),
                            Err(error)=>serde_json::json!({"request_id":request.request_id,"status":409,"error":error}),
                        };
                        use std::{io::Write,os::unix::fs::OpenOptionsExt};
                        let pending="/private/tmp/producer-rtc-staging/native-room-reply.pending";
                        let mut file=std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(pending).map_err(|_|"Native proof reply unavailable")?;
                        file.write_all(value.to_string().as_bytes()).map_err(|_|"Native proof reply failed")?;drop(file);
                        std::fs::rename(pending,"/private/tmp/producer-rtc-staging/native-room-reply.json").map_err(|_|"Native proof reply failed")?;
                    }
                }
                write(&counts, media.as_deref(), None, None);
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            owner.close().await?;
            if lifetime.strong_count() != 0
                || counts.alive.load(Ordering::Relaxed) != 0
                || counts.closed.load(Ordering::Relaxed) != 1
            {
                return Err("Subscription owner did not retire");
            }
            if media.as_ref().is_some_and(|m| {
                m.workers.load(Ordering::Acquire) != 0 || m.observers.load(Ordering::Acquire) != 0
            }) {
                return Err("Decoded media owner did not retire");
            }
            Ok(())
        })
    })();
    write(
        &counts,
        media.as_deref(),
        Some(result.is_ok()),
        result.as_ref().err().copied(),
    );
    if result.is_err() {
        std::process::exit(1);
    }
}

struct ProofOutputs;
struct ProofOutput(std::sync::atomic::AtomicBool);
impl producer_guest_runtime::media::Outputs for ProofOutputs {
    fn available(&self, _: &str) -> bool {
        true
    }
    fn open(&self, _: &str) -> Option<Arc<dyn producer_guest_runtime::media::Output>> {
        Some(Arc::new(ProofOutput(std::sync::atomic::AtomicBool::new(
            true,
        ))))
    }
}
impl producer_guest_runtime::media::Output for ProofOutput {
    fn video(&self, frame: producer_guest_runtime::media::Video<'_>, _: Instant) -> bool {
        self.0.load(Ordering::Acquire)
            && frame.width > 0
            && frame.height > 0
            && !frame.planes.0.is_empty()
    }
    fn audio(&self, samples: &[i16], channels: u32, _: Instant) -> bool {
        self.0.load(Ordering::Acquire)
            && matches!(channels, 1 | 2)
            && samples.len() == 480 * channels as usize
    }
    fn invalidate(&self) {
        self.0.store(false, Ordering::Release);
    }
}
