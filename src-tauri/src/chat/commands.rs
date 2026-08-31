//! Chat IPC. Read-only today: nothing here carries a credential.

use tauri::State;

use super::{kick, ChatConnection};
use crate::AppState;

#[tauri::command]
pub fn chat_connect(
    state: State<'_, AppState>,
    platform: String,
    channel: String,
    chatroom_id: Option<String>,
) -> Result<(), String> {
    state.chat.connect(&platform, &channel, chatroom_id)
}

#[tauri::command]
pub fn chat_disconnect(state: State<'_, AppState>, platform: String) {
    state.chat.disconnect(&platform);
}

#[tauri::command]
pub fn chat_status(state: State<'_, AppState>) -> Vec<ChatConnection> {
    state.chat.status()
}

/// Slug → chatroom id. Cache the answer: it never changes, and the lookup is
/// the one Cloudflare-guarded step in the Kick path.
#[tauri::command]
pub async fn kick_resolve_chatroom(slug: String) -> Result<String, String> {
    kick::resolve_chatroom(&slug).await
}
