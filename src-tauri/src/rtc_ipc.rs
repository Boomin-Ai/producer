//! Opt-in staging receive owner. Webview receives no token or provider session.
use crate::{
    error::{EngineError, EngineResult},
    AppState,
};
use tauri::State;

#[cfg(feature = "guest-rtc-pilot")]
fn runtime_enabled() -> bool {
    cfg!(feature = "guest-rtc-production")
        || std::env::var("PRODUCER_RTC_NATIVE_PILOT").as_deref() == Ok("1")
}
#[cfg(feature = "guest-rtc-pilot")]
fn pilot_origin_matches(base: &str) -> bool {
    let api = crate::ipc::api_root_of(base);
    api.trim_end_matches('/') == "https://boomin-rtc-pilot.kleveland-bishop.workers.dev"
        || ((cfg!(feature = "guest-rtc-production")
            || std::env::var("PRODUCER_RTC_PRODUCTION").as_deref() == Ok("1"))
            && api.trim_end_matches('/') == crate::boomin::DEFAULT_BOOMIN_API_ROOT)
}

#[tauri::command]
pub async fn live_rtc_enabled(
    state: State<'_, AppState>,
    endpoint_id: String,
    room_id: String,
) -> EngineResult<bool> {
    #[cfg(all(feature = "guest-rtc-pilot", have_engine))]
    {
        if !runtime_enabled() {
            return Ok(false);
        }
        let base: String = state
            .db
            .lock()
            .map_err(|_| EngineError::Other("Room database unavailable".into()))?
            .query_row(
                "SELECT base_url FROM endpoints WHERE id=?1",
                rusqlite::params![endpoint_id],
                |row| row.get(0),
            )?;
        let api = crate::ipc::api_root_of(&base);
        if !pilot_origin_matches(&api) {
            return Ok(false);
        }
        if api.trim_end_matches('/') != crate::boomin::DEFAULT_BOOMIN_API_ROOT {
            return Ok(true);
        }
        uuid::Uuid::parse_str(&room_id)
            .map_err(|_| EngineError::Other("Invalid hosted room".into()))?;
        let (_, _, token) = crate::ipc::endpoint_access(&state, &endpoint_id)?;
        let response = reqwest::Client::new()
            .get(format!("{api}/v1/app/live/rooms/{room_id}/rtc"))
            .bearer_auth(token)
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(false);
        }
        if !response.status().is_success() {
            return Err(EngineError::Other(
                "Could not confirm hosted guest transport".into(),
            ));
        }
        let body: serde_json::Value = response.json().await?;
        return Ok(body.get("enabled").and_then(|v| v.as_bool()) == Some(true)
            && body.get("transport").and_then(|v| v.as_str()) == Some("livekit"));
    }
    #[cfg(not(all(feature = "guest-rtc-pilot", have_engine)))]
    {
        let _ = (state, endpoint_id, room_id);
        Ok(false)
    }
}

/// Existing room controls select this path only for an explicitly enabled
/// staging pilot. A stopped owner never falls back to unfenced legacy writes.
pub async fn room_command(
    state: &State<'_, AppState>,
    api: &str,
    room_id: Option<&str>,
    command: serde_json::Value,
) -> Option<EngineResult<serde_json::Value>> {
    #[cfg(feature = "guest-rtc-pilot")]
    if pilot_origin_matches(api) && runtime_enabled() {
        let production = crate::ipc::api_root_of(api).trim_end_matches('/')
            == crate::boomin::DEFAULT_BOOMIN_API_ROOT;
        let expected_epoch = state
            .rtc_host_epoch
            .load(std::sync::atomic::Ordering::Acquire);
        let (owner, waited) = match state.rtc_host.try_lock() {
            Ok(owner) => (owner, false),
            Err(_) => {
                match tokio::time::timeout(std::time::Duration::from_secs(5), state.rtc_host.lock())
                    .await
                {
                    Ok(owner) => (owner, true),
                    Err(_) => {
                        return Some(Err(EngineError::Other(
                            "Native guest controls are busy; refresh room state and try again"
                                .into(),
                        )))
                    }
                }
            }
        };
        if state
            .rtc_host_epoch
            .load(std::sync::atomic::Ordering::Acquire)
            != expected_epoch
        {
            return Some(Err(EngineError::Other(
                "Native RTC room binding changed".into(),
            )));
        }
        if production
            && owner
                .as_ref()
                .is_none_or(|host| room_id.is_some_and(|room| room != host.room_id()))
        {
            // Decide fallback and capture the immutable sender under the same
            // bounded lock. A closing owner must never select legacy writes.
            return if waited {
                Some(Err(EngineError::Other(
                    "Native RTC room binding changed".into(),
                )))
            } else {
                None
            };
        }
        let sender = match owner.as_ref() {
            Some(host) if room_id.is_none_or(|room| room == host.room_id()) => {
                host.command_sender()
            }
            _ => {
                return Some(Err(EngineError::Other(
                    "Native RTC room binding changed".into(),
                )))
            }
        };
        drop(owner);
        let command = match serde_json::from_value(command) {
            Ok(command) => command,
            Err(_) => {
                return Some(Err(EngineError::Other(
                    "Invalid native RTC room command".into(),
                )))
            }
        };
        return Some(
            sender
                .room_command(command)
                .await
                .map_err(|e| EngineError::Other(e.into())),
        );
    }
    let _ = (state, api, room_id, command);
    None
}

#[tauri::command]
pub async fn live_rtc_start(
    state: State<'_, AppState>,
    endpoint_id: String,
    brand_id: String,
    room_id: String,
) -> EngineResult<bool> {
    #[cfg(all(feature = "guest-rtc-pilot", have_engine))]
    {
        if !runtime_enabled() {
            return Err(EngineError::Other("Native guest pilot is disabled".into()));
        }
        let (base, _, token) = crate::ipc::endpoint_access(&state, &endpoint_id)?;
        let api = crate::ipc::api_root_of(&base);
        if !pilot_origin_matches(&api) {
            return Err(EngineError::Other(
                "Native guest pilot requires the isolated staging endpoint".into(),
            ));
        }
        let control = crate::rtc_control::Control::for_api(
            crate::rtc_control::Operator {
                brand_id,
                room_id,
                token,
            },
            &api,
        )
        .map_err(|e| EngineError::Other(e.into()))?;
        let mut owner = state.rtc_host.lock().await;
        if owner
            .as_ref()
            .is_some_and(|host| host.room_id() == control.room_id())
        {
            return if owner.as_ref().is_some_and(|host| host.running()) {
                Ok(false)
            } else {
                Err(EngineError::Other(
                    "Native guest connection stopped; exit and reopen the room".into(),
                ))
            };
        }
        if owner.is_some() {
            return Err(EngineError::Other(
                "A native guest room is already owned".into(),
            ));
        }
        state
            .rtc_host_epoch
            .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        *owner = Some(
            crate::rtc_owner::HostOwner::start_scene(control)
                .await
                .map_err(|e| EngineError::Other(e.into()))?,
        );
        Ok(true)
    }
    #[cfg(not(all(feature = "guest-rtc-pilot", have_engine)))]
    {
        let _ = (state, endpoint_id, brand_id, room_id);
        Err(EngineError::Other(
            "Native guest pilot is unavailable in this build".into(),
        ))
    }
}
pub async fn stop_host(state: &State<'_, AppState>) -> EngineResult<()> {
    #[cfg(feature = "guest-rtc-pilot")]
    {
        crate::rtc_owner::shutdown::retire(
            state.rtc_host.clone(),
            None,
            |_| true,
            |mut host| async move { host.close().await },
            Some(crate::performance_trace::native_stage),
        )
        .await
        .map_err(|e| EngineError::Other(e.into()))?;
    }
    #[cfg(not(feature = "guest-rtc-pilot"))]
    let _ = state;
    Ok(())
}
#[tauri::command]
pub async fn live_rtc_stop(
    state: State<'_, AppState>,
    room_id: Option<String>,
) -> EngineResult<()> {
    let started = std::time::Instant::now();
    crate::performance_trace::native_stage(
        "native.rtc.stop.entry",
        std::time::Duration::ZERO,
        None,
    );
    #[cfg(feature = "guest-rtc-pilot")]
    if let Some(room) = room_id {
        let result = crate::rtc_owner::shutdown::retire(
            state.rtc_host.clone(),
            Some(state.rtc_host_epoch.clone()),
            move |host| host.room_id() == room,
            |mut host| async move { host.close().await },
            Some(crate::performance_trace::native_stage),
        )
        .await
        .map_err(|e| EngineError::Other(e.into()));
        crate::performance_trace::native_stage(
            "native.rtc.stop.reply",
            started.elapsed(),
            Some(result.is_ok()),
        );
        return result;
    }
    #[cfg(not(feature = "guest-rtc-pilot"))]
    let _ = room_id;
    let result = stop_host(&state).await;
    crate::performance_trace::native_stage(
        "native.rtc.stop.reply",
        started.elapsed(),
        Some(result.is_ok()),
    );
    result
}

/// Explicit local development bootstrap. Never compiled into release builds,
/// and refuses to seed the production application identifier/database.
#[cfg(all(feature = "guest-rtc-pilot", debug_assertions))]
pub fn seed_dev_room(db: &rusqlite::Connection, identifier: &str) -> Result<(), &'static str> {
    if std::env::var("PRODUCER_RTC_ROOM_DEV_FIXTURE").as_deref() != Ok("1") {
        return Ok(());
    }
    if identifier != "ai.boomin.producer.rtc-pilot" {
        return Err("RTC development requires its isolated app identifier");
    }
    let bytes = std::fs::read("/private/tmp/producer-rtc-staging/operator.json")
        .map_err(|_| "RTC development authorization unavailable")?;
    if bytes.len() > 32768 {
        return Err("RTC development authorization invalid");
    }
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "RTC development authorization invalid")?;
    let room = value["roomId"]
        .as_str()
        .ok_or("RTC development room unavailable")?;
    let token = value["token"]
        .as_str()
        .filter(|t| !t.is_empty())
        .ok_or("RTC development authorization unavailable")?;
    uuid::Uuid::parse_str(room).map_err(|_| "RTC development room invalid")?;
    let endpoint = "16d299c4-7e58-4a27-a460-fb5c8b5b70f1";
    crate::vault::set_token(endpoint, token).map_err(|_| "RTC development keychain unavailable")?;
    let tx = db
        .unchecked_transaction()
        .map_err(|_| "RTC development database unavailable")?;
    tx.execute("INSERT OR IGNORE INTO endpoints(id,kind,name,base_url) VALUES(?1,'connected','Guest RTC staging',?2)", rusqlite::params![endpoint,"https://boomin-rtc-pilot.kleveland-bishop.workers.dev/v1/app/producer"]).map_err(|_| "RTC development endpoint unavailable")?;
    let config = serde_json::json!({"server_room_id":room,"sources":{},"channels":{}}).to_string();
    tx.execute("INSERT OR IGNORE INTO live_rooms(id,name,config,endpoint_id) VALUES(?1,'LiveKit staging call',?2,?3)", rusqlite::params![room,config,endpoint]).map_err(|_| "RTC development room unavailable")?;
    tx.commit().map_err(|_| "RTC development setup failed")?;
    Ok(())
}

#[cfg(all(test, feature = "guest-rtc-pilot"))]
mod routing_tests {
    use super::pilot_origin_matches;
    #[test]
    fn controls_accept_the_normal_producer_endpoint_base() {
        assert!(pilot_origin_matches(
            "https://boomin-rtc-pilot.kleveland-bishop.workers.dev/v1/app/producer"
        ));
        assert!(pilot_origin_matches(
            "https://boomin-rtc-pilot.kleveland-bishop.workers.dev/"
        ));
        assert_eq!(
            pilot_origin_matches("https://api.boomin.ai/v1/app/producer"),
            cfg!(feature = "guest-rtc-production")
        );
        assert!(!pilot_origin_matches(
            "https://boomin-rtc-pilot.kleveland-bishop.workers.dev.evil.invalid/v1/app/producer"
        ));
    }
}
