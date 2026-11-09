//! Independently fetched guest permissions. A session response cannot grant
//! itself authority, and a delayed response never receives a fresh deadline.
use crate::{ExpectedAuthority, PublishSource, Role, Scope, Session};
use serde::Deserialize;
use std::time::{Duration, Instant};

pub const FRESHNESS: Duration = Duration::from_millis(3500);
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StagePeer {
    pub participant_id: String,
    pub rtc_identity: String,
    pub authorization_generation: u64,
    pub can_publish_audio: bool,
    pub can_subscribe: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireAuthority {
    expected: ExpectedAuthority,
    producer_identity: String,
    #[serde(default)]
    on_stage: bool,
    #[serde(default)]
    stage_audio: Vec<StagePeer>,
}
#[derive(Clone)]
pub struct Authority {
    pub expected: ExpectedAuthority,
    pub producer_identity: String,
    pub producer_participant_id: String,
    pub on_stage: bool,
    pub stage_audio: Vec<StagePeer>,
    deadline: Instant,
}
fn canonical_id(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == b'-'
            } else {
                c.is_ascii_digit() || (b'a'..=b'f').contains(&c)
            }
        })
}
impl Authority {
    pub fn parse(
        bytes: &[u8],
        participant_id: &str,
        endpoint: &str,
        started: Instant,
        now: Instant,
    ) -> Result<Self, &'static str> {
        let invalid = "Native appearance authority mismatch";
        if bytes.len() > 32768 {
            return Err(invalid);
        }
        let wire: WireAuthority = serde_json::from_slice(bytes).map_err(|_| invalid)?;
        let e = &wire.expected;
        if e.role != Role::Guest
            || e.scope != Scope::Stage
            || e.private_participant_id.is_some()
            || e.participant_id != participant_id
            || e.endpoint != endpoint
            || !crate::cloud_endpoint_allowed(endpoint)
            || [&e.brand_id, &e.room_id, &e.run_id, &e.participant_id]
                .iter()
                .any(|id| !canonical_id(id))
            || [
                e.host_lease_epoch,
                e.control_revision,
                e.authorization_generation,
            ]
            .iter()
            .any(|n| *n == 0 || *n > crate::MAX_SAFE_INTEGER)
            || e.publish_sources.len() > 4
            || e.publish_sources
                .iter()
                .enumerate()
                .any(|(i, s)| e.publish_sources[..i].contains(s))
            || (e.publish_sources.contains(&PublishSource::ScreenShareAudio)
                && !e.publish_sources.contains(&PublishSource::ScreenShare))
            || wire.stage_audio.len() > 25
        {
            return Err(invalid);
        }
        let suffix = format!("-e{}-g1", e.host_lease_epoch);
        let host = wire
            .producer_identity
            .strip_prefix("producer-")
            .and_then(|v| v.strip_suffix(&suffix))
            .filter(|v| canonical_id(v))
            .ok_or(invalid)?
            .to_owned();
        let mut ids = std::collections::HashSet::new();
        for peer in &wire.stage_audio {
            if !canonical_id(&peer.participant_id)
                || peer.participant_id == participant_id
                || !ids.insert(&peer.participant_id)
                || peer.authorization_generation == 0
                || peer.authorization_generation > crate::MAX_SAFE_INTEGER
                || peer.rtc_identity
                    != format!(
                        "guest-{}-e{}-g{}",
                        peer.participant_id, e.host_lease_epoch, peer.authorization_generation
                    )
            {
                return Err(invalid);
            }
        }
        let deadline = started.checked_add(FRESHNESS).ok_or(invalid)?;
        if now >= deadline {
            return Err("Native appearance authority expired");
        }
        Ok(Self {
            expected: wire.expected,
            producer_identity: wire.producer_identity,
            producer_participant_id: host,
            on_stage: wire.on_stage,
            stage_audio: wire.stage_audio,
            deadline,
        })
    }
    pub fn current(&self, now: Instant) -> bool {
        now < self.deadline
    }
    pub fn deadline(&self) -> Instant {
        self.deadline
    }
    pub fn same_binding(&self, other: &Self) -> bool {
        let mut a = self.expected.clone();
        let mut b = other.expected.clone();
        a.control_revision = 0;
        b.control_revision = 0;
        a == b && self.producer_identity == other.producer_identity
    }
    pub fn supersedes(&self, old: &Self) -> bool {
        self.same_binding(old)
            && (self.expected.control_revision > old.expected.control_revision
                || self.expected.control_revision == old.expected.control_revision
                    && self.deadline > old.deadline)
    }
    pub fn session(&self, bytes: &[u8], now_ms: u64) -> Result<Session, &'static str> {
        if !self.current(Instant::now()) {
            return Err("Native appearance authority expired");
        }
        let session = Session::parse(bytes, &self.expected, now_ms)
            .map_err(|_| "Native appearance session mismatch")?;
        if session.appearance_sources().is_none()
            || session.expires_at_ms() <= now_ms.saturating_add(2000)
        {
            return Err("Native appearance session expired");
        }
        Ok(session)
    }
    pub fn allows(&self, source: PublishSource) -> bool {
        self.expected.publish_sources.contains(&source)
    }
    pub fn peer_audio_allowed(&self, peer: &StagePeer) -> bool {
        self.on_stage && self.expected.can_subscribe && peer.can_publish_audio
    }
    pub fn audio_recipients(&self) -> impl Iterator<Item = &str> {
        let allowed = self.on_stage && self.allows(PublishSource::Microphone);
        self.stage_audio
            .iter()
            .filter(move |p| allowed && p.can_subscribe)
            .map(|p| p.rtc_identity.as_str())
    }
    /// Expiring admission facts may change without a control revision. Compare
    /// the actual publication audience, never just the revision counter.
    pub fn publication_audience(&self) -> (String, Vec<String>) {
        let mut peers = self
            .audio_recipients()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        peers.sort();
        (self.producer_identity.clone(), peers)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    const GUEST: &str = "22222222-2222-4222-8222-222222222222";
    const HOST: &str = "11111111-1111-4111-8111-111111111111";
    const ENDPOINT: &str = "wss://fixture.livekit.cloud";
    fn wire() -> Value {
        json!({"expected":{"brand_id":HOST,"room_id":HOST,"run_id":HOST,
        "participant_id":GUEST,"role":"guest","scope":"stage","private_participant_id":null,
        "host_lease_epoch":2,"control_revision":7,"authorization_generation":3,"endpoint":ENDPOINT,
        "publish_sources":["camera","microphone"],"can_subscribe":true},
        "producer_identity":format!("producer-{HOST}-e2-g1"),"on_stage":true,"stage_audio":[]})
    }
    fn parse(v: &Value, started: Instant, now: Instant) -> Result<Authority, &'static str> {
        Authority::parse(
            &serde_json::to_vec(v).unwrap(),
            GUEST,
            ENDPOINT,
            started,
            now,
        )
    }
    #[test]
    fn independent_authority_rejects_wrong_identity_role_endpoint_and_stale_reads() {
        let now = Instant::now();
        let v = wire();
        assert!(parse(&v, now, now).is_ok());
        for (field, value) in [
            ("role", json!("producer")),
            ("scope", json!("private")),
            ("participant_id", json!(HOST)),
            ("endpoint", json!("wss://other.livekit.cloud")),
        ] {
            let mut bad = v.clone();
            bad["expected"][field] = value;
            assert!(parse(&bad, now, now).is_err());
        }
        assert!(parse(&v, now, now + FRESHNESS).is_err());
    }
    #[test]
    fn stale_revisions_and_grant_changes_cannot_reauthorize_existing_binding() {
        let now = Instant::now();
        let v = wire();
        let old = parse(&v, now, now).unwrap();
        let mut next = v.clone();
        next["expected"]["control_revision"] = json!(8);
        let new = parse(&next, now, now).unwrap();
        assert!(new.same_binding(&old));
        assert!(new.supersedes(&old));
        assert!(!old.supersedes(&new));
        next["expected"]["publish_sources"] = json!(["camera"]);
        assert!(!parse(&next, now, now).unwrap().same_binding(&new));
    }
    #[test]
    fn peer_audio_is_stage_scoped_and_not_an_unrestricted_camera_grant() {
        let now = Instant::now();
        let mut v = wire();
        v["stage_audio"] = json!([{"participant_id":HOST,"rtc_identity":format!("guest-{HOST}-e2-g4"),
            "authorization_generation":4,"can_publish_audio":true,"can_subscribe":true}]);
        let a = parse(&v, now, now).unwrap();
        assert!(a.peer_audio_allowed(&a.stage_audio[0]));
        assert_eq!(a.audio_recipients().count(), 1);
        v["on_stage"] = json!(false);
        let a = parse(&v, now, now).unwrap();
        assert!(!a.peer_audio_allowed(&a.stage_audio[0]));
        assert_eq!(a.audio_recipients().count(), 0);
        v["stage_audio"][0]["rtc_identity"] = json!(format!("guest-{HOST}-e1-g4"));
        assert!(parse(&v, now, now).is_err());
    }
    #[test]
    fn issuer_session_cannot_widen_grants_or_replace_the_guest_identity() {
        let now = Instant::now();
        let a = parse(&wire(), now, now).unwrap();
        let mut session = wire()["expected"].clone();
        let fields = json!({"schema_version":1,"transport":"livekit",
            "issued_at_ms":1791700000000u64,"expires_at_ms":1791700120000u64,
            "provider_room":format!("b_{HOST}_r_{HOST}_run_{HOST}_stage"),
            "rtc_identity":format!("guest-{GUEST}-e2-g3"),"join_token":"fixture.payload.signature"});
        for (key, value) in fields.as_object().unwrap() {
            session[key] = value.clone();
        }
        let accepted = a
            .session(&serde_json::to_vec(&session).unwrap(), 1791700000500)
            .unwrap();
        assert!(accepted.appearance_sources().is_some());
        assert!(!accepted.can_publish_program());
        for (field, value) in [
            ("role", json!("producer")),
            ("rtc_identity", json!(format!("producer-{HOST}-e2-g1"))),
            (
                "publish_sources",
                json!(["camera", "microphone", "screen_share"]),
            ),
        ] {
            let mut bad = session.clone();
            bad[field] = value;
            assert!(a
                .session(&serde_json::to_vec(&bad).unwrap(), 1791700000500)
                .is_err());
        }
    }
    #[test]
    fn same_revision_peer_expiry_changes_publication_permissions() {
        let now = Instant::now();
        let mut v = wire();
        v["stage_audio"] = json!([{"participant_id":HOST,"rtc_identity":format!("guest-{HOST}-e2-g4"),
            "authorization_generation":4,"can_publish_audio":true,"can_subscribe":true}]);
        let before = parse(&v, now, now).unwrap();
        assert_eq!(before.publication_audience().1.len(), 1);
        v["stage_audio"] = json!([]);
        let after = parse(
            &v,
            now + Duration::from_millis(100),
            now + Duration::from_millis(100),
        )
        .unwrap();
        assert_eq!(
            before.expected.control_revision,
            after.expected.control_revision
        );
        assert!(after.same_binding(&before));
        assert!(after.supersedes(&before));
        assert_ne!(before.publication_audience(), after.publication_audience());
        assert!(after.publication_audience().1.is_empty());
    }
}
