use producer_production_contract::*;
#[test]
fn seeded_malformed_ingress_never_panics() {
    let mut seed = 0xbba93521u64;
    for _ in 0..10_000 {
        let mut bytes = Vec::new();
        for _ in 0..(seed % 256) {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            bytes.push((seed >> 32) as u8);
        }
        let _ = parse_document(&bytes);
    }
}
#[test]
fn near_valid_graph_mutations_reject_at_the_native_boundary() {
    let base = serde_json::to_value(fixture::classic_like()).unwrap();
    let cases = [
        ("/sets/classic/layouts/wide/width", serde_json::json!(0)),
        (
            "/sets/classic/layouts/wide/root/children/2/content/pin",
            serde_json::json!("a".repeat(64)),
        ),
        (
            "/sources/stage/scene/batches/0/instances",
            serde_json::json!(4097),
        ),
        ("/sources/stage/scene/analytic", serde_json::json!(false)),
        (
            "/sequences/opener/tracks/0/keys/0/value/value",
            serde_json::json!(2),
        ),
        (
            "/sequences/opener/placements/1/sourceIn/ticks",
            serde_json::json!("999"),
        ),
        (
            "/shows/pilot/segments/0/vertical",
            serde_json::json!("wide"),
        ),
    ];
    for (path, value) in cases {
        let mut v = base.clone();
        *v.pointer_mut(path).unwrap() = value;
        assert!(
            parse_document(&serde_json::to_vec(&v).unwrap()).is_err(),
            "{path}"
        );
    }
}
#[test]
fn many_tiny_json_values_are_work_bounded() {
    let bytes = format!(
        "[{}]",
        std::iter::repeat_n("0", RAW_VALUES + 1)
            .collect::<Vec<_>>()
            .join(",")
    );
    assert!(ingress::parse(bytes.as_bytes(), DOCUMENT_BYTES).is_err());
}
