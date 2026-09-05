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

    /// A brand scope means the hosted backend (Boomin): the room routes there
    /// differ in a few places from the open server's (producer-server
    /// contract) — POST verbs for interaction transitions, `contributions`
    /// for overlays, no runs, no audience code, a ticket + upgrade instead of
    /// `control-session`. Every branch below keys on this one derivation,
    /// the same one ipc.rs `endpoint_kind_of` and workspace.ts `isBoomin` use.
    pub fn is_boomin(&self) -> bool {
        self.brand_slug.is_some()
    }

    /// One platform-root request (see `root_url`) with the contract's error
    /// envelope read on failure. `body` None = no JSON body.
    async fn root_request(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&Value>,
    ) -> EngineResult<Value> {
        let mut req = self
            .http
            .request(method, self.root_url(path))
            .bearer_auth(&self.token);
        if let Some(b) = body {
            req = req.json(b);
        }
        let resp = req.send().await?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let b: Value = resp.json().await.unwrap_or(Value::Null);
            return Err(EngineError::Other(error_message(&b, status)));
        }
        Ok(resp.json().await?)
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

    /// Every server room this brand owns — Producer-registered ones (by
    /// `external_ref`) and rooms minted on the web or by a deal. Home
    /// reconciles its local rows against this so a room created anywhere is
    /// hostable from any machine.
    pub async fn list_rooms(&self) -> EngineResult<Value> {
        let resp = self
            .http
            .get(self.root_url("/v1/app/live/rooms"))
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

    /// Rename a SERVER room (the title the web, deals and the network show).
    pub async fn room_set_title(&self, room_id: &str, title: &str) -> EngineResult<Value> {
        let resp = self
            .http
            .patch(self.root_url(&format!("/v1/app/live/rooms/{room_id}")))
            .bearer_auth(&self.token)
            .json(&serde_json::json!({ "title": title }))
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let b: Value = resp.json().await.unwrap_or(Value::Null);
            return Err(EngineError::Other(error_message(&b, status)));
        }
        Ok(resp.json().await?)
    }

    /// Delete a SERVER room. The server refuses (409 `room_occupied` here,
    /// 409 `room_on_air` on Boomin) while the room is a live session — that
    /// verdict comes back as `Ok({ ok: false, code, message })`, a decision
    /// rather than a transport failure, so the app can keep the room and say
    /// why. Anything else non-2xx is an error (offline, missing route, 404).
    pub async fn delete_room(&self, room_id: &str) -> EngineResult<Value> {
        let resp = self
            .http
            .delete(self.root_url(&format!("/v1/app/live/rooms/{room_id}")))
            .bearer_auth(&self.token)
            .send()
            .await?;
        let status = resp.status().as_u16();
        if status == 409 || status == 422 {
            let b: Value = resp.json().await.unwrap_or(Value::Null);
            let code = b
                .pointer("/error/code")
                .or_else(|| b.get("code"))
                .and_then(Value::as_str)
                .unwrap_or("refused")
                .to_string();
            return Ok(serde_json::json!({
                "ok": false,
                "code": code,
                "message": error_message(&b, status),
            }));
        }
        if !(200..300).contains(&status) {
            let b: Value = resp.json().await.unwrap_or(Value::Null);
            return Err(EngineError::Other(error_message(&b, status)));
        }
        Ok(serde_json::json!({ "ok": true }))
    }

    /// Who is in this room right now. Producer polls this and reconciles its
    /// browser sources against it — guests arrive via the room link on their
    /// own, so the roster is the only way to learn about them.
    pub async fn room_guests(&self, room_id: &str) -> EngineResult<Value> {
        let resp = self
            .http
            .get(self.root_url(&format!("/v1/app/live/rooms/{room_id}/guests")))
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

    /// What THIS token may do in a room: host, or a member holding room
    /// control (api #380: `GET /rooms/:id/access`). Feature-detected — a
    /// server without the route (self-hosted, or Boomin before #380) answers
    /// 404, which comes back as `{available: false}` so the caller behaves
    /// exactly as it did before the route existed: as the host.
    pub async fn room_access(&self, room_id: &str) -> EngineResult<Value> {
        let resp = self
            .http
            .get(self.root_url(&format!("/v1/app/live/rooms/{room_id}/access")))
            .bearer_auth(&self.token)
            .send()
            .await?;
        if resp.status().as_u16() == 404 {
            return Ok(serde_json::json!({ "available": false }));
        }
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let b: Value = resp.json().await.unwrap_or(Value::Null);
            return Err(EngineError::Other(error_message(&b, status)));
        }
        let body: Value = resp.json().await?;
        Ok(serde_json::json!({ "available": true, "access": body }))
    }

    /// Mint a mod link (#47): a control seat (kind producer, control grants,
    /// no media) another Producer opens. `mod_url` is returned exactly once.
    pub async fn room_mod_link(
        &self,
        room_id: &str,
        display_name: Option<&str>,
    ) -> EngineResult<Value> {
        let resp = self
            .http
            .post(self.root_url(&format!("/v1/app/live/rooms/{room_id}/mod-link")))
            .bearer_auth(&self.token)
            .json(&serde_json::json!({ "display_name": display_name }))
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let b: Value = resp.json().await.unwrap_or(Value::Null);
            return Err(EngineError::Other(error_message(&b, status)));
        }
        Ok(resp.json().await?)
    }

    /// A 120 s ticket to the room channel's control side (host role). The
    /// webview opens the socket itself; this only mints the ticket.
    pub async fn room_control_session(&self, room_id: &str) -> EngineResult<Value> {
        if self.is_boomin() {
            // Same shape the webview's RoomControlLink consumes; the ticket
            // route already returns `signaling_url` (api #392).
            let t = self.room_channel_ticket(room_id).await?;
            return Ok(serde_json::json!({
                "signaling_ticket": t.get("ticket").cloned().unwrap_or(Value::Null),
                "signaling_url": t.get("signaling_url").cloned().unwrap_or(Value::Null),
                "role": t.get("role").cloned().unwrap_or(Value::Null),
                "can": t.get("can").cloned().unwrap_or(Value::Null),
            }));
        }
        let resp = self
            .http
            .post(self.root_url(&format!("/v1/app/live/rooms/{room_id}/control-session")))
            .bearer_auth(&self.token)
            .json(&serde_json::json!({}))
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let b: Value = resp.json().await.unwrap_or(Value::Null);
            return Err(EngineError::Other(error_message(&b, status)));
        }
        Ok(resp.json().await?)
    }

    /// Boomin (api #392): a 120 s ticket into the room's Durable Object for a
    /// host or a mod — `scene.cut`, `contribution.*` and the interaction
    /// frames ride it. `{ ticket, expires_in, role, can, signaling_url }`.
    pub async fn room_channel_ticket(&self, room_id: &str) -> EngineResult<Value> {
        self.root_request(
            reqwest::Method::POST,
            &format!("/v1/app/live/rooms/{room_id}/channel-ticket"),
            Some(&serde_json::json!({})),
        )
        .await
    }

    /// Boomin: the host publishes its scene list into the room's config so a
    /// mod's `POST …/scene` can name one (the server 422s an unknown id).
    /// `config` is built by the webview (lib/boominRoom.ts `boominStageConfig`)
    /// and passed through: `{ stage_enabled, scenes: [{id, kind, label}],
    /// active_scene_id }`. The open server takes the list over the socket
    /// (`scene.publish`) instead, so this is Boomin-only by construction.
    pub async fn room_publish_scenes(&self, room_id: &str, config: &Value) -> EngineResult<Value> {
        self.root_request(
            reqwest::Method::PATCH,
            &format!("/v1/app/live/rooms/{room_id}"),
            Some(&serde_json::json!({ "config": config })),
        )
        .await
    }

    /// Boomin: cut the room to a scene from a mod's Producer (`room.scene`).
    /// The host hears it as a `scene.cut` frame on the room channel. 403
    /// room_scene_required / 422 scene_unknown come back as messages.
    pub async fn room_scene_cut(&self, room_id: &str, scene_id: &str) -> EngineResult<Value> {
        self.root_request(
            reqwest::Method::POST,
            &format!("/v1/app/live/rooms/{room_id}/scene"),
            Some(&serde_json::json!({ "scene_id": scene_id })),
        )
        .await
    }

    /// The run's contribution ledger (#50). `run_id` None = the open run,
    /// else the latest with rows.
    pub async fn room_contributions(
        &self,
        room_id: &str,
        run_id: Option<&str>,
    ) -> EngineResult<Value> {
        let mut req = self
            .http
            .get(self.root_url(&format!("/v1/app/live/rooms/{room_id}/contributions")))
            .bearer_auth(&self.token);
        if let Some(r) = run_id {
            req = req.query(&[("run_id", r)]);
        }
        let resp = req.send().await?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let b: Value = resp.json().await.unwrap_or(Value::Null);
            return Err(EngineError::Other(error_message(&b, status)));
        }
        Ok(resp.json().await?)
    }

    /// Start / stop a run — the span the ledger reports on.
    pub async fn room_run(&self, room_id: &str, action: &str) -> EngineResult<Value> {
        if self.is_boomin() {
            // No Producer-facing run route on Boomin: the roster poll is the
            // heartbeat and a lapse ends the run server-side. The webview
            // brackets the report by its own clock (run_id stays null).
            return Ok(serde_json::json!({
                "run_id": Value::Null,
                "started_at": chrono_now_iso(),
                "action": action,
                "native": false,
            }));
        }
        let resp = self
            .http
            .post(self.root_url(&format!("/v1/app/live/rooms/{room_id}/runs")))
            .bearer_auth(&self.token)
            .json(&serde_json::json!({ "action": action }))
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let b: Value = resp.json().await.unwrap_or(Value::Null);
            return Err(EngineError::Other(error_message(&b, status)));
        }
        Ok(resp.json().await?)
    }

    /// An overlay source with a binding was shown or hidden.
    pub async fn room_overlay(
        &self,
        room_id: &str,
        source_id: &str,
        binding: &Value,
        shown: bool,
        label: Option<&str>,
    ) -> EngineResult<Value> {
        if self.is_boomin() {
            // `POST …/contributions {kind:"overlay", action, binding}` (api
            // #384): the binding names the source so the interval is
            // addressable; whatever the © button bound (a sponsor handle)
            // rides along so a metered deal's `contribution_binding` can
            // match on it.
            let mut b = match binding {
                Value::Object(m) => m.clone(),
                _ => serde_json::Map::new(),
            };
            b.insert("source_id".into(), Value::String(source_id.to_string()));
            let mut body = serde_json::json!({
                "kind": "overlay",
                "action": if shown { "show" } else { "hide" },
                "binding": Value::Object(b),
            });
            if let Some(l) = label {
                body["metadata"] = serde_json::json!({ "label": l });
            }
            return self
                .root_request(
                    reqwest::Method::POST,
                    &format!("/v1/app/live/rooms/{room_id}/contributions"),
                    Some(&body),
                )
                .await;
        }
        let resp = self
            .http
            .post(self.root_url(&format!("/v1/app/live/rooms/{room_id}/overlays")))
            .bearer_auth(&self.token)
            .json(&serde_json::json!({ "source_id": source_id, "binding": binding, "shown": shown, "label": label }))
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let b: Value = resp.json().await.unwrap_or(Value::Null);
            return Err(EngineError::Other(error_message(&b, status)));
        }
        Ok(resp.json().await?)
    }

    /// The room's interactions, projected for the host (#51).
    pub async fn room_interactions(&self, room_id: &str) -> EngineResult<Value> {
        let resp = self
            .http
            .get(self.root_url(&format!("/v1/app/live/rooms/{room_id}/interactions")))
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

    /// Open an interaction (a two-choice vote); the body is the contract's
    /// InteractionCreate, passed through unchanged.
    pub async fn room_interaction_create(
        &self,
        room_id: &str,
        body: &Value,
    ) -> EngineResult<Value> {
        let resp = self
            .http
            .post(self.root_url(&format!("/v1/app/live/rooms/{room_id}/interactions")))
            .bearer_auth(&self.token)
            .json(body)
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let b: Value = resp.json().await.unwrap_or(Value::Null);
            return Err(EngineError::Other(error_message(&b, status)));
        }
        Ok(resp.json().await?)
    }

    /// open · reveal · close · cancel. A reveal with a hold ARMS the server's
    /// alarm; the client never sets `revealed` itself.
    pub async fn room_interaction_transition(
        &self,
        room_id: &str,
        interaction_id: &str,
        transition: &str,
        reveal_hold_ms: Option<u64>,
    ) -> EngineResult<Value> {
        if self.is_boomin() {
            // Verbs are POSTs (api #386) and a vote is COLLECTING from the
            // moment it opens, so "open" is a read-back; a reveal hold is
            // timed by the webview (no reveal_hold_ms on the wire).
            let base = format!("/v1/app/live/rooms/{room_id}/interactions/{interaction_id}");
            return match transition {
                "open" => self.root_request(reqwest::Method::GET, &base, None).await,
                "reveal" | "close" | "cancel" => {
                    self.root_request(
                        reqwest::Method::POST,
                        &format!("{base}/{transition}"),
                        Some(&serde_json::json!({})),
                    )
                    .await
                }
                other => Err(EngineError::Other(format!("unknown transition {other}"))),
            };
        }
        let resp = self
            .http
            .patch(self.root_url(&format!(
                "/v1/app/live/rooms/{room_id}/interactions/{interaction_id}"
            )))
            .bearer_auth(&self.token)
            .json(
                &serde_json::json!({ "transition": transition, "reveal_hold_ms": reveal_hold_ms }),
            )
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let b: Value = resp.json().await.unwrap_or(Value::Null);
            return Err(EngineError::Other(error_message(&b, status)));
        }
        Ok(resp.json().await?)
    }

    /// The room's audience code + share URL (/a/CODE); `rotate` mints a new one.
    pub async fn room_audience_link(&self, room_id: &str, rotate: bool) -> EngineResult<Value> {
        if self.is_boomin() {
            // Boomin has no room-level audience code: the share link is PER
            // VOTE (boomin.ai/a/<interaction id>), built by the webview.
            return Err(EngineError::Other(
                "On Boomin the audience link is per vote — open a vote first.".into(),
            ));
        }
        let resp = self
            .http
            .post(self.root_url(&format!("/v1/app/live/rooms/{room_id}/audience-link")))
            .bearer_auth(&self.token)
            .json(&serde_json::json!({ "rotate": rotate }))
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let b: Value = resp.json().await.unwrap_or(Value::Null);
            return Err(EngineError::Other(error_message(&b, status)));
        }
        Ok(resp.json().await?)
    }

    /// Host-controlled slot order — the FULL list of guest ids, first on top.
    pub async fn room_guest_order(&self, room_id: &str, order: &[String]) -> EngineResult<Value> {
        let resp = self
            .http
            .post(self.root_url(&format!("/v1/app/live/rooms/{room_id}/guest-order")))
            .bearer_auth(&self.token)
            .json(&serde_json::json!({ "order": order }))
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let b: Value = resp.json().await.unwrap_or(Value::Null);
            return Err(EngineError::Other(error_message(&b, status)));
        }
        Ok(resp.json().await?)
    }

    /// The room's shareable join link. `join_url` is readable ONLY at
    /// rotation, so the caller must persist what comes back — there is no
    /// way to ask for it again without invalidating everyone using it.
    pub async fn room_join_link(&self, room_id: &str, rotate: bool) -> EngineResult<Value> {
        let resp = self
            .http
            .post(self.root_url(&format!("/v1/app/live/rooms/{room_id}/guest-link")))
            .bearer_auth(&self.token)
            .json(&serde_json::json!({ "enabled": true, "rotate": rotate }))
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let b: Value = resp.json().await.unwrap_or(Value::Null);
            return Err(EngineError::Other(error_message(&b, status)));
        }
        Ok(resp.json().await?)
    }

    pub async fn admit_guest(&self, _room_id: &str, guest_id: &str) -> EngineResult<Value> {
        let resp = self
            .http
            .post(self.root_url(&format!("/v1/app/live/guests/{guest_id}/admit")))
            .bearer_auth(&self.token)
            .json(&serde_json::json!({}))
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let b: Value = resp.json().await.unwrap_or(Value::Null);
            return Err(EngineError::Other(error_message(&b, status)));
        }
        Ok(resp.json().await?)
    }

    pub async fn revoke_guest(&self, guest_id: &str) -> EngineResult<Value> {
        let resp = self
            .http
            .post(self.root_url(&format!("/v1/app/live/guests/{guest_id}/revoke")))
            .bearer_auth(&self.token)
            .json(&serde_json::json!({}))
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let b: Value = resp.json().await.unwrap_or(Value::Null);
            return Err(EngineError::Other(error_message(&b, status)));
        }
        Ok(resp.json().await?)
    }

    /// Push the CURRENT stage set. Always the FULL list, never a delta, so a
    /// dropped call is corrected by the next one instead of compounding. The
    /// server filters to admitted guests of THIS room and enforces the room's
    /// stage capacity, so it — not Producer — has the last word on what a
    /// reconnecting guest reads back.
    pub async fn set_stage(&self, room_id: &str, on_stage: &[String]) -> EngineResult<Value> {
        let resp = self
            .http
            .post(self.root_url(&format!("/v1/app/live/rooms/{room_id}/stage")))
            .bearer_auth(&self.token)
            .json(&serde_json::json!({ "on_stage": on_stage }))
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

    /// Network status: membership, live-now count, member count.
    pub async fn network_status(&self) -> EngineResult<Value> {
        let resp = self
            .http
            .get(self.root_url("/v1/app/network"))
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

    pub async fn network_invitations(&self, direction: &str) -> EngineResult<Value> {
        let resp = self
            .http
            .get(self.root_url(&format!(
                "/v1/app/network/invitations?direction={direction}"
            )))
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

    /// Invite by SLUG. Slugs are unique platform-wide, so they address a brand
    /// on their own — resolution happens server-side, which also avoids
    /// handing out a slug-existence oracle.
    pub async fn network_invite(
        &self,
        to_slug: &str,
        message: Option<String>,
    ) -> EngineResult<Value> {
        let mut body = serde_json::Map::new();
        body.insert("to_slug".into(), Value::String(to_slug.to_string()));
        if let Some(m) = message {
            body.insert("message".into(), Value::String(m));
        }
        let resp = self
            .http
            .post(self.root_url("/v1/app/network/invitations"))
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

    /// action: accept | decline | revoke
    /// Invite someone who is not (yet) on Boomin — or whose handle you don't
    /// know — by email. The server mints a single-use link; they sign in, pick
    /// the brand, and the membership records that WE brought them in.
    pub async fn network_invite_email(
        &self,
        to_email: &str,
        message: Option<String>,
    ) -> EngineResult<Value> {
        let mut body = serde_json::Map::new();
        body.insert("to_email".into(), Value::String(to_email.to_string()));
        if let Some(m) = message {
            body.insert("message".into(), Value::String(m));
        }
        let resp = self
            .http
            .post(self.root_url("/v1/app/network/invitations"))
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

    pub async fn network_invitation_action(&self, id: &str, action: &str) -> EngineResult<Value> {
        let resp = self
            .http
            .post(self.root_url(&format!("/v1/app/network/invitations/{id}/{action}")))
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

    /// One deal transition as THIS brand (accept | decline | cancel); the server
    /// decides whether this side may make the move.
    pub async fn network_deal_action(&self, id: &str, action: &str) -> EngineResult<Value> {
        let resp = self
            .http
            .post(self.root_url(&format!("/v1/app/network/deals/{id}/{action}")))
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

    /// One-time sign-in code for the runtime-delivered console
    /// (@boomin/components/console): the webview never sees THIS token —
    /// the console exchanges the code for its own in-memory session.
    pub async fn auth_handoff(&self, brand_slug: Option<&str>) -> EngineResult<Value> {
        let body = match brand_slug {
            Some(slug) => serde_json::json!({ "brand_slug": slug }),
            None => serde_json::json!({}),
        };
        let resp = self
            .http
            .post(self.root_url("/v1/app/auth/handoff"))
            .bearer_auth(&self.token)
            .json(&body)
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body: Value = resp.json().await.unwrap_or(Value::Null);
            return Err(EngineError::Other(error_message(&body, status)));
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

    /// Exact-handle lookup — Producer's whole discovery surface. There is
    /// deliberately no list call: the desktop can resolve a handle it was
    /// handed, nothing more.
    pub async fn network_lookup(&self, slug: &str) -> EngineResult<Value> {
        // Handles are [a-z0-9._-]; strip anything else BEFORE it reaches the
        // query string, so pasted junk ("@Name!", "a&b") can neither corrupt
        // the URL nor smuggle a second query parameter past root_url.
        let slug: String = slug
            .trim()
            .trim_start_matches('@')
            .to_lowercase()
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
            .collect();
        let resp = self
            .http
            .get(self.root_url(&format!("/v1/app/network/lookup?slug={slug}")))
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

    /// Open stages visible to this brand: connections' rooms + public rooms.
    pub async fn network_live_rooms(&self) -> EngineResult<Value> {
        let resp = self
            .http
            .get(self.root_url("/v1/app/network/rooms/live"))
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

    /// Knock on a visible open stage; lands in the host's waiting room and
    /// returns a guest join URL to open in the browser.
    pub async fn network_enter_room(&self, room_id: &str) -> EngineResult<Value> {
        let resp = self
            .http
            .post(self.root_url(&format!("/v1/app/network/rooms/{room_id}/enter")))
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

    /// Enter a deal's show as the BENEFICIARY: knocks on the host's room
    /// through the deal, so the admit settles it. Returns `{join_url, resumed}`.
    /// A 409 `network_room_closed` (host's Producer isn't polling its roster)
    /// is surfaced with the code intact so the UI can say "not open yet".
    pub async fn network_deal_enter(&self, id: &str) -> EngineResult<Value> {
        let resp = self
            .http
            .post(self.root_url(&format!("/v1/app/network/deals/{id}/enter")))
            .bearer_auth(&self.token)
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let b: Value = resp.json().await.unwrap_or(Value::Null);
            let code = b
                .pointer("/error/code")
                .or_else(|| b.get("code"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if status == 409 && code == "network_room_closed" {
                return Err(EngineError::Other(format!(
                    "network_room_closed: {}",
                    error_message(&b, status)
                )));
            }
            return Err(EngineError::Other(error_message(&b, status)));
        }
        Ok(resp.json().await?)
    }

    /// Every deal this brand is party to (client or beneficiary), newest first.
    pub async fn network_deals(&self) -> EngineResult<Value> {
        let resp = self
            .http
            .get(self.root_url("/v1/app/network/deals"))
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

    /// Propose an appearance deal: this brand (the host) pays the counterparty
    /// to appear on one of ITS server rooms. Presence there is delivery —
    /// admitting the guest flips the funded deal to delivered server-side.
    /// Pricing is server-owned; only amount/title/room travel.
    pub async fn network_propose_deal(
        &self,
        connection_id: &str,
        beneficiary_brand_id: &str,
        room_id: &str,
        title: &str,
        amount_cents: u64,
        min_stage_minutes: Option<u32>,
        metered: Option<&Value>,
    ) -> EngineResult<Value> {
        let mut body = serde_json::json!({
            "connection_id": connection_id,
            "beneficiary_brand_id": beneficiary_brand_id,
            "room_id": room_id,
            "title": title,
            "amount_cents": amount_cents,
        });
        // Omitted, never null: the API's optional field rejects an explicit null.
        if let Some(m) = min_stage_minutes {
            body["min_stage_minutes"] = serde_json::json!(m);
        }
        // Metered terms (api #385): pricing, rate_card, contribution_kind,
        // contribution_binding — merged verbatim; the server validates them.
        if let Some(Value::Object(extra)) = metered {
            for (k, v) in extra {
                body[k.as_str()] = v.clone();
            }
        }
        let resp = self
            .http
            .post(self.root_url("/v1/app/network/deals"))
            .bearer_auth(&self.token)
            .json(&body)
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let b: Value = resp.json().await.unwrap_or(Value::Null);
            return Err(EngineError::Other(error_message(&b, status)));
        }
        Ok(resp.json().await?)
    }

    /// Network exposure of a SERVER room: private | connections | public.
    pub async fn room_set_visibility(
        &self,
        room_id: &str,
        visibility: &str,
    ) -> EngineResult<Value> {
        let resp = self
            .http
            .patch(self.root_url(&format!("/v1/app/live/rooms/{room_id}")))
            .bearer_auth(&self.token)
            .json(&serde_json::json!({ "visibility": visibility }))
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let b: Value = resp.json().await.unwrap_or(Value::Null);
            return Err(EngineError::Other(error_message(&b, status)));
        }
        Ok(resp.json().await?)
    }

    /// Make this room the brand's main stage (the one Network bookings and
    /// deals land in). The API moves the flag; a brand always has exactly one.
    pub async fn room_set_default(&self, room_id: &str) -> EngineResult<Value> {
        let resp = self
            .http
            .patch(self.root_url(&format!("/v1/app/live/rooms/{room_id}")))
            .bearer_auth(&self.token)
            .json(&serde_json::json!({ "is_default": true }))
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let b: Value = resp.json().await.unwrap_or(Value::Null);
            return Err(EngineError::Other(error_message(&b, status)));
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

    /// Disconnect a posting channel (contract: DELETE /v1/channels/:id). The
    /// same path on both backends; Boomin may answer 501 until its own route
    /// lands, and the message says where to do it instead.
    pub async fn disconnect_channel(&self, channel_id: &str) -> EngineResult<Value> {
        let resp = self
            .http
            .delete(self.url(&format!("/v1/channels/{channel_id}")))
            .bearer_auth(&self.token)
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body: Value = resp.json().await.unwrap_or(Value::Null);
            return Err(EngineError::Other(error_message(&body, status)));
        }
        Ok(resp.json().await.unwrap_or(Value::Null))
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

/// ISO-8601 UTC now, without pulling a date crate in for one field: the
/// webview only parses it back with Date.parse.
fn chrono_now_iso() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Civil-from-days (Howard Hinnant), enough for a timestamp.
    let days = (secs / 86_400) as i64;
    let sod = secs % 86_400;
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        sod / 3600,
        (sod % 3600) / 60,
        sod % 60
    )
}
