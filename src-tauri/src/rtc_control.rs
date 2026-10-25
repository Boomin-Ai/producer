//! Native-only staging authority owner. Credentials never cross the IPC boundary.
//! The native owner serializes control mutations, renewal and authority reads.
use producer_guest_session::{ExpectedAuthority, PublishSource, Role, Scope, Session};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
const API: &str = "https://boomin-rtc-pilot.kleveland-bishop.workers.dev";
const ENDPOINT: &str = "wss://producer-boomin-6h2iz2sq.livekit.cloud";
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Operator {
    pub brand_id: String,
    pub room_id: String,
    pub token: String,
}
pub use producer_guest_runtime::authority::HostReceipt as Receipt;

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum RoomCommand {
    Admit {
        participant_id: String,
    },
    Revoke {
        participant_id: String,
    },
    Stage {
        on_stage: Vec<String>,
    },
    Grant {
        participant_id: String,
        grant: String,
        enabled: bool,
    },
    Link {
        rotate: bool,
    },
}
impl RoomCommand {
    fn route(&self, room: &str) -> Result<(String, Value), &'static str> {
        let valid = |id: &str| {
            uuid::Uuid::parse_str(id)
                .map(|_| ())
                .map_err(|_| "Invalid RTC participant")
        };
        match self {
            Self::Admit { participant_id } | Self::Revoke { participant_id } => {
                valid(participant_id)?;
                let action = if matches!(self, Self::Admit { .. }) {
                    "admit"
                } else {
                    "revoke"
                };
                Ok((
                    format!("/v1/app/live/guests/{participant_id}/{action}"),
                    json!({}),
                ))
            }
            Self::Stage { on_stage } => {
                if on_stage.len() > 25 {
                    return Err("RTC stage capacity exceeded");
                }
                let mut unique = std::collections::HashSet::new();
                for id in on_stage {
                    valid(id)?;
                    if !unique.insert(id) {
                        return Err("Duplicate RTC participant");
                    }
                }
                Ok((
                    format!("/v1/app/live/rooms/{room}/stage"),
                    json!({"on_stage":on_stage}),
                ))
            }
            Self::Grant {
                participant_id,
                grant,
                enabled,
            } => {
                valid(participant_id)?;
                if !matches!(
                    grant.as_str(),
                    "media.camera"
                        | "media.mic"
                        | "media.screen"
                        | "media.return_feed"
                        | "input.vote"
                        | "input.text"
                        | "input.hand"
                ) {
                    return Err("Unsupported RTC grant");
                }
                Ok((
                    format!("/v1/app/live/guests/{participant_id}/grants"),
                    json!({"grant":grant,"enabled":enabled}),
                ))
            }
            Self::Link { rotate } => Ok((
                format!("/v1/app/live/rooms/{room}/guest-link"),
                json!({"enabled":true,"auto_admit":false,"rotate":rotate}),
            )),
        }
    }
}

fn now() -> Result<u64, &'static str> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "Clock unavailable")?
        .as_millis() as u64)
}
#[derive(Clone)]
pub struct Control {
    http: reqwest::Client,
    api: String,
    operator: Operator,
    ticket: String,
    connection_id: Option<String>,
    receipt: Option<Receipt>,
    ticket_renewed_ms: u64,
}
fn same_owned_run(next: &Receipt, previous: &Receipt) -> bool {
    next.room_id == previous.room_id
        && next.brand_id == previous.brand_id
        && next.run_id == previous.run_id
        && next.host_process_id == previous.host_process_id
        && next.host_participant_id == previous.host_participant_id
        && next.host_lease_epoch == previous.host_lease_epoch
        && next.endpoint == previous.endpoint
        && next.transport == "livekit"
        && next.state == "active"
        && next.control_revision >= previous.control_revision
}
fn renewable_after_read(error: &str) -> bool {
    matches!(
        error,
        "RTC authority changed"
            | "RTC request timed out"
            | "RTC request failed"
            | "RTC response failed"
            | "RTC authority temporarily unavailable"
    )
}

impl Control {
    /// The independent permission reader already validated this snapshot. Reuse
    /// its current owner revision only; never extend freshness or permissions.
    pub fn use_current_authority(
        &mut self,
        snapshot: &producer_guest_runtime::authority::Snapshot,
    ) -> bool {
        let Some(previous) = self.receipt.as_ref() else {
            return false;
        };
        let next = snapshot.receipt();
        if !snapshot.current(std::time::Instant::now())
            || !same_owned_run(next, previous)
            || next.host_lease_expires_at_ms <= now().unwrap_or(u64::MAX)
        {
            return false;
        }
        self.receipt = Some(next.clone());
        true
    }
    pub fn room_id(&self) -> &str {
        &self.operator.room_id
    }
    pub fn new(operator: Operator) -> Result<Self, &'static str> {
        Self::for_api(operator, API)
    }
    /// Bind all authority reads and writes to the endpoint used to open the room.
    /// Never move an existing ticket between staging and production.
    pub fn for_api(operator: Operator, api: &str) -> Result<Self, &'static str> {
        let api = api.trim_end_matches('/');
        if !matches!(api, API | crate::boomin::DEFAULT_BOOMIN_API_ROOT) {
            return Err("Unsupported native RTC authority endpoint");
        }
        for id in [&operator.brand_id, &operator.room_id] {
            uuid::Uuid::parse_str(id).map_err(|_| "Invalid staging room")?;
        }
        if operator.token.is_empty() {
            return Err("Missing staging authorization");
        }
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(|_| "HTTP setup failed")?;
        Ok(Self {
            http,
            api: api.to_owned(),
            operator,
            ticket: String::new(),
            connection_id: None,
            receipt: None,
            ticket_renewed_ms: 0,
        })
    }
    async fn post(&self, suffix: &str, body: Value) -> Result<Vec<u8>, &'static str> {
        self.post_route(
            &format!("/v1/app/live/rooms/{}/rtc/{suffix}", self.operator.room_id),
            body,
            suffix == "media-authority",
        )
        .await
    }
    async fn post_route(
        &self,
        route: &str,
        body: Value,
        permission_read: bool,
    ) -> Result<Vec<u8>, &'static str> {
        let mut response = self
            .http
            .post(format!("{}{route}", self.api))
            .bearer_auth(&self.operator.token)
            // A permission response must fit inside the receiver's 3.5-second
            // freshness window. Control mutations retain their five-second limit.
            .timeout(Duration::from_millis(if permission_read {
                2500
            } else {
                5000
            }))
            .json(&body)
            .send()
            .await
            .map_err(|error| {
                if error.is_timeout() {
                    "RTC request timed out"
                } else {
                    "RTC request failed"
                }
            })?;
        if response.status() == reqwest::StatusCode::CONFLICT {
            return Err("RTC authority changed");
        }
        if response.status().is_server_error()
            || response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS
        {
            return Err("RTC authority temporarily unavailable");
        }
        if !response.status().is_success() {
            return Err("RTC authority rejected request");
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "RTC response failed")? {
            if bytes.len() + chunk.len() > 32768 {
                return Err("RTC response too large");
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }
    pub async fn room_command(&self, command: RoomCommand) -> Result<Value, &'static str> {
        let (route, mut body) = command.route(&self.operator.room_id)?;
        let receipt = self
            .receipt
            .as_ref()
            .filter(|r| r.host_lease_expires_at_ms > now().unwrap_or(u64::MAX))
            .ok_or("No owned RTC run")?;
        body["rtc"] = json!({"request_id":uuid::Uuid::new_v4().to_string(),"expected":{
            "run_id":receipt.run_id,"control_revision":receipt.control_revision,"host_lease_epoch":receipt.host_lease_epoch}});
        let bytes = self.post_route(&route, body, false).await?;
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid RTC room control response")?;
        let next: Receipt = serde_json::from_value(value["rtc"]["run"].clone())
            .map_err(|_| "Missing RTC room control receipt")?;
        if !same_owned_run(&next, receipt) {
            return Err("RTC room control authority mismatch");
        }
        Ok(value)
    }
    pub async fn open(&mut self) -> Result<(), &'static str> {
        if !self.ticket.is_empty() {
            return Err("RTC connection already opened");
        }
        // Opening a ticket does not acquire a run or publish an identity.
        // A lost response may leave an expiring unused connection record.
        for attempt in 0..3 {
            match self.post("connection", json!({"session_version":1})).await {
                Ok(body) => return self.accept_ticket(&body),
                Err(error)
                    if attempt < 2
                        && matches!(
                            error,
                            "RTC request timed out"
                                | "RTC request failed"
                                | "RTC authority temporarily unavailable"
                        ) =>
                {
                    tokio::time::sleep(Duration::from_millis(200 * (attempt + 1))).await;
                }
                Err(error) => return Err(error),
            }
        }
        Err("RTC connection opening failed")
    }
    fn accept_ticket(&mut self, body: &[u8]) -> Result<(), &'static str> {
        let value: Value =
            serde_json::from_slice(body).map_err(|_| "Invalid connection response")?;
        let ticket = value["connection_ticket"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 4096)
            .ok_or("Missing connection ticket")?;
        let connection = &value["connection"];
        let id = connection["connection_id"]
            .as_str()
            .ok_or("Missing connection identity")?;
        uuid::Uuid::parse_str(id).map_err(|_| "Invalid connection identity")?;
        if connection["kind"] != "host"
            || connection["brand_id"] != self.operator.brand_id
            || connection["room_id"] != self.operator.room_id
            || self
                .connection_id
                .as_ref()
                .is_some_and(|previous| previous != id)
        {
            return Err("Native RTC connection binding changed");
        }
        self.connection_id = Some(id.to_owned());
        self.ticket = ticket.to_owned();
        self.ticket_renewed_ms = now()?;
        Ok(())
    }
    async fn read_run(&self) -> Result<Receipt, &'static str> {
        let mut response = self
            .http
            .get(format!(
                "{}/v1/app/live/rooms/{}/rtc-control",
                self.api, self.operator.room_id
            ))
            .bearer_auth(&self.operator.token)
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .map_err(|_| "RTC recovery state unavailable")?;
        if !response.status().is_success() {
            return Err("RTC recovery state rejected");
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "RTC recovery state unavailable")?
        {
            if bytes.len() + chunk.len() > 32768 {
                return Err("RTC recovery response too large");
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid RTC recovery state")?;
        let receipt: Receipt = serde_json::from_value(value["rtc"].clone())
            .map_err(|_| "Missing RTC recovery state")?;
        if receipt.brand_id != self.operator.brand_id
            || receipt.room_id != self.operator.room_id
            || receipt.endpoint != ENDPOINT
            || receipt.transport != "livekit"
            || receipt.control_revision == 0
            || receipt.control_revision > 9_007_199_254_740_991
            || receipt.host_lease_epoch == 0
            || receipt.host_lease_epoch > 9_007_199_254_740_991
        {
            return Err("RTC recovery state mismatch");
        }
        for id in [
            &receipt.run_id,
            &receipt.host_process_id,
            &receipt.host_participant_id,
        ] {
            uuid::Uuid::parse_str(id).map_err(|_| "Invalid RTC recovery identity")?;
        }
        Ok(receipt)
    }
    pub async fn start_or_recover(&mut self) -> Result<(), &'static str> {
        match self.command("start").await {
            Ok(_) => return Ok(()),
            Err("RTC authority changed") => {}
            Err(error) => return Err(error),
        }
        let old = self.read_run().await?;
        if !matches!(old.state.as_str(), "active" | "fencing")
            || old.host_lease_expires_at_ms > now()?
        {
            return Err("Another host session still controls this room");
        }
        // The server checks account ownership and expiry atomically under the room
        // lock. Never substitute the unrestricted explicit takeover operation.
        let bytes = self.post("control", json!({"connection_ticket":self.ticket,"command":{
            "operation":"reclaim_expired","requestId":uuid::Uuid::new_v4().to_string(),
            "expectedRunId":old.run_id,"expectedRevision":old.control_revision,"expectedEpoch":old.host_lease_epoch}})).await?;
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid RTC recovery receipt")?;
        let pending: Receipt = serde_json::from_value(value["receipt"].clone())
            .map_err(|_| "Missing RTC recovery receipt")?;
        if pending.run_id != old.run_id
            || pending.brand_id != old.brand_id
            || pending.room_id != old.room_id
            || pending.endpoint != ENDPOINT
            || pending.transport != "livekit"
            || self.connection_id.as_deref() != Some(pending.host_process_id.as_str())
            || pending.host_lease_epoch != old.host_lease_epoch + 1
            || pending.control_revision != old.control_revision + 1
            || !matches!(pending.state.as_str(), "fencing" | "active")
        {
            return Err("RTC recovery ownership mismatch");
        }
        // No SDK session or media capture exists until an independent read proves
        // retirement completed for exactly this replacement connection and epoch.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            let current = self.read_run().await?;
            if current.run_id != pending.run_id
                || current.host_process_id != pending.host_process_id
                || current.host_participant_id != pending.host_participant_id
                || current.host_lease_epoch != pending.host_lease_epoch
                || current.control_revision
                    != pending.control_revision
                        + u64::from(pending.state == "fencing" && current.state == "active")
                || current.host_lease_expires_at_ms <= now()?
            {
                return Err("RTC recovery ownership changed");
            }
            if current.state == "active" {
                self.receipt = Some(current);
                return Ok(());
            }
            if current.state != "fencing" || tokio::time::Instant::now() >= deadline {
                return Err("RTC previous media retirement is not complete");
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }
    pub async fn command(&mut self, operation: &str) -> Result<Receipt, &'static str> {
        let mut command =
            json!({"operation":operation,"requestId":uuid::Uuid::new_v4().to_string()});
        match operation {
            "start" if self.receipt.is_none() => {}
            "renew" | "end" => {
                let r = self.receipt.as_ref().ok_or("No owned RTC run")?;
                command["expectedRunId"] = json!(r.run_id);
                command["expectedRevision"] = json!(r.control_revision);
                command["expectedEpoch"] = json!(r.host_lease_epoch);
            }
            _ => return Err("Unsupported RTC transition"),
        }
        let previous = self.receipt.clone();
        self.receipt = None;
        let payload = json!({"connection_ticket":self.ticket,"command":command});
        let mut result = self.post("control", payload.clone()).await;
        // The deployed SQL atomically stores (room, requestId, exact request)
        // and replays only its immutable receipt. Retry START with the same
        // key and body, never a fresh mutation. Other transitions stay fenced
        // on ambiguity; old media permits are never extended by this retry.
        if operation == "start" {
            for attempt in 0..2 {
                if !matches!(
                    result,
                    Err("RTC request timed out"
                        | "RTC request failed"
                        | "RTC response failed"
                        | "RTC authority temporarily unavailable")
                ) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(200 * (attempt + 1))).await;
                result = self.post("control", payload.clone()).await;
            }
        }
        // Any ambiguous control failure immediately invalidates local publication authority.
        let bytes = match result {
            Ok(v) => v,
            Err(e) => {
                self.receipt = None;
                return Err(e);
            }
        };
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid control response")?;
        let receipt: Receipt =
            serde_json::from_value(value["receipt"].clone()).map_err(|_| "Invalid RTC receipt")?;
        self.receipt = None;
        if receipt.brand_id != self.operator.brand_id
            || receipt.room_id != self.operator.room_id
            || receipt.endpoint != ENDPOINT
            || receipt.transport != "livekit"
            || self.connection_id.as_deref() != Some(receipt.host_process_id.as_str())
            || receipt.host_lease_epoch > 9_007_199_254_740_991
            || receipt.control_revision > 9_007_199_254_740_991
            || receipt.host_lease_epoch == 0
            || receipt.control_revision == 0
        {
            return Err("RTC receipt authority mismatch");
        }
        if let Some(previous) = previous {
            if receipt.run_id != previous.run_id
                || receipt.host_participant_id != previous.host_participant_id
                || receipt.host_lease_epoch != previous.host_lease_epoch
            {
                return Err("RTC ownership changed");
            }
        }
        if operation == "end" && !matches!(receipt.state.as_str(), "ending" | "ended") {
            return Err("RTC end not confirmed");
        }
        for id in [&receipt.run_id, &receipt.host_participant_id] {
            uuid::Uuid::parse_str(id).map_err(|_| "Invalid RTC receipt identity")?;
        }
        if operation != "end"
            && (receipt.state != "active" || receipt.host_lease_expires_at_ms <= now()?)
        {
            return Err("RTC lease unavailable");
        }
        if operation != "end" {
            self.receipt = Some(receipt.clone());
        }
        Ok(receipt)
    }
    pub async fn renew(&mut self) -> Result<(), &'static str> {
        if now()?.saturating_sub(self.ticket_renewed_ms) >= 300_000 {
            let body = self
                .post("connection/renew", json!({"connection_ticket":self.ticket}))
                .await?;
            self.accept_ticket(&body)?;
        }
        let previous = self.receipt.clone().ok_or("No owned RTC run")?;
        // Several admissions can advance the revision between the independent
        // read and the renewal CAS. Bound contention retries and verify the
        // same owner with a fresh read before every retry.
        for attempt in 0..3 {
            match self.command("renew").await {
                Ok(_) => return Ok(()),
                Err(error) if renewable_after_read(error) && attempt < 2 => {
                    #[cfg(debug_assertions)]
                    eprintln!("Native RTC renewal reconciliation: {error}");
                    let snapshot = self.read_media_authority(&previous).await?;
                    self.receipt = Some(snapshot.receipt().clone());
                }
                Err(error) => return Err(error),
            }
        }
        Err("RTC authority changed")
    }

    pub async fn end(&mut self) -> Result<(), &'static str> {
        let previous = self.receipt.clone().ok_or("No owned RTC run")?;
        match self.command("end").await {
            Ok(_) => Ok(()),
            Err("RTC authority changed") => {
                let snapshot = self.read_media_authority(&previous).await?;
                self.receipt = Some(snapshot.receipt().clone());
                self.command("end").await.map(|_| ())
            }
            Err(error) => Err(error),
        }
    }
    pub fn lease_expires_at_ms(&self) -> Option<u64> {
        self.receipt.as_ref().map(|r| r.host_lease_expires_at_ms)
    }
    pub async fn media_authority(
        &mut self,
    ) -> Result<producer_guest_runtime::authority::Snapshot, &'static str> {
        let expected = self.receipt.as_ref().ok_or("No owned RTC run")?.clone();
        let snapshot = self.read_media_authority(&expected).await?;
        self.receipt = Some(snapshot.receipt().clone());
        Ok(snapshot)
    }
    async fn read_media_authority(
        &self,
        expected: &Receipt,
    ) -> Result<producer_guest_runtime::authority::Snapshot, &'static str> {
        let started = std::time::Instant::now();
        let body = self.post("media-authority", json!({"connection_ticket":self.ticket,"expected":{
            "run_id":expected.run_id,"control_revision":expected.control_revision,"host_lease_epoch":expected.host_lease_epoch}})).await?;
        let snapshot = producer_guest_runtime::authority::Snapshot::parse(
            &body,
            &expected,
            now()?,
            started,
            std::time::Instant::now(),
        )?;
        Ok(snapshot)
    }
    pub async fn session(&mut self) -> Result<Session, &'static str> {
        match self.issue_session().await {
            Ok(session) => Ok(session),
            Err("RTC authority changed") => {
                self.media_authority().await?;
                self.issue_session().await
            }
            Err(error) => Err(error),
        }
    }
    async fn issue_session(&self) -> Result<Session, &'static str> {
        let r = self
            .receipt
            .as_ref()
            .filter(|r| r.host_lease_expires_at_ms > now().unwrap_or(u64::MAX))
            .ok_or("RTC publication authority expired")?;
        let expected = ExpectedAuthority {
            brand_id: r.brand_id.clone(),
            room_id: r.room_id.clone(),
            run_id: r.run_id.clone(),
            participant_id: r.host_participant_id.clone(),
            role: Role::Producer,
            scope: Scope::Stage,
            private_participant_id: None,
            host_lease_epoch: r.host_lease_epoch,
            control_revision: r.control_revision,
            authorization_generation: 1,
            endpoint: r.endpoint.clone(),
            publish_sources: vec![PublishSource::Camera, PublishSource::Microphone],
            can_subscribe: true,
        };
        let body = self.post("session",json!({"connection_ticket":self.ticket,"expected":{
            "run_id":r.run_id,"control_revision":r.control_revision,"host_lease_epoch":r.host_lease_epoch}})).await?;
        Session::parse(&body, &expected, now()?).map_err(|_| "RTC session authority mismatch")
    }
}

/// Exercises the actual application's authority client, without camera or microphone.
#[cfg(debug_assertions)]
pub fn selftest(path: &std::path::Path) -> Result<(), &'static str> {
    let bytes = std::fs::read(path).map_err(|_| "Staging operator profile unavailable")?;
    if bytes.len() > 32768 {
        return Err("Staging operator profile too large");
    }
    let operator =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid staging operator profile")?;
    let runtime = tokio::runtime::Runtime::new().map_err(|_| "RTC runtime unavailable")?;
    runtime.block_on(async {
        let mut control = Control::new(operator)?;
        control.open().await?;
        control.command("start").await?;
        let proof = async {
            let session = control.session().await?;
            if session.endpoint() != ENDPOINT {
                return Err("Unexpected RTC endpoint");
            }
            control.renew().await?;
            control.session().await?;
            Ok(())
        }
        .await;
        let ended = control.command("end").await;
        proof?;
        ended?;
        println!("RTC authority proof passed: open, start, validated session, renew, end");
        Ok(())
    })
}

#[cfg(test)]
mod room_command_tests {
    use super::*;
    const ID: &str = "11111111-1111-4111-8111-111111111111";
    fn authority_fixture(
        value: Value,
        age: Duration,
    ) -> producer_guest_runtime::authority::Snapshot {
        let receipt: Receipt = serde_json::from_value(value.clone()).unwrap();
        let wall = now().unwrap();
        let start = std::time::Instant::now() - age;
        let wire = json!({"schema_version":1,"receipt":value,"observed_at_ms":wall,"guests":[]});
        producer_guest_runtime::authority::Snapshot::parse(
            &serde_json::to_vec(&wire).unwrap(),
            &receipt,
            wall,
            start,
            start,
        )
        .unwrap()
    }
    #[test]
    fn current_authority_reuse_rejects_stale_or_other_owner_snapshots() {
        let receipt = json!({"brand_id":ID,"room_id":ID,"run_id":ID,"host_process_id":ID,"host_participant_id":ID,
            "transport":"livekit","endpoint":ENDPOINT,"state":"active","host_lease_epoch":1,
            "control_revision":5,"host_lease_expires_at_ms":now().unwrap()+45000});
        let make = || {
            let mut control = Control::new(Operator {
                brand_id: ID.into(),
                room_id: ID.into(),
                token: "fixture".into(),
            })
            .unwrap();
            control.receipt = Some(serde_json::from_value(receipt.clone()).unwrap());
            control
        };
        let mut newer = receipt.clone();
        newer["control_revision"] = 6.into();
        let mut control = make();
        assert!(control.use_current_authority(&authority_fixture(newer.clone(), Duration::ZERO)));
        assert_eq!(control.receipt.as_ref().unwrap().control_revision, 6);
        assert!(!control.use_current_authority(&authority_fixture(receipt.clone(), Duration::ZERO)));
        assert!(!make()
            .use_current_authority(&authority_fixture(newer.clone(), Duration::from_secs(4))));
        for field in [
            "brand_id",
            "room_id",
            "run_id",
            "host_process_id",
            "host_participant_id",
        ] {
            let mut other = newer.clone();
            other[field] = "22222222-2222-4222-8222-222222222222".into();
            assert!(
                !make().use_current_authority(&authority_fixture(other, Duration::ZERO)),
                "{field}"
            );
        }
        let mut other_epoch = newer;
        other_epoch["host_lease_epoch"] = 2.into();
        assert!(!make().use_current_authority(&authority_fixture(other_epoch, Duration::ZERO)));
        let mut unopened = make();
        unopened.receipt = None;
        assert!(!unopened.use_current_authority(&authority_fixture(receipt, Duration::ZERO)));
    }
    #[test]
    fn authority_endpoint_is_explicit_and_pinned() {
        let operator = || Operator {
            brand_id: ID.into(),
            room_id: ID.into(),
            token: "fixture".into(),
        };
        assert_eq!(Control::new(operator()).unwrap().api, API);
        assert_eq!(
            Control::for_api(operator(), "https://api.boomin.ai/")
                .unwrap()
                .api,
            "https://api.boomin.ai"
        );
        assert!(Control::for_api(operator(), "https://api.boomin.ai.evil.invalid").is_err());
        assert!(Control::for_api(operator(), "http://api.boomin.ai").is_err());
    }
    #[test]
    fn renewal_recovery_requires_a_fresh_owned_read_and_excludes_rejections() {
        for error in [
            "RTC authority changed",
            "RTC request timed out",
            "RTC request failed",
            "RTC response failed",
            "RTC authority temporarily unavailable",
        ] {
            assert!(renewable_after_read(error));
        }
        for error in [
            "RTC authority rejected request",
            "Native guest authority response expired",
            "RTC room control authority mismatch",
            "Invalid control response",
        ] {
            assert!(!renewable_after_read(error));
        }
    }

    #[test]
    fn webview_cannot_supply_routes_authority_or_change_grant_duration() {
        for command in [
            json!({"operation":"grant","participant_id":ID,"grant":"media.mic","enabled":true,"expires_at_ms":123}),
            json!({"operation":"admit","participant_id":ID,"rtc":{"expected":{"run_id":ID}}}),
            json!({"operation":"stage","on_stage":[],"endpoint":"https://other.invalid"}),
            json!({"operation":"post","path":"/v1/private"}),
        ] {
            assert!(serde_json::from_value::<RoomCommand>(command).is_err());
        }
    }
    #[test]
    fn participant_paths_capacity_and_duplicates_are_bounded() {
        assert!(RoomCommand::Admit {
            participant_id: "../other".into()
        }
        .route(ID)
        .is_err());
        assert!(RoomCommand::Stage {
            on_stage: vec![ID.into(), ID.into()]
        }
        .route(ID)
        .is_err());
        assert!(RoomCommand::Stage {
            on_stage: vec![ID.into(); 26]
        }
        .route(ID)
        .is_err());
        assert!(RoomCommand::Grant {
            participant_id: ID.into(),
            grant: "room.admin".into(),
            enabled: true
        }
        .route(ID)
        .is_err());
        assert_eq!(
            RoomCommand::Stage { on_stage: vec![] }.route(ID).unwrap().1,
            json!({"on_stage":[]})
        );
    }
}
