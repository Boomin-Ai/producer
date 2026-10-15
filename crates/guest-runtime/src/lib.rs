//! Owned native SDK connection. No automatic subscription or device acquisition.
//! Media must be attached by a separately authorized room adapter.
use livekit::{ConnectionState, Room, RoomEvent, RoomOptions};
use producer_guest_session::Session;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use tokio::{
    sync::{oneshot, watch},
    task::JoinHandle,
};
mod subscriptions;
pub use subscriptions::GuestMedia;
pub mod authority;
pub mod media;
pub mod program;
mod timing {
    #[cfg(debug_assertions)]
    pub mod capture_clock;
    #[cfg(debug_assertions)]
    pub mod markers;
    pub mod playout_clock;
    pub mod presentation;
    pub mod queue;
    pub mod sender_clock;
}

#[derive(Clone)]
pub struct MediaAuthorityUpdater {
    authority: watch::Sender<Option<Arc<authority::Snapshot>>>,
    healthy: Arc<AtomicBool>,
}
impl MediaAuthorityUpdater {
    pub fn publish(&self, snapshot: authority::Snapshot) -> Result<bool, &'static str> {
        if !snapshot.current(std::time::Instant::now()) { return Err("Native guest authority response expired"); }
        let mut closed = false;
        let changed = self.authority.send_if_modified(|current| {
            // Check inside the watch write lock: close cannot be followed by a
            // late read restoring media permissions to a stopped connection.
            if !self.healthy.load(Ordering::Acquire) { closed = true; return false; }
            if current.as_ref().is_some_and(|old| !snapshot.supersedes(old)) { return false; }
            *current = Some(Arc::new(snapshot)); true
        });
        if closed { Err("Native RTC connection unavailable") } else { Ok(changed) }
    }
}

pub struct Connection {
    room: Option<Room>,
    events: Option<JoinHandle<()>>,
    stop: Option<oneshot::Sender<()>>,
    healthy: Arc<AtomicBool>,
    authority: watch::Sender<Option<Arc<authority::Snapshot>>>,
    program_allowed: bool,
    program_started: bool,
    program_ids: Option<(livekit::id::TrackSid, livekit::id::TrackSid)>,
}
impl Connection {
    pub async fn connect(session: &Session) -> Result<Self, &'static str> {
        Self::connect_with_media(session, None).await
    }
    pub async fn connect_with_media(
        session: &Session,
        sink: Option<Box<dyn GuestMedia>>,
    ) -> Result<Self, &'static str> {
        // Own the media adapter even through partial initialization failures.
        let mut subscriptions = subscriptions::Subscriptions::new(sink);
        let mut options = RoomOptions::default();
        options.auto_subscribe = false;
        options.join_retries = 0;
        options.connect_timeout = Duration::from_secs(8);
        let (room, mut events) = Room::connect(session.endpoint(), session.join_token(), options)
            .await
            .map_err(|_| "Native RTC connection failed")?;
        if room.local_participant().identity().as_str() != session.rtc_identity() {
            let _ = room.close().await;
            return Err("Native RTC identity mismatch");
        }
        let healthy = Arc::new(AtomicBool::new(
            room.connection_state() == ConnectionState::Connected,
        ));
        let health = healthy.clone();
        let (stop, mut stopped) = oneshot::channel();
        // This task owns only its event receiver and a health flag, never a Room clone.
        // It drains SDK events promptly; credentials/data payloads are never logged.
        let (authority, mut permissions) = watch::channel(None);
        for participant in room.remote_participants().into_values() {
            if !subscriptions.participant(&participant) {
                let _ = room.close().await;
                return Err("Native RTC publication capacity exceeded");
            }
        }
        let task = tokio::spawn(async move {
            let mut expiry = tokio::time::interval(Duration::from_millis(50));
            expiry.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {
                    biased;
                    _ = &mut stopped => break,
                    _ = expiry.tick() => subscriptions.reconcile(),
                    changed = permissions.changed() => {
                        if changed.is_err() {break;}
                        subscriptions.authority(permissions.borrow_and_update().clone());
                    }
                    event = events.recv() => match event {
                        None => { eprintln!("Native RTC event stream ended"); break; }
                        Some(RoomEvent::Disconnected { reason, .. }) => { eprintln!("Native RTC disconnected: {reason:?}"); break; }
                        Some(RoomEvent::Reconnecting) => { eprintln!("Native RTC reconnect requires fresh owner authorization"); health.store(false, Ordering::Release); subscriptions.authority(None); }
                        // A reconnect does not restore publication authorization. The
                        // room adapter must obtain fresh independent authority first.
                        Some(RoomEvent::Reconnected) => { health.store(false, Ordering::Release); }
                        Some(RoomEvent::ParticipantConnected(participant)) => {if !subscriptions.participant(&participant){break;}},
                        Some(RoomEvent::ParticipantDisconnected(participant)) => subscriptions.disconnected(participant.identity().as_str()),
                        Some(RoomEvent::TrackPublished {participant,publication}) => {if !subscriptions.published(&participant,publication){break;}},
                        Some(RoomEvent::TrackUnpublished {publication,..}) => subscriptions.unpublished(&publication.sid().to_string()),
                        Some(RoomEvent::TrackUnsubscribed {publication,..}) => subscriptions.unsubscribed(&publication.sid().to_string()),
                        Some(RoomEvent::TrackSubscribed {participant,publication,track}) => {if !subscriptions.subscribed(&participant,&publication,track){break;}},
                        _ => {}
                    }
                }
            }
            subscriptions.close();
            health.store(false, Ordering::Release);
        });
        Ok(Self {
            room: Some(room),
            events: Some(task),
            stop: Some(stop),
            healthy,
            authority,
            program_allowed: session.can_publish_program(),
            program_started: false,
            program_ids: None,
        })
    }
    pub async fn publish_program(&mut self) -> Result<program::Sources, &'static str> {
        if !self.healthy() || !self.program_allowed || self.program_started {
            return Err("Native program publication unauthorized or already started");
        }
        self.program_started = true;
        let (sources, ids) = program::Sources::publish(self.room.as_ref().ok_or("Native RTC room unavailable")?).await?;
        self.program_ids = Some(ids);
        Ok(sources)
    }
    /// Only the pair this connection itself published may be retired here.
    pub async fn retire_program(&mut self) -> Result<(), &'static str> {
        let room = self.room.as_ref().ok_or("Native RTC room unavailable")?;
        let (audio, video) = self.program_ids.take().ok_or("Native program publication unavailable")?;
        let audio = room.local_participant().unpublish_track(&audio).await;
        let video = room.local_participant().unpublish_track(&video).await;
        audio.map_err(|_| "Native program audio retirement failed")?;
        video.map_err(|_| "Native program video retirement failed")?;
        self.program_started = false;
        Ok(())
    }
    pub fn media_authority(&self, snapshot: authority::Snapshot) -> Result<(), &'static str> {
        if !self.healthy() {
            return Err("Native RTC connection unavailable");
        }
        self.media_authority_updater().publish(snapshot).map(|_| ())
    }
    pub fn media_authority_updater(&self) -> MediaAuthorityUpdater {
        MediaAuthorityUpdater { authority: self.authority.clone(), healthy: self.healthy.clone() }
    }
    /// Debug proof hook: close the actual SDK transport, not just an app flag.
    #[cfg(debug_assertions)]
    pub async fn disconnect_for_test(&self) {
        self.healthy.store(false,Ordering::Release);
        self.authority.send_replace(None);
        if let Some(room)=self.room.as_ref(){let _=room.close().await;}
    }
    pub fn healthy(&self) -> bool {
        self.healthy.load(Ordering::Acquire)
    }
    pub async fn close(&mut self) -> Result<(), &'static str> {
        self.healthy.store(false, Ordering::Release);
        let _ = self.authority.send(None);
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        let joined = if let Some(task) = self.events.take() {
            task.await.map_err(|_| "Native RTC event task failed")
        } else {
            Ok(())
        };
        let closed = if let Some(room) = self.room.take() {
            match room.close().await {
                Ok(()) | Err(livekit::RoomError::AlreadyClosed) => Ok(()),
                Err(_) => Err("Native RTC close failed"),
            }
        } else {
            Ok(())
        };
        joined?;
        closed
    }
}
impl Drop for Connection {
    fn drop(&mut self) {
        self.healthy.store(false, Ordering::Release);
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        // Normal owners must explicitly await close. Abnormal drop still transfers
        // both SDK close and event-task join to one cleanup task, never aborts them.
        let room = self.room.take();
        let task = self.events.take();
        if room.is_some() || task.is_some() {
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    if let Some(task) = task {
                        let _ = task.await;
                    }
                    if let Some(room) = room {
                        let _ = room.close().await;
                    }
                });
            }
        }
    }
}

#[cfg(test)]
mod authority_update_tests {
    use super::*;
    use serde_json::json;
    fn snapshot(revision: u64, on_stage: bool, age: Duration) -> authority::Snapshot {
        let id="11111111-1111-4111-8111-111111111111";
        let wall=1791800000000u64;let start=std::time::Instant::now()-age;
        let receipt=json!({"brand_id":id,"room_id":id,"run_id":id,"host_process_id":id,"host_participant_id":id,"transport":"livekit","endpoint":"wss://fixture.livekit.cloud","state":"active","host_lease_epoch":1,"control_revision":revision,"host_lease_expires_at_ms":wall+45000});
        let expected:authority::HostReceipt=serde_json::from_value(receipt.clone()).unwrap();
        let wire=json!({"schema_version":1,"receipt":receipt,"observed_at_ms":wall,"guests":[{"participant_id":id,"rtc_identity":format!("guest-{id}-e1-g1"),"authorization_generation":1,"publish_sources":["camera","microphone"],"on_stage":on_stage,"expires_at_ms":wall+45000}]});
        authority::Snapshot::parse(&serde_json::to_vec(&wire).unwrap(),&expected,wall,start,std::time::Instant::now()).unwrap()
    }
    #[test]
    fn delayed_old_revision_cannot_restore_broadcast_audio() {
        let (sender,_receiver)=watch::channel(None);
        let updater=MediaAuthorityUpdater { authority: sender.clone(), healthy:Arc::new(AtomicBool::new(true)) };
        assert!(updater.publish(snapshot(9,false,Duration::ZERO)).unwrap());
        assert!(!updater.publish(snapshot(8,true,Duration::ZERO)).unwrap());
        let value=sender.borrow();let snapshot=value.as_ref().unwrap();
        let id="guest-11111111-1111-4111-8111-111111111111-e1-g1";
        assert!(!snapshot.permission(id,producer_guest_session::PublishSource::Microphone,std::time::Instant::now()).unwrap().on_stage());
    }
    #[test]
    fn older_same_revision_response_cannot_reduce_freshness() {
        let (sender,_receiver)=watch::channel(None);
        let updater=MediaAuthorityUpdater { authority:sender.clone(), healthy:Arc::new(AtomicBool::new(true)) };
        assert!(updater.publish(snapshot(9,true,Duration::ZERO)).unwrap());
        assert!(!updater.publish(snapshot(9,true,Duration::from_secs(1))).unwrap());
    }
    #[test]
    fn closed_connection_cannot_be_revived_by_pending_read() {
        let (sender,_receiver)=watch::channel(None);
        let health=Arc::new(AtomicBool::new(true));
        let updater=MediaAuthorityUpdater { authority:sender.clone(),healthy:health.clone() };
        assert!(updater.publish(snapshot(9,true,Duration::ZERO)).unwrap());
        health.store(false,Ordering::Release);sender.send_replace(None);
        assert!(updater.publish(snapshot(10,true,Duration::ZERO)).is_err());
        assert!(sender.borrow().is_none());
    }
}
