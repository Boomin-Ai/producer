//! Local provider runtime. No room, renderer, endpoint vault or Boomin authority.
//! OAuth credentials stay in the host's supplied vault, outside the webview.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use jsonwebtoken::{decode, decode_header, jwk::JwkSet, Algorithm, DecodingKey, Validation};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    future::Future,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::{Mutex, Notify},
};

const ISSUER: &str = "https://auth.openai.com";
const RESOURCE: &str = "https://api.openai.com/v1";
const SCOPE: &str = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const PLAN_SCOPE: &str = "chatgpt.tokens.use.direct";
// First-time browser sign-in may include account selection, MFA and consent.
// Keep this bounded, but do not close the callback during a normal setup flow.
const AUTHORIZATION_WINDOW: Duration = Duration::from_secs(15 * 60);
pub type Result<T> = std::result::Result<T, String>;

async fn authorize_until_deadline<T>(
    cancel: Arc<Notify>,
    work: impl Future<Output = Result<T>>,
) -> Result<T> {
    tokio::select! {
        _ = cancel.notified() => Err("ChatGPT sign-in canceled.".into()),
        result = tokio::time::timeout(AUTHORIZATION_WINDOW, work) => result.unwrap_or_else(|_| Err("ChatGPT sign-in expired. Click Continue with ChatGPT and use the newest browser tab.".into())),
    }
}

/// Deliberately no Debug implementation on credential-bearing types.
#[derive(Clone, Serialize, Deserialize)]
pub struct CredentialStore {
    pub host_id: String,
    #[serde(default)]
    pub active: Option<String>,
    #[serde(default)]
    pub accounts: Vec<Account>,
}
impl Default for CredentialStore {
    fn default() -> Self {
        Self {
            host_id: format!("urn:uuid:{}", uuid::Uuid::new_v4()),
            active: None,
            accounts: Vec::new(),
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Account {
    id: String,
    client_id: String,
    subject: String,
    email: String,
    access_token: String,
    refresh_token: Option<String>,
    id_token: String,
    expires_at: u64,
    scopes: Vec<String>,
    #[serde(default)]
    verified: bool,
}
pub trait CredentialVault: Send + Sync + 'static {
    fn load(&self) -> Result<Option<CredentialStore>>;
    fn save(&self, store: &CredentialStore) -> Result<()>;
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    pub id: String,
    pub email: String,
    pub plan_enabled: bool,
    pub verified: bool,
}
impl From<&Account> for AccountInfo {
    fn from(a: &Account) -> Self {
        Self {
            id: a.id.clone(),
            email: a.email.clone(),
            plan_enabled: a.scopes.iter().any(|s| s == PLAN_SCOPE),
            verified: a.verified,
        }
    }
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SignInStatus {
    pub id: String,
    pub status: String,
    pub error: Option<String>,
    pub expires_at: u64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub accounts: Vec<AccountInfo>,
    pub active: Option<String>,
    pub sign_in: Option<SignInStatus>,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Model {
    pub slug: String,
    pub display_name: String,
}
#[derive(Deserialize)]
struct ModelRow {
    slug: String,
    display_name: String,
    visibility: String,
}
#[derive(Deserialize)]
struct ModelList {
    models: Vec<ModelRow>,
}
#[derive(Deserialize)]
struct Tokens {
    access_token: String,
    id_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: u64,
    token_type: String,
    scope: Option<String>,
}
#[derive(Clone, Deserialize)]
struct Claims {
    sub: String,
    email: Option<String>,
    nonce: Option<String>,
    exp: u64,
    iat: u64,
}

pub struct Client {
    http: reqwest::Client,
    vault: Arc<dyn CredentialVault>,
    credentials: Mutex<CredentialStore>,
    sign_in: Mutex<Option<(SignInStatus, Arc<Notify>)>>,
    turns: Mutex<HashMap<String, Arc<Notify>>>,
    models: Mutex<HashMap<String, Vec<Model>>>,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn random() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
fn equal(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |n, (a, b)| n | (a ^ b)) == 0
}
fn account_key(client: &str, subject: &str) -> String {
    hex_digest(format!("{client}\0{subject}").as_bytes())
}
fn hex_digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn provider_error(value: &Value) -> String {
    let code = value
        .pointer("/error/code")
        .or_else(|| value.pointer("/response/error/code"))
        .and_then(Value::as_str)
        .unwrap_or("request_failed");
    match code {
        "subscription_sharing_usage_limit_exceeded" | "subscription_sharing_usage_unavailable" => "ChatGPT plan usage is unavailable or its limit was reached. Check usage in ChatGPT settings.".into(),
        "invalid_grant" | "invalid_refresh_token" | "refresh_token_reused" | "token_expired" | "refresh_token_expired" | "refresh_token_invalidated" => "ChatGPT sign-in expired or was revoked. Reconnect this account.".into(),
        "subscription_sharing_unsupported_capability" => "This model or capability is unavailable through ChatGPT plan usage. Choose another available model.".into(),
        "access_denied" => "ChatGPT sign-in was declined.".into(),
        _ => "ChatGPT could not complete the request. Retry or reconnect your account if access was revoked.".into(),
    }
}
async fn json_response(mut response: reqwest::Response) -> Result<Value> {
    let status = response.status();
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "ChatGPT response was interrupted.".to_string())?
    {
        if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
            return Err("ChatGPT response exceeded its size limit.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "ChatGPT returned an unreadable response.".to_string())?;
    if !status.is_success() {
        return Err(provider_error(&value));
    }
    Ok(value)
}
impl Client {
    pub async fn new(vault: Arc<dyn CredentialVault>) -> Result<Arc<Self>> {
        let v = vault.clone();
        let credentials = tokio::task::spawn_blocking(move || v.load())
            .await
            .map_err(|_| "Assistant storage is unavailable.".to_string())??
            .unwrap_or_default();
        if !credentials.host_id.starts_with("urn:uuid:") {
            return Err("Invalid assistant host identity.".into());
        }
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(180))
            .build()
            .map_err(|_| "Assistant network client is unavailable.".to_string())?;
        Ok(Arc::new(Self {
            http,
            vault,
            credentials: Mutex::new(credentials),
            sign_in: Mutex::new(None),
            turns: Mutex::new(HashMap::new()),
            models: Mutex::new(HashMap::new()),
        }))
    }
    async fn save(&self, store: &CredentialStore) -> Result<()> {
        let vault = self.vault.clone();
        let data = store.clone();
        tokio::task::spawn_blocking(move || vault.save(&data))
            .await
            .map_err(|_| "Assistant storage is unavailable.".to_string())?
    }
    pub async fn status(&self) -> Status {
        let sign_in = self.sign_in.lock().await.as_ref().map(|(s, _)| s.clone());
        let store = self.credentials.lock().await;
        Status {
            accounts: store.accounts.iter().map(AccountInfo::from).collect(),
            active: store.active.clone(),
            sign_in,
        }
    }
    pub async fn select(&self, id: &str) -> Result<()> {
        let mut store = self.credentials.lock().await;
        if !store.accounts.iter().any(|a| a.id == id) {
            return Err("Unknown ChatGPT account.".into());
        }
        let mut next = store.clone();
        next.active = Some(id.into());
        self.save(&next).await?;
        *store = next;
        Ok(())
    }
    /// Native caller opens this URL; it is never logged or sent to the webview.
    pub async fn begin(self: &Arc<Self>, account_id: Option<String>) -> Result<(String, String)> {
        let mut pending = self.sign_in.lock().await;
        if pending.as_ref().is_some_and(|(s, _)| s.status == "waiting") {
            return Err(
                "A ChatGPT sign-in is already open. Cancel it before starting another.".into(),
            );
        }
        let (host, prior) = {
            let store = self.credentials.lock().await;
            self.save(&store).await?;
            let prior = match account_id {
                Some(ref id) => Some(
                    store
                        .accounts
                        .iter()
                        .find(|a| &a.id == id)
                        .ok_or("Unknown ChatGPT account.")?
                        .clone(),
                ),
                None => None,
            };
            (store.host_id.clone(), prior)
        };
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|_| "Could not start the local ChatGPT callback.".to_string())?;
        let redirect = format!(
            "http://127.0.0.1:{}/auth/callback",
            listener
                .local_addr()
                .map_err(|_| "Local callback unavailable.")?
                .port()
        );
        let state = random();
        let nonce = random();
        let verifier = random();
        let url = authorize_url(&host, &redirect, &state, &nonce, &verifier, prior.as_ref())?;
        let id = uuid::Uuid::new_v4().to_string();
        let cancel = Arc::new(Notify::new());
        *pending = Some((
            SignInStatus {
                id: id.clone(),
                status: "waiting".into(),
                error: None,
                expires_at: now() + AUTHORIZATION_WINDOW.as_secs(),
            },
            cancel.clone(),
        ));
        let client = self.clone();
        let attempt = id.clone();
        tokio::spawn(async move {
            let result = authorize_until_deadline(
                cancel,
                client.finish(listener, &redirect, &state, &nonce, &verifier, prior),
            )
            .await;
            let mut pending = client.sign_in.lock().await;
            if let Some((status, _)) = pending.as_mut().filter(|(s, _)| s.id == attempt) {
                status.status = if result.is_ok() { "complete" } else { "error" }.into();
                status.error = result.err();
            }
        });
        Ok((id, url))
    }
    pub async fn cancel_sign_in(&self) {
        if let Some((_, cancel)) = self.sign_in.lock().await.as_ref() {
            cancel.notify_one();
        }
    }
    async fn finish(
        &self,
        listener: TcpListener,
        redirect: &str,
        state: &str,
        nonce: &str,
        verifier: &str,
        prior: Option<Account>,
    ) -> Result<()> {
        let fields = receive_callback(listener, state).await?;
        let issued = callback_client(&fields, prior.as_ref().map(|a| a.client_id.as_str()))?;
        let code = fields
            .get("code")
            .filter(|c| !c.is_empty())
            .ok_or("ChatGPT did not return an authorization code.")?;
        let response = self
            .http
            .post(format!("{ISSUER}/api/accounts/oauth/token"))
            .timeout(Duration::from_secs(30))
            .form(&[
                ("grant_type", "authorization_code"),
                ("client_id", issued.as_str()),
                ("code", code.as_str()),
                ("code_verifier", verifier),
                ("redirect_uri", redirect),
                ("resource", RESOURCE),
            ])
            .send()
            .await
            .map_err(|_| "Could not reach ChatGPT to finish sign-in.".to_string())?;
        let tokens: Tokens = serde_json::from_value(json_response(response).await?)
            .map_err(|_| "ChatGPT returned incomplete credentials.".to_string())?;
        let id_token = tokens
            .id_token
            .clone()
            .ok_or("ChatGPT did not return an identity token.")?;
        let jwks: JwkSet = serde_json::from_value(
            json_response(
                self.http
                    .get(format!("{ISSUER}/.well-known/jwks.json"))
                    .timeout(Duration::from_secs(20))
                    .send()
                    .await
                    .map_err(|_| "Could not verify ChatGPT identity.".to_string())?,
            )
            .await?,
        )
        .map_err(|_| "ChatGPT identity keys were invalid.".to_string())?;
        let claims = verify_identity(&id_token, &issued, nonce, &jwks)?;
        if prior.as_ref().is_some_and(|p| p.subject != claims.sub) {
            return Err(
                "This sign-in belongs to a different ChatGPT account. Add it as a new connection."
                    .into(),
            );
        }
        check_tokens(&tokens)?;
        let id = account_key(&issued, &claims.sub);
        let account = Account {
            id: id.clone(),
            client_id: issued,
            subject: claims.sub,
            email: claims.email.unwrap_or_else(|| "ChatGPT account".into()),
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            id_token: id_token.clone(),
            expires_at: now() + tokens.expires_in,
            scopes: tokens
                .scope
                .unwrap_or_default()
                .split_whitespace()
                .map(String::from)
                .collect(),
            verified: false,
        };
        let mut store = self.credentials.lock().await;
        let mut next = store.clone();
        next.accounts.retain(|a| a.id != id);
        next.accounts.push(account);
        next.active = Some(id);
        self.save(&next).await?;
        *store = next;
        self.models.lock().await.clear();
        Ok(())
    }
    async fn access(&self, id: &str) -> Result<String> {
        // One writer serializes rotating refreshes. Never hold a renderer/room lock.
        let mut store = self.credentials.lock().await;
        let index = store
            .accounts
            .iter()
            .position(|a| a.id == id)
            .ok_or("Choose a connected ChatGPT account.")?;
        let account = &store.accounts[index];
        if !account.scopes.iter().any(|s| s == PLAN_SCOPE) {
            return Err(
                "Enable ChatGPT plan usage by reconnecting this account and approving access."
                    .into(),
            );
        }
        if account.expires_at > now() + 60 {
            return Ok(account.access_token.clone());
        }
        let refresh = account
            .refresh_token
            .as_deref()
            .ok_or("Reconnect ChatGPT to renew access.")?;
        let response = self
            .http
            .post(format!("{ISSUER}/api/accounts/oauth/token"))
            .timeout(Duration::from_secs(30))
            .form(&[
                ("grant_type", "refresh_token"),
                ("client_id", account.client_id.as_str()),
                ("refresh_token", refresh),
                ("resource", RESOURCE),
            ])
            .send()
            .await
            .map_err(|_| "ChatGPT renewal was interrupted. Retry when connected.".to_string())?;
        let tokens: Tokens = serde_json::from_value(json_response(response).await?)
            .map_err(|_| "ChatGPT returned incomplete renewal credentials.".to_string())?;
        check_tokens(&tokens)?;
        let mut next = store.clone();
        let account = &mut next.accounts[index];
        account.access_token = tokens.access_token;
        account.expires_at = now() + tokens.expires_in;
        if let Some(refresh) = tokens.refresh_token {
            account.refresh_token = Some(refresh);
        }
        // A refresh may omit scope; omission retains the original grant.
        if let Some(scope) = tokens.scope {
            account.scopes = scope.split_whitespace().map(String::from).collect();
        }
        let token = account.access_token.clone();
        self.save(&next).await?;
        *store = next;
        Ok(token)
    }
    pub async fn models(&self, id: &str) -> Result<Vec<Model>> {
        let token = self.access(id).await?;
        let value = json_response(
            self.http
                .get(format!("{RESOURCE}/models"))
                .timeout(Duration::from_secs(30))
                .bearer_auth(token)
                .send()
                .await
                .map_err(|_| "Could not load this account's ChatGPT models.".to_string())?,
        )
        .await?;
        let list: ModelList = serde_json::from_value(value)
            .map_err(|_| "ChatGPT returned an unsupported model catalog.".to_string())?;
        let models: Vec<Model> = list
            .models
            .into_iter()
            .filter(|m| {
                m.visibility == "list" && m.slug.len() <= 128 && m.display_name.len() <= 256
            })
            .map(|m| Model {
                slug: m.slug,
                display_name: m.display_name,
            })
            .take(100)
            .collect();
        self.models.lock().await.insert(id.into(), models.clone());
        Ok(models)
    }
    pub async fn disconnect(&self, id: &str) -> Result<bool> {
        self.cancel_all().await;
        let mut store = self.credentials.lock().await;
        let account = store
            .accounts
            .iter()
            .find(|a| a.id == id)
            .ok_or("Unknown ChatGPT account.")?;
        let mut revoked = account.refresh_token.is_none();
        if let Some(refresh) = &account.refresh_token {
            if let Ok(response) = self
                .http
                .get(format!("{ISSUER}/.well-known/openid-configuration"))
                .timeout(Duration::from_secs(15))
                .send()
                .await
            {
                if let Ok(value) = json_response(response).await {
                    if let Some(endpoint) = value
                        .get("revocation_endpoint")
                        .and_then(Value::as_str)
                        .filter(|u| u.starts_with("https://auth.openai.com/"))
                    {
                        revoked = self
                            .http
                            .post(endpoint)
                            .timeout(Duration::from_secs(15))
                            .form(&[
                                ("token", refresh.as_str()),
                                ("token_type_hint", "refresh_token"),
                                ("client_id", account.client_id.as_str()),
                            ])
                            .send()
                            .await
                            .is_ok_and(|r| r.status().is_success());
                    }
                }
            }
        }
        // Preserve registration identity/client so reconnect never re-registers.
        let mut next = store.clone();
        let account = next.accounts.iter_mut().find(|a| a.id == id).unwrap();
        account.access_token.clear();
        account.refresh_token = None;
        account.id_token.clear();
        account.expires_at = 0;
        account.scopes.clear();
        account.verified = false;
        if next.active.as_deref() == Some(id) {
            next.active = None;
        }
        self.save(&next).await?;
        *store = next;
        self.models.lock().await.remove(id);
        Ok(revoked)
    }
    pub async fn cancel(&self, id: &str) {
        if let Some(cancel) = self.turns.lock().await.get(id) {
            cancel.notify_one();
        }
    }
    pub async fn cancel_all(&self) {
        for cancel in self.turns.lock().await.values() {
            cancel.notify_one();
        }
    }
    pub async fn turn(
        &self,
        id: &str,
        turn_id: &str,
        model: &str,
        instructions: &str,
        input: Value,
        tools: Value,
        emit: impl Fn(Value) -> Result<()> + Send + Sync,
    ) -> Result<()> {
        if turn_id.len() > 100
            || turn_id.is_empty()
            || instructions.len() > 100_000
            || !input.is_array()
            || input.as_array().unwrap().len() > 160
            || !tools.is_array()
            || serde_json::to_vec(&input)
                .map_err(|_| "Invalid assistant input.")?
                .len()
                > 2 * 1024 * 1024
            || serde_json::to_vec(&tools)
                .map_err(|_| "Invalid tools.")?
                .len()
                > 256 * 1024
        {
            return Err(
                "Assistant turn exceeds its input budget. Start a new conversation.".into(),
            );
        }
        if !self
            .models
            .lock()
            .await
            .get(id)
            .is_some_and(|m| m.iter().any(|m| m.slug == model))
        {
            return Err("Refresh and select an available model before sending.".into());
        }
        let token = self.access(id).await?;
        let cancel = Arc::new(Notify::new());
        {
            let mut turns = self.turns.lock().await;
            if !turns.is_empty() {
                return Err("Another assistant turn is running. Stop it first.".into());
            }
            turns.insert(turn_id.into(), cancel.clone());
        }
        let request = json!({"model": model, "instructions": instructions, "input": input, "tools": tools, "include": ["reasoning.encrypted_content"], "store": false, "stream": true});
        let result = tokio::select! {
            _ = cancel.notified() => Err("Assistant stopped.".into()),
            result = self.stream(token, request, &emit) => result,
        };
        self.turns.lock().await.remove(turn_id);
        result?;
        let mut store = self.credentials.lock().await;
        if let Some(account) = store
            .accounts
            .iter()
            .find(|a| a.id == id)
            .filter(|a| !a.verified)
        {
            let mut next = store.clone();
            next.accounts
                .iter_mut()
                .find(|a| a.id == account.id)
                .unwrap()
                .verified = true;
            self.save(&next).await?;
            *store = next;
        }
        Ok(())
    }
    async fn stream(
        &self,
        token: String,
        body: Value,
        emit: &impl Fn(Value) -> Result<()>,
    ) -> Result<()> {
        let mut response = self
            .http
            .post(format!("{RESOURCE}/responses"))
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .map_err(|_| "Could not reach ChatGPT. Check your connection.".to_string())?;
        if !response.status().is_success() {
            return Err(json_response(response)
                .await
                .err()
                .unwrap_or_else(|| "ChatGPT request failed.".into()));
        }
        let mut parser = EventStream::default();
        let mut completed = false;
        while let Some(chunk) = response.chunk().await.map_err(|_| {
            "Assistant stream was interrupted. No unfinished edit was applied.".to_string()
        })? {
            for event in parser.push(&chunk)? {
                match event.get("type").and_then(Value::as_str) {
                    Some("response.output_text.delta") => emit(json!({"type": "text", "text": event.get("delta").and_then(Value::as_str).unwrap_or("")}))?,
                    Some("response.completed") => {completed = true; emit(json!({"type": "completed", "output": event.pointer("/response/output").cloned().unwrap_or(json!([]))}))?;},
                    Some("response.failed") | Some("error") => return Err(provider_error(&event)),
                    Some("response.incomplete") => return Err("ChatGPT stopped before completing this turn. No unfinished edit was applied.".into()),
                    _ => {},
                }
            }
        }
        if !completed {
            return Err(
                "Assistant stream ended without a completed response. Retry the request.".into(),
            );
        }
        Ok(())
    }
}
fn check_tokens(tokens: &Tokens) -> Result<()> {
    if !tokens.token_type.eq_ignore_ascii_case("bearer")
        || tokens.access_token.is_empty()
        || tokens.expires_in == 0
        || tokens.expires_in > 86400
    {
        return Err("ChatGPT returned invalid access credentials.".into());
    }
    Ok(())
}
fn authorize_url(
    host: &str,
    redirect: &str,
    state: &str,
    nonce: &str,
    verifier: &str,
    prior: Option<&Account>,
) -> Result<String> {
    let mut url = reqwest::Url::parse(&format!("{ISSUER}/api/accounts/authorize"))
        .map_err(|_| "Invalid sign-in endpoint.")?;
    {
        let mut query = url.query_pairs_mut();
        query
            .append_pair(
                "client_id",
                prior.map_or("dynamic_agent_client", |a| a.client_id.as_str()),
            )
            .append_pair("ext_agent_host_id", host)
            .append_pair("response_type", "code")
            .append_pair("redirect_uri", redirect)
            .append_pair("scope", SCOPE)
            .append_pair("resource", RESOURCE)
            .append_pair("state", state)
            .append_pair("nonce", nonce)
            .append_pair("code_challenge_method", "S256")
            .append_pair(
                "code_challenge",
                &URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())),
            );
        if let Some(a) = prior {
            if !a.id_token.is_empty() {
                query.append_pair("id_token_hint", &a.id_token);
            }
            if !a.email.is_empty() {
                query.append_pair("login_hint", &a.email);
            }
        } else {
            query.append_pair("agent_name_hint", "Producer");
        }
    }
    Ok(url.into())
}
fn callback_client(fields: &HashMap<String, String>, prior: Option<&str>) -> Result<String> {
    if fields.contains_key("error") {
        return Err("ChatGPT sign-in was declined or could not be completed.".into());
    }
    let issued = fields
        .get("client_id")
        .map(String::as_str)
        .or(prior)
        .ok_or("ChatGPT registration did not return its issued client ID.")?;
    if issued == "dynamic_agent_client"
        || issued.is_empty()
        || issued.len() > 256
        || !issued
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        || prior.is_some_and(|p| p != issued)
    {
        return Err("ChatGPT returned a different or invalid client registration.".into());
    }
    Ok(issued.into())
}
fn verify_identity(token: &str, client: &str, nonce: &str, keys: &JwkSet) -> Result<Claims> {
    let header = decode_header(token).map_err(|_| "Invalid ChatGPT identity token.")?;
    if ![Algorithm::RS256, Algorithm::ES256].contains(&header.alg) {
        return Err("Unsupported ChatGPT identity signature.".into());
    }
    let key = header
        .kid
        .as_ref()
        .and_then(|kid| keys.find(kid))
        .ok_or("ChatGPT identity signing key was not found.")?;
    let key = DecodingKey::from_jwk(key).map_err(|_| "Invalid ChatGPT identity signing key.")?;
    let mut validation = Validation::new(header.alg);
    validation.set_audience(&[client]);
    validation.set_issuer(&[ISSUER]);
    validation.set_required_spec_claims(&["sub", "exp", "iat", "iss", "aud"]);
    validation.leeway = 5;
    let claims = decode::<Claims>(token, &key, &validation)
        .map_err(|_| "ChatGPT identity verification failed.")?
        .claims;
    if claims.sub.is_empty()
        || claims.sub.len() > 256
        || claims.email.as_ref().is_some_and(|e| e.len() > 320)
        || claims.iat > now() + 5
        || claims.exp <= now()
        || !claims.nonce.as_deref().is_some_and(|n| equal(n, nonce))
    {
        return Err("ChatGPT identity or nonce did not match this sign-in.".into());
    }
    Ok(claims)
}
async fn receive_callback(listener: TcpListener, state: &str) -> Result<HashMap<String, String>> {
    let expected_host = listener
        .local_addr()
        .map_err(|_| "Local callback unavailable.")?
        .to_string();
    for _ in 0..64 {
        let (mut stream, peer) = listener
            .accept()
            .await
            .map_err(|_| "ChatGPT callback was interrupted.".to_string())?;
        if !peer.ip().is_loopback() {
            continue;
        }
        let received = tokio::time::timeout(Duration::from_secs(3), async {
            let mut bytes = Vec::new();
            let mut chunk = [0u8; 1024];
            while bytes.len() < 8192 {
                let count = stream.read(&mut chunk).await?;
                if count == 0 {
                    break;
                }
                bytes.extend_from_slice(&chunk[..count]);
                if bytes.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            Ok::<_, std::io::Error>(bytes)
        })
        .await;
        let Ok(Ok(bytes)) = received else {
            continue;
        };
        let request = String::from_utf8_lossy(&bytes);
        let first = request.lines().next().unwrap_or("");
        let parts = first.split_whitespace().collect::<Vec<_>>();
        let target = parts.get(1).copied().unwrap_or("");
        let parsed = reqwest::Url::parse(&format!("http://127.0.0.1{target}"));
        let host_matches = request
            .lines()
            .filter_map(|l| l.split_once(':'))
            .any(|(k, v)| k.eq_ignore_ascii_case("host") && v.trim() == expected_host);
        let mut fields = HashMap::new();
        let mut valid = bytes.len() < 8192
            && request.ends_with("\r\n\r\n")
            && host_matches
            && target.starts_with('/')
            && parts.first() == Some(&"GET")
            && parsed.as_ref().is_ok_and(|u| u.path() == "/auth/callback");
        if let Ok(url) = parsed {
            for (key, value) in url.query_pairs() {
                if fields.insert(key.to_string(), value.to_string()).is_some() {
                    valid = false;
                }
            }
        }
        valid &= fields.get("state").is_some_and(|s| equal(s, state));
        let body = if valid {
            "<!doctype html><meta charset=utf-8><title>Producer</title><p>Sign-in received. Return to Producer to finish connecting.</p>"
        } else {
            "Invalid sign-in callback."
        };
        let reply = format!("HTTP/1.1 {}\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}", if valid {"200 OK"} else {"400 Bad Request"}, body.len(), body);
        let _ = stream.write_all(reply.as_bytes()).await;
        let _ = stream.shutdown().await;
        if valid {
            return Ok(fields);
        }
    }
    Err("Too many invalid sign-in callbacks. Start a new sign-in.".into())
}
#[derive(Default)]
struct EventStream {
    buffer: Vec<u8>,
    total: usize,
}
impl EventStream {
    fn push(&mut self, bytes: &[u8]) -> Result<Vec<Value>> {
        self.total += bytes.len();
        if self.total > 16 * 1024 * 1024 {
            return Err("Assistant response exceeded its budget.".into());
        }
        self.buffer.extend_from_slice(bytes);
        let mut output = Vec::new();
        loop {
            let separator = self
                .buffer
                .windows(2)
                .position(|w| w == b"\n\n")
                .map(|i| (i, 2))
                .or_else(|| {
                    self.buffer
                        .windows(4)
                        .position(|w| w == b"\r\n\r\n")
                        .map(|i| (i, 4))
                });
            let Some((index, width)) = separator else {
                break;
            };
            let event = String::from_utf8(self.buffer.drain(..index + width).collect())
                .map_err(|_| "Invalid assistant stream encoding.")?;
            let data = event
                .lines()
                .filter_map(|l| l.strip_prefix("data:").map(str::trim_start))
                .collect::<Vec<_>>()
                .join("\n");
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            output
                .push(serde_json::from_str(&data).map_err(|_| "Invalid assistant stream event.")?);
        }
        if self.buffer.len() > 2 * 1024 * 1024 {
            return Err("Assistant stream event exceeded its budget.".into());
        }
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn registration_uses_pkce_stable_host_and_issued_client() {
        let url = reqwest::Url::parse(
            &authorize_url(
                "urn:uuid:test",
                "http://127.0.0.1:1234/auth/callback",
                "state",
                "nonce",
                "verifier",
                None,
            )
            .unwrap(),
        )
        .unwrap();
        let fields: HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(fields["client_id"], "dynamic_agent_client");
        assert_eq!(fields["agent_name_hint"], "Producer");
        assert_eq!(fields["ext_agent_host_id"], "urn:uuid:test");
        assert_eq!(
            fields["code_challenge"],
            URL_SAFE_NO_PAD.encode(Sha256::digest(b"verifier"))
        );
        assert!(callback_client(&HashMap::new(), None).is_err());
        assert!(callback_client(
            &HashMap::from([("client_id".into(), "dynamic_agent_client".into())]),
            None
        )
        .is_err());
        assert!(callback_client(
            &HashMap::from([("client_id".into(), "oaiapp_other".into())]),
            Some("oaiapp_expected")
        )
        .is_err());
        assert_eq!(
            callback_client(&HashMap::new(), Some("oaiapp_expected")).unwrap(),
            "oaiapp_expected"
        );
    }
    #[test]
    fn stream_handles_chunks_utf8_crlf_and_terminal_event() {
        let mut parser = EventStream::default();
        let data = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"café\"}\r\n\r\ndata: {\"type\":\"response.completed\",\"response\":{\"output\":[]}}\n\n".as_bytes();
        let mut events = Vec::new();
        for byte in data {
            events.extend(parser.push(&[*byte]).unwrap());
        }
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["delta"], "café");
        assert_eq!(events[1]["type"], "response.completed");
        assert!(EventStream::default().push(b"data: not-json\n\n").is_err());
    }
    #[test]
    fn identities_and_errors_do_not_expose_credentials() {
        assert_ne!(
            account_key("oaiapp_a", "user"),
            account_key("oaiapp_b", "user")
        );
        assert!(
            !provider_error(&json!({"error":{"code":"unknown", "message":"secret"}}))
                .contains("secret")
        );
        assert!(
            verify_identity("bad-token", "oaiapp_a", "nonce", &JwkSet { keys: vec![] }).is_err()
        );
        assert!(!equal("abc", "abd"));
        assert!(!equal("abc", "abcx"));
        assert!(equal("abc", "abc"));
    }
    #[test]
    fn signed_identity_requires_signature_issuer_audience_expiry_and_nonce() {
        // Synthetic tokens signed by a discarded test-only key. These have no
        // authority at OpenAI; production always fetches the issuer's real JWKS.
        let keys: JwkSet =
            serde_json::from_str(include_str!("../tests/keys/test-only-jwks.json")).unwrap();
        let tokens: HashMap<String, String> =
            serde_json::from_str(include_str!("../tests/keys/test-only-tokens.json")).unwrap();
        assert_eq!(
            verify_identity(&tokens["valid"], "oaiapp_test", "test_nonce", &keys)
                .unwrap()
                .sub,
            "test_subject"
        );
        for name in ["wrong_issuer", "wrong_audience", "expired", "future_issued"] {
            assert!(
                verify_identity(&tokens[name], "oaiapp_test", "test_nonce", &keys).is_err(),
                "{name}"
            );
        }
        assert!(
            verify_identity(&tokens["valid"], "oaiapp_test", "different_nonce", &keys).is_err()
        );
        let invalid = format!("{}broken", tokens["valid"]);
        assert!(verify_identity(&invalid, "oaiapp_test", "test_nonce", &keys).is_err());
        assert!(verify_identity(
            &tokens["valid"],
            "oaiapp_test",
            "test_nonce",
            &JwkSet { keys: vec![] }
        )
        .is_err());
    }
    #[tokio::test]
    async fn callback_rejects_forgery_and_accepts_split_valid_request() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let callback = tokio::spawn(receive_callback(listener, "expected_state"));
        let mut forged = tokio::net::TcpStream::connect(address).await.unwrap();
        forged.write_all(format!("GET /auth/callback?state=wrong&code=stolen HTTP/1.1\r\nHost: {address}\r\n\r\n").as_bytes()).await.unwrap();
        let mut result = Vec::new();
        forged.read_to_end(&mut result).await.unwrap();
        assert!(String::from_utf8_lossy(&result).starts_with("HTTP/1.1 400"));
        let mut valid = tokio::net::TcpStream::connect(address).await.unwrap();
        valid
            .write_all(b"GET /auth/callback?state=expected_")
            .await
            .unwrap();
        tokio::task::yield_now().await;
        // Opaque authorization codes can occupy several kilobytes. Exercise
        // the chunked reader without ever putting a real credential in tests.
        let opaque_code = "test_code".repeat(500);
        valid.write_all(format!("state&code={opaque_code}&client_id=oaiapp_test HTTP/1.1\r\nHost: {address}\r\n\r\n").as_bytes()).await.unwrap();
        let fields = callback.await.unwrap().unwrap();
        assert_eq!(fields["code"], opaque_code);
        assert_eq!(fields["client_id"], "oaiapp_test");
    }
    #[tokio::test]
    async fn host_identity_is_saved_before_authorization_and_concurrent_sign_in_is_rejected() {
        #[derive(Default)]
        struct Memory(std::sync::Mutex<Option<CredentialStore>>);
        impl CredentialVault for Memory {
            fn load(&self) -> Result<Option<CredentialStore>> {
                Ok(self.0.lock().unwrap().clone())
            }
            fn save(&self, store: &CredentialStore) -> Result<()> {
                *self.0.lock().unwrap() = Some(store.clone());
                Ok(())
            }
        }
        let vault = Arc::new(Memory::default());
        let client = Client::new(vault.clone()).await.unwrap();
        let (attempt, url) = client.begin(None).await.unwrap();
        let saved = vault.0.lock().unwrap().clone().unwrap();
        assert!(url.contains("ext_agent_host_id="));
        assert!(!saved.host_id.is_empty());
        assert_eq!(client.status().await.sign_in.unwrap().id, attempt);
        assert!(client.begin(None).await.is_err());
        client.cancel_sign_in().await;
        let public = serde_json::to_string(&client.status().await).unwrap();
        assert!(!public.contains("access_token"));
        assert!(!public.contains("refresh_token"));
        assert!(!public.contains("host_id"));
    }
    #[tokio::test(start_paused = true)]
    async fn first_sign_in_survives_five_minutes_but_has_a_deadline_and_cancel() {
        let cancel = Arc::new(Notify::new());
        let (complete, receive) = tokio::sync::oneshot::channel();
        let flow = tokio::spawn(authorize_until_deadline(cancel, async {
            receive
                .await
                .map_err(|_| "test response closed".to_string())
        }));
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(301)).await;
        tokio::task::yield_now().await;
        assert!(
            !flow.is_finished(),
            "first-time setup must outlive five minutes"
        );
        complete.send("completed").unwrap();
        assert_eq!(flow.await.unwrap().unwrap(), "completed");

        let cancel = Arc::new(Notify::new());
        let flow = tokio::spawn(authorize_until_deadline::<()>(
            cancel,
            std::future::pending(),
        ));
        tokio::task::yield_now().await;
        tokio::time::advance(AUTHORIZATION_WINDOW).await;
        assert!(flow
            .await
            .unwrap()
            .unwrap_err()
            .contains("newest browser tab"));

        let cancel = Arc::new(Notify::new());
        let flow = tokio::spawn(authorize_until_deadline::<()>(
            cancel.clone(),
            std::future::pending(),
        ));
        cancel.notify_one();
        assert!(flow.await.unwrap().unwrap_err().contains("canceled"));
    }
}
