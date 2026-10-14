//! Single serialized owner of the native host connection and room lease.
//! Incoming media is supplied by an independently authorized receiver adapter.
use crate::rtc_control::{Control, Operator, RoomCommand};
use producer_guest_runtime::Connection;
use std::sync::{Arc, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::{
    sync::{mpsc, oneshot, watch},
    task::{JoinHandle, JoinSet},
};

/// Permission reads do not share the mutation queue or renew its lease.
/// At most two reads overlap; request-start expiry and monotonic revision
/// publication prevent slow responses from reviving old grants.
struct AuthorityReader {
    updates: watch::Sender<Control>,
    failed: watch::Receiver<Option<&'static str>>,
    stop: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
}
impl AuthorityReader {
    fn start(control: Control, updater: producer_guest_runtime::MediaAuthorityUpdater) -> Self {
        let (updates, contexts) = watch::channel(control);
        let (failure, failed) = watch::channel(None);
        let (stop, mut stopped) = oneshot::channel();
        let task = tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(500));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut pending = JoinSet::new();
            let mut failures = 0u8;
            loop {
                tokio::select! {
                    biased;
                    _ = &mut stopped => break,
                    result = pending.join_next(), if !pending.is_empty() => {
                        let result = result.unwrap().unwrap_or(Err("Native authority read task failed"));
                        match result.and_then(|snapshot| updater.publish(snapshot)) {
                            Ok(_) => failures = 0,
                            Err(error) => {
                                failures = failures.saturating_add(1);
                                if failures >= 3 || !matches!(error,
                                    "RTC request failed" | "RTC request timed out" | "RTC response failed" |
                                    "RTC authority temporarily unavailable" | "Native guest authority response expired") {
                                    let _ = failure.send(Some(error)); break;
                                }
                            }
                        }
                    }
                    _ = tick.tick(), if pending.len() < 2 => {
                        let mut reader = contexts.borrow().clone();
                        pending.spawn(async move { reader.media_authority().await });
                    }
                }
            }
            pending.abort_all();
            while pending.join_next().await.is_some() {}
        });
        Self {
            updates,
            failed,
            stop: Some(stop),
            task: Some(task),
        }
    }
    fn update(&self, control: &Control) {
        let _ = self.updates.send(control.clone());
    }
    async fn close(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}
impl Drop for AuthorityReader {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }
}

struct RoomRequest {
    command: RoomCommand,
    reply: oneshot::Sender<Result<serde_json::Value, &'static str>>,
}

pub struct HostOwner {
    stop: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<Result<(), &'static str>>>,
    lifetime: Weak<()>,
    room_id: String,
    commands: mpsc::Sender<RoomRequest>,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(u64::MAX)
}
impl HostOwner {
    pub fn running(&self) -> bool {
        self.task.as_ref().is_some_and(|task| !task.is_finished()) && !self.commands.is_closed()
    }
    #[cfg(all(feature = "guest-rtc-pilot", have_engine))]
    pub async fn start_scene(control: Control) -> Result<Self, &'static str> {
        let receiver = crate::live::rtc_media::SceneOutputs::receiver()?;
        Self::start_with_options(
            control,
            Box::new(receiver),
            std::env::var("PRODUCER_RTC_PROGRAM_PILOT").as_deref() == Ok("1"),
        )
        .await
    }
    pub async fn start(control: Control) -> Result<Self, &'static str> {
        let (mut owner, connected) = Self::spawn(control, None, false);
        match connected.await {
            Ok(Ok(())) => Ok(owner),
            Ok(Err(error)) => {
                let _ = owner.close().await;
                Err(error)
            }
            Err(_) => {
                let _ = owner.close().await;
                Err("Native RTC startup task failed")
            }
        }
    }
    pub async fn start_with_media(
        control: Control,
        media: Box<dyn producer_guest_runtime::GuestMedia>,
    ) -> Result<Self, &'static str> {
        Self::start_with_options(control, media, false).await
    }
    async fn start_with_options(
        control: Control,
        media: Box<dyn producer_guest_runtime::GuestMedia>,
        program_requested: bool,
    ) -> Result<Self, &'static str> {
        let (mut owner, connected) = Self::spawn(control, Some(media), program_requested);
        match connected.await {
            Ok(Ok(())) => Ok(owner),
            Ok(Err(error)) => {
                let _ = owner.close().await;
                Err(error)
            }
            Err(_) => {
                let _ = owner.close().await;
                Err("Native RTC startup task failed")
            }
        }
    }
    fn spawn(
        control: Control,
        media: Option<Box<dyn producer_guest_runtime::GuestMedia>>,
        program_requested: bool,
    ) -> (Self, oneshot::Receiver<Result<(), &'static str>>) {
        let (stop, mut stopped) = oneshot::channel();
        let (ready, connected) = oneshot::channel();
        let room_id = control.room_id().to_owned();
        let (commands, mut requests) = mpsc::channel::<RoomRequest>(8);
        let lifetime = Arc::new(());
        let probe = Arc::downgrade(&lifetime);
        // The task, rather than the caller's cancellable start future, owns
        // connection initialization. Cancellation signals stop; it never drops
        // Room::connect halfway through native initialization.
        let task = tokio::spawn(async move {
            let _lifetime = lifetime;
            let mut control = control;
            let started = async {
                control.open().await?;
                control.start_or_recover().await?;
                let session = control.session().await?;
                let mut connection = Connection::connect_with_media(&session, media).await?;
                if control.lease_expires_at_ms().unwrap_or(0) <= now() || !connection.healthy() {
                    let _ = connection.close().await;
                    return Err("Native RTC authority expired during connection");
                }
                match control.media_authority().await {
                    Ok(snapshot) => {
                        if connection.media_authority(snapshot).is_err() {
                            let _ = connection.close().await;
                            return Err("Native media authority handoff failed");
                        }
                    }
                    Err(error) => {
                        let _ = connection.close().await;
                        return Err(error);
                    }
                }
                Ok(connection)
            }
            .await;
            let mut connection = match started {
                Ok(connection) => connection,
                Err(error) => {
                    let _ = control.end().await;
                    let _ = ready.send(Err(error));
                    return Err(error);
                }
            };
            #[cfg(all(feature = "guest-rtc-pilot", have_engine))]
            let mut program = if program_requested {
                crate::live::rtc_program::reset_diagnostics();
                let started = tokio::time::timeout(Duration::from_secs(8), async {
                    let sources = connection.publish_program().await?;
                    crate::live::rtc_program::Publisher::start(
                        sources,
                        control.lease_expires_at_ms().unwrap_or(0),
                    )
                })
                .await
                .unwrap_or(Err("Native program publication timed out"));
                match started {
                    Ok(program) => Some(program),
                    Err(error) => {
                        let _ = connection.close().await;
                        let _ = control.end().await;
                        let _ = ready.send(Err(error));
                        return Err(error);
                    }
                }
            } else {
                None
            };
            #[cfg(not(all(feature = "guest-rtc-pilot", have_engine)))]
            let _ = program_requested;
            if stopped.try_recv() != Err(oneshot::error::TryRecvError::Empty)
                || ready.send(Ok(())).is_err()
            {
                #[cfg(all(feature = "guest-rtc-pilot", have_engine))]
                let program_closed = program
                    .as_mut()
                    .map(|program| program.close())
                    .unwrap_or(Ok(()));
                #[cfg(not(all(feature = "guest-rtc-pilot", have_engine)))]
                let program_closed: Result<(), &'static str> = Ok(());
                let closed = connection.close().await;
                let ended = control.end().await;
                program_closed?;
                closed?;
                ended?;
                return Ok(());
            }
            let mut heartbeat = tokio::time::interval(Duration::from_secs(10));
            heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            heartbeat.tick().await;
            let mut safety = tokio::time::interval(Duration::from_millis(100));
            safety.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut authority_reader =
                AuthorityReader::start(control.clone(), connection.media_authority_updater());
            let mut failure = None;
            #[cfg(all(feature = "guest-rtc-pilot", have_engine))]
            let mut program_recoveries = std::collections::VecDeque::<std::time::Instant>::new();
            loop {
                tokio::select! {
                    biased;
                    _ = &mut stopped => break,
                    _ = safety.tick() => {
                        #[cfg(all(feature = "guest-rtc-pilot", have_engine))]
                        if program.as_ref().is_some_and(|program| program.failed()) {
                            let instant = std::time::Instant::now();
                            while program_recoveries.front().is_some_and(|at| instant.duration_since(*at) >= Duration::from_secs(60)) {
                                program_recoveries.pop_front();
                            }
                            if !program.as_ref().is_some_and(|publisher| publisher.recoverable()) || program_recoveries.len() >= 3 || !connection.healthy() || control.lease_expires_at_ms().unwrap_or(0) <= now() {
                                failure = Some("Native program capture or publication stopped"); break;
                            }
                            // Stop capture and discard pending samples before removing
                            // only our own publications. Never replay late audio.
                            let mut retired = program.take().unwrap();
                            if retired.close() != Err("Native program audio publication deadline missed") {
                                failure = Some("Native program recovery teardown failed"); break;
                            }
                            let recovered = tokio::time::timeout(Duration::from_secs(8), async {
                                let first = control.media_authority().await;
                                let snapshot = match first {
                                    Err("RTC request timed out" | "RTC request failed" | "RTC response failed" | "RTC authority temporarily unavailable" | "Native guest authority response expired") => {
                                        // Retry only a read. Expired receiver permissions
                                        // stay expired and no new publication starts
                                        // until a current response validates successfully.
                                        tokio::time::sleep(Duration::from_millis(100)).await;
                                        control.media_authority().await?
                                    }
                                    result => result?,
                                };
                                connection.media_authority(snapshot)?;
                                if control.lease_expires_at_ms().unwrap_or(0) <= now() {
                                    return Err("Native program recovery lease expired");
                                }
                                connection.retire_program().await?;
                                let sources = connection.publish_program().await?;
                                crate::live::rtc_program::Publisher::start(sources, control.lease_expires_at_ms().unwrap_or(0))
                            }).await.unwrap_or(Err("Native program recovery timed out"));
                            match recovered {
                                Ok(publisher) => { crate::live::rtc_program::note_recovery(); program = Some(publisher); program_recoveries.push_back(instant); }
                                Err(error) => { failure = Some(error); break; }
                            }
                        }
                        if !connection.healthy() {
                            failure = Some("Native RTC transport stopped"); break;
                        }
                        if control.lease_expires_at_ms().unwrap_or(0) <= now() {
                            failure = Some("Native RTC host lease expired"); break;
                        }
                    }
                    _ = heartbeat.tick() => {
                        if let Err(error) = control.renew().await {
                            failure = Some(error); break;
                        }
                        authority_reader.update(&control);
                        #[cfg(all(feature = "guest-rtc-pilot", have_engine))]
                        if let Some(program) = program.as_ref() { program.renew(control.lease_expires_at_ms().unwrap_or(0)); }
                    }
                    request = requests.recv() => {
                        let Some(request)=request else {break;};
                        if request.reply.is_closed() { continue; }
                        // Controls precede polling: a slow authority read must
                        // not make an overdue poll starve the bounded queue.
                        // Each command independently refreshes authority too.
                        // The same task owns commands, renewal and permission
                        // reads. No GUI request races a cached host revision.
                        let result=async {
                            let before=control.media_authority().await?;
                            connection.media_authority(before)?;
                            let result=control.room_command(request.command).await;
                            // Even an ambiguous POST may have committed. Never
                            // extend old permits or blindly replay the POST.
                            // If this read fails, their independent expiry
                            // remains in force while the poll loop recovers.
                            let after=control.media_authority().await?;
                            connection.media_authority(after)?;
                            result
                        }.await;
                        authority_reader.update(&control);
                        let _=request.reply.send(result);
                    }
                    changed = authority_reader.failed.changed() => {
                        failure = Some(if changed.is_err() { "Native authority reader stopped" }
                            else { authority_reader.failed.borrow().unwrap_or("Native authority reader stopped") });
                        break;
                    }

                }
            }
            authority_reader.close().await;
            // Close SDK before ending authority; queue/media adapters must retire
            // before this boundary once they are installed. All normal exits join.
            #[cfg(all(feature = "guest-rtc-pilot", have_engine))]
            let program_closed = program
                .as_mut()
                .map(|program| program.close())
                .unwrap_or(Ok(()));
            #[cfg(not(all(feature = "guest-rtc-pilot", have_engine)))]
            let program_closed: Result<(), &'static str> = Ok(());
            let closed = connection.close().await;
            let ended = control.end().await;
            // Preserve the initiating failure even when publisher teardown
            // also reports its already-known deadline fault.
            if let Some(error) = failure {
                // Errors here are fixed application messages, never provider
                // responses, credentials or invitation capabilities.
                #[cfg(debug_assertions)]
                eprintln!("Native RTC owner stopped: {error}");
                return Err(error);
            }
            program_closed?;
            closed?;
            ended?;
            Ok(())
        });
        (
            Self {
                stop: Some(stop),
                task: Some(task),
                lifetime: probe,
                room_id,
                commands,
            },
            connected,
        )
    }
    pub fn task_lifetime(&self) -> Weak<()> {
        self.lifetime.clone()
    }
    pub fn room_id(&self) -> &str {
        &self.room_id
    }
    pub async fn room_command(
        &self,
        command: RoomCommand,
    ) -> Result<serde_json::Value, &'static str> {
        let (reply, result) = oneshot::channel();
        self.commands
            .try_send(RoomRequest { command, reply })
            .map_err(|_| "Native RTC control queue unavailable")?;
        tokio::time::timeout(Duration::from_secs(15), result)
            .await
            .map_err(|_| "Native room control response timed out; refresh room state")?
            .map_err(|_| "Native RTC room owner stopped")?
    }
    pub async fn close(&mut self) -> Result<(), &'static str> {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(task) = self.task.take() {
            task.await.map_err(|_| "Native RTC owner task failed")??;
        }
        Ok(())
    }
}
impl Drop for HostOwner {
    fn drop(&mut self) {
        // Dropping the control handle wakes the task. The task owns no handle
        // back-reference and completes SDK close/end even if its join is detached.
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }
}
#[cfg(debug_assertions)]
pub fn selftest(path: &std::path::Path) -> Result<(), &'static str> {
    let bytes = std::fs::read(path).map_err(|_| "Staging operator profile unavailable")?;
    if bytes.len() > 32768 {
        return Err("Staging operator profile too large");
    }
    let operator: Operator =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid staging operator profile")?;
    let runtime = tokio::runtime::Runtime::new().map_err(|_| "Native RTC runtime unavailable")?;
    runtime.block_on(async {
        let mut owner = HostOwner::start(Control::new(operator.clone())?).await?;
        tokio::time::sleep(Duration::from_secs(22)).await;
        let lifetime = owner.task_lifetime();
        owner.close().await?;
        if lifetime.strong_count() != 0 { return Err("Native RTC owner remained alive after close"); }
        // Repeated close must have no task, SDK room or authority left to own.
        owner.close().await?;
        // Drop while startup is still pending. The owning task must finish its
        // initialization and clean up, rather than dropping Room::connect.
        let (pending,ready)=HostOwner::spawn(Control::new(operator)?,None,false);
        let lifetime=pending.task_lifetime();
        tokio::time::sleep(Duration::from_millis(50)).await;
        drop(pending);drop(ready);
        let until=std::time::Instant::now()+Duration::from_secs(30);
        while lifetime.strong_count()!=0 {
            if std::time::Instant::now()>=until{return Err("Native startup cancellation did not retire");}
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        println!("Native SDK owner proof passed: hosted join, two lease renewals, SDK close, event task join, run end, startup cancellation");
        Ok(())
    })
}

/// Disposable generated-program fixture. No GUI, user DB or physical devices.
#[cfg(all(
    feature = "guest-rtc-pilot",
    have_engine,
    debug_assertions,
    target_os = "macos"
))]
pub fn program_selftest() -> Result<(), &'static str> {
    use crate::live::{
        engine, ffi,
        graph::{ExtraSpec, SceneGraph, TransformPatch},
        rtc_program,
    };
    use std::{io::Write, os::unix::fs::OpenOptionsExt};
    const ROOT: &str = "/private/tmp/producer-rtc-staging";
    fn save(value: serde_json::Value) -> Result<(), &'static str> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(format!("{ROOT}/native-program-owner.pending"))
            .map_err(|_| "Native program report unavailable")?;
        file.write_all(value.to_string().as_bytes())
            .map_err(|_| "Native program report failed")?;
        drop(file);
        std::fs::rename(
            format!("{ROOT}/native-program-owner.pending"),
            format!("{ROOT}/native-program-owner.json"),
        )
        .map_err(|_| "Native program report failed")
    }
    struct GuestLoad {
        id: String,
        stop: Arc<std::sync::atomic::AtomicBool>,
        worker: Option<std::thread::JoinHandle<()>>,
    }
    impl GuestLoad {
        fn close(&mut self) {
            self.stop.store(true, std::sync::atomic::Ordering::Release);
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
        }
    }
    impl Drop for GuestLoad {
        fn drop(&mut self) {
            self.close();
        }
    }
    fn guest_load(graph: &mut SceneGraph, index: usize) -> Result<GuestLoad, &'static str> {
        let participant = uuid::Uuid::new_v4().to_string();
        let id = format!("guest-{participant}");
        graph
            .add_extra(
                &id,
                "Generated guest load",
                &ExtraSpec::RtcGuest {
                    participant_id: participant,
                },
            )
            .map_err(|_| "Native lifecycle source unavailable")?;
        graph
            .set_transform(
                &id,
                &TransformPatch {
                    x: Some((index % 2) as f32 * 960.),
                    y: Some((index / 2) as f32 * 540.),
                    w: Some(960.),
                    h: Some(540.),
                    visible: Some(true),
                    ..Default::default()
                },
            )
            .map_err(|_| "Native lifecycle placement failed")?;
        graph
            .set_source_audio(&id, Some(0.25), Some(false))
            .map_err(|_| "Native lifecycle audio unavailable")?;
        let delivery = crate::live::rtc_ingest::endpoint(&id)
            .and_then(|endpoint| endpoint.replace())
            .ok_or("Native lifecycle delivery unavailable")?;
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stopped = stop.clone();
        let worker = std::thread::Builder::new()
            .name("rtc-lifecycle-fixture".into())
            .spawn(move || {
                extern "C" {
                    fn os_gettime_ns() -> u64;
                }
                let y = vec![64 + index as u8 * 16; 1280 * 720];
                let uv = vec![128; 640 * 360];
                let pcm = [2048i16; 480];
                let mut tick = 0;
                while !stopped.load(std::sync::atomic::Ordering::Acquire) {
                    let at = unsafe { os_gettime_ns() };
                    let _ = delivery.audio(&pcm, 1, at);
                    if tick % 3 == 0 {
                        let _ = delivery.video(
                            crate::live::rtc_ingest::Video {
                                planes: (&y, &uv, &uv),
                                width: 1280,
                                height: 720,
                                strides: (1280, 640, 640),
                            },
                            at,
                        );
                    }
                    tick += 1;
                    std::thread::sleep(Duration::from_millis(10));
                }
            })
            .map_err(|_| "Native lifecycle worker unavailable")?;
        Ok(GuestLoad {
            id,
            stop,
            worker: Some(worker),
        })
    }
    let bytes = std::fs::read(format!("{ROOT}/operator.json"))
        .map_err(|_| "Native program operator unavailable")?;
    if bytes.len() > 32768 {
        return Err("Native program operator too large");
    }
    let operator: Operator =
        serde_json::from_slice(&bytes).map_err(|_| "Native program operator invalid")?;
    engine::bootstrap_with_config(&std::path::Path::new(ROOT).join("obs-program-config"));
    let path = std::path::Path::new(ROOT).join("generated-program-tone.wav");
    let mut wave = hound::WavWriter::create(
        &path,
        hound::WavSpec {
            channels: 2,
            sample_rate: 48000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        },
    )
    .map_err(|_| "Native program fixture unavailable")?;
    for n in 0..48000 * 2 {
        let sample = ((n as f64 * 2. * std::f64::consts::PI * 997. / 48000.).sin() * 8000.) as i16;
        wave.write_sample(sample)
            .map_err(|_| "Native program fixture failed")?;
        wave.write_sample(sample)
            .map_err(|_| "Native program fixture failed")?;
    }
    wave.finalize()
        .map_err(|_| "Native program fixture failed")?;
    let mut graph = SceneGraph::create().map_err(|_| "Native program scene unavailable")?;
    let generated_av = std::env::var("PRODUCER_RTC_AV_PROOF").as_deref() == Ok("1");
    if generated_av {
        let av_path = std::path::Path::new(ROOT).join("generated-program-av.mov");
        if !av_path.is_file() { return Err("Generated AV fixture unavailable"); }
        graph.add_extra("generated-program-av", "Generated numbered AV", &ExtraSpec::Media {
            path: av_path.to_string_lossy().into_owned(), looping: false,
        }).map_err(|_| "Generated AV source unavailable")?;
        graph.set_transform("generated-program-av", &TransformPatch {
            w: Some(1280.), h: Some(720.), visible: Some(true), ..Default::default()
        }).map_err(|_| "Generated AV transform failed")?;
        graph.set_source_audio("generated-program-av", Some(1.0), Some(false))
            .map_err(|_| "Generated AV audio routing failed")?;
    } else {
    graph
        .add_extra(
            "generated-program-color",
            "Generated program",
            &ExtraSpec::Color {
                color: "#ff0000".into(),
            },
        )
        .map_err(|_| "Native program color unavailable")?;
    graph
        .set_transform(
            "generated-program-color",
            &TransformPatch {
                w: Some(1920.),
                h: Some(1080.),
                visible: Some(true),
                ..Default::default()
            },
        )
        .map_err(|_| "Native program scene failed")?;
    graph
        .add_extra(
            "generated-program-audio",
            "Generated tone",
            &ExtraSpec::Media {
                path: path.to_string_lossy().into_owned(),
                looping: true,
            },
        )
        .map_err(|_| "Native program tone unavailable")?;
    graph
        .set_source_audio("generated-program-audio", Some(0.5), Some(false))
        .map_err(|_| "Native program tone routing failed")?;
    }
    let lifecycle = std::env::var("PRODUCER_RTC_LIFECYCLE_PROOF").as_deref() == Ok("1");
    if generated_av && lifecycle { return Err("AV recording and generated source lifecycle modes are exclusive"); }
    let mut loads = Vec::new();
    if lifecycle {
        for index in 0..4 {
            loads.push(guest_load(&mut graph, index)?);
        }
    }
    let runtime =
        tokio::runtime::Runtime::new().map_err(|_| "Native program runtime unavailable")?;
    let result = runtime.block_on(async {
        let receiver = crate::live::rtc_media::SceneOutputs::receiver()?;
        let mut owner = HostOwner::start_with_options(Control::new(operator)?, Box::new(receiver), true).await?;
        let lifetime = owner.task_lifetime();
        let began = std::time::Instant::now();
        let until = began + Duration::from_secs(60);
        let mut lifecycle_cycles=0;
        let outcome = async {
        while std::time::Instant::now() < until && owner.running() {
            if lifecycle && lifecycle_cycles<2 && began.elapsed()>=Duration::from_secs(20*(lifecycle_cycles+1)) {
                for mut load in std::mem::take(&mut loads) {load.close();graph.remove_extra(&load.id).map_err(|_|"Native lifecycle removal failed")?;}
                for index in 0..4 {loads.push(guest_load(&mut graph,index)?);}
                lifecycle_cycles+=1;
            }
            let (audio,video) = rtc_program::counts(); save(serde_json::json!({"passed":null,"audio_submitted":audio,"video_submitted":video,"timing":rtc_program::timing(),"generated_av_fixture":generated_av}))?;
            if let Ok(bytes) = std::fs::read(format!("{ROOT}/native-room-command.json")) {
                let _ = std::fs::remove_file(format!("{ROOT}/native-room-command.json"));
                #[derive(serde::Deserialize)] #[serde(deny_unknown_fields)]
                struct Request { request_id: String, command: RoomCommand }
                if bytes.len()>16384 {return Err("Native program command too large");}
                let request:Request=serde_json::from_slice(&bytes).map_err(|_|"Native program command invalid")?;
                uuid::Uuid::parse_str(&request.request_id).map_err(|_|"Native program request invalid")?;
                let reply=match owner.room_command(request.command).await {Ok(body)=>serde_json::json!({"request_id":request.request_id,"status":200,"body":body}),Err(_)=>serde_json::json!({"request_id":request.request_id,"status":409})};
                let mut file=std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(format!("{ROOT}/native-room-reply.pending")).map_err(|_|"Native program reply unavailable")?;
                file.write_all(reply.to_string().as_bytes()).map_err(|_|"Native program reply failed")?;drop(file);
                std::fs::rename(format!("{ROOT}/native-room-reply.pending"),format!("{ROOT}/native-room-reply.json")).map_err(|_|"Native program reply failed")?;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        Ok::<(), &'static str>(())
        }.await;
        for load in &mut loads {load.close();}
        let closed = owner.close().await;
        owner.close().await?;
        if outcome.is_err() || closed.is_err() {
            let (audio,video)=rtc_program::counts();
            let _=save(serde_json::json!({"passed":false,"audio_submitted":audio,"video_submitted":video,"timing":rtc_program::timing()}));
        }
        outcome?; closed?;
        let (audio,video)=rtc_program::counts();
        let timing = rtc_program::timing();
        let capture_injection = std::env::var("PRODUCER_RTC_CAPTURE_GAP_PROOF").as_deref()==Ok("1");
        let video_injection = std::env::var("PRODUCER_RTC_VIDEO_DELAY_PROOF").as_deref()==Ok("1");
        if lifetime.strong_count()!=0 || audio<100 || video<20 || timing["capture_fault_code"]!=0
            || (capture_injection && timing["capture_gap_injected"]!=true)
            || (video_injection && timing["video_worker_stall_injected"]!=true)
            || (lifecycle && (lifecycle_cycles!=2 || audio<4500 || video<1500
                || timing["publisher_recoveries"]!=0
                || timing["silence_blocks_submitted"].as_u64().unwrap_or(u64::MAX)>if capture_injection {180} else {50})) {
            return Err("Native program lifecycle or submission proof failed");
        }
        save(serde_json::json!({"passed":true,"audio_submitted":audio,"video_submitted":video,"timing":rtc_program::timing(),"owner_expired":true,"repeated_close_passed":true,"generated_av_fixture":generated_av,"generated_guest_sources":if lifecycle {4}else{0},"source_recreation_cycles":lifecycle_cycles}))
    });
    graph
        .clear_room()
        .map_err(|_| "Native program scene cleanup failed")?;
    // Match the app's process-exit contract; it does not globally unload OBS.
    result
}
