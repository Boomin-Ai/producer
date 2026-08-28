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
