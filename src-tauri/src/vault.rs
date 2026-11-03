//! OS keychain access. Per the frozen secrets law (PHASE1.md §1.7),
//! this vault holds ENDPOINT ACCESS TOKENS ONLY — never platform
//! credentials, never storage credentials.

use crate::error::EngineResult;

const SERVICE: &str = "ai.boomin.producer";

fn entry(endpoint_id: &str) -> EngineResult<keyring::Entry> {
    Ok(keyring::Entry::new(SERVICE, endpoint_id)?)
}

pub fn set_token(endpoint_id: &str, token: &str) -> EngineResult<()> {
    #[cfg(all(feature = "sets-v2-dev", debug_assertions, target_os = "macos"))]
    if local_fixture_token(endpoint_id).as_deref() == Some(token) {
        return Ok(());
    }
    entry(endpoint_id)?.set_password(token)?;
    Ok(())
}

pub fn get_token(endpoint_id: &str) -> EngineResult<String> {
    #[cfg(all(feature = "sets-v2-dev", debug_assertions, target_os = "macos"))]
    if let Some(token) = local_fixture_token(endpoint_id) {
        return Ok(token);
    }
    Ok(entry(endpoint_id)?.get_password()?)
}

pub fn delete_token(endpoint_id: &str) -> EngineResult<()> {
    match entry(endpoint_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

// The explicit local workspace already owns a private, generated endpoint
// token. A development re-sign must not prompt for production Keychain access
// just to run a loopback fixture. This path is absent from release builds and
// never applies to other endpoints or provider credentials.
#[cfg(all(feature = "sets-v2-dev", debug_assertions, target_os = "macos"))]
#[path = "dev_workspace_token.rs"]
mod local_fixture;
#[cfg(all(feature = "sets-v2-dev", debug_assertions, target_os = "macos"))]
fn local_fixture_token(endpoint_id: &str) -> Option<String> {
    if std::env::var("PRODUCER_SETS_V2_LOCAL_WORKSPACE").as_deref() != Ok("1") {
        return None;
    }
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let path = std::path::Path::new("/private/tmp/producer-sets-v2-local-workspace.json");
    unsafe extern "C" {
        fn geteuid() -> u32;
    }
    let meta = path.symlink_metadata().ok()?;
    if !meta.is_file()
        || meta.uid() != unsafe { geteuid() }
        || meta.permissions().mode() & 0o077 != 0
    {
        return None;
    }
    local_fixture::fixture_token(endpoint_id, &std::fs::read_to_string(path).ok()?)
}
