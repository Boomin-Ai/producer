//! Assistant-only credentials and HTTP work. Endpoint tokens and the live engine
//! are intentionally outside this module's authority.
use fs2::FileExt;
use producer_assistant_runtime::{Client, CredentialStore, CredentialVault, Model, Status};
use serde::Deserialize;
use serde_json::Value;
use std::{fs::File, sync::Arc};
use tauri::{ipc::Channel, Manager};
use tokio::sync::Mutex;

#[derive(Default)]
pub struct AssistantState {
    client: Mutex<Option<Arc<Client>>>,
    owner: Mutex<Option<File>>,
}
struct AssistantVault {
    service: String,
}
impl CredentialVault for AssistantVault {
    fn load(&self) -> Result<Option<CredentialStore>, String> {
        let entry = keyring::Entry::new(&self.service, "chatgpt-accounts-v1")
            .map_err(|_| "Assistant credential storage is unavailable.")?;
        match entry.get_password() {
            Ok(value) => serde_json::from_str(&value).map(Some).map_err(|_| {
                "Saved assistant credentials are unreadable. Reconnect ChatGPT.".into()
            }),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("Unlock this device's secure storage to access ChatGPT.".into()),
        }
    }
    fn save(&self, store: &CredentialStore) -> Result<(), String> {
        keyring::Entry::new(&self.service, "chatgpt-accounts-v1")
            .map_err(|_| "Assistant credential storage is unavailable.")?
            .set_password(
                &serde_json::to_string(store)
                    .map_err(|_| "Assistant credentials could not be saved.")?,
            )
            .map_err(|_| "Could not save ChatGPT credentials in secure storage.".into())
    }
}
async fn client(app: &tauri::AppHandle) -> Result<Arc<Client>, String> {
    let state = app.state::<AssistantState>();
    let mut client = state.client.lock().await;
    if let Some(value) = client.as_ref() {
        return Ok(value.clone());
    }
    let path = app
        .path()
        .app_data_dir()
        .map_err(|_| "Assistant storage is unavailable.")?
        .join("assistant");
    let owner = tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&path).map_err(|_| "Assistant storage is unavailable.")?;
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path.join("owner.lock"))
            .map_err(|_| "Assistant storage is unavailable.")?;
        file.try_lock_exclusive().map_err(|_| {
            "This Producer profile's assistant is open in another process. Use one app per profile."
        })?;
        Ok::<_, String>(file)
    })
    .await
    .map_err(|_| "Assistant storage is unavailable.")??;
    let value = Client::new(Arc::new(AssistantVault {
        service: format!("{}.assistant", app.config().identifier),
    }))
    .await?;
    *state.owner.lock().await = Some(owner);
    *client = Some(value.clone());
    Ok(value)
}
#[tauri::command]
pub async fn assistant_status(app: tauri::AppHandle) -> Result<Status, String> {
    Ok(client(&app).await?.status().await)
}
#[tauri::command]
pub async fn assistant_sign_in(
    app: tauri::AppHandle,
    account_id: Option<String>,
) -> Result<String, String> {
    use tauri_plugin_opener::OpenerExt;
    let client = client(&app).await?;
    let (attempt, url) = client.begin(account_id).await?;
    if app.opener().open_url(url, None::<&str>).is_err() {
        client.cancel_sign_in().await;
        return Err("Could not open the system browser for ChatGPT sign-in.".into());
    }
    Ok(attempt)
}
#[tauri::command]
pub async fn assistant_cancel_sign_in(app: tauri::AppHandle) -> Result<(), String> {
    client(&app).await?.cancel_sign_in().await;
    Ok(())
}
#[tauri::command]
pub async fn assistant_select_account(
    app: tauri::AppHandle,
    account_id: String,
) -> Result<(), String> {
    let client = client(&app).await?;
    client.cancel_all().await;
    client.select(&account_id).await
}
#[tauri::command]
pub async fn assistant_disconnect(
    app: tauri::AppHandle,
    account_id: String,
) -> Result<bool, String> {
    client(&app).await?.disconnect(&account_id).await
}
#[tauri::command]
pub async fn assistant_models(
    app: tauri::AppHandle,
    account_id: String,
) -> Result<Vec<Model>, String> {
    client(&app).await?.models(&account_id).await
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Turn {
    account_id: String,
    turn_id: String,
    model: String,
    instructions: String,
    input: Value,
    tools: Value,
}
#[tauri::command]
pub async fn assistant_turn(
    app: tauri::AppHandle,
    turn: Turn,
    on_event: Channel<Value>,
) -> Result<(), String> {
    client(&app)
        .await?
        .turn(
            &turn.account_id,
            &turn.turn_id,
            &turn.model,
            &turn.instructions,
            turn.input,
            turn.tools,
            |event| {
                on_event
                    .send(event)
                    .map_err(|_| "Assistant panel closed.".into())
            },
        )
        .await
}
#[tauri::command]
pub async fn assistant_cancel_turn(app: tauri::AppHandle, turn_id: String) -> Result<(), String> {
    client(&app).await?.cancel(&turn_id).await;
    Ok(())
}

#[tauri::command]
pub fn assistant_authoring_capabilities() -> Value {
    let mut features: Vec<String> = Vec::new();
    if crate::live::commands::live_set_v2_enabled() {
        features.push("core@1".into());
        features.extend(
            crate::live::commands::live_set_v2_capabilities()
                .into_iter()
                .map(String::from),
        );
        if crate::live::commands::live_set_v2_scene3d_enabled() {
            features.push("scene3d@1".into());
        }
        features.extend(
            crate::live::shaders::PRESETS
                .iter()
                .map(|name| format!("shader.{name}@1")),
        );
    }
    serde_json::json!({"schema":"producer.native-authoring/1", "catalogRevision":2, "packageSchema":"producer.presentation/2", "features":features, "nativeAdmission":"separate-native-preparation-required"})
}
