//! The local overlay bridge (#51, docs/INTERACTIVE.md decision 1).
//!
//! Anything that becomes PIXELS is driven from the host over a local path;
//! the network only carries state. A browser source on the set loads
//! `http://127.0.0.1:<port>/overlay` (the vote bar, embedded below) and polls
//! `/state.json`, which Producer writes from the interaction frames it
//! receives — so what is on air follows the host's clock and works with zero
//! server. Loopback only, ephemeral port, no dependencies: a hand-rolled
//! HTTP/1.0 responder on std::net is all a GET of a few KB needs.

use serde_json::Value;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex, OnceLock};

use crate::error::{EngineError, EngineResult};

const OVERLAY_HTML: &str = include_str!("../../overlay/vote.html");
const CHAT_HTML: &str = include_str!("../../overlay/chat.html");

#[derive(Default)]
struct ChatState {
    messages: Vec<ChatLine>,
    room: Option<String>,
    room_messages: Vec<ChatLine>,
    channels: Option<Vec<String>>,
    emotes: std::collections::HashMap<String, std::collections::HashMap<String, String>>,
}

#[derive(Clone, serde::Serialize)]
struct ChatLine {
    #[serde(flatten)]
    msg: crate::chat::ChatMsg,
    received_at: u64,
}

// A complete authoritative room snapshot, including deletions. Kept separate
// from native platform readers so updates never re-emit or duplicate messages.
#[derive(serde::Deserialize)]
pub struct ChatRoomProjection {
    room: Option<String>,
    messages: Vec<RoomChatMessage>,
    channels: Vec<String>,
}
#[derive(serde::Deserialize)]
struct RoomChatMessage {
    id: String,
    name: String,
    text: String,
    #[serde(default)]
    at: u64,
}

impl ChatState {
    fn push(&mut self, msg: &crate::chat::ChatMsg, now: u64) {
        if !msg.id.is_empty()
            && self
                .messages
                .iter()
                .any(|m| m.msg.platform == msg.platform && m.msg.id == msg.id)
        {
            return;
        }
        self.messages.push(ChatLine {
            msg: msg.clone(),
            received_at: now,
        });
        if self.messages.len() > 24 {
            self.messages.drain(..self.messages.len() - 24);
        }
    }

    fn project_room(&mut self, projection: ChatRoomProjection) {
        self.room = projection.room;
        self.channels = Some(
            projection
                .channels
                .into_iter()
                .filter(|channel| {
                    matches!(channel.as_str(), "boomin" | "twitch" | "kick" | "youtube")
                })
                .collect(),
        );
        self.room_messages.clear();
        if let Some(room) = &self.room {
            let mut ids = std::collections::HashSet::new();
            // The server's bounded history is replaced rather than appended:
            // deletion and a room switch must also disappear from the output.
            for message in projection.messages.into_iter().rev().take(100).rev() {
                if message.id.is_empty() || !ids.insert(message.id.clone()) {
                    continue;
                }
                self.room_messages.push(ChatLine {
                    msg: crate::chat::ChatMsg {
                        platform: "boomin".into(),
                        id: format!("{room}:{}", message.id),
                        user: message.name,
                        text: message.text,
                        color: None,
                        emotes: None,
                    },
                    received_at: message.at,
                });
            }
        }
    }

    fn output(&self) -> Value {
        let mut messages: Vec<_> = self
            .messages
            .iter()
            .chain(self.room_messages.iter())
            .filter(|line| {
                self.channels
                    .as_ref()
                    .map_or(true, |channels| channels.contains(&line.msg.platform))
            })
            .cloned()
            .collect();
        messages.sort_by_key(|line| line.received_at);
        let start = messages.len().saturating_sub(24);
        serde_json::json!({ "messages": &messages[start..], "emotes": self.emotes })
    }
}

static CHAT: OnceLock<Mutex<ChatState>> = OnceLock::new();
static START_LOCK: Mutex<()> = Mutex::new(());

fn chat_cell() -> &'static Mutex<ChatState> {
    CHAT.get_or_init(|| Mutex::new(ChatState::default()))
}

/// Native readers feed the output even while the room webview is closed.
pub fn chat_event(event: &crate::chat::ChatEvent) {
    let Ok(mut state) = chat_cell().lock() else {
        return;
    };
    match event {
        crate::chat::ChatEvent::Message { msg } => {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            state.push(msg, now);
        }
        crate::chat::ChatEvent::EmoteSet { platform, emotes } => {
            state
                .emotes
                .entry(platform.clone())
                .or_default()
                .extend(emotes.clone());
        }
        _ => {}
    }
}

pub fn clear_chat(platform: &str) {
    if let Ok(mut state) = chat_cell().lock() {
        state.messages.retain(|m| m.msg.platform != platform);
        state.emotes.remove(platform);
    }
}

static STATE: OnceLock<Arc<Mutex<String>>> = OnceLock::new();
static PORT: OnceLock<u16> = OnceLock::new();

fn state_cell() -> Arc<Mutex<String>> {
    STATE
        .get_or_init(|| Arc::new(Mutex::new("null".to_string())))
        .clone()
}

/// Start the bridge once; later calls return the same port.
pub fn start() -> EngineResult<u16> {
    let _guard = START_LOCK
        .lock()
        .map_err(|e| EngineError::Other(e.to_string()))?;
    if let Some(p) = PORT.get() {
        return Ok(*p);
    }
    // A fixed port first, so a room document's overlay URL survives a
    // relaunch; an ephemeral one if something else holds it (the source is
    // re-pointed by Producer in that case).
    let listener = TcpListener::bind("127.0.0.1:47119")
        .or_else(|_| TcpListener::bind("127.0.0.1:0"))
        .map_err(|e| EngineError::Other(e.to_string()))?;
    let port = listener
        .local_addr()
        .map_err(|e| EngineError::Other(e.to_string()))?
        .port();
    let state = state_cell();
    std::thread::Builder::new()
        .name("overlay-bridge".into())
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                let st = state.clone();
                std::thread::spawn(move || serve(stream, st));
            }
        })
        .map_err(|e| EngineError::Other(e.to_string()))?;
    // Starting is serialized so chat and vote overlays share one listener.
    let _ = PORT.set(port);
    Ok(*PORT.get().unwrap_or(&port))
}

/// Replace what the overlay page reads next.
pub fn set_state(json: &Value) {
    if let Ok(mut s) = state_cell().lock() {
        *s = json.to_string();
    }
}

fn serve(mut stream: TcpStream, state: Arc<Mutex<String>>) {
    let mut buf = [0u8; 2048];
    let n = match stream.read(&mut buf) {
        Ok(n) if n > 0 => n,
        _ => return,
    };
    let req = String::from_utf8_lossy(&buf[..n]);
    let path = req.split_whitespace().nth(1).unwrap_or("/");
    let path = path.split('?').next().unwrap_or(path);
    let (ctype, body): (&str, String) = if path == "/chat-state.json" {
        (
            "application/json",
            chat_cell()
                .lock()
                .map(|s| s.output().to_string())
                .unwrap_or_else(|_| "null".into()),
        )
    } else if path == "/chat" {
        ("text/html; charset=utf-8", CHAT_HTML.to_string())
    } else if path == "/state.json" {
        (
            "application/json",
            state
                .lock()
                .map(|s| s.clone())
                .unwrap_or_else(|_| "null".into()),
        )
    } else {
        ("text/html; charset=utf-8", OVERLAY_HTML.to_string())
    };
    let head = format!(
        "HTTP/1.0 200 OK\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body.as_bytes());
    let _ = stream.flush();
}

/// The overlay URL a browser source loads. Starts the bridge if needed.
#[tauri::command]
pub async fn overlay_bridge_start() -> EngineResult<String> {
    let port = start()?;
    Ok(format!("http://127.0.0.1:{port}/overlay"))
}

#[tauri::command]
pub async fn chat_overlay_start() -> EngineResult<String> {
    Ok(format!("http://127.0.0.1:{}/chat", start()?))
}

/// Mirror the host's selected channels and authoritative room chat snapshot.
#[tauri::command]
pub fn chat_overlay_update(projection: ChatRoomProjection) -> EngineResult<()> {
    let mut state = chat_cell()
        .lock()
        .map_err(|e| EngineError::Other(e.to_string()))?;
    state.project_room(projection);
    Ok(())
}

/// Feed the overlay: `{ interaction, server_now, hidden? }` or null.
#[tauri::command]
pub async fn overlay_bridge_set(state: Value) -> EngineResult<()> {
    set_state(&state);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn msg(id: &str, platform: &str) -> crate::chat::ChatMsg {
        crate::chat::ChatMsg {
            id: id.into(),
            platform: platform.into(),
            user: "viewer".into(),
            color: None,
            text: "hello".into(),
            emotes: None,
        }
    }
    #[test]
    fn chat_dedupes_per_platform_and_keeps_messages_when_chat_is_quiet() {
        let mut state = ChatState::default();
        state.push(&msg("one", "twitch"), 1_000);
        state.push(&msg("one", "twitch"), 1_100);
        state.push(&msg("one", "kick"), 1_200);
        assert_eq!(state.messages.len(), 2);
        state.push(&msg("new", "twitch"), 3_601_200);
        assert_eq!(state.messages.len(), 3);
        assert_eq!(state.messages[0].msg.id, "one");
    }
    #[test]
    fn chat_keeps_a_bounded_recent_buffer() {
        let mut state = ChatState::default();
        for i in 0..100 {
            state.push(&msg(&i.to_string(), "twitch"), i);
        }
        assert_eq!(state.messages.len(), 24);
        assert_eq!(state.messages[0].msg.id, "76");
    }
    fn projection(
        room: Option<&str>,
        ids: &[(&str, u64)],
        channels: &[&str],
    ) -> ChatRoomProjection {
        ChatRoomProjection {
            room: room.map(str::to_owned),
            messages: ids
                .iter()
                .map(|(id, at)| RoomChatMessage {
                    id: id.to_string(),
                    name: "Guest".into(),
                    text: "room hello".into(),
                    at: *at,
                })
                .collect(),
            channels: channels.iter().map(|s| s.to_string()).collect(),
        }
    }
    #[test]
    fn room_chat_matches_filters_and_preserves_native_reader_history() {
        let mut state = ChatState::default();
        state.push(&msg("external", "twitch"), 2);
        state.project_room(projection(
            Some("one"),
            &[("room", 1), ("room", 1)],
            &["boomin"],
        ));
        assert_eq!(state.output()["messages"].as_array().unwrap().len(), 1);
        assert_eq!(state.output()["messages"][0]["platform"], "boomin");
        state.project_room(projection(
            Some("one"),
            &[("room", 1)],
            &["boomin", "twitch"],
        ));
        assert_eq!(state.output()["messages"][1]["platform"], "twitch");
        state.project_room(projection(Some("one"), &[("room", 1)], &[]));
        assert!(state.output()["messages"].as_array().unwrap().is_empty());
        assert_eq!(state.messages.len(), 1);
    }
    #[test]
    fn room_deletion_switch_and_leave_replace_the_output_snapshot() {
        let mut state = ChatState::default();
        state.push(&msg("external", "twitch"), 1);
        state.project_room(projection(
            Some("one"),
            &[("a", 2), ("b", 3)],
            &["boomin", "twitch"],
        ));
        state.project_room(projection(Some("one"), &[("b", 3)], &["boomin", "twitch"]));
        assert_eq!(state.room_messages.len(), 1);
        assert_eq!(state.room_messages[0].msg.id, "one:b");
        state.project_room(projection(Some("two"), &[("b", 4)], &["boomin", "twitch"]));
        assert_eq!(state.room_messages[0].msg.id, "two:b");
        state.project_room(projection(None, &[("b", 4)], &["boomin", "twitch"]));
        assert!(state.room_messages.is_empty());
        assert_eq!(state.output()["messages"].as_array().unwrap().len(), 1);
    }
}
