//! Live chat ingest.
//!
//! Chat sockets live in the HOST, never the webview: the same law that keeps
//! stream keys engine-side (LIVE-REVIEW.md §8) applies to any credential a
//! send-capable connection will eventually carry, and a host-side reader
//! survives webview reloads and is inherited by every platform we ship on.
//!
//! Each platform is an independent task with its own reconnect backoff, so a
//! dead Kick socket never stalls Twitch. Messages fan out to the webview on
//! the `chat://event` channel.

pub mod commands;
mod emotes;
mod kick;
mod twitch;
mod youtube;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// One chat line, already normalized across platforms.
#[derive(Debug, Clone, Serialize)]
pub struct ChatMsg {
    pub platform: String,
    /// Stable per-message id where the platform gives one; used for dedupe.
    pub id: String,
    pub user: String,
    /// Author colour as `#rrggbb` when the platform supplies one.
    pub color: Option<String>,
    pub text: String,
    /// Emotes named in THIS message (Twitch's own), name → image URL. The
    /// channel-wide sets arrive once, via `EmoteSet`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub emotes: Option<std::collections::HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChatEvent {
    /// Transport truth only: connected means the socket is joined, not that
    /// the channel is live.
    Connected {
        platform: String,
        channel: String,
    },
    Disconnected {
        platform: String,
        reason: Option<String>,
    },
    Message {
        msg: ChatMsg,
    },
    /// A channel's emote vocabulary (7TV + BTTV), sent once after joining.
    EmoteSet {
        platform: String,
        emotes: std::collections::HashMap<String, String>,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatConnection {
    pub platform: String,
    pub channel: String,
    pub connected: bool,
}

/// A running reader, and the flag that asks it to stop.
struct Conn {
    channel: String,
    connected: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
}

#[derive(Clone)]
pub struct ChatHub {
    app: AppHandle,
    conns: Arc<Mutex<HashMap<String, Conn>>>,
}

impl ChatHub {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            conns: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn emit(&self, ev: ChatEvent) {
        let _ = self.app.emit("chat://event", ev);
    }

    /// Join `channel` on `platform`, replacing any existing reader for it.
    /// Kick reads by numeric chatroom id, so `target` carries that; Twitch
    /// reads by login name. `channel` is always the human-facing name.
    pub fn connect(
        &self,
        platform: &str,
        channel: &str,
        target: Option<String>,
    ) -> Result<(), String> {
        let platform = platform.to_ascii_lowercase();
        let channel = channel.trim().trim_start_matches('#').to_string();
        if channel.is_empty() {
            return Err("channel name is empty".into());
        }
        self.disconnect(&platform);

        let stop = Arc::new(AtomicBool::new(false));
        let connected = Arc::new(AtomicBool::new(false));
        self.conns.lock().unwrap().insert(
            platform.clone(),
            Conn {
                channel: channel.clone(),
                connected: connected.clone(),
                stop: stop.clone(),
            },
        );

        let hub = self.clone();
        let p = platform.clone();
        let c = channel.clone();
        match platform.as_str() {
            "twitch" => {
                tauri::async_runtime::spawn(async move {
                    twitch::run(hub, c, stop, connected).await;
                });
            }
            "kick" => {
                let chatroom = match target.filter(|t| !t.trim().is_empty()) {
                    Some(t) => t,
                    None => {
                        self.conns.lock().unwrap().remove(&platform);
                        return Err("Kick needs a chatroom id — resolve the channel first".into());
                    }
                };
                tauri::async_runtime::spawn(async move {
                    kick::run(hub, chatroom, stop, connected).await;
                });
            }
            "youtube" => {
                tauri::async_runtime::spawn(async move {
                    youtube::run(hub, c, stop, connected).await;
                });
            }
            _ => {
                self.conns.lock().unwrap().remove(&p);
                return Err(format!("no chat reader for {p}"));
            }
        }
        Ok(())
    }

    pub fn disconnect(&self, platform: &str) {
        let platform = platform.to_ascii_lowercase();
        if let Some(c) = self.conns.lock().unwrap().remove(&platform) {
            c.stop.store(true, Ordering::SeqCst);
        }
    }

    pub fn disconnect_all(&self) {
        let keys: Vec<String> = self.conns.lock().unwrap().keys().cloned().collect();
        for k in keys {
            self.disconnect(&k);
        }
    }

    pub fn status(&self) -> Vec<ChatConnection> {
        self.conns
            .lock()
            .unwrap()
            .iter()
            .map(|(platform, c)| ChatConnection {
                platform: platform.clone(),
                channel: c.channel.clone(),
                connected: c.connected.load(Ordering::SeqCst),
            })
            .collect()
    }
}

/// Reconnect backoff shared by every reader: 1s doubling to 30s.
pub(crate) fn backoff(attempt: u32) -> std::time::Duration {
    std::time::Duration::from_millis(u64::min(1000u64 << attempt.min(5), 30_000))
}
