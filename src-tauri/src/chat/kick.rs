//! Kick chat over the public Pusher stream.
//!
//! Kick's official API (docs.kick.com, current as of 2026-08) can SEND chat
//! and can deliver `chat.message.sent` to a webhook, but offers no read
//! transport a desktop app can use — no polling endpoint, no websocket. The
//! Pusher socket every logged-out kick.com visitor already receives is the
//! only path, so that is what we read.
//!
//! It is unofficial, so nothing here is a compile-time constant: the app key,
//! client version and event names are all overridable at runtime, and unknown
//! events are logged rather than dropped. When Kick rotates something we want
//! a config change, not a release.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio_tungstenite::tungstenite::Message;

use super::{backoff, ChatEvent, ChatHub, ChatMsg};

const DEFAULT_APP_KEY: &str = "32cbd69e4b950bf97679";
const DEFAULT_CLIENT_VERSION: &str = "8.4.0-rc2";
const DEFAULT_CLUSTER_HOST: &str = "ws-us2.pusher.com";

/// Kick has renamed this event at least once; accept every spelling we know.
const MESSAGE_EVENTS: &[&str] = &[
    r"App\Events\ChatMessageEvent",
    r"App\Events\ChatMessageSentEvent",
];

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| fallback.to_string())
}

fn socket_url() -> String {
    format!(
        "wss://{}/app/{}?protocol=7&client=js&version={}&flash=false",
        env_or("PRODUCER_KICK_WS_HOST", DEFAULT_CLUSTER_HOST),
        env_or("PRODUCER_KICK_APP_KEY", DEFAULT_APP_KEY),
        env_or("PRODUCER_KICK_CLIENT_VERSION", DEFAULT_CLIENT_VERSION),
    )
}

/// `channel` here is the numeric chatroom id, already resolved (see
/// `commands::kick_resolve_chatroom` for why that is a separate step).
pub async fn run(hub: ChatHub, chatroom_id: String, stop: Arc<AtomicBool>, connected: Arc<AtomicBool>) {
    let mut attempt = 0u32;
    while !stop.load(Ordering::SeqCst) {
        match session(&hub, &chatroom_id, &stop, &connected).await {
            Ok(()) => attempt = 0,
            Err(e) => {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                hub.emit(ChatEvent::Disconnected {
                    platform: "kick".into(),
                    reason: Some(e),
                });
            }
        }
        connected.store(false, Ordering::SeqCst);
        if stop.load(Ordering::SeqCst) {
            break;
        }
        tokio::time::sleep(backoff(attempt)).await;
        attempt = attempt.saturating_add(1);
    }
    connected.store(false, Ordering::SeqCst);
}

async fn session(
    hub: &ChatHub,
    chatroom_id: &str,
    stop: &Arc<AtomicBool>,
    connected: &Arc<AtomicBool>,
) -> Result<(), String> {
    let (mut ws, _) = tokio_tungstenite::connect_async(socket_url())
        .await
        .map_err(|e| format!("connect failed: {e}"))?;

    // Both channel spellings are in the wild and a spare subscription is free.
    for chan in [format!("chatrooms.{chatroom_id}.v2"), format!("chatrooms.{chatroom_id}")] {
        let sub = serde_json::json!({
            "event": "pusher:subscribe",
            "data": { "channel": chan, "auth": "" }
        });
        ws.send(Message::Text(sub.to_string()))
            .await
            .map_err(|e| format!("subscribe failed: {e}"))?;
    }

    connected.store(true, Ordering::SeqCst);
    hub.emit(ChatEvent::Connected {
        platform: "kick".into(),
        channel: chatroom_id.to_string(),
    });

    const IDLE: std::time::Duration = std::time::Duration::from_secs(180);
    // We subscribe to two channel spellings; only `.v2` delivers today, but
    // if Kick ever fans out on both we must not print every line twice.
    let mut recent: std::collections::VecDeque<String> = std::collections::VecDeque::new();
    loop {
        let frame = match tokio::time::timeout(IDLE, ws.next()).await {
            Err(_) => {
                let ping = serde_json::json!({ "event": "pusher:ping", "data": {} });
                ws.send(Message::Text(ping.to_string()))
                    .await
                    .map_err(|e| format!("keepalive failed: {e}"))?;
                continue;
            }
            Ok(None) => break,
            Ok(Some(f)) => f,
        };
        if stop.load(Ordering::SeqCst) {
            let _ = ws.close(None).await;
            return Ok(());
        }
        let text = match frame.map_err(|e| format!("socket error: {e}"))? {
            Message::Text(t) => t,
            Message::Close(_) => return Err("server closed the connection".into()),
            _ => continue,
        };
        let env: Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let event = env.get("event").and_then(Value::as_str).unwrap_or_default();
        match event {
            "pusher:ping" => {
                let pong = serde_json::json!({ "event": "pusher:pong", "data": {} });
                let _ = ws.send(Message::Text(pong.to_string())).await;
            }
            "pusher:error" => {
                return Err(format!("pusher rejected us: {}", env.get("data").unwrap_or(&Value::Null)));
            }
            e if MESSAGE_EVENTS.contains(&e) => {
                // Pusher nests the real payload as a JSON *string*.
                if let Some(msg) = env.get("data").and_then(Value::as_str).and_then(parse_message) {
                    if !msg.id.is_empty() {
                        if recent.contains(&msg.id) {
                            continue;
                        }
                        recent.push_back(msg.id.clone());
                        if recent.len() > 200 {
                            recent.pop_front();
                        }
                    }
                    hub.emit(ChatEvent::Message { msg });
                }
            }
            "" | "pusher:pong" | "pusher_internal:subscription_succeeded" | "pusher:connection_established" => {}
            other => {
                // Kick renames events without notice; leave a trail.
                eprintln!("kick chat: unhandled event {other}");
            }
        }
    }
    Err("stream ended".into())
}

fn parse_message(raw: &str) -> Option<ChatMsg> {
    let v: Value = serde_json::from_str(raw).ok()?;
    let content = v.get("content").and_then(Value::as_str)?;
    let sender = v.get("sender")?;
    Some(ChatMsg {
        emotes: None,
        platform: "kick".into(),
        id: v.get("id").and_then(Value::as_str).unwrap_or_default().to_string(),
        user: sender
            .get("username")
            .and_then(Value::as_str)
            .unwrap_or("someone")
            .to_string(),
        color: sender
            .get("identity")
            .and_then(|i| i.get("color"))
            .and_then(Value::as_str)
            .filter(|c| !c.is_empty())
            .map(str::to_string),
        text: strip_emotes(content),
    })
}

/// Kick inlines emotes in the text as `[emote:<id>:<name>]`; show the name.
fn strip_emotes(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find("[emote:") {
        out.push_str(&rest[..open]);
        let after = &rest[open + "[emote:".len()..];
        match after.find(']') {
            Some(close) => {
                let inner = &after[..close];
                out.push_str(inner.split(':').nth(1).unwrap_or(inner));
                rest = &after[close + 1..];
            }
            None => {
                // Unclosed token: keep the raw text rather than mangling it.
                out.push_str(&rest[open..]);
                return out;
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::{parse_message, strip_emotes};

    #[test]
    fn reads_username_and_colour() {
        let raw = r##"{"id":"m-1","content":"lets go","sender":{"username":"xQc","identity":{"color":"#E9113C"}}}"##;
        let m = parse_message(raw).expect("parsed");
        assert_eq!(m.user, "xQc");
        assert_eq!(m.color.as_deref(), Some("#E9113C"));
        assert_eq!(m.text, "lets go");
    }

    #[test]
    fn survives_missing_identity() {
        let raw = r#"{"id":"m-2","content":"hi","sender":{"username":"nobody"}}"#;
        let m = parse_message(raw).expect("parsed");
        assert_eq!(m.color, None);
    }

    #[test]
    fn emotes_become_their_names() {
        assert_eq!(strip_emotes("gg [emote:37226:EZ] wp"), "gg EZ wp");
        assert_eq!(strip_emotes("no emotes here"), "no emotes here");
        assert_eq!(strip_emotes("[emote:1:A][emote:2:B]"), "AB");
    }

    #[test]
    fn tolerates_unclosed_emote() {
        assert_eq!(strip_emotes("oops [emote:9:X"), "oops [emote:9:X");
    }
}

/// Resolve a channel slug to its numeric chatroom id.
///
/// This is the one fragile step in the Kick path: `kick.com/api/v2` sits
/// behind Cloudflare, which fingerprints TLS as well as headers, so a plain
/// Rust client is refused some of the time. We try anyway (it often works,
/// and costs one request), and the caller caches the answer forever — the id
/// never changes for a channel — with a paste-it-yourself fallback in the UI
/// for the case Cloudflare wins. The official API cannot substitute: it
/// exposes broadcaster_user_id, which is a different number.
pub async fn resolve_chatroom(slug: &str) -> Result<String, String> {
    let slug = slug.trim().trim_start_matches('@').to_ascii_lowercase();
    if slug.is_empty() {
        return Err("channel name is empty".into());
    }
    let url = format!("https://kick.com/api/v2/channels/{slug}");
    let res = reqwest::Client::builder()
        .user_agent(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
        )
        .build()
        .map_err(|e| e.to_string())?
        .get(&url)
        .header("Accept", "application/json")
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("Referer", "https://kick.com/")
        .send()
        .await
        .map_err(|e| format!("could not reach Kick: {e}"))?;

    if !res.status().is_success() {
        return Err(format!(
            "Kick refused the lookup ({}). Cloudflare blocks non-browser clients — open {url} in your browser and paste the chatroom id.",
            res.status()
        ));
    }
    let body: Value = res.json().await.map_err(|e| format!("unreadable reply: {e}"))?;
    body.get("chatroom")
        .and_then(|c| c.get("id"))
        .and_then(Value::as_u64)
        .map(|id| id.to_string())
        .ok_or_else(|| "Kick's reply had no chatroom id".to_string())
}
