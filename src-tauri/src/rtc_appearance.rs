//! Candidate native guest owner. Invitation capability stays with its issuer;
//! no local host identity, credentials, or room-control lease is reused.
use crate::{
    error::{EngineError, EngineResult},
    AppState,
};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Controls {
    pub muted: bool,
    pub camera_off: bool,
    pub playback: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceStatus {
    pub appearance_id: String,
    pub phase: String,
    pub on_stage: bool,
    pub has_program: bool,
    pub has_audio: bool,
    pub return_source_id: Option<String>,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}
fn enabled() -> bool {
    cfg!(all(feature = "guest-rtc-pilot", have_engine))
        && std::env::var("PRODUCER_NATIVE_APPEARANCE").as_deref() == Ok("1")
}
#[tauri::command]
pub fn live_appearance_enabled() -> bool {
    enabled()
}

#[cfg(all(feature = "guest-rtc-pilot", have_engine))]
mod native {
    use super::*;
    use crate::live::{
        appearance_media::AppearanceOutputs,
        rtc_program::{CaptureTarget, Publisher},
    };
    use producer_guest_runtime::{
        authority::Snapshot, media::Receiver, program::Sources, Connection,
    };
    use producer_guest_session::appearance::Authority;
    use std::{
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc, Mutex,
        },
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    };
    use tokio::{sync::watch, task::JoinHandle};
    const ENDPOINT: &str = "wss://producer-boomin-6h2iz2sq.livekit.cloud";
    pub struct StartSpec {
        pub appearance_id: String,
        pub api: String,
        pub invite: String,
        pub participant_id: String,
    }
    #[derive(Clone)]
    enum ReadState {
        Current(Arc<Authority>),
        Waiting,
        Gone,
        Unavailable,
        Invalid,
    }
    struct GuestApi {
        client: reqwest::Client,
        root: String,
    }
    impl GuestApi {
        fn validate(api: &str, invite: &str) -> Result<(), &'static str> {
            let api = api.trim_end_matches('/');
            if !["https://api.boomin.ai", "https://api.boomin.ai/v1/connect"].contains(&api)
                || !invite.strip_prefix("gi_").is_some_and(|v| {
                    (16..=120).contains(&v.len())
                        && v.bytes()
                            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
                })
            {
                return Err("Native appearance issuer is unavailable");
            }
            Ok(())
        }
        async fn new(api: &str, invite: &str) -> Result<Self, &'static str> {
            // The candidate is hosted-only. An explicit API address must never
            // turn a native capability request into arbitrary-origin fetching.
            Self::validate(api, invite)?;
            Ok(Self {
                client: crate::http_transport::rtc_control().await?,
                root: format!("https://api.boomin.ai/v1/connect/guest/{invite}/rtc"),
            })
        }
        async fn request(
            &self,
            path: &str,
            body: Option<serde_json::Value>,
        ) -> Result<(u16, Vec<u8>), &'static str> {
            let url = format!("{}/{path}", self.root);
            let request = if let Some(body) = body {
                self.client.post(url).json(&body)
            } else {
                self.client.get(url)
            };
            let mut response = request
                .header("Cache-Control", "no-store")
                .timeout(Duration::from_millis(2500))
                .send()
                .await
                .map_err(|_| "Native appearance request failed")?;
            let status = response.status().as_u16();
            let mut bytes = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| "Native appearance response unavailable")?
            {
                if bytes.len().saturating_add(chunk.len()) > 32768 {
                    return Err("Native appearance response too large");
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok((status, bytes))
        }
        async fn state(&self, participant: &str) -> ReadState {
            let started = Instant::now();
            match self.request("state?stage_audio=1", None).await {
                Ok((200, bytes)) => {
                    Authority::parse(&bytes, participant, ENDPOINT, started, Instant::now())
                        .map(|v| ReadState::Current(Arc::new(v)))
                        .unwrap_or(ReadState::Invalid)
                }
                Ok((404 | 410, _)) => ReadState::Gone,
                Ok((409, _)) => ReadState::Waiting,
                _ => ReadState::Unavailable,
            }
        }
        async fn session(
            &self,
            a: &Authority,
        ) -> Result<producer_guest_session::Session, &'static str> {
            let (status, bytes) = self
                .request("connection", Some(serde_json::json!({"session_version":1})))
                .await?;
            if ![200, 201].contains(&status) {
                return Err("Native appearance connection unavailable");
            }
            let value: serde_json::Value = serde_json::from_slice(&bytes)
                .map_err(|_| "Native appearance connection invalid")?;
            let ticket = value["connection_ticket"]
                .as_str()
                .filter(|v| !v.is_empty() && v.len() <= 4096)
                .ok_or("Native appearance connection invalid")?;
            let e = &a.expected;
            let (status,bytes)=self.request("session",Some(serde_json::json!({"connection_ticket":ticket,"expected":{
                "run_id":e.run_id,"control_revision":e.control_revision,"host_lease_epoch":e.host_lease_epoch}}))).await?;
            if status != 200 {
                return Err("Native appearance authorization changed");
            }
            a.session(&bytes, wall_ms())
        }
    }
    fn wall_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|v| v.as_millis() as u64)
            .unwrap_or(u64::MAX)
    }
    fn publication_deadline(a: &Authority) -> u64 {
        wall_ms().saturating_add(
            a.deadline()
                .saturating_duration_since(Instant::now())
                .as_millis() as u64,
        )
    }
    fn current(reads: &watch::Receiver<ReadState>) -> Option<Arc<Authority>> {
        match reads.borrow().clone() {
            ReadState::Current(a) if a.current(Instant::now()) => Some(a),
            _ => None,
        }
    }
    async fn close_publisher(publisher: &mut Option<Publisher>) -> Result<(), &'static str> {
        if let Some(mut publisher) = publisher.take() {
            publisher.request_stop();
            let closed = tokio::task::spawn_blocking(move || publisher.close())
                .await
                .map_err(|_| "Native appearance publisher retirement failed")?;
            if closed != Err("Native program audio publication deadline missed") {
                closed?;
            }
        }
        Ok(())
    }
    async fn retire(
        connection: &mut Option<Connection>,
        publisher: &mut Option<Publisher>,
        outputs: &AppearanceOutputs,
    ) -> Result<(), &'static str> {
        // Fence subscriptions first, then join callbacks/SDK capture before any
        // engine lease or private monitor source can be released.
        if let Some(connection) = connection.as_mut() {
            connection.begin_close();
        }
        let published = close_publisher(publisher).await;
        let received = if let Some(mut connection) = connection.take() {
            connection.close().await
        } else {
            Ok(())
        };
        outputs.clear();
        published.and(received)
    }
    pub struct AppearanceOwner {
        id: String,
        stop: Arc<AtomicBool>,
        controls: watch::Sender<Controls>,
        status: watch::Receiver<AppearanceStatus>,
        task: Option<JoinHandle<()>>,
        outputs: Arc<AppearanceOutputs>,
        capture: Arc<Mutex<Option<Sources>>>,
    }
    impl AppearanceOwner {
        pub fn start(
            spec: StartSpec,
            target: CaptureTarget,
            outputs: Arc<AppearanceOutputs>,
            initial_controls: Controls,
        ) -> Result<Self, &'static str> {
            uuid::Uuid::parse_str(&spec.participant_id)
                .map_err(|_| "Invalid appearance participant")?;
            GuestApi::validate(&spec.api, &spec.invite)?;
            // Reserve the timestamped receiver before issuing any remote
            // connection capability. Configuration/conflict failures are explicit.
            let receiver = Receiver::new_shared(outputs.clone())?;
            let profile = target.profile();
            let initial = AppearanceStatus {
                appearance_id: spec.appearance_id.clone(),
                phase: "starting".into(),
                on_stage: false,
                has_program: false,
                has_audio: false,
                return_source_id: None,
                width: profile.width,
                height: profile.height,
                fps: profile.fps,
            };
            let (statuses, status) = watch::channel(initial);
            let (controls, mut control) = watch::channel(Controls {
                playback: false,
                ..initial_controls
            });
            let stop = Arc::new(AtomicBool::new(false));
            let stopped = stop.clone();
            let returned = outputs.clone();
            let capture = Arc::new(Mutex::new(None::<Sources>));
            let active_capture = capture.clone();
            let id = spec.appearance_id.clone();
            let task = tokio::spawn(async move {
                // Retain the master lease across publisher recovery and all
                // receiver retirement. Only dropping the owner releases it.
                let target = target;
                let run=async {
                    let api=Arc::new(GuestApi::new(&spec.api,&spec.invite).await?);
                    let (read_updates,mut reads)=watch::channel(ReadState::Unavailable);
                    let reader_stop=stopped.clone();let client=api.clone();let participant=spec.participant_id.clone();
                    let reader=tokio::spawn(async move {
                        let mut old:Option<Arc<Authority>>=None;
                        while !reader_stop.load(Ordering::Acquire) {
                            let next=client.state(&participant).await;
                            if reader_stop.load(Ordering::Acquire){break;}
                            if let ReadState::Current(a)=&next {
                                if old.as_ref().is_some_and(|b|a.same_binding(b)&&!a.supersedes(b)){
                                    tokio::time::sleep(Duration::from_secs(1)).await;continue;
                                }
                                old=Some(a.clone());
                            }else{old=None;}
                            let gone=matches!(next,ReadState::Gone);read_updates.send_replace(next);
                            if gone {break;}
                            tokio::time::sleep(Duration::from_secs(1)).await;
                        }
                    });
                    let mut initial_receiver=Some(receiver);
                    let mut connection:Option<Connection>=None;let mut publisher:Option<Publisher>=None;
                    let mut binding:Option<Arc<Authority>>=None;
                    let mut published_audience=None;let mut next_attempt=Instant::now();let mut tick=tokio::time::interval(Duration::from_millis(50));
                    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                    let result=async {
                        while !stopped.load(Ordering::Acquire) {
                            tick.tick().await;
                            let read=reads.borrow_and_update().clone();let controls=*control.borrow_and_update();
                            returned.set_playback(controls.playback);
                            if matches!(read,ReadState::Invalid){return Err("Native appearance authority mismatch");}
                            if matches!(read,ReadState::Gone) {let mut status=statuses.borrow().clone();status.phase="gone".into();statuses.send_replace(status);break;}
                            let authority=current(&reads);
                            let incompatible=binding.as_ref().is_some_and(|b|authority.as_ref().is_none_or(|a|!a.same_binding(b)));
                            if incompatible||connection.as_ref().is_some_and(|c|!c.healthy())||publisher.as_ref().is_some_and(|p|p.failed()) {
                                if let Ok(mut capture)=active_capture.lock(){if let Some(s)=capture.take(){s.set_enabled(false,false);}}
                                retire(&mut connection,&mut publisher,&returned).await?;binding=None;published_audience=None;
                                next_attempt=Instant::now()+Duration::from_millis(250);
                            }
                            let Some(authority)=authority else {
                                let mut status=statuses.borrow().clone();status.phase=if matches!(read,ReadState::Waiting){"waiting"}else{"reconnecting"}.into();
                                status.on_stage=false;status.has_program=false;status.has_audio=false;statuses.send_replace(status);continue;
                            };
                            if connection.is_none() && Instant::now()>=next_attempt {
                                let joined=async {
                                    let session=api.session(&authority).await?;
                                    if stopped.load(Ordering::Acquire){return Err("Native appearance stopped");}
                                    let receiver=match initial_receiver.take(){Some(receiver)=>receiver,None=>Receiver::new_shared(returned.clone())?};
                                    let mut joined=Connection::connect_with_media(&session,Some(Box::new(receiver))).await?;
                                    let prepared=async {
                                        let fresh=current(&reads).filter(|a|a.same_binding(&authority)).ok_or("Native appearance authority changed during connect")?;
                                        if stopped.load(Ordering::Acquire){return Err("Native appearance stopped");}
                                        returned.set_host(&fresh.producer_participant_id);
                                        joined.media_authority(Snapshot::for_appearance(&fresh,wall_ms())?)?;
                                        let capture_controls=*control.borrow();
                                        let capture=joined.publish_appearance(&fresh,profile,capture_controls.muted,capture_controls.camera_off).await?;
                                        let live=current(&reads).filter(|a|a.same_binding(&fresh)).ok_or("Native appearance authority changed during publish")?;
                                        if stopped.load(Ordering::Acquire){return Err("Native appearance stopped");}
                                        let publish_controls=*control.borrow();
                                        joined.appearance_controls(publish_controls.muted,publish_controls.camera_off);
                                        let publishing=if let Some(s)=capture.as_ref(){
                                            if let Ok(mut active)=active_capture.lock(){
                                                let controls=*control.borrow();let live=!stopped.load(Ordering::Acquire);
                                                s.set_enabled(live&&!controls.muted,live&&!controls.camera_off);*active=Some(s.clone());
                                            }else{return Err("Native appearance capture controls unavailable");}
                                            Some(Publisher::start_target(s.clone(),publication_deadline(&live),target.clone())?)}else{None};
                                        Ok((publishing,live))
                                    }.await;
                                    match prepared {Ok((publishing,live))=>Ok((joined,publishing,live)),Err(error)=>{let _=joined.close().await;Err(error)}}
                                }.await;
                                match joined {
                                    Ok((joined,publishing,live))=>{connection=Some(joined);publisher=publishing;binding=Some(live);},
                                    Err(error)=>{
                                        if matches!(error,"Native appearance session mismatch"|"Native appearance connection invalid"|"Timestamped native receive pipeline is not configured"|"Native receive pipeline already owned"|"Native receive worker unavailable") {return Err(error);}
                                        next_attempt=Instant::now()+Duration::from_secs(1);let mut status=statuses.borrow().clone();status.phase="reconnecting".into();statuses.send_replace(status);continue;
                                    }
                                }
                            }
                            let Some(authority)=current(&reads).filter(|a|binding.as_ref().is_some_and(|b|a.same_binding(b))) else {continue;};
                            let controls=*control.borrow();
                            if let Some(connection)=connection.as_ref() {
                                connection.appearance_controls(controls.muted,controls.camera_off);
                                connection.media_authority(Snapshot::for_appearance(&authority,wall_ms())?)?;
                                let audience=connection.appearance_permission_key(&authority)?;
                                if published_audience.as_ref()!=Some(&audience) {
                                    tokio::time::timeout(Duration::from_millis(2500),connection.appearance_permissions(&authority)).await
                                        .map_err(|_|"Native appearance permissions timed out")??;
                                    published_audience=Some(audience);
                                }
                                if let Some(publisher)=publisher.as_ref(){publisher.renew(publication_deadline(&authority));}
                                if let Ok(active)=active_capture.lock(){if let Some(source)=active.as_ref(){
                                    let controls=*control.borrow();let live=!stopped.load(Ordering::Acquire);
                                    source.set_enabled(live&&!controls.muted,live&&!controls.camera_off);
                                }}
                                let (video,audio)=returned.fresh();let mut status=statuses.borrow().clone();status.phase="live".into();status.on_stage=authority.on_stage;
                                status.has_program=video;status.has_audio=audio;status.return_source_id=Some(format!("guest-{}",authority.producer_participant_id));statuses.send_replace(status);
                            }
                        }
                        Ok::<(),&'static str>(())
                    }.await;
                    // Stop the independent reader and await its finite HTTP request;
                    // never abort an owner holding a native/SDK resource.
                    stopped.store(true,Ordering::Release);
                    if let Ok(mut capture)=active_capture.lock(){if let Some(s)=capture.take(){s.set_enabled(false,false);}}
                    returned.stop_playback();
                    if let Some(publisher)=publisher.as_ref(){publisher.request_stop();}
                    if let Some(connection)=connection.as_mut(){connection.begin_close();}
                    let _=reader.await;drop(initial_receiver.take());
                    let closed=retire(&mut connection,&mut publisher,&returned).await;
                    result.and(closed)
                }.await;
                returned.stop_playback();
                if let Ok(mut capture) = active_capture.lock() {
                    if let Some(s) = capture.take() {
                        s.set_enabled(false, false);
                    }
                }
                let mut status = statuses.borrow().clone();
                status.has_audio = false;
                status.has_program = false;
                status.on_stage = false;
                if run.is_err() {
                    status.phase = "error".into();
                } else if status.phase != "gone" {
                    status.phase = "gone".into();
                }
                statuses.send_replace(status);
                drop(target);
            });
            Ok(Self {
                id,
                stop,
                controls,
                status,
                task: Some(task),
                outputs,
                capture,
            })
        }
        pub fn id(&self) -> &str {
            &self.id
        }
        pub fn status(&self) -> AppearanceStatus {
            self.status.borrow().clone()
        }
        pub fn controls(&self, controls: Controls) {
            self.controls.send_replace(controls);
            if let Ok(active) = self.capture.lock() {
                if let Some(source) = active.as_ref() {
                    let live = !self.stop.load(Ordering::Acquire);
                    source.set_enabled(live && !controls.muted, live && !controls.camera_off);
                }
            }
            self.outputs.set_playback(controls.playback);
        }
        pub fn preview(&self) -> Vec<u8> {
            self.outputs.preview()
        }
        pub async fn close(&mut self) -> Result<(), &'static str> {
            self.stop.store(true, Ordering::Release);
            if let Ok(active) = self.capture.lock() {
                if let Some(source) = active.as_ref() {
                    source.set_enabled(false, false);
                }
            }
            self.outputs.stop_playback();
            if let Some(task) = self.task.take() {
                task.await
                    .map_err(|_| "Native appearance retirement task failed")?;
            }
            Ok(())
        }
    }
    impl Drop for AppearanceOwner {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            if let Ok(active) = self.capture.lock() {
                if let Some(source) = active.as_ref() {
                    source.set_enabled(false, false);
                }
            }
            self.outputs.stop_playback();
            if let Some(task) = self.task.take() {
                if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                    runtime.spawn(async move {
                        let _ = task.await;
                    });
                }
            }
        }
    }
}
#[cfg(all(feature = "guest-rtc-pilot", have_engine))]
pub use native::{AppearanceOwner, StartSpec};

#[tauri::command]
pub async fn live_appearance_start(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    appearance_id: String,
    local_room_id: String,
    api: String,
    invite: String,
    participant_id: String,
    portrait: bool,
    quality: u32,
    controls: Controls,
) -> EngineResult<AppearanceStatus> {
    #[cfg(all(feature = "guest-rtc-pilot", have_engine))]
    {
        use tauri::Manager;
        if !enabled() {
            return Err(EngineError::Other(
                "Native appearances require the opt-in candidate".into(),
            ));
        }
        uuid::Uuid::parse_str(&appearance_id)
            .map_err(|_| EngineError::Other("Invalid appearance ID".into()))?;
        let mut owner = state.rtc_appearance.lock().await;
        if let Some(owner) = owner.as_ref() {
            return if owner.id() == appearance_id {
                Ok(owner.status())
            } else {
                Err(EngineError::Other(
                    "A native appearance is already owned".into(),
                ))
            };
        }
        let id = appearance_id.clone();
        // Native room identity, selected output, capture lifetime and receiver
        // availability must all be established before contacting the issuer.
        let (target, outputs) = tauri::async_runtime::spawn_blocking(move || {
            app.state::<AppState>()
                .live
                .appearance_media(local_room_id, portrait, quality, id)
        })
        .await
        .map_err(|_| EngineError::Other("Native appearance preparation worker failed".into()))?
        .map_err(EngineError::Other)?;
        let started = AppearanceOwner::start(
            StartSpec {
                appearance_id,
                api,
                invite,
                participant_id,
            },
            target,
            outputs,
            controls,
        )
        .map_err(|e| EngineError::Other(e.into()))?;
        let status = started.status();
        *owner = Some(started);
        return Ok(status);
    }
    #[cfg(not(all(feature = "guest-rtc-pilot", have_engine)))]
    {
        let _ = (
            app,
            state,
            appearance_id,
            local_room_id,
            api,
            invite,
            participant_id,
            portrait,
            quality,
            controls,
        );
        Err(EngineError::Other(
            "Native appearances are unavailable in this build".into(),
        ))
    }
}
#[tauri::command]
pub async fn live_appearance_status(
    state: State<'_, AppState>,
    appearance_id: String,
) -> EngineResult<AppearanceStatus> {
    #[cfg(all(feature = "guest-rtc-pilot", have_engine))]
    {
        let owner = state.rtc_appearance.lock().await;
        return owner
            .as_ref()
            .filter(|o| o.id() == appearance_id)
            .map(|o| o.status())
            .ok_or_else(|| EngineError::Other("Native appearance owner changed".into()));
    }
    #[cfg(not(all(feature = "guest-rtc-pilot", have_engine)))]
    {
        let _ = (state, appearance_id);
        Err(EngineError::Other(
            "Native appearances are unavailable in this build".into(),
        ))
    }
}
#[tauri::command]
pub async fn live_appearance_controls(
    state: State<'_, AppState>,
    appearance_id: String,
    controls: Controls,
) -> EngineResult<()> {
    #[cfg(all(feature = "guest-rtc-pilot", have_engine))]
    {
        let owner = state.rtc_appearance.lock().await;
        let owner = owner
            .as_ref()
            .filter(|o| o.id() == appearance_id)
            .ok_or_else(|| EngineError::Other("Native appearance owner changed".into()))?;
        owner.controls(controls);
        return Ok(());
    }
    #[cfg(not(all(feature = "guest-rtc-pilot", have_engine)))]
    {
        let _ = (state, appearance_id, controls);
        Err(EngineError::Other(
            "Native appearances are unavailable in this build".into(),
        ))
    }
}
#[tauri::command]
pub async fn live_appearance_preview(
    state: State<'_, AppState>,
    appearance_id: String,
) -> EngineResult<tauri::ipc::Response> {
    #[cfg(all(feature = "guest-rtc-pilot", have_engine))]
    {
        let owner = state.rtc_appearance.lock().await;
        let owner = owner
            .as_ref()
            .filter(|o| o.id() == appearance_id)
            .ok_or_else(|| EngineError::Other("Native appearance owner changed".into()))?;
        return Ok(tauri::ipc::Response::new(owner.preview()));
    }
    #[cfg(not(all(feature = "guest-rtc-pilot", have_engine)))]
    {
        let _ = (state, appearance_id);
        Err(EngineError::Other(
            "Native appearances are unavailable in this build".into(),
        ))
    }
}
pub async fn stop_all(state: &State<'_, AppState>) -> EngineResult<()> {
    #[cfg(all(feature = "guest-rtc-pilot", have_engine))]
    {
        let mut owner = state.rtc_appearance.lock().await;
        if let Some(mut existing) = owner.take() {
            existing
                .close()
                .await
                .map_err(|e| EngineError::Other(e.into()))?;
        }
    }
    let _ = state;
    Ok(())
}
#[tauri::command]
pub async fn live_appearance_stop(
    state: State<'_, AppState>,
    appearance_id: String,
) -> EngineResult<()> {
    #[cfg(all(feature = "guest-rtc-pilot", have_engine))]
    {
        let mut owner = state.rtc_appearance.lock().await;
        if owner.as_ref().is_some_and(|o| o.id() == appearance_id) {
            if let Some(mut existing) = owner.take() {
                existing
                    .close()
                    .await
                    .map_err(|e| EngineError::Other(e.into()))?;
            }
        }
    }
    let _ = (state, appearance_id);
    Ok(())
}
