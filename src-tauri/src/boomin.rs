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

/// List the workspaces this account can act in (hosted `GET /v1/app/brands`).
pub async fn list_brands(api_root: &str, token: &str) -> EngineResult<Vec<(String, String)>> {
    let url = format!("{}/v1/app/brands", api_root.trim_end_matches('/'));
    let resp = reqwest::Client::new()
        .get(url)
        .bearer_auth(token)
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(EngineError::Other(format!(
            "could not list workspaces (HTTP {})",
            resp.status().as_u16()
        )));
    }
    let body: Value = resp.json().await?;
    let brands = body
        .get("brands")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(brands
        .iter()
        .filter_map(|b| {
            let slug = b.get("slug").and_then(Value::as_str)?.to_string();
            let name = b
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(&slug)
                .to_string();
            Some((slug, name))
        })
        .collect())
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
