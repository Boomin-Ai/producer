#[path = "../../../../src-tauri/src/live/sets_v2/contract.rs"]
mod contract;
use serde_json::{json, Value};
fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../docs/sets-v2/native/landscape-plan.json"
    ))
    .unwrap()
}
fn validates(value: Value) -> bool {
    serde_json::from_value::<contract::Plan>(value).is_ok_and(|p| contract::validate(&p).is_ok())
}
#[test]
fn compiled_fixture_and_strict_rejection() {
    assert!(validates(fixture()));
    let mut p = fixture();
    p["extra"] = json!(true);
    assert!(!validates(p));
    let mut p = fixture();
    p["viewport"]["scaleX"] = json!(999);
    assert!(!validates(p));
    let mut p = fixture();
    p["root"]["children"][0]["id"] = json!("root");
    assert!(!validates(p));
    let mut p = fixture();
    p["resources"] = json!([]);
    assert!(!validates(p));
    let mut p = fixture();
    p["root"]["children"][0]["properties"]["background"] = json!("url(https://example.test)");
    assert!(!validates(p));
    let mut p = fixture();
    p["root"]["children"][0]["properties"]["rotation"] = json!(30);
    assert!(!validates(p));
    let mut p = fixture();
    p["root"]["children"][0]["kind"] = json!("asset");
    assert!(!validates(p));
}
#[test]
fn transport_fields_and_graphics_data_are_not_executable() {
    let action: contract::Action = serde_json::from_value(
        json!({"op":"take","generation":7,"revision":2,"durationMs":300,"mode":"wipe"}),
    )
    .unwrap();
    assert_eq!(action.generation(), 7);
    assert!(serde_json::from_value::<contract::Action>(json!({"op":"take","generation":7,"revision":2,"durationMs":300,"mode":"wipe","html":"<script>bad()</script>"})).is_err());
    let mut p = fixture();
    p["root"]["children"][0] = json!({"id":"caption","kind":"text","bounds":{"x":0,"y":0,"width":100,"height":50},"properties":{"text":"<script>bad()</script> & hi","color":"#ffffff"},"children":[]});
    let n: contract::Node = serde_json::from_value(p["root"]["children"][0].clone()).unwrap();
    let html = contract::graphics_document(&[&n], 100, 50, (0., 0.), &Default::default()).unwrap();
    assert!(html.contains("&lt;script&gt;bad()&lt;/script&gt; &amp; hi"));
    assert!(!html.contains("<script>"));
    assert!(html.contains("top:50px;width:1px;height:1px;background:#01fe03"));
    assert!(html.contains("default-src 'none'"));
}
