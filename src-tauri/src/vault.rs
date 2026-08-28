//! OS keychain access. Per the frozen secrets law (PHASE1.md §1.7),
//! this vault holds ENDPOINT ACCESS TOKENS ONLY — never platform
//! credentials, never storage credentials.

use crate::error::EngineResult;

const SERVICE: &str = "ai.boomin.producer";

fn entry(endpoint_id: &str) -> EngineResult<keyring::Entry> {
    Ok(keyring::Entry::new(SERVICE, endpoint_id)?)
}

pub fn set_token(endpoint_id: &str, token: &str) -> EngineResult<()> {
    entry(endpoint_id)?.set_password(token)?;
    Ok(())
}

pub fn get_token(endpoint_id: &str) -> EngineResult<String> {
    Ok(entry(endpoint_id)?.get_password()?)
}

pub fn delete_token(endpoint_id: &str) -> EngineResult<()> {
    match entry(endpoint_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}
