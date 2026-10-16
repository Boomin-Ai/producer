//! Track subscriptions belong to the same owner as their media observers.
//! Remote metadata is never a permission. An absent sink subscribes to nothing.
use crate::authority::{Permission, Snapshot};
use livekit::prelude::{
    RemoteParticipant, RemoteTrack, RemoteTrackPublication, TrackKind, TrackSource,
};
use producer_guest_session::PublishSource;
use std::{collections::HashMap, sync::Arc, time::Instant};

/// Implementations must bound queues, preserve sender timing, and invalidate
/// delivery handles before detaching observers. No blocking network calls.
pub trait GuestMedia: Send + 'static {
    fn can_receive(&self, permission: &Permission, source: PublishSource) -> bool;
    fn reconcile(&mut self, authority: Option<&Snapshot>, now: Instant);
    fn attach(
        &mut self,
        permission: &Permission,
        source: PublishSource,
        sid: &str,
        track: RemoteTrack,
    ) -> Result<(), &'static str>;
    fn detach(&mut self, sid: &str);
    /// Removes native observers and joins every delivery worker before return.
    fn close(&mut self);
}
struct Publication {
    identity: String,
    publication: RemoteTrackPublication,
}
pub(crate) struct Subscriptions {
    publications: HashMap<String, Publication>,
    authority: Option<Arc<Snapshot>>,
    sink: Option<Box<dyn GuestMedia>>,
}
impl Subscriptions {
    pub fn new(sink: Option<Box<dyn GuestMedia>>) -> Self {
        Self {
            publications: HashMap::new(),
            authority: None,
            sink,
        }
    }
    pub fn authority(&mut self, authority: Option<Arc<Snapshot>>) {
        self.authority = authority;
        self.reconcile();
    }
    pub fn participant(&mut self, participant: &RemoteParticipant) -> bool {
        for publication in participant.track_publications().into_values() {
            if !self.published(participant, publication) {
                return false;
            }
        }
        true
    }
    pub fn published(
        &mut self,
        participant: &RemoteParticipant,
        publication: RemoteTrackPublication,
    ) -> bool {
        let sid = publication.sid().to_string();
        if self.publications.len() >= 150 && !self.publications.contains_key(&sid) {
            publication.set_subscribed(false);
            return false;
        }
        self.publications.insert(
            sid,
            Publication {
                identity: participant.identity().to_string(),
                publication,
            },
        );
        self.reconcile();
        true
    }
    fn allowed(&self, p: &Publication, now: Instant) -> Option<(&Permission, PublishSource)> {
        let kind = source(&p.publication)?;
        let snapshot = self.authority.as_ref()?;
        let permission = snapshot.permission(&p.identity, kind, now)?;
        let count = self
            .publications
            .values()
            .filter(|other| {
                other.identity == p.identity && source(&other.publication) == Some(kind)
            })
            .count();
        if count != 1 || !self.sink.as_ref()?.can_receive(permission, kind) {
            return None;
        }
        Some((permission, kind))
    }
    pub fn reconcile(&mut self) {
        let now = Instant::now();
        if let Some(sink) = self.sink.as_mut() {
            sink.reconcile(self.authority.as_deref().filter(|s| s.current(now)), now);
        }
        for (sid, p) in &self.publications {
            let desired = self.allowed(p, now).is_some();
            if !desired {
                if let Some(sink) = self.sink.as_mut() {
                    sink.detach(sid);
                }
            }
            if p.publication.is_desired() != desired {
                p.publication.set_subscribed(desired);
            }
        }
    }
    pub fn subscribed(
        &mut self,
        participant: &RemoteParticipant,
        publication: &RemoteTrackPublication,
        track: RemoteTrack,
    ) -> bool {
        let sid = publication.sid().to_string();
        let now = Instant::now();
        let identity = participant.identity().to_string();
        let permit = self
            .publications
            .get(&sid)
            .filter(|p| p.identity == identity)
            .and_then(|p| self.allowed(p, now));
        let Some((permission, source)) = permit else {
            publication.set_subscribed(false);
            return true;
        };
        let authority = self.authority.as_ref().unwrap().clone();
        let participant_id = permission.participant_id().to_owned();
        let permission = authority
            .permission(&identity, source, now)
            .filter(|p| p.participant_id() == participant_id)
            .unwrap();
        if self
            .sink
            .as_mut()
            .unwrap()
            .attach(permission, source, &sid, track)
            .is_err()
        {
            publication.set_subscribed(false);
            return false;
        }
        true
    }
    pub fn unsubscribed(&mut self, sid: &str) {
        if let Some(sink) = self.sink.as_mut() {
            sink.detach(sid);
        }
    }
    pub fn unpublished(&mut self, sid: &str) {
        self.unsubscribed(sid);
        self.publications.remove(sid);
        self.reconcile();
    }
    pub fn disconnected(&mut self, identity: &str) {
        let sids: Vec<_> = self
            .publications
            .iter()
            .filter(|(_, p)| p.identity == identity)
            .map(|(sid, _)| sid.clone())
            .collect();
        for sid in sids {
            self.unpublished(&sid);
        }
    }
    pub fn close(&mut self) {
        self.authority = None;
        if let Some(mut sink) = self.sink.take() {
            sink.close();
        }
        for p in self.publications.values() {
            p.publication.set_subscribed(false);
        }
        self.publications.clear();
    }
}
impl Drop for Subscriptions {
    fn drop(&mut self) {
        self.close();
    }
}
fn source(p: &RemoteTrackPublication) -> Option<PublishSource> {
    match (p.source(), p.kind()) {
        (TrackSource::Camera, TrackKind::Video) => Some(PublishSource::Camera),
        (TrackSource::Microphone, TrackKind::Audio) => Some(PublishSource::Microphone),
        // Screen tracks require a distinct scene/source binding; unsupported
        // sources cannot enter a camera slot through a misleading name.
        _ => None,
    }
}
