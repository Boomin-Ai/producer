//! Ephemeral, server-authorized RTC session boundary, shared by app and lab.
//! No token is serializable or included in Debug. This validates the response
//! against independently held room authority; it does not verify JWT signatures
//! or replace backend fencing/provider revocation. No SDK or media owners here.
use serde::Deserialize;
use std::fmt;

const MAX_BODY_BYTES: usize = 32_768;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_TTL_MS: u64 = 120_000;
const CLOCK_SKEW_MS: u64 = 30_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Producer,
    Guest,
    Monitor,
}
impl Role {
    fn label(self) -> &'static str {
        match self {
            Self::Producer => "producer",
            Self::Guest => "guest",
            Self::Monitor => "monitor",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    Stage,
    Private,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PublishSource {
    Camera,
    Microphone,
    ScreenShare,
    ScreenShareAudio,
}

#[derive(Deserialize)]
#[serde(transparent)]
struct JoinToken(String);
impl fmt::Debug for JoinToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[redacted]")
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireSession {
    schema_version: u32,
    transport: String,
    brand_id: String,
    room_id: String,
    run_id: String,
    participant_id: String,
    role: Role,
    scope: Scope,
    #[serde(deserialize_with = "nullable_id")]
    private_participant_id: Option<String>,
    host_lease_epoch: u64,
    control_revision: u64,
    authorization_generation: u64,
    provider_room: String,
    rtc_identity: String,
    endpoint: String,
    issued_at_ms: u64,
    expires_at_ms: u64,
    publish_sources: Vec<PublishSource>,
    can_subscribe: bool,
    join_token: JoinToken,
}

/// From the current authenticated control snapshot, never this session response.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExpectedAuthority {
    pub brand_id: String,
    pub room_id: String,
    pub run_id: String,
    pub participant_id: String,
    pub role: Role,
    pub scope: Scope,
    pub private_participant_id: Option<String>,
    pub host_lease_epoch: u64,
    pub control_revision: u64,
    pub authorization_generation: u64,
    pub endpoint: String,
    pub publish_sources: Vec<PublishSource>,
    pub can_subscribe: bool,
}

fn nullable_id<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(d)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionError {
    Malformed,
    Unsupported,
    AuthorityMismatch,
    EndpointMismatch,
    IdentityMismatch,
    Expired,
    InvalidLifetime,
    InvalidSources,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    const NOW: u64 = 1_791_700_000_500;
    fn fixture() -> Value {
        serde_json::from_str(include_str!("../fixtures/session-v1.json")).unwrap()
    }
    fn authority(value: &Value) -> ExpectedAuthority {
        ExpectedAuthority {
            brand_id: value["brand_id"].as_str().unwrap().into(),
            room_id: value["room_id"].as_str().unwrap().into(),
            run_id: value["run_id"].as_str().unwrap().into(),
            participant_id: value["participant_id"].as_str().unwrap().into(),
            role: serde_json::from_value(value["role"].clone()).unwrap(),
            scope: serde_json::from_value(value["scope"].clone()).unwrap(),
            private_participant_id: serde_json::from_value(value["private_participant_id"].clone())
                .unwrap(),
            host_lease_epoch: value["host_lease_epoch"].as_u64().unwrap(),
            control_revision: value["control_revision"].as_u64().unwrap(),
            authorization_generation: value["authorization_generation"].as_u64().unwrap(),
            endpoint: value["endpoint"].as_str().unwrap().into(),
            publish_sources: serde_json::from_value(value["publish_sources"].clone()).unwrap(),
            can_subscribe: value["can_subscribe"].as_bool().unwrap(),
        }
    }
    fn parse(v: &Value, expected: &ExpectedAuthority) -> Result<Session, SessionError> {
        Session::parse(&serde_json::to_vec(v).unwrap(), expected, NOW)
    }
    fn canonicalize(v: &mut Value) {
        let suffix = if v["scope"] == "stage" {
            "stage".into()
        } else {
            format!("private_{}", v["private_participant_id"].as_str().unwrap())
        };
        v["provider_room"] = json!(format!(
            "b_{}_r_{}_run_{}_{}",
            v["brand_id"].as_str().unwrap(),
            v["room_id"].as_str().unwrap(),
            v["run_id"].as_str().unwrap(),
            suffix
        ));
        v["rtc_identity"] = json!(format!(
            "{}-{}-e{}-g{}",
            v["role"].as_str().unwrap(),
            v["participant_id"].as_str().unwrap(),
            v["host_lease_epoch"],
            v["authorization_generation"]
        ));
    }

    #[test]
    fn backend_fixture_validates_without_exposing_credentials_in_debug() {
        let value = fixture();
        let session = parse(&value, &authority(&value)).unwrap();
        assert_eq!(
            session.guest_source_id().as_deref(),
            Some("guest-44444444-4444-4444-8444-444444444444")
        );
        assert_eq!(session.join_token(), "fixture.payload.signature");
        assert!(!format!("{session:?}").contains("fixture.payload.signature"));
        assert!(format!("{session:?}").contains("[redacted]"));
    }
    #[test]
    fn stale_or_foreign_authority_cannot_be_accepted() {
        let value = fixture();
        let expected = authority(&value);
        for field in ["brand_id", "room_id", "run_id", "participant_id"] {
            let mut changed = value.clone();
            changed[field] = json!("99999999-9999-4999-8999-999999999999");
            assert_eq!(
                parse(&changed, &expected).unwrap_err(),
                SessionError::AuthorityMismatch
            );
        }
        for field in [
            "host_lease_epoch",
            "control_revision",
            "authorization_generation",
        ] {
            let mut changed = value.clone();
            changed[field] = json!(value[field].as_u64().unwrap() + 1);
            assert_eq!(
                parse(&changed, &expected).unwrap_err(),
                SessionError::AuthorityMismatch
            );
        }
    }
    #[test]
    fn provider_room_identity_and_endpoint_are_bound_to_control_snapshot() {
        let value = fixture();
        let expected = authority(&value);
        for field in ["provider_room", "rtc_identity"] {
            let mut changed = value.clone();
            changed[field] = json!("foreign-authority");
            assert_eq!(
                parse(&changed, &expected).unwrap_err(),
                SessionError::IdentityMismatch
            );
        }
        for endpoint in [
            "ws://test-project.livekit.cloud",
            "wss://other.livekit.cloud",
            "wss://user@test-project.livekit.cloud",
            "wss://test-project.livekit.cloud?token=secret",
            "wss://test-project.livekit.cloud.evil",
            "wss://test-project.livekit.cloud/",
        ] {
            let mut changed = value.clone();
            changed["endpoint"] = json!(endpoint);
            assert_eq!(
                parse(&changed, &expected).unwrap_err(),
                SessionError::EndpointMismatch
            );
        }
    }
    #[test]
    fn malformed_payload_errors_do_not_echo_secrets() {
        let value = fixture();
        let expected = authority(&value);
        let mut unknown = value.clone();
        unknown["API_SECRET-DO-NOT-LOG"] = json!("private");
        let error = parse(&unknown, &expected).unwrap_err();
        assert_eq!(error, SessionError::Malformed);
        assert!(!error.to_string().contains("API_SECRET"));
        let mut missing = value.clone();
        missing
            .as_object_mut()
            .unwrap()
            .remove("private_participant_id");
        assert_eq!(
            parse(&missing, &expected).unwrap_err(),
            SessionError::Malformed
        );
        assert_eq!(
            Session::parse(&vec![b' '; MAX_BODY_BYTES + 1], &expected, NOW).unwrap_err(),
            SessionError::Malformed
        );
        for token in ["", "a.b", "a.b.c.d", "a.secret with spaces.c"] {
            let mut changed = value.clone();
            changed["join_token"] = json!(token);
            assert_eq!(
                parse(&changed, &expected).unwrap_err(),
                SessionError::Malformed
            );
        }
    }
    #[test]
    fn time_and_cross_language_integer_bounds_fail_closed() {
        let value = fixture();
        let expected = authority(&value);
        let mut v = value.clone();
        v["expires_at_ms"] = v["issued_at_ms"].clone();
        assert_eq!(
            parse(&v, &expected).unwrap_err(),
            SessionError::InvalidLifetime
        );
        v["expires_at_ms"] = json!(NOW + MAX_TTL_MS + 1000);
        assert_eq!(
            parse(&v, &expected).unwrap_err(),
            SessionError::InvalidLifetime
        );
        v["issued_at_ms"] = json!(NOW + CLOCK_SKEW_MS + 1000);
        v["expires_at_ms"] = json!(NOW + CLOCK_SKEW_MS + 10_000);
        assert_eq!(
            parse(&v, &expected).unwrap_err(),
            SessionError::InvalidLifetime
        );
        v = value.clone();
        assert_eq!(
            Session::parse(
                &serde_json::to_vec(&v).unwrap(),
                &expected,
                value["expires_at_ms"].as_u64().unwrap()
            )
            .unwrap_err(),
            SessionError::Expired
        );
        v["authorization_generation"] = json!(MAX_SAFE_INTEGER + 1);
        assert_eq!(parse(&v, &expected).unwrap_err(), SessionError::Malformed);
    }
    #[test]
    fn monitor_and_program_publisher_never_become_guest_sources() {
        let mut v = fixture();
        v["role"] = json!("monitor");
        v["publish_sources"] = json!([]);
        canonicalize(&mut v);
        assert!(!parse(&v, &authority(&v)).unwrap().can_publish_program());
        assert!(parse(&v, &authority(&v))
            .unwrap()
            .guest_source_id()
            .is_none());
        v["publish_sources"] = json!(["camera"]);
        assert_eq!(
            parse(&v, &authority(&v)).unwrap_err(),
            SessionError::InvalidSources
        );
        v["role"] = json!("producer");
        v["publish_sources"] = json!(["camera", "microphone"]);
        canonicalize(&mut v);
        assert!(parse(&v, &authority(&v)).unwrap().can_publish_program());
        assert!(parse(&v, &authority(&v))
            .unwrap()
            .guest_source_id()
            .is_none());
    }
    #[test]
    fn private_session_cannot_leak_program_or_screen_sources() {
        let mut v = fixture();
        v["scope"] = json!("private");
        v["private_participant_id"] = v["participant_id"].clone();
        canonicalize(&mut v);
        assert!(parse(&v, &authority(&v)).is_ok());
        v["publish_sources"] = json!(["camera", "microphone", "screen_share"]);
        assert_eq!(
            parse(&v, &authority(&v)).unwrap_err(),
            SessionError::InvalidSources
        );
        v["role"] = json!("producer");
        v["publish_sources"] = json!(["camera", "microphone"]);
        canonicalize(&mut v);
        assert_eq!(
            parse(&v, &authority(&v)).unwrap_err(),
            SessionError::InvalidSources
        );
        v["publish_sources"] = json!(["microphone"]);
        assert!(parse(&v, &authority(&v)).is_ok());
    }
    #[test]
    fn permission_changes_cannot_reuse_the_previous_native_expectations() {
        let value = fixture();
        let expected = authority(&value);
        let mut changed = value.clone();
        changed["publish_sources"] = json!(["camera", "microphone", "screen_share"]);
        assert_eq!(
            parse(&changed, &expected).unwrap_err(),
            SessionError::InvalidSources
        );
        changed["publish_sources"] = json!(["camera", "camera"]);
        assert_eq!(
            parse(&changed, &authority(&changed)).unwrap_err(),
            SessionError::InvalidSources
        );
        changed = value.clone();
        changed["can_subscribe"] = json!(false);
        assert_eq!(
            parse(&changed, &expected).unwrap_err(),
            SessionError::AuthorityMismatch
        );
    }
    #[test]
    fn reconnect_identity_changes_keep_the_saved_source_binding() {
        let value = fixture();
        let a = parse(&value, &authority(&value)).unwrap();
        let mut changed = value.clone();
        changed["host_lease_epoch"] = json!(3);
        changed["authorization_generation"] = json!(4);
        canonicalize(&mut changed);
        let b = parse(&changed, &authority(&changed)).unwrap();
        assert_eq!(a.guest_source_id(), b.guest_source_id());
        assert_ne!(a.rtc_identity(), b.rtc_identity());
    }
}
impl fmt::Display for SessionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Neither serde inputs nor provider error payloads may enter errors.
        write!(f, "Native media session rejected: {self:?}")
    }
}
impl std::error::Error for SessionError {}

/// Validated credentials stay in native memory and go directly to the SDK.
#[derive(Debug)]
pub struct Session(WireSession);

pub fn cloud_endpoint_allowed(endpoint: &str) -> bool {
    let Some(label) = endpoint
        .strip_prefix("wss://")
        .and_then(|s| s.strip_suffix(".livekit.cloud"))
    else {
        return false;
    };
    !label.is_empty()
        && label.len() <= 63
        && label.as_bytes()[0].is_ascii_alphanumeric()
        && label.as_bytes()[label.len() - 1].is_ascii_alphanumeric()
        && label
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
}

fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}

impl Session {
    pub fn parse(
        body: &[u8],
        expected: &ExpectedAuthority,
        now_ms: u64,
    ) -> Result<Self, SessionError> {
        if body.len() > MAX_BODY_BYTES {
            return Err(SessionError::Malformed);
        }
        let wire: WireSession =
            serde_json::from_slice(body).map_err(|_| SessionError::Malformed)?;
        if wire.schema_version != 1 || wire.transport != "livekit" {
            return Err(SessionError::Unsupported);
        }
        for id in [
            &wire.brand_id,
            &wire.room_id,
            &wire.run_id,
            &wire.participant_id,
        ] {
            if !uuid(id) {
                return Err(SessionError::Malformed);
            }
        }
        if wire
            .private_participant_id
            .as_deref()
            .is_some_and(|id| !uuid(id))
            || [wire.host_lease_epoch, wire.authorization_generation].contains(&0)
            || [
                wire.host_lease_epoch,
                wire.control_revision,
                wire.authorization_generation,
                wire.issued_at_ms,
                wire.expires_at_ms,
                now_ms,
            ]
            .iter()
            .any(|n| *n > MAX_SAFE_INTEGER)
        {
            return Err(SessionError::Malformed);
        }
        if wire.brand_id != expected.brand_id
            || wire.room_id != expected.room_id
            || wire.run_id != expected.run_id
            || wire.participant_id != expected.participant_id
            || wire.role != expected.role
            || wire.scope != expected.scope
            || wire.private_participant_id != expected.private_participant_id
            || wire.host_lease_epoch != expected.host_lease_epoch
            || wire.control_revision != expected.control_revision
            || wire.authorization_generation != expected.authorization_generation
            || wire.can_subscribe != expected.can_subscribe
        {
            return Err(SessionError::AuthorityMismatch);
        }
        if !cloud_endpoint_allowed(&wire.endpoint) || wire.endpoint != expected.endpoint {
            return Err(SessionError::EndpointMismatch);
        }
        let suffix = match (wire.scope, wire.private_participant_id.as_deref()) {
            (Scope::Stage, None) => "stage".to_owned(),
            (Scope::Private, Some(id))
                if wire.role != Role::Monitor
                    && (wire.role == Role::Producer || id == wire.participant_id) =>
            {
                format!("private_{id}")
            }
            _ => return Err(SessionError::AuthorityMismatch),
        };
        let room = format!(
            "b_{}_r_{}_run_{}_{}",
            wire.brand_id, wire.room_id, wire.run_id, suffix
        );
        let identity = format!(
            "{}-{}-e{}-g{}",
            wire.role.label(),
            wire.participant_id,
            wire.host_lease_epoch,
            wire.authorization_generation
        );
        if wire.provider_room != room || wire.rtc_identity != identity {
            return Err(SessionError::IdentityMismatch);
        }
        let ttl = wire
            .expires_at_ms
            .checked_sub(wire.issued_at_ms)
            .ok_or(SessionError::InvalidLifetime)?;
        if ttl == 0
            || ttl > MAX_TTL_MS
            || wire.issued_at_ms > now_ms.saturating_add(CLOCK_SKEW_MS)
            || !wire.issued_at_ms.is_multiple_of(1000)
            || !wire.expires_at_ms.is_multiple_of(1000)
        {
            return Err(SessionError::InvalidLifetime);
        }
        if wire.expires_at_ms <= now_ms {
            return Err(SessionError::Expired);
        }
        let token = &wire.join_token.0;
        let parts: Vec<_> = token.split('.').collect();
        if token.len() > 16_384
            || parts.len() != 3
            || parts.iter().any(|part| {
                part.is_empty()
                    || !part
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
            })
        {
            return Err(SessionError::Malformed);
        }
        let sources = &wire.publish_sources;
        if sources.len() > 4
            || sources
                .iter()
                .enumerate()
                .any(|(i, source)| sources[..i].contains(source))
            || sources.len() != expected.publish_sources.len()
            || sources
                .iter()
                .any(|s| !expected.publish_sources.contains(s))
            || (sources.contains(&PublishSource::ScreenShareAudio)
                && !sources.contains(&PublishSource::ScreenShare))
            || (wire.scope == Scope::Private
                && sources.iter().any(|s| {
                    matches!(
                        s,
                        PublishSource::ScreenShare | PublishSource::ScreenShareAudio
                    )
                }))
            || (wire.role == Role::Monitor && !sources.is_empty())
        {
            return Err(SessionError::InvalidSources);
        }
        if wire.role == Role::Producer {
            let allowed = if wire.scope == Scope::Stage {
                vec![PublishSource::Camera, PublishSource::Microphone]
            } else {
                vec![PublishSource::Microphone]
            };
            if sources.len() != allowed.len() || sources.iter().any(|s| !allowed.contains(s)) {
                return Err(SessionError::InvalidSources);
            }
        }
        Ok(Self(wire))
    }

    pub fn endpoint(&self) -> &str {
        &self.0.endpoint
    }
    pub fn join_token(&self) -> &str {
        &self.0.join_token.0
    }
    pub fn rtc_identity(&self) -> &str {
        &self.0.rtc_identity
    }
    pub fn expires_at_ms(&self) -> u64 {
        self.0.expires_at_ms
    }
    pub fn can_publish_program(&self) -> bool {
        self.0.role == Role::Producer && self.0.scope == Scope::Stage
            && self.0.publish_sources.contains(&PublishSource::Camera)
            && self.0.publish_sources.contains(&PublishSource::Microphone)
    }

    /// Preserve Producer's existing guest source ID across token/track changes.
    /// Monitors and the program publisher never become guest canvas sources.
    pub fn guest_source_id(&self) -> Option<String> {
        (self.0.role == Role::Guest).then(|| format!("guest-{}", self.0.participant_id))
    }
}
