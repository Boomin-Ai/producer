//! Independent, expiring permissions for incoming tracks. No provider tokens.
use producer_guest_session::PublishSource;
use serde::Deserialize;
use std::{
    collections::HashSet,
    time::{Duration, Instant},
};
const MAX_COUNTER: u64 = 9_007_199_254_740_991;
const MAX_STALENESS_MS: u64 = 3500;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostReceipt {
    pub brand_id: String,
    pub room_id: String,
    pub run_id: String,
    pub host_process_id: String,
    pub host_participant_id: String,
    pub transport: String,
    pub endpoint: String,
    pub state: String,
    pub host_lease_epoch: u64,
    pub control_revision: u64,
    pub host_lease_expires_at_ms: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WirePermission {
    participant_id: String,
    rtc_identity: String,
    authorization_generation: u64,
    publish_sources: Vec<PublishSource>,
    expires_at_ms: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireSnapshot {
    schema_version: u32,
    receipt: HostReceipt,
    observed_at_ms: u64,
    guests: Vec<WirePermission>,
}
#[derive(Clone)]
pub struct Permission {
    participant_id: String,
    identity: String,
    sources: Vec<PublishSource>,
    deadline: Instant,
}
impl Permission {
    pub fn rtc_identity(&self) -> &str {
        &self.identity
    }
    pub fn participant_id(&self) -> &str {
        &self.participant_id
    }
    pub fn source_id(&self) -> String {
        format!("guest-{}", self.participant_id)
    }
    pub fn allows(&self, identity: &str, source: PublishSource, now: Instant) -> bool {
        now < self.deadline && identity == self.identity && self.sources.contains(&source)
    }
}
pub struct Snapshot {
    receipt: HostReceipt,
    permissions: Vec<Permission>,
    deadline: Instant,
}
impl Snapshot {
    /// Request start bounds freshness, including time spent in HTTP/SDK queues.
    /// A delayed response cannot buy a fresh 3.5 seconds after it arrives.
    pub fn parse(
        bytes: &[u8],
        expected: &HostReceipt,
        local_wall_ms: u64,
        request_started: Instant,
        now: Instant,
    ) -> Result<Self, &'static str> {
        let invalid = "Native guest media authority mismatch";
        if bytes.len() > 32768 {
            return Err(invalid);
        }
        let wire: WireSnapshot = serde_json::from_slice(bytes).map_err(|_| invalid)?;
        let r = &wire.receipt;
        if wire.schema_version != 1
            || wire.guests.len() > 25
            || r.transport != "livekit"
            || r.state != "active"
            || r.brand_id != expected.brand_id
            || r.room_id != expected.room_id
            || r.run_id != expected.run_id
            || r.host_process_id != expected.host_process_id
            || r.host_participant_id != expected.host_participant_id
            || r.host_lease_epoch != expected.host_lease_epoch
            || r.endpoint != expected.endpoint
            || r.control_revision == 0
            || r.control_revision < expected.control_revision
            || r.control_revision > MAX_COUNTER
            || r.host_lease_epoch == 0
            || r.host_lease_epoch > MAX_COUNTER
            || wire.observed_at_ms > MAX_COUNTER
            || wire.observed_at_ms.abs_diff(local_wall_ms) > 30000
            || r.host_lease_expires_at_ms <= wire.observed_at_ms
            || r.host_lease_expires_at_ms > MAX_COUNTER
        {
            return Err(invalid);
        }
        for id in [
            &r.brand_id,
            &r.room_id,
            &r.run_id,
            &r.host_process_id,
            &r.host_participant_id,
        ] {
            canonical_uuid(id).ok_or(invalid)?;
        }
        let duration = MAX_STALENESS_MS.min(r.host_lease_expires_at_ms - wire.observed_at_ms);
        let deadline = request_started
            .checked_add(Duration::from_millis(duration))
            .ok_or(invalid)?;
        if now >= deadline {
            return Err("Native guest authority response expired");
        }
        let mut ids = HashSet::new();
        let mut permissions = Vec::new();
        for p in wire.guests {
            canonical_uuid(&p.participant_id).ok_or(invalid)?;
            if !ids.insert(p.participant_id.clone())
                || p.authorization_generation == 0
                || p.authorization_generation > MAX_COUNTER
                || p.publish_sources.len() > 4
                || p.expires_at_ms <= wire.observed_at_ms
                || p.expires_at_ms > r.host_lease_expires_at_ms
                || p.expires_at_ms - wire.observed_at_ms > 120000
                || p.rtc_identity
                    != format!(
                        "guest-{}-e{}-g{}",
                        p.participant_id, r.host_lease_epoch, p.authorization_generation
                    )
                || p.publish_sources
                    .iter()
                    .enumerate()
                    .any(|(i, s)| p.publish_sources[..i].contains(s))
            {
                return Err(invalid);
            }
            let guest_deadline = request_started
                .checked_add(Duration::from_millis(
                    duration.min(p.expires_at_ms - wire.observed_at_ms),
                ))
                .ok_or(invalid)?;
            permissions.push(Permission {
                participant_id: p.participant_id,
                identity: p.rtc_identity,
                sources: p.publish_sources,
                deadline: guest_deadline,
            });
        }
        Ok(Self {
            receipt: wire.receipt,
            permissions,
            deadline,
        })
    }
    pub fn receipt(&self) -> &HostReceipt {
        &self.receipt
    }
    pub fn current(&self, now: Instant) -> bool {
        now < self.deadline
    }
    pub fn permission(
        &self,
        identity: &str,
        source: PublishSource,
        now: Instant,
    ) -> Option<&Permission> {
        if !self.current(now) {
            return None;
        }
        self.permissions
            .iter()
            .find(|p| p.allows(identity, source, now))
    }
}
fn canonical_uuid(value: &str) -> Option<()> {
    let id = uuid::Uuid::parse_str(value).ok()?;
    (id.hyphenated().to_string() == value).then_some(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    const WALL: u64 = 1791800000000;
    fn fixture() -> (HostReceipt, Value, String) {
        let host = "11111111-1111-4111-8111-111111111111";
        let guest = "22222222-2222-4222-8222-222222222222";
        let receipt = json!({"brand_id":host,"room_id":host,"run_id":host,"host_process_id":host,
          "host_participant_id":host,"transport":"livekit","endpoint":"wss://fixture.livekit.cloud",
          "state":"active","host_lease_epoch":2,"control_revision":7,"host_lease_expires_at_ms":WALL+45000});
        let expected = serde_json::from_value(receipt.clone()).unwrap();
        let identity = format!("guest-{guest}-e2-g3");
        (
            expected,
            json!({"schema_version":1,"receipt":receipt,"observed_at_ms":WALL,"guests":[{
            "participant_id":guest,"rtc_identity":identity,"authorization_generation":3,
            "publish_sources":["camera","microphone"],"expires_at_ms":WALL+45000}]}),
            identity,
        )
    }
    fn parse(
        expected: &HostReceipt,
        wire: &Value,
        start: Instant,
        now: Instant,
    ) -> Result<Snapshot, &'static str> {
        Snapshot::parse(
            &serde_json::to_vec(wire).unwrap(),
            expected,
            WALL,
            start,
            now,
        )
    }
    #[test]
    fn identity_generation_and_source_are_required_and_freshness_expires() {
        let (expected, wire, identity) = fixture();
        let start = Instant::now();
        let s = parse(&expected, &wire, start, start).unwrap();
        assert!(s
            .permission(&identity, PublishSource::Camera, start)
            .is_some());
        assert!(s
            .permission(&identity.replace("g3", "g2"), PublishSource::Camera, start)
            .is_none());
        assert!(s
            .permission(&identity, PublishSource::ScreenShare, start)
            .is_none());
        assert!(s
            .permission(
                &identity,
                PublishSource::Camera,
                start + Duration::from_millis(3500)
            )
            .is_none());
    }
    #[test]
    fn delayed_response_does_not_restart_freshness() {
        let (expected, wire, _) = fixture();
        let start = Instant::now();
        assert!(parse(&expected, &wire, start, start + Duration::from_millis(3500)).is_err());
        let s = parse(&expected, &wire, start, start + Duration::from_millis(3000)).unwrap();
        assert!(!s.current(start + Duration::from_millis(3500)));
    }
    #[test]
    fn removal_or_muting_revokes_previous_permissions() {
        let (expected, mut wire, identity) = fixture();
        let start = Instant::now();
        wire["guests"][0]["publish_sources"] = json!(["camera"]);
        let s = parse(&expected, &wire, start, start).unwrap();
        assert!(s
            .permission(&identity, PublishSource::Microphone, start)
            .is_none());
        wire["guests"] = json!([]);
        assert!(parse(&expected, &wire, start, start)
            .unwrap()
            .permission(&identity, PublishSource::Camera, start)
            .is_none());
    }
    #[test]
    fn malformed_or_conflicting_authority_fails_closed() {
        let (expected, wire, _) = fixture();
        let start = Instant::now();
        let mutations: Vec<Box<dyn Fn(&mut Value)>> = vec![
            Box::new(|v| v["receipt"]["control_revision"] = json!(6)),
            Box::new(|v| v["receipt"]["host_lease_epoch"] = json!(3)),
            Box::new(|v| {
                v["receipt"]["host_process_id"] = json!("22222222-2222-4222-8222-222222222222")
            }),
            Box::new(|v| v["receipt"]["endpoint"] = json!("wss://different.livekit.cloud")),
            Box::new(|v| v["guests"][0]["expires_at_ms"] = json!(WALL + 45001)),
            Box::new(|v| v["guests"][0]["authorization_generation"] = json!(4)),
            Box::new(|v| v["guests"][0]["publish_sources"] = json!(["camera", "camera"])),
            Box::new(|v| v["guests"][0]["join_token"] = json!("unexpected credential")),
            Box::new(|v| v["guests"] = json!([v["guests"][0].clone(), v["guests"][0].clone()])),
        ];
        for mutate in mutations {
            let mut v = wire.clone();
            mutate(&mut v);
            assert!(parse(&expected, &v, start, start).is_err());
        }
    }
    #[test]
    fn admission_expiry_shortens_permission() {
        let (expected, mut wire, identity) = fixture();
        let start = Instant::now();
        wire["guests"][0]["expires_at_ms"] = json!(WALL + 1000);
        let s = parse(&expected, &wire, start, start).unwrap();
        assert!(s
            .permission(
                &identity,
                PublishSource::Camera,
                start + Duration::from_millis(999)
            )
            .is_some());
        assert!(s
            .permission(
                &identity,
                PublishSource::Camera,
                start + Duration::from_millis(1000)
            )
            .is_none());
    }
}
