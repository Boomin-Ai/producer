use producer_production_contract::{
    fixture, validate_document, GraphInput, GraphPass, RenderGraph,
};
use serde_json::json;

fn graph() -> RenderGraph {
    serde_json::from_value(json!({
        "profile":"producer.render/1",
        "passes":[
            {"kind":"fragment","id":"field","shader":"return frame.params;"},
            {"kind":"fragment","id":"color","inputs":[{"kind":"pass","id":"field"}],
                "shader":"return textureSample(input0,linear_sampler,uv);"}
        ]
    }))
    .unwrap()
}

#[test]
fn forwards_cycles_dead_passes_and_unavailable_inputs_are_refused() {
    let mut room = fixture::classic_like();
    let mut g = graph();
    room.sets
        .get_mut("classic")
        .unwrap()
        .graphs
        .insert("surface".into(), g.clone());
    assert!(validate_document(&room).is_ok());
    for inputs in [
        vec![],
        vec![GraphInput::Pass { id: "color".into() }],
        vec![GraphInput::Source {
            id: "missing".into(),
        }],
        vec![GraphInput::Image {
            asset: "missing".into(),
        }],
    ] {
        let GraphPass::Fragment { inputs: target, .. } = &mut g.passes[1] else { panic!("expected fragment") };
        *target = inputs;
        room.sets
            .get_mut("classic")
            .unwrap()
            .graphs
            .insert("surface".into(), g.clone());
        assert!(validate_document(&room).is_err());
    }
    let mut g = graph();
    g.passes.swap(0, 1);
    room.sets
        .get_mut("classic")
        .unwrap()
        .graphs
        .insert("surface".into(), g);
    assert!(validate_document(&room).is_err());
}

#[test]
fn v1_rejects_unknown_profiles_and_stages() {
    let base = serde_json::to_value(graph()).unwrap();
    for (path, value) in [
        ("/profile", "producer.render/2"),
        ("/passes/0/kind", "compute"),
    ] {
        let mut draft = base.clone();
        *draft.pointer_mut(path).unwrap() = json!(value);
        assert!(serde_json::from_value::<RenderGraph>(draft).is_err());
    }
}

#[test]
fn output_layers_resolve_in_each_layout_and_cannot_recurse_through_a_fill() {
    use producer_production_contract::{Paint, SurfaceStyle};
    let mut room = fixture::classic_like();
    let set = room.sets.get_mut("classic").unwrap();
    let branch = set.layouts["wide"].root.children[0].id.clone();
    let mut composition = graph();
    let GraphPass::Fragment { inputs, .. } = &mut composition.passes[0] else { panic!("expected fragment") };
    inputs.push(GraphInput::Layers {
        nodes: vec![branch],
    });
    set.graphs.insert("output".into(), composition);
    set.output_graphs.insert("wide".into(), "output".into());
    assert!(validate_document(&room).is_ok());

    let mut broken = room.clone();
    let set = broken.sets.get_mut("classic").unwrap();
    let GraphPass::Fragment { inputs, .. } = &mut set.graphs.get_mut("output").unwrap().passes[0] else { panic!("expected fragment") };
    *inputs = vec![GraphInput::Layers {
        nodes: vec!["missing-branch".into()],
    }];
    assert!(validate_document(&broken).is_err());
    let set = room.sets.get_mut("classic").unwrap();
    let node = &mut set.layouts.get_mut("wide").unwrap().root.children[0];
    node.style.get_or_insert_with(SurfaceStyle::default).fill = Some(Paint::Graph {
        graph: "output".into(),
    });
    assert!(validate_document(&room).is_err());
}

#[test]
fn geometry_requires_its_profile_and_valid_shot_resources() {
    let key = json!({"seconds":0,"eye":[0,1,4],"target":[0,0,0],"fov":45});
    let mut end=key.clone();
    end["seconds"]=json!(4);
    let scene=json!({"camera":[key,end], "lightDirection":[0,1,0],"lightColor":[1,1,1],"ambient":[0.2,0.2,0.2],
        "objects":[{"id":"planet","mesh":"sphere","position":[0,0,0],"scale":[1,1,1],
            "rotation":[0,0,0],"color":[1,0.5,0.2],"roughness":0.4,"metallic":0.1}]});
    let graph=json!({"profile":"producer.geometry/1","passes":[{"id":"world","kind":"geometry","scene":scene}]});
    let check=|value| {
        let mut room=fixture::classic_like();
        room.sets.get_mut("classic").unwrap().graphs.insert("world".into(),serde_json::from_value(value).unwrap());
        validate_document(&room).is_ok()
    };
    assert!(check(graph.clone()));
    for (path, value) in [
        ("/profile", json!("producer.render/1")),
        ("/passes/0/scene/lightDirection",json!([0,0,0])),
        ("/passes/0/scene/camera/1/seconds",json!(0)),
        ("/passes/0/scene/camera/1/fov",json!(180)),
        ("/passes/0/scene/objects/0/scale",json!([1,0,1])),
    ]{
        let mut bad=graph.clone();*bad.pointer_mut(path).unwrap()=value;
        assert!(!check(bad),"{path}");
    }
    let mut bad=graph;
    bad["passes"][0]["scene"]["objects"][0]["input"]=json!(0);
    assert!(!check(bad));
}
