// Pure validation for the explicitly enabled, private loopback development fixture.
pub(crate) fn fixture_token(endpoint_id: &str, raw: &str) -> Option<String> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        endpoint_id: String,
        base_url: String,
        token: String,
    }
    let f: Fixture = serde_json::from_str(raw).ok()?;
    if f.endpoint_id != endpoint_id
        || uuid::Uuid::parse_str(endpoint_id).is_err()
        || f.base_url != "http://127.0.0.1:8795"
        || f.token.len() < 32
    {
        return None;
    }
    Some(f.token)
}

#[cfg(test)]
mod local_fixture_tests {
    use super::fixture_token;
    #[test]
    fn local_token_is_scoped_to_one_loopback_fixture() {
        let id = "11111111-2222-4333-8444-555555555555";
        let make = |endpoint: &str, url: &str, token: &str| {
            serde_json::json!({"endpointId":endpoint,"baseUrl":url,"token":token,"moduleBindings":{}}).to_string()
        };
        let token = "x".repeat(64);
        assert_eq!(
            fixture_token(id, &make(id, "http://127.0.0.1:8795", &token)),
            Some(token.clone())
        );
        assert!(fixture_token(id, &make(id, "https://example.com", &token)).is_none());
        assert!(fixture_token(id, &make("other", "http://127.0.0.1:8795", &token)).is_none());
        assert!(fixture_token(id, &make(id, "http://127.0.0.1:8795", "short")).is_none());
    }
}
