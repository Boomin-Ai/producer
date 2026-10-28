use producer_sets_v2_native_adapter_probe::sets_v2::contract;
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
    assert!(validates(p));
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

#[test]
fn masks_and_backdrops_are_bounded_and_animation_targets_are_explicit() {
    let mut p = fixture();
    p["root"]["mask"] = json!({"kind":"circle","progress":0.5,"x":0.5,"y":0.5,"feather":8});
    p["motion"] = json!([{"target":"root","property":"mask.progress","keyframes":[{"atMs":0,"value":0},{"atMs":1000,"value":1}]}]);
    assert!(validates(p.clone()));
    p["motion"][0]["keyframes"][1]["value"] = json!(1.1);
    assert!(!validates(p));
    let mut p = fixture();
    p["root"]["mask"] = json!({"kind":"wipe","progress":0.5,"feather":33});
    assert!(!validates(p));
    let mut p = fixture();
    p["root"]["backdrop"] = json!({"blur":12});
    assert!(!validates(p));
    let mut p = fixture();
    p["root"]["children"].as_array_mut().unwrap().push(json!({"id":"glass","kind":"group","bounds":{"x":10,"y":10,"width":100,"height":80},"properties":{},"backdrop":{"blur":12},"children":[]}));
    assert!(validates(p.clone()));
    let i = p["root"]["children"].as_array().unwrap().len() - 1;
    p["root"]["children"][i]["backdrop"]["blur"] = json!(25);
    assert!(!validates(p));
}
#[test]
fn equivalent_paint_produces_identical_cached_rasters() {
    let mut p = fixture();
    p["root"]["children"][0] = json!({"id":"caption","kind":"text","bounds":{"x":0,"y":0,"width":100,"height":50},"properties":{"text":"Stable"},"paint":{"border":"1px solid #ffffff","borderRadius":12,"fontSize":20,"color":"#ffffff","padding":4},"children":[]});
    let serialized = p["root"]["children"][0].to_string();
    let document = || {let node:contract::Node=serde_json::from_str(&serialized).unwrap();contract::graphics_document(&[&node],100,50,(0.,0.),&Default::default()).unwrap()};
    let expected=document();
    for _ in 0..100 {assert_eq!(document(),expected);}
}

#[test]
fn native_charts_independently_reject_unbounded_or_executable_data(){
 use producer_sets_v2_native_adapter_probe::sets_v2::chart;
 let base=json!({"id":"plot","kind":"area","data":{"scope":"city","points":[{"x":1,"y":null},{"x":2,"y":50}]},"xMin":1,"xMax":2,"yMin":0,"yMax":100,"color":"#f2d3a5","gridColor":"#ffffff22","durationMs":650,"lineWidth":3,"fillOpacity":0.2});
 let valid=|v:Value|serde_json::from_value::<chart::Spec>(v).is_ok_and(|s|chart::validate(&s).is_ok());
 assert!(valid(base.clone()));
 let mut plan=fixture();plan["charts"]=json!({"plot":base.clone()});let node=json!({"id":"plot-node","kind":"chart","bounds":{"x":0,"y":0,"width":320,"height":200},"properties":{},"resource":"chart:plot","children":[]});plan["root"]["children"].as_array_mut().unwrap().push(node.clone());plan["resources"].as_array_mut().unwrap().push(json!("chart:plot"));assert!(validates(plan.clone()));let mut duplicate=node;duplicate["id"]=json!("second-plot");plan["root"]["children"].as_array_mut().unwrap().push(duplicate);assert!(!validates(plan));

 for (key,value) in [("kind",json!("script")),("color",json!("url(https://x)")),("lineWidth",json!(1000)),("durationMs",json!(9000)),("xMax",json!(1)),("html",json!("<script/>"))]{let mut p=base.clone();p[key]=value;assert!(!valid(p));}
 let mut p=base.clone();p["data"]["points"]=json!([{"x":2,"y":2},{"x":1,"y":1}]);assert!(!valid(p));
 let mut p=base;p["data"]["points"]=json!((0..257).map(|x|json!({"x":x,"y":x})).collect::<Vec<_>>());assert!(!valid(p));
}
