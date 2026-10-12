//! Opt-in staging receive owner. Webview receives no token or provider session.
use crate::{
    error::{EngineError, EngineResult},
    AppState,
};
use tauri::State;

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
) -> EngineResult<()> {
    #[cfg(all(feature = "guest-rtc-pilot", have_engine))]
    {
        if std::env::var("PRODUCER_RTC_NATIVE_PILOT").as_deref() != Ok("1") {
            return Err(EngineError::Other("Native guest pilot is disabled".into()));
        }
        let (api, _, token) = crate::ipc::endpoint_access(&state, &endpoint_id)?;
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
        Ok(())
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
pub async fn live_rtc_stop(state: State<'_, AppState>) -> EngineResult<()> {
    stop_host(&state).await
}
