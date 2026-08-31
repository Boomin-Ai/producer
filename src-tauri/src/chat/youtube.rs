//! YouTube live chat over InnerTube — the same call youtube.com's own chat
//! page makes.
//!
//! YouTube has no anonymous read transport we can use officially: the Data
//! API's `liveChatMessages.list` needs an API key, and a key shipped inside a
//! desktop app means every user on earth shares one daily quota — a few
//! hours of chat, total, for everybody. So we read the way every desktop
//! YouTube-chat tool does.
//!
//! Verified against live YouTube 2026-08-30: no API key (the `key=` param is
//! ignored outright), no browser User-Agent, no Origin/Referer. The ONE hard
//! requirement is a plausible `clientVersion` — omit it and you get 400,
//! malform it and you get 404. Everything fragile here is HTML scraping, not
//! the API, so every scraped value has a fallback and nothing is a
//! compile-time constant.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use super::{backoff, ChatEvent, ChatHub, ChatMsg};

/// A stale version still works (a two-year-old one returned 200); only a
/// malformed one 404s. Used when scraping the live value fails.
const FALLBACK_CLIENT_VERSION: &str = "2.20260828.01.00";
const CHAT_URL: &str = "https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?prettyPrint=false";

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key)
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

/// Text between `needle` and the next `end`, if present.
fn between<'a>(hay: &'a str, needle: &str, end: &str) -> Option<&'a str> {
    let start = hay.find(needle)? + needle.len();
    let rest = &hay[start..];
    let stop = rest.find(end)?;
    Some(&rest[..stop])
}

/// Balanced-brace slice starting at the first `{` after `needle`.
fn json_after<'a>(hay: &'a str, needle: &str) -> Option<&'a str> {
    let start = hay.find(needle)? + needle.len();
    let rest = &hay[start..];
    let open = rest.find('{')?;
    let bytes = rest.as_bytes();
    let mut depth = 0usize;
    let mut in_str = false;
    let mut esc = false;
    for i in open..bytes.len() {
        let c = bytes[i];
        if in_str {
            if esc {
                esc = false;
            } else if c == b'\\' {
                esc = true;
            } else if c == b'"' {
                in_str = false;
            }
            continue;
        }
        match c {
            b'"' => in_str = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&rest[open..=i]);
                }
            }
            _ => {}
        }
    }
    None
}

struct Bootstrap {
    continuation: String,
    client_version: String,
}

/// Resolve a channel handle to its live video, then that video to a chat
/// continuation token. Offline channels return 200 with a browse page, not a
/// 404 — so "no watch page" is a normal state, not an error.
async fn bootstrap(client: &reqwest::Client, channel: &str) -> Result<Bootstrap, String> {
    let handle = channel.trim().trim_start_matches('@');
    let live_url = if handle.starts_with("UC") && handle.len() > 20 {
        format!("https://www.youtube.com/channel/{handle}/live")
    } else {
        format!("https://www.youtube.com/@{handle}/live")
    };
    let page = client
        .get(&live_url)
        .send()
        .await
        .map_err(|e| format!("couldn't reach YouTube: {e}"))?
        .text()
        .await
        .map_err(|e| format!("couldn't read YouTube's reply: {e}"))?;

    if page.contains("consent.youtube.com") || page.contains("Before you continue to YouTube") {
        return Err("YouTube served a consent page — chat can't start from here".into());
    }

    let video = between(&page, r#"<link rel="canonical" href="https://www.youtube.com/watch?v="#, "\"")
        .or_else(|| between(&page, r#""canonicalBaseUrl":"/watch?v="#, "\""))
        .or_else(|| between(&page, r#""videoId":""#, "\""))
        .map(|s| s.to_string())
        .ok_or_else(|| format!("{handle} isn't live right now"))?;

    // The /live page IS the watch page when live; re-fetch only if we had to
    // fall back to a videoId found elsewhere.
    let watch = if page.contains("twoColumnWatchNextResults") {
        page
    } else {
        client
            .get(format!("https://www.youtube.com/watch?v={video}"))
            .send()
            .await
            .map_err(|e| format!("couldn't reach the stream: {e}"))?
            .text()
            .await
            .map_err(|e| format!("couldn't read the stream page: {e}"))?
    };

    if !watch.contains("twoColumnWatchNextResults") {
        return Err(format!("{handle} isn't live right now"));
    }

    let data = json_after(&watch, "ytInitialData = ").ok_or("YouTube's page layout changed")?;
    let v: Value = serde_json::from_str(data).map_err(|_| "YouTube's page layout changed")?;
    let chat = v
        .pointer("/contents/twoColumnWatchNextResults/conversationBar/liveChatRenderer")
        .ok_or("this stream has chat turned off")?;
    if chat.get("isReplay").and_then(Value::as_bool).unwrap_or(false) {
        return Err("that stream has ended — its chat is a replay".into());
    }
    let continuation = chat
        .pointer("/continuations/0/reloadContinuationData/continuation")
        .and_then(Value::as_str)
        .ok_or("couldn't find the chat stream")?
        .to_string();

    let client_version = between(&watch, r#""INNERTUBE_CONTEXT_CLIENT_VERSION":""#, "\"")
        .map(|s| s.to_string())
        .unwrap_or_else(|| env_or("PRODUCER_YT_CLIENT_VERSION", FALLBACK_CLIENT_VERSION));

    Ok(Bootstrap {
        continuation,
        client_version,
    })
}

/// Pull the readable text out of a message's runs: plain text runs, plus
/// emoji runs (standard emoji carry the literal character in `emojiId`;
/// custom ones fall back to their shortcut).
fn runs_text(runs: &Value) -> String {
    let Some(arr) = runs.as_array() else {
        return String::new();
    };
    let mut out = String::new();
    for r in arr {
        if let Some(t) = r.get("text").and_then(Value::as_str) {
            out.push_str(t);
        } else if let Some(e) = r.get("emoji") {
            let custom = e.get("isCustomEmoji").and_then(Value::as_bool).unwrap_or(false);
            let shortcut = e
                .pointer("/shortcuts/0")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let id = e.get("emojiId").and_then(Value::as_str).unwrap_or_default();
            if custom || id.is_empty() {
                out.push_str(shortcut);
            } else {
                out.push_str(id);
            }
        }
    }
    out
}

pub async fn run(hub: ChatHub, channel: String, stop: Arc<AtomicBool>, connected: Arc<AtomicBool>) {
    // Every documented break of this path lands on the HTML fetch (the
    // "confirm you're not a bot" wall), never on the chat endpoint — so the
    // browser-ish headers and the consent cookie are cheap insurance there.
    // SOCS=CAI dismisses the EU consent interstitial; harmless elsewhere.
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::USER_AGENT,
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36".parse().unwrap(),
    );
    headers.insert(reqwest::header::ACCEPT_LANGUAGE, "en-US,en;q=0.9".parse().unwrap());
    headers.insert(reqwest::header::COOKIE, "SOCS=CAI".parse().unwrap());
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .default_headers(headers)
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            hub.emit(ChatEvent::Disconnected {
                platform: "youtube".into(),
                reason: Some(e.to_string()),
            });
            return;
        }
    };

    let mut attempt = 0u32;
    while !stop.load(Ordering::SeqCst) {
        let boot = match bootstrap(&client, &channel).await {
            Ok(b) => b,
            Err(e) => {
                connected.store(false, Ordering::SeqCst);
                hub.emit(ChatEvent::Disconnected {
                    platform: "youtube".into(),
                    reason: Some(e),
                });
                // Offline is the common case, not a fault: wait and look again.
                let wait = backoff(attempt);
                attempt = attempt.saturating_add(1);
                tokio::time::sleep(wait).await;
                continue;
            }
        };
        attempt = 0;
        connected.store(true, Ordering::SeqCst);
        hub.emit(ChatEvent::Connected {
            platform: "youtube".into(),
            channel: channel.clone(),
        });

        let mut token = boot.continuation;
        let mut seen: std::collections::VecDeque<String> = std::collections::VecDeque::new();
        loop {
            if stop.load(Ordering::SeqCst) {
                connected.store(false, Ordering::SeqCst);
                return;
            }
            let body = json!({
                "context": { "client": {
                    "clientName": "WEB",
                    "clientVersion": boot.client_version,
                }},
                "continuation": token,
            });
            let resp = client
                .post(env_or("PRODUCER_YT_CHAT_URL", CHAT_URL))
                .header("Content-Type", "application/json")
                .json(&body)
                .send()
                .await;
            let v: Value = match resp {
                Ok(r) if r.status().is_success() => match r.json().await {
                    Ok(v) => v,
                    Err(_) => break, // unreadable body: re-bootstrap
                },
                // 403 means region-locked or login-required — retrying can
                // only hammer them, so stop this reader outright.
                Ok(r) if r.status().as_u16() == 403 => {
                    connected.store(false, Ordering::SeqCst);
                    hub.emit(ChatEvent::Disconnected {
                        platform: "youtube".into(),
                        reason: Some("YouTube refused this chat (region-locked or sign-in required)".into()),
                    });
                    return;
                }
                // 400/404 = the token expired or the protocol drifted. Either
                // way the fix is the same: start over from the watch page.
                _ => break,
            };
            let cont = v.pointer("/continuationContents/liveChatContinuation");
            let Some(cont) = cont else { break };

            // Absent `actions` is the NORMAL idle case — not an error, and not
            // an empty array. Never treat it as a failure.
            if let Some(actions) = cont.get("actions").and_then(Value::as_array) {
                for a in actions {
                    let Some(item) = a.pointer("/addChatItemAction/item") else {
                        continue;
                    };
                    // Match only renderers we know. YouTube is migrating
                    // `…Renderer` → `…ViewModel`, so unknown shapes must be
                    // skipped silently rather than assumed.
                    let Some(m) = item.get("liveChatTextMessageRenderer") else {
                        continue;
                    };
                    let id = m.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
                    if id.is_empty() || seen.contains(&id) {
                        continue;
                    }
                    seen.push_back(id.clone());
                    if seen.len() > 400 {
                        seen.pop_front();
                    }
                    let user = m
                        .pointer("/authorName/simpleText")
                        .and_then(Value::as_str)
                        .unwrap_or("viewer")
                        .to_string();
                    let text = runs_text(m.get("message").and_then(|v| v.get("runs")).unwrap_or(&Value::Null));
                    if text.trim().is_empty() {
                        continue;
                    }
                    hub.emit(ChatEvent::Message {
                        msg: ChatMsg {
                            emotes: None,
                            platform: "youtube".into(),
                            id,
                            user,
                            color: None,
                            text,
                        },
                    });
                }
            }

            let next = cont
                .pointer("/continuations/0/invalidationContinuationData")
                .or_else(|| cont.pointer("/continuations/0/timedContinuationData"));
            let Some(next) = next else {
                // No continuation = the stream ended or chat closed.
                break;
            };
            let Some(t) = next.get("continuation").and_then(Value::as_str) else {
                break;
            };
            token = t.to_string();
            let ms = next
                .get("timeoutMs")
                .and_then(Value::as_u64)
                .unwrap_or(5_000)
                .clamp(1_000, 15_000);
            tokio::time::sleep(Duration::from_millis(ms)).await;
        }

        connected.store(false, Ordering::SeqCst);
        hub.emit(ChatEvent::Disconnected {
            platform: "youtube".into(),
            reason: None,
        });
        tokio::time::sleep(backoff(attempt.min(3))).await;
        attempt = attempt.saturating_add(1);
    }
}
