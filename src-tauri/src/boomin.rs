//! Connected-mode bootstrap: Boomin email OTP sign-in. Auth acquisition is
//! backend-specific (outside the Producer contract); once a token exists the
//! endpoint is spoken to purely through the contract client. The token flows
//! response → keychain without ever entering the webview.

use serde_json::Value;

use crate::error::{EngineError, EngineResult};

pub const DEFAULT_BOOMIN_API_ROOT: &str = "https://api.boomin.ai";

/// The Producer-contract base for a Boomin API root (D1's lean mount).
pub fn producer_base_for_root(api_root: &str) -> String {
    format!("{}/v1/app/producer", api_root.trim_end_matches('/'))
}

pub async fn request_otp(api_root: &str, email: &str) -> EngineResult<()> {
    let url = format!("{}/v1/app/auth/otp", api_root.trim_end_matches('/'));
    let resp = reqwest::Client::new()
        .post(url)
        .json(&serde_json::json!({ "email": email }))
        .send()
        .await?;
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        let message = body
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("could not send the sign-in code");
        return Err(EngineError::Other(format!("{message} (HTTP {status})")));
    }
    Ok(())
}

pub async fn verify_otp(api_root: &str, email: &str, code: &str) -> EngineResult<String> {
    let url = format!("{}/v1/app/auth/verify", api_root.trim_end_matches('/'));
    let resp = reqwest::Client::new()
        .post(url)
        .json(&serde_json::json!({ "email": email, "code": code }))
        .send()
        .await?;
    let status = resp.status().as_u16();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    if !(200..300).contains(&status) {
        let message = body
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("the code was not accepted");
        return Err(EngineError::Other(format!("{message} (HTTP {status})")));
    }
    body.get("auth_token")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| EngineError::Other("sign-in succeeded but no token was returned".into()))
}
