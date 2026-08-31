//! Emote sets: the images chat actually speaks in.
//!
//! Chat is text on the wire — `KEKW` arrives as five letters. Every real
//! chat client swaps those words for pictures, and without it our panel
//! shows raw codes where the culture is. Two sources, both anonymous:
//!
//! * **Twitch native** — the IRC `emotes` tag already names them per message
//!   (id + character range), so those need no network call at all; the
//!   reader turns them into name→URL pairs inline.
//! * **7TV** — the third-party set most big channels actually use. Public
//!   REST, no key, no login. Keyed by the channel's numeric Twitch id, which
//!   we get free from the IRC `ROOMSTATE` tag.
//!
//! BTTV rides the same numeric id and the same shape, so it comes along for
//! a few lines rather than a second integration.

use std::collections::HashMap;

use serde_json::Value;

/// Name → image URL for one channel's emotes.
pub type EmoteMap = HashMap<String, String>;

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .unwrap_or_default()
}

/// 7TV emote list → name/URL pairs. Their CDN serves several sizes; 1x is
/// the inline-with-text size and keeps chat cheap to render.
fn collect_7tv(emotes: &Value, out: &mut EmoteMap) {
    let Some(arr) = emotes.as_array() else { return };
    for e in arr {
        let (Some(name), Some(id)) = (
            e.get("name").and_then(Value::as_str),
            e.get("id").and_then(Value::as_str),
        ) else {
            continue;
        };
        out.insert(
            name.to_string(),
            format!("https://cdn.7tv.app/emote/{id}/1x.webp"),
        );
    }
}

/// Every emote a Twitch channel's viewers can type, minus Twitch's own
/// (those arrive per-message). Failures are silent and partial by design: a
/// missing emote set must never cost us the chat itself.
pub async fn fetch_for_twitch(room_id: &str) -> EmoteMap {
    let http = client();
    let mut map = EmoteMap::new();

    // 7TV global, then the channel's own set (channel wins on collision).
    if let Ok(r) = http.get("https://7tv.io/v3/emote-sets/global").send().await {
        if let Ok(v) = r.json::<Value>().await {
            collect_7tv(v.get("emotes").unwrap_or(&Value::Null), &mut map);
        }
    }
    if let Ok(r) = http
        .get(format!("https://7tv.io/v3/users/twitch/{room_id}"))
        .send()
        .await
    {
        if let Ok(v) = r.json::<Value>().await {
            collect_7tv(
                v.pointer("/emote_set/emotes").unwrap_or(&Value::Null),
                &mut map,
            );
        }
    }

    // BTTV: same id, same idea — global plus channel.
    if let Ok(r) = http
        .get("https://api.betterttv.net/3/cached/emotes/global")
        .send()
        .await
    {
        if let Ok(v) = r.json::<Value>().await {
            if let Some(arr) = v.as_array() {
                for e in arr {
                    if let (Some(name), Some(id)) = (
                        e.get("code").and_then(Value::as_str),
                        e.get("id").and_then(Value::as_str),
                    ) {
                        map.entry(name.to_string()).or_insert_with(|| {
                            format!("https://cdn.betterttv.net/emote/{id}/1x.webp")
                        });
                    }
                }
            }
        }
    }
    if let Ok(r) = http
        .get(format!("https://api.betterttv.net/3/cached/users/twitch/{room_id}"))
        .send()
        .await
    {
        if let Ok(v) = r.json::<Value>().await {
            for key in ["channelEmotes", "sharedEmotes"] {
                if let Some(arr) = v.get(key).and_then(Value::as_array) {
                    for e in arr {
                        if let (Some(name), Some(id)) = (
                            e.get("code").and_then(Value::as_str),
                            e.get("id").and_then(Value::as_str),
                        ) {
                            map.insert(
                                name.to_string(),
                                format!("https://cdn.betterttv.net/emote/{id}/1x.webp"),
                            );
                        }
                    }
                }
            }
        }
    }
    map
}

/// Twitch's own emotes for ONE message, from the IRC `emotes` tag:
/// `id:start-end,start-end/id2:start-end`. Ranges index CHARACTERS, not
/// bytes, so the name has to be sliced by char position.
pub fn twitch_native(tag: &str, text: &str) -> EmoteMap {
    let mut map = EmoteMap::new();
    if tag.is_empty() {
        return map;
    }
    let chars: Vec<char> = text.chars().collect();
    for part in tag.split('/') {
        let Some((id, ranges)) = part.split_once(':') else {
            continue;
        };
        let Some(first) = ranges.split(',').next() else {
            continue;
        };
        let Some((a, b)) = first.split_once('-') else {
            continue;
        };
        let (Ok(a), Ok(b)) = (a.parse::<usize>(), b.parse::<usize>()) else {
            continue;
        };
        if b < a || b >= chars.len() {
            continue;
        }
        let name: String = chars[a..=b].iter().collect();
        map.insert(
            name,
            format!("https://static-cdn.jtvnw.net/emoticons/v2/{id}/default/dark/1.0"),
        );
    }
    map
}
