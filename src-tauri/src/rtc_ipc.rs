//! Opt-in staging receive owner. Webview receives no token or provider session.
use crate::{
    error::{EngineError, EngineResult},
    AppState,
};
use tauri::State;

#[tauri::command]
pub async fn live_rtc_enabled(
    state: State<'_, AppState>,
    endpoint_id: String,
) -> EngineResult<bool> {
    #[cfg(all(feature = "guest-rtc-pilot", have_engine))]
    {
        if std::env::var("PRODUCER_RTC_NATIVE_PILOT").as_deref() != Ok("1") {
            return Ok(false);
        }
        let (base, _, _) = crate::ipc::endpoint_access(&state, &endpoint_id)?;
        let api = crate::ipc::api_root_of(&base);
        return Ok(
            std::env::var("PRODUCER_RTC_NATIVE_PILOT").as_deref() == Ok("1")
                && api.trim_end_matches('/')
                    == "https://boomin-rtc-pilot.kleveland-bishop.workers.dev",
        );
    }
    #[cfg(not(all(feature = "guest-rtc-pilot", have_engine)))]
    {
        let _ = (state, endpoint_id);
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
    if api.trim_end_matches('/') == "https://boomin-rtc-pilot.kleveland-bishop.workers.dev"
        && std::env::var("PRODUCER_RTC_NATIVE_PILOT").as_deref() == Ok("1")
    {
        let result = async {
            let command = serde_json::from_value(command)
                .map_err(|_| EngineError::Other("Invalid native RTC room command".into()))?;
            let owner = state.rtc_host.lock().await;
            let host = owner.as_ref().ok_or_else(|| {
                EngineError::Other(
                    "Start the native guest room before changing guest controls".into(),
                )
            })?;
            if room_id.is_some_and(|room| room != host.room_id()) {
                return Err(EngineError::Other("Native RTC room binding changed".into()));
            }
            host.room_command(command)
                .await
                .map_err(|e| EngineError::Other(e.into()))
        }
        .await;
        return Some(result);
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
        if std::env::var("PRODUCER_RTC_NATIVE_PILOT").as_deref() != Ok("1") {
            return Err(EngineError::Other("Native guest pilot is disabled".into()));
        }
        let (base, _, token) = crate::ipc::endpoint_access(&state, &endpoint_id)?;
        let api = crate::ipc::api_root_of(&base);
        if api.trim_end_matches('/') != "https://boomin-rtc-pilot.kleveland-bishop.workers.dev" {
            return Err(EngineError::Other(
                "Native guest pilot requires the isolated staging endpoint".into(),
            ));
        }
        let control = crate::rtc_control::Control::new(crate::rtc_control::Operator {
            brand_id,
            room_id,
            token,
        })
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
        let mut owner = state.rtc_host.lock().await;
        if let Some(mut host) = owner.take() {
            host.close()
                .await
                .map_err(|e| EngineError::Other(e.into()))?;
        }
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
    #[cfg(feature = "guest-rtc-pilot")]
    if let Some(room) = room_id {
        let mut owner = state.rtc_host.lock().await;
        if owner.as_ref().is_some_and(|host| host.room_id() == room) {
            if let Some(mut host) = owner.take() {
                return host.close().await.map_err(|e| EngineError::Other(e.into()));
            }
        }
        return Ok(());
    }
    #[cfg(not(feature = "guest-rtc-pilot"))]
    let _ = room_id;
    stop_host(&state).await
}

/// Explicit local development bootstrap. Never compiled into release builds,
/// and refuses to seed the production application identifier/database.
#[cfg(all(feature = "guest-rtc-pilot", debug_assertions))]
pub fn seed_dev_room(db: &rusqlite::Connection, identifier: &str) -> Result<(), &'static str> {
    if std::env::var("PRODUCER_RTC_ROOM_DEV_FIXTURE").as_deref() != Ok("1") { return Ok(()); }
    if identifier != "ai.boomin.producer.rtc-pilot" { return Err("RTC development requires its isolated app identifier"); }
    let bytes = std::fs::read("/private/tmp/producer-rtc-staging/operator.json").map_err(|_| "RTC development authorization unavailable")?;
    if bytes.len() > 32768 { return Err("RTC development authorization invalid"); }
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| "RTC development authorization invalid")?;
    let room = value["roomId"].as_str().ok_or("RTC development room unavailable")?;
    let token = value["token"].as_str().filter(|t| !t.is_empty()).ok_or("RTC development authorization unavailable")?;
    uuid::Uuid::parse_str(room).map_err(|_| "RTC development room invalid")?;
    let endpoint = "16d299c4-7e58-4a27-a460-fb5c8b5b70f1";
    crate::vault::set_token(endpoint, token).map_err(|_| "RTC development keychain unavailable")?;
    let tx = db.unchecked_transaction().map_err(|_| "RTC development database unavailable")?;
    tx.execute("INSERT OR IGNORE INTO endpoints(id,kind,name,base_url) VALUES(?1,'connected','Guest RTC staging',?2)", rusqlite::params![endpoint,"https://boomin-rtc-pilot.kleveland-bishop.workers.dev/v1/app/producer"]).map_err(|_| "RTC development endpoint unavailable")?;
    let config=serde_json::json!({"server_room_id":room,"sources":{},"channels":{}}).to_string();
    tx.execute("INSERT OR IGNORE INTO live_rooms(id,name,config,endpoint_id) VALUES(?1,'LiveKit staging call',?2,?3)", rusqlite::params![room,config,endpoint]).map_err(|_| "RTC development room unavailable")?;
    tx.commit().map_err(|_| "RTC development setup failed")?;
    Ok(())
}
