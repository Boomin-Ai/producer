//! Live stream credentials — LIVE-REVIEW.md §8, verbatim law:
//! stream credentials are never persisted outside the OS keychain and never
//! exposed to the webview, SQLite, analytics, crash metadata, or logs.
//! Everything outside this module handles opaque credential IDs only; the
//! secret is resolved here, at output creation time, and handed straight to
//! libobs in memory.
//!
//! Deliberately separate from vault.rs, whose own frozen law restricts it to
//! endpoint access tokens.

const SERVICE: &str = "ai.boomin.producer.live";

/// Resolve a stream key by credential ID. Engine-side only — the returned
/// secret must never be serialized, logged, or sent over IPC.
pub fn resolve(credential_id: &str) -> Result<String, String> {
    keyring::Entry::new(SERVICE, credential_id)
        .and_then(|e| e.get_password())
        .map_err(|e| format!("keychain resolve failed for {credential_id}: {e}"))
}

/// Store a stream key under a credential ID (used by the destination UI in
/// M-L5+; tests and the first-light harness may seed the keychain directly).
#[allow(dead_code)]
pub fn store(credential_id: &str, key: &str) -> Result<(), String> {
    keyring::Entry::new(SERVICE, credential_id)
        .and_then(|e| e.set_password(key))
        .map_err(|e| format!("keychain store failed for {credential_id}: {e}"))
}

/// Remove a credential (destination deleted). Missing entries are fine.
pub fn delete(credential_id: &str) -> Result<(), String> {
    match keyring::Entry::new(SERVICE, credential_id).and_then(|e| e.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keychain delete failed for {credential_id}: {e}")),
    }
}

/// Redact a secret out of any operator-facing string (§8: service/output
/// errors may embed URLs containing keys).
pub fn redact(text: &str, secret: &str) -> String {
    if secret.is_empty() {
        return text.to_string();
    }
    text.replace(secret, "•••redacted•••")
}
