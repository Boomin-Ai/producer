//! Native-only staging authority owner. Credentials never cross the IPC boundary.
//! Callers must serialize access (all mutating operations require &mut self).
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

fn now() -> Result<u64, &'static str> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "Clock unavailable")?
        .as_millis() as u64)
}
pub struct Control {
    http: reqwest::Client,
    operator: Operator,
    ticket: String,
    connection_id: Option<String>,
    receipt: Option<Receipt>,
    ticket_renewed_ms: u64,
}
impl Control {
    pub fn new(operator: Operator) -> Result<Self, &'static str> {
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
            operator,
            ticket: String::new(),
            connection_id: None,
            receipt: None,
            ticket_renewed_ms: 0,
        })
    }
    async fn post(&self, suffix: &str, body: Value) -> Result<Vec<u8>, &'static str> {
        let mut response = self
            .http
            .post(format!(
                "{API}/v1/app/live/rooms/{}/rtc/{suffix}",
                self.operator.room_id
            ))
            .bearer_auth(&self.operator.token)
            // A permission response must fit inside the receiver's 3.5-second
            // freshness window. Control mutations retain their five-second limit.
            .timeout(Duration::from_millis(if suffix == "media-authority" {
                2500
            } else {
                5000
            }))
            .json(&body)
            .send()
            .await
            .map_err(|_| "RTC request failed")?;
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
    pub async fn open(&mut self) -> Result<(), &'static str> {
        if !self.ticket.is_empty() {
            return Err("RTC connection already opened");
        }
        let body = self
            .post("connection", json!({"session_version":1}))
            .await?;
        self.accept_ticket(&body)
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
        let result = self
            .post(
                "control",
                json!({"connection_ticket":self.ticket,"command":command}),
            )
            .await;
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
        match self.command("renew").await {
            Ok(_) => Ok(()),
            Err("RTC authority changed") => {
                // A coordinated stage/grant change may advance revision between
                // polls. Recheck this SAME connection/run/epoch independently;
                // never reclaim or mint from the failed command's old receipt.
                let snapshot = self.read_media_authority(&previous).await?;
                self.receipt = Some(snapshot.receipt().clone());
                self.command("renew").await.map(|_| ())
            }
            Err(error) => Err(error),
        }
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
