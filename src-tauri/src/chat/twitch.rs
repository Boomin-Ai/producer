//! Twitch chat over IRC-on-WebSocket, read-only and anonymous.
//!
//! Twitch still serves anonymous readers to any NICK matching `justinfan\d+`
//! with no PASS — so v1 shows real chat with no OAuth dance and no token to
//! protect. Sending (and the EventSub path for follows/subs) needs a user
//! token; that arrives with Connect, and this reader keeps working unchanged
//! when it does.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;

use super::{backoff, ChatEvent, ChatHub, ChatMsg};

const URL: &str = "wss://irc-ws.chat.twitch.tv:443";

pub async fn run(hub: ChatHub, channel: String, stop: Arc<AtomicBool>, connected: Arc<AtomicBool>) {
    let mut attempt = 0u32;
    while !stop.load(Ordering::SeqCst) {
        match session(&hub, &channel, &stop, &connected).await {
            Ok(()) => attempt = 0,
            Err(e) => {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                hub.emit(ChatEvent::Disconnected {
                    platform: "twitch".into(),
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
    channel: &str,
    stop: &Arc<AtomicBool>,
    connected: &Arc<AtomicBool>,
) -> Result<(), String> {
    let (mut ws, _) = tokio_tungstenite::connect_async(URL)
        .await
        .map_err(|e| format!("connect failed: {e}"))?;

    let nick = format!("justinfan{}", rand::random::<u32>() % 80_000 + 10_000);
    // tags carry display-name and colour; commands carry RECONNECT notices.
    for line in [
        "CAP REQ :twitch.tv/tags twitch.tv/commands".to_string(),
        format!("NICK {nick}"),
        format!("JOIN #{}", channel.to_ascii_lowercase()),
    ] {
        ws.send(Message::Text(line))
            .await
            .map_err(|e| format!("handshake failed: {e}"))?;
    }

    connected.store(true, Ordering::SeqCst);
    hub.emit(ChatEvent::Connected {
        platform: "twitch".into(),
        channel: channel.to_string(),
    });

    // No traffic for this long means the socket is wedged: ping, and if the
    // next window is silent too, fall through to a reconnect.
    const IDLE: std::time::Duration = std::time::Duration::from_secs(300);
    let mut pinged = false;
    // One emote fetch per session, latched.
    let mut emotes_fetched = false;
    loop {
        let frame = match tokio::time::timeout(IDLE, ws.next()).await {
            Err(_) => {
                if pinged {
                    return Err("no reply to keepalive".into());
                }
                pinged = true;
                ws.send(Message::Text("PING :tmi.twitch.tv".into()))
                    .await
                    .map_err(|e| format!("keepalive failed: {e}"))?;
                continue;
            }
            Ok(None) => break,
            Ok(Some(f)) => f,
        };
        pinged = false;
        if stop.load(Ordering::SeqCst) {
            let _ = ws.close(None).await;
            return Ok(());
        }
        let text = match frame.map_err(|e| format!("socket error: {e}"))? {
            Message::Text(t) => t,
            Message::Close(_) => return Err("server closed the connection".into()),
            _ => continue,
        };
        for line in text.split("\r\n").filter(|l| !l.is_empty()) {
            // Twitch drops the connection if PINGs go unanswered.
            if let Some(rest) = line.strip_prefix("PING") {
                let _ = ws.send(Message::Text(format!("PONG{rest}"))).await;
                continue;
            }
            if line.contains("RECONNECT") && line.starts_with(':') {
                return Err("server asked us to reconnect".into());
            }
            // ROOMSTATE carries the channel's numeric id — the key 7TV and
            // BTTV are addressed by. Getting it here means the emote sets
            // need no Twitch API credentials of any kind.
            if line.contains("ROOMSTATE") && !emotes_fetched {
                if let Some(room) = line
                    .split(';')
                    .find_map(|kv| kv.strip_prefix("room-id="))
                    .and_then(|v| v.split(' ').next())
                    .map(str::to_string)
                {
                    if !room.is_empty() {
                        emotes_fetched = true;
                        let hub2 = hub.clone();
                        tauri::async_runtime::spawn(async move {
                            let map = super::emotes::fetch_for_twitch(&room).await;
                            if !map.is_empty() {
                                hub2.emit(ChatEvent::EmoteSet {
                                    platform: "twitch".into(),
                                    emotes: map,
                                });
                            }
                        });
                    }
                }
            }
            if let Some(msg) = parse_privmsg(line) {
                hub.emit(ChatEvent::Message { msg });
            }
        }
    }
    Err("stream ended".into())
}

/// `@tags :nick!user@host PRIVMSG #channel :text`
fn parse_privmsg(line: &str) -> Option<ChatMsg> {
    let (tags, rest) = match line.strip_prefix('@') {
        Some(r) => {
            let (t, r) = r.split_once(' ')?;
            (Some(t), r)
        }
        None => (None, line),
    };
    let rest = rest.strip_prefix(':')?;
    let (prefix, rest) = rest.split_once(' ')?;
    let mut parts = rest.splitn(3, ' ');
    if parts.next()? != "PRIVMSG" {
        return None;
    }
    let _channel = parts.next()?;
    let text = parts.next()?.strip_prefix(':')?.trim_end().to_string();

    let tag = |key: &str| -> Option<String> {
        tags?
            .split(';')
            .find_map(|kv| kv.strip_prefix(key)?.strip_prefix('=').map(unescape_tag))
            .filter(|v| !v.is_empty())
    };
    let user = tag("display-name").unwrap_or_else(|| {
        prefix
            .split('!')
            .next()
            .unwrap_or("someone")
            .to_string()
    });

    // Twitch names its own emotes per message (id + char range), so these
    // cost no network call at all.
    let emotes = tag("emotes")
        .map(|t| super::emotes::twitch_native(&t, &text))
        .filter(|m| !m.is_empty());

    Some(ChatMsg {
        platform: "twitch".into(),
        id: tag("id").unwrap_or_default(),
        user,
        color: tag("color"),
        text,
        emotes,
    })
}

/// IRCv3 tag values escape space, semicolon, backslash and newlines.
fn unescape_tag(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('s') => out.push(' '),
            Some(':') => out.push(';'),
            Some('r') => out.push('\r'),
            Some('n') => out.push('\n'),
            Some('\\') => out.push('\\'),
            Some(other) => out.push(other),
            None => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::parse_privmsg;

    #[test]
    fn reads_display_name_and_colour() {
        let line = "@badge-info=;badges=;color=#1E90FF;display-name=NightOwl;id=abc-1 :nightowl!nightowl@nightowl.tmi.twitch.tv PRIVMSG #kleveland :this room UI is clean";
        let m = parse_privmsg(line).expect("parsed");
        assert_eq!(m.user, "NightOwl");
        assert_eq!(m.color.as_deref(), Some("#1E90FF"));
        assert_eq!(m.text, "this room UI is clean");
        assert_eq!(m.id, "abc-1");
    }

    #[test]
    fn falls_back_to_nick_without_tags() {
        let line = ":someone!someone@someone.tmi.twitch.tv PRIVMSG #kleveland :hello there";
        let m = parse_privmsg(line).expect("parsed");
        assert_eq!(m.user, "someone");
        assert_eq!(m.color, None);
        assert_eq!(m.text, "hello there");
    }

    #[test]
    fn ignores_non_privmsg() {
        assert!(parse_privmsg(":tmi.twitch.tv 001 justinfan1 :Welcome, GLHF!").is_none());
    }

    #[test]
    fn keeps_colons_inside_message_text() {
        let line = ":a!a@a.tmi.twitch.tv PRIVMSG #c :check this: https://boomin.ai";
        assert_eq!(parse_privmsg(line).unwrap().text, "check this: https://boomin.ai");
    }
}
