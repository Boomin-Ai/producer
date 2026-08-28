//! Typed client for the Producer API contract
//! (producer-server/contract/openapi.yaml). Both backends speak this.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{EngineError, EngineResult};

pub struct ProducerClient {
    http: reqwest::Client,
    base_url: String,
    token: String,
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
    body.pointer("/error/message")
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
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
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
        let resp = self
            .http
            .get(self.url("/v1/channels"))
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
