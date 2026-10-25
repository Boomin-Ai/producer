//! Credential-safe cross-runtime contract check for the owned Cloud smoke.
use producer_guest_session::{ExpectedAuthority, Session};
use serde::Deserialize;
use std::io::{self, Read};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    expected: ExpectedAuthority,
    session: serde_json::Value,
}
fn run() -> Result<(), ()> {
    let mut bytes = Vec::new();
    io::stdin()
        .take(65_537)
        .read_to_end(&mut bytes)
        .map_err(|_| ())?;
    if bytes.len() > 65_536 {
        return Err(());
    }
    let input: Input = serde_json::from_slice(&bytes).map_err(|_| ())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| ())?
        .as_millis();
    Session::parse(
        &serde_json::to_vec(&input.session).map_err(|_| ())?,
        &input.expected,
        now.try_into().map_err(|_| ())?,
    )
    .map_err(|_| ())?;
    Ok(())
}
fn main() {
    if run().is_err() {
        eprintln!("Native session validation failed");
        std::process::exit(1);
    }
    println!("Native session accepted");
}
