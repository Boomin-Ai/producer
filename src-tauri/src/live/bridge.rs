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

static STATE: OnceLock<Arc<Mutex<String>>> = OnceLock::new();
static PORT: OnceLock<u16> = OnceLock::new();

fn state_cell() -> Arc<Mutex<String>> {
    STATE
        .get_or_init(|| Arc::new(Mutex::new("null".to_string())))
        .clone()
}

/// Start the bridge once; later calls return the same port.
pub fn start() -> EngineResult<u16> {
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
    // A second racing start() loses harmlessly: its listener drops.
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
    let (ctype, body): (&str, String) = if path.starts_with("/state.json") {
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

/// Feed the overlay: `{ interaction, server_now, hidden? }` or null.
#[tauri::command]
pub async fn overlay_bridge_set(state: Value) -> EngineResult<()> {
    set_state(&state);
    Ok(())
}
