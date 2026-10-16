//! Build the app's exact owner/control modules without the Tauri UI linker.
//! Dedicated staging profile only; no devices, capture or media subscriptions.
#[path = "../../../src-tauri/src/rtc_control.rs"]
mod rtc_control;
#[path = "../../../src-tauri/src/rtc_owner.rs"]
mod rtc_owner;
fn main() {
    let result = rtc_owner::selftest(std::path::Path::new(
        "/private/tmp/producer-rtc-staging/operator.json",
    ));
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open("/private/tmp/producer-rtc-staging/native-sdk-owner-result.json")
    {
        let report = serde_json::json!({"passed":result.is_ok(),"error":result.as_ref().err().copied(),"media_published":false});
        let _ = file.write_all(report.to_string().as_bytes());
    }
    if let Err(message) = result {
        eprintln!("{message}");
        std::process::exit(1);
    }
}
