//! Typed client for the Producer API contract
//! (producer-server/contract/openapi.yaml). Both backends speak this.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{EngineError, EngineResult};

pub struct ProducerClient {
    http: reqwest::Client,
    base_url: String,
    token: String,
    /// Hosted-backend workspace scope, appended as ?brandSlug= to every
    /// request. Backend-specific (like the bearer token itself); None for
    /// self-hosted endpoints.
    brand_slug: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub token_class: String,
    #[serde(default)]
    pub account: Option<Value>,
    pub server: Value,
}

#[derive(Debug)]
pub enum SubmitOutcome {
    /// 201 created, or 200 idempotent replay of the original result.
    Accepted { job: Value, replayed: bool },
    /// 409: same idempotency key, different payload. A client bug —
    /// surfaced loudly, never retried automatically.
    IdempotencyConflict,
    /// Any other rejection; message is user-renderable.
    Rejected {
        #[allow(dead_code)] // read once job history rendering lands (M3)
        status: u16,
        message: String,
    },
}

fn error_message(body: &Value, status: u16) -> String {
    // Contract envelope { error: { message } }; legacy hosted routes use a
    // flat { message } — read both so mixed surfaces stay legible.
    body.pointer("/error/message")
        .or_else(|| body.get("message"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("endpoint returned HTTP {status}"))
}

impl ProducerClient {
    pub fn new(base_url: &str, token: &str) -> Self {
        Self {
            http: reqwest::Client::new(),
            base_url: base_url.trim_end_matches('/').to_string(),
            token: token.to_string(),
            brand_slug: None,
        }
    }

    pub fn with_brand(mut self, brand_slug: Option<String>) -> Self {
        self.brand_slug = brand_slug.filter(|s| !s.is_empty());
        self
    }

    /// Producer's own endpoints hang off the connected base
    /// (…/v1/app/producer). Platform-wide routes do NOT — they live at the
    /// API root, so they must be resolved against the ORIGIN rather than
    /// appended, or you get /v1/app/producer/v1/app/live/... and a 404 that
    /// reads like a missing feature.
    fn root_url(&self, path: &str) -> String {
        let origin = match self.base_url.find("/v1/") {
            Some(i) => &self.base_url[..i],
            None => self.base_url.trim_end_matches('/'),
        };
        let mut url = format!("{origin}{path}");
        if let Some(slug) = &self.brand_slug {
            url.push(if path.contains('?') { '&' } else { '?' });
            url.push_str("brandSlug=");
            url.push_str(slug);
        }
        url
    }

    fn url(&self, path: &str) -> String {
        let mut url = format!("{}{}", self.base_url, path);
        if let Some(slug) = &self.brand_slug {
            url.push(if path.contains('?') { '&' } else { '?' });
            url.push_str("brandSlug=");
            url.push_str(slug);
        }
        url
    }

    /// Validate the token and learn its class + the server identity.
    pub async fn get_session(&self) -> EngineResult<Session> {
        let resp = self
            .http
            .get(self.url("/v1/session"))
            .bearer_auth(&self.token)
            .send()
            .await?;
        let status = resp.status();
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(EngineError::Unauthorized(
                "the endpoint did not accept this access token".into(),
            ));
        }
        if !status.is_success() {
            return Err(EngineError::Other(format!(
                "endpoint validation failed (HTTP {status})"
            )));
        }
        Ok(resp.json::<Session>().await?)
    }

    pub async fn list_channels(&self) -> EngineResult<Value> {
        self.get_json("/v1/channels").await
    }

    pub async fn list_jobs(&self, limit: u32) -> EngineResult<Value> {
        self.get_json(&format!("/v1/jobs?limit={limit}")).await
    }

    async fn get_json(&self, path: &str) -> EngineResult<Value> {
        let resp = self
            .http
            .get(self.url(path))
            .bearer_auth(&self.token)
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body: Value = resp.json().await.unwrap_or(Value::Null);
            return Err(EngineError::Other(error_message(&body, status)));
        }
        Ok(resp.json().await?)
    }

    /// Begin channel authorization (contract: connect-session). Returns the
    /// one-time browser URL a human completes — primary token only.
    /// Join the Brand Network. Idempotent server-side: a second call returns
    /// joined:false and changes nothing, so onboarding can be re-run safely.
    /// `rejoin` must only ever be true from an explicit user action — a brand
    /// that deliberately LEFT must never be silently re-listed at login.
    /// Register a local room with the platform, lazily, the first time it
    /// needs anything server-side. Idempotent by `external_ref` (our local
    /// uuid), so a retry, a reinstall or a second machine converges on the
    /// SAME server room instead of scattering guests across duplicates.
    /// Never called at room creation or app start — Producer must keep
    /// working offline and streaming to RTMP without a Boomin session.
    pub async fn register_room(&self, title: &str, external_ref: &str) -> EngineResult<Value> {
        let resp = self
            .http
            .post(self.root_url("/v1/app/live/rooms"))
            .bearer_auth(&self.token)
            .json(&serde_json::json!({ "title": title, "external_ref": external_ref }))
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let b: Value = resp.json().await.unwrap_or(Value::Null);
            return Err(EngineError::Other(error_message(&b, status)));
        }
        Ok(resp.json().await?)
    }

    /// Invite a guest to a live room. Returns the invite link (for the guest)
    /// and the render URL (for Producer's browser source) — both are returned
    /// ONCE ONLY, so the caller must persist them immediately.
    /// `guest_brand_id` is optional: naming a brand needs an active network
    /// connection, omitting it produces an anonymous link anyone can open.
    pub async fn invite_room_guest(
        &self,
        room_id: &str,
        guest_brand_id: Option<String>,
        display_name: Option<String>,
    ) -> EngineResult<Value> {
        let mut body = serde_json::Map::new();
        if let Some(b) = guest_brand_id {
            body.insert("guest_brand_id".into(), Value::String(b));
        }
        if let Some(n) = display_name {
            body.insert("display_name".into(), Value::String(n));
        }
        let resp = self
            .http
            .post(self.root_url(&format!("/v1/app/live/rooms/{room_id}/guests")))
            .bearer_auth(&self.token)
            .json(&Value::Object(body))
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let b: Value = resp.json().await.unwrap_or(Value::Null);
            return Err(EngineError::Other(error_message(&b, status)));
        }
        Ok(resp.json().await?)
    }

    /// Brands this brand is connected to — the "pick a connected brand" path.
    pub async fn network_connections(&self) -> EngineResult<Value> {
        let resp = self
            .http
            .get(self.root_url("/v1/app/network/connections"))
            .bearer_auth(&self.token)
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let b: Value = resp.json().await.unwrap_or(Value::Null);
            return Err(EngineError::Other(error_message(&b, status)));
        }
        Ok(resp.json().await?)
    }

    pub async fn network_join(&self, rejoin: bool) -> EngineResult<Value> {
        let resp = self
            .http
            .post(self.root_url("/v1/app/network/join"))
            .bearer_auth(&self.token)
            .json(&serde_json::json!({ "rejoin": rejoin }))
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body: Value = resp.json().await.unwrap_or(Value::Null);
            return Err(EngineError::Other(error_message(&body, status)));
        }
        Ok(resp.json().await?)
    }

    pub async fn create_connect_session(&self, platform: &str) -> EngineResult<Value> {
        let resp = self
            .http
            .post(self.url(&format!("/v1/channels/{platform}/connect-session")))
            .bearer_auth(&self.token)
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body: Value = resp.json().await.unwrap_or(Value::Null);
            return Err(EngineError::Other(error_message(&body, status)));
        }
        Ok(resp.json().await?)
    }

    /// Request an upload slot (contract: POST /v1/media/uploads).
    pub async fn create_upload(
        &self,
        filename: &str,
        content_type: &str,
        size_bytes: u64,
    ) -> EngineResult<Value> {
        let resp = self
            .http
            .post(self.url("/v1/media/uploads"))
            .bearer_auth(&self.token)
            .json(&serde_json::json!({
                "filename": filename,
                "content_type": content_type,
                "size_bytes": size_bytes,
            }))
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body: Value = resp.json().await.unwrap_or(Value::Null);
            return Err(EngineError::Other(error_message(&body, status)));
        }
        Ok(resp.json().await?)
    }

    /// PUT raw bytes to a presigned capability URL — no credentials involved,
    /// exactly per the contract's media rule.
    pub async fn put_bytes(
        &self,
        put_url: &str,
        content_type: &str,
        bytes: Vec<u8>,
    ) -> EngineResult<()> {
        let resp = self
            .http
            .put(put_url)
            .header("Content-Type", content_type)
            .body(bytes)
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(EngineError::Other(format!(
                "media upload failed (HTTP {})",
                resp.status().as_u16()
            )));
        }
        Ok(())
    }

    /// Submit one publishing job for one channel. The request body is
    /// the target's immutable request_json, replayed verbatim with the
    /// same idempotency key on every retry.
    pub async fn create_post(
        &self,
        request_json: &str,
        idempotency_key: &str,
    ) -> EngineResult<SubmitOutcome> {
        let body: Value = serde_json::from_str(request_json)
            .map_err(|e| EngineError::Other(format!("corrupt outbox request: {e}")))?;
        let resp = self
            .http
            .post(self.url("/v1/posts"))
            .bearer_auth(&self.token)
            .header("Idempotency-Key", idempotency_key)
            .json(&body)
            .send()
            .await?;
        let status = resp.status().as_u16();
        let payload: Value = resp.json().await.unwrap_or(Value::Null);
        match status {
            201 | 200 => Ok(SubmitOutcome::Accepted {
                replayed: payload
                    .get("replayed")
                    .and_then(Value::as_bool)
                    .unwrap_or(status == 200),
                job: payload.get("job").cloned().unwrap_or(payload),
            }),
            409 => Ok(SubmitOutcome::IdempotencyConflict),
            _ => Ok(SubmitOutcome::Rejected {
                status,
                message: error_message(&payload, status),
            }),
        }
    }
}
