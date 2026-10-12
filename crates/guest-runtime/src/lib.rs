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

pub struct Connection {
    room: Option<Room>,
    events: Option<JoinHandle<()>>,
    stop: Option<oneshot::Sender<()>>,
    healthy: Arc<AtomicBool>,
    authority: watch::Sender<Option<Arc<authority::Snapshot>>>,
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
                        None | Some(RoomEvent::Disconnected { .. }) => break,
                        Some(RoomEvent::Reconnecting) => { health.store(false, Ordering::Release); subscriptions.authority(None); }
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
        })
    }
    pub fn media_authority(&self, snapshot: authority::Snapshot) -> Result<(), &'static str> {
        if !self.healthy() {
            return Err("Native RTC connection unavailable");
        }
        self.authority
            .send(Some(Arc::new(snapshot)))
            .map_err(|_| "Native RTC event owner unavailable")
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
            room.close().await.map_err(|_| "Native RTC close failed")
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
