//! Native stream presence survives leaving the room view. An engine output
//! must be sending before the host announces it; idle/failed starts never do.
//! The server expires missed renewals, so quit/crash needs no goodbye to clear.
use crate::{client::ProducerClient, AppState};
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::Manager;
use uuid::Uuid;

static GENERATION: AtomicU64 = AtomicU64::new(0);

fn sending(snapshot: &Value) -> bool {
    snapshot["session_state"] == "streaming"
        && snapshot["destinations"]
            .as_array()
            .is_some_and(|destinations| {
                destinations.iter().any(|d| {
                    d["phase"] == "live"
                        && d["active"] == true
                        && d["bytes_sent"].as_u64().unwrap_or(0) > 0
                })
            })
}

pub fn start(app: tauri::AppHandle, base: String, brand: String, token: String, room: String) {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn(async move {
        let client = ProducerClient::new(&base, &token).with_brand(Some(brand));
        let began = Instant::now();
        let mut seen_session = false;
        let mut lease: Option<String> = None;
        let mut last_renewal: Option<Instant> = None;
        loop {
            let snapshot = app.state::<AppState>().live.status();
            let state = snapshot["session_state"].as_str().unwrap_or("idle");
            seen_session |= state != "idle";
            let finished = GENERATION.load(Ordering::SeqCst) != generation
                || (state == "idle" && (seen_session || began.elapsed() > Duration::from_secs(30)));
            let on_air = !finished && sending(&snapshot);
            if on_air {
                let id = lease.get_or_insert_with(|| Uuid::new_v4().to_string());
                if last_renewal.is_none_or(|at| at.elapsed() >= Duration::from_secs(10)) {
                    match client.producer_stream(&room, id, true).await {
                        Ok(_) => last_renewal = Some(Instant::now()),
                        Err(_) => {
                            // No URL, credential or provider error is logged.
                            // Retry while sending; the lease fails closed.
                            eprintln!("[live] network stream status update failed; retrying");
                            last_renewal = Some(Instant::now() - Duration::from_secs(8));
                        }
                    }
                }
            } else if let Some(id) = lease.take() {
                // Fence the old lease even if its start acknowledgement was
                // lost. A delayed start may never resurrect a stopped lease.
                for _ in 0..3 {
                    if client.producer_stream(&room, &id, false).await.is_ok() {
                        break;
                    }
                }
                last_renewal = None;
            }
            if finished {
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn only_sending_outputs_establish_live_presence() {
        for state in ["idle", "starting", "stopping", "streaming"] {
            for phase in ["connecting", "reconnecting", "stopped", "live"] {
                for active in [false, true] {
                    for bytes in [0, 100] {
                        let snapshot = json!({"session_state":state,"destinations":[{"phase":phase,"active":active,"bytes_sent":bytes}]});
                        assert_eq!(
                            sending(&snapshot),
                            state == "streaming" && phase == "live" && active && bytes > 0
                        );
                    }
                }
            }
        }
        assert!(!sending(&json!({"session_state":"streaming"})));
        assert!(sending(
            &json!({"session_state":"streaming","destinations":[{"phase":"stopped"},{"phase":"live","active":true,"bytes_sent":42}]})
        ));
    }
}
