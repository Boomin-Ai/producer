//! Explicit generated-media Cloud test boundary; ordinary lab runs stay local.
pub fn allowed_url(url: &str, enabled: bool) -> bool {
    if !enabled {
        return false;
    }
    producer_guest_session::cloud_endpoint_allowed(url)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cloud_requires_explicit_opt_in_and_exact_tls_project_host() {
        assert!(allowed_url("wss://test-rtc.livekit.cloud", true));
        assert!(!allowed_url("wss://test-rtc.livekit.cloud", false));
        for url in [
            "ws://test-rtc.livekit.cloud",
            "wss://user@test-rtc.livekit.cloud",
            "wss://test-rtc.livekit.cloud/room",
            "wss://test-rtc.livekit.cloud?token=secret",
            "wss://test-rtc.livekit.cloud.evil",
            "wss://evil.test-rtc.livekit.cloud",
            "wss://.livekit.cloud",
        ] {
            assert!(!allowed_url(url, true));
        }
    }
}
