use producer_production_core::{compile::*, contract::*, incremental::*};
use std::sync::{atomic::AtomicBool, Arc};
fn same(d: &Document, p: &Plan) {
    assert_eq!(
        serde_json::to_value(p).unwrap(),
        serde_json::to_value(compile(d).unwrap()).unwrap()
    );
    for (id, s) in &p.sequences {
        let reference = compile(d).unwrap();
        for t in [Time::ZERO, Time::new(1, 2).unwrap(), s.duration] {
            let mut a = vec![None; s.tracks.len()];
            let mut b = a.clone();
            s.evaluate_into(t, &mut a).unwrap();
            reference.sequences[id].evaluate_into(t, &mut b).unwrap();
            assert_eq!(a, b);
        }
    }
}
#[test]
fn no_op_and_controls_reuse_actual_immutable_allocations() {
    let mut d = fixture::classic_like();
    let mut c = Compiler::default();
    let (a, stats) = c.compile(&d).unwrap();
    assert_eq!(stats.layouts_built, 2);
    d.title = "Renamed".into();
    d.sets.get_mut("classic").unwrap().controls[0].label = "Go".into();
    let (b, stats) = c.compile(&d).unwrap();
    assert_eq!(stats.layouts_built, 0);
    assert_eq!(stats.layouts_reused, 2);
    assert_eq!(stats.sequences_built, 0);
    assert!(Arc::ptr_eq(&a.nodes[0], &b.nodes[0]));
    assert!(Arc::ptr_eq(&a.sequences["opener"], &b.sequences["opener"]));
    assert_ne!(a.digest, b.digest);
    same(&d, &b);
}
#[test]
fn one_layout_edit_preserves_other_layout_and_sequence_handles() {
    let mut d = fixture::classic_like();
    let mut c = Compiler::default();
    let (a, _) = c.compile(&d).unwrap();
    d.sets
        .get_mut("classic")
        .unwrap()
        .layouts
        .get_mut("wide")
        .unwrap()
        .root
        .children[0]
        .frame
        .as_mut()
        .unwrap()
        .x += 1.0;
    let (b, stats) = c.compile(&d).unwrap();
    assert_eq!(stats.layouts_built, 1);
    assert_eq!(stats.layouts_reused, 1);
    for (a, b) in a.nodes.iter().zip(&b.nodes) {
        assert_eq!(
            Arc::ptr_eq(a, b),
            !a.path.starts_with("sets/classic/layouts/wide/")
        );
    }
    assert!(Arc::ptr_eq(&a.sequences["opener"], &b.sequences["opener"]));
    same(&d, &b);
}
#[test]
fn transitive_component_and_nested_sequence_dependencies_invalidate() {
    let mut d = fixture::nested_timeline();
    let mut c = Compiler::default();
    let (a, _) = c.compile(&d).unwrap();
    d.sequences.get_mut("pulse").unwrap().tracks[0].keys[0].value = Value::Number(0.2);
    let (b, stats) = c.compile(&d).unwrap();
    assert_eq!(stats.layouts_built, 0);
    for id in ["pulse", "motif", "timeline"] {
        assert!(!Arc::ptr_eq(&a.sequences[id], &b.sequences[id]));
    }
    assert!(Arc::ptr_eq(&a.sequences["opener"], &b.sequences["opener"]));
    same(&d, &b);
    d.components
        .get_mut("badge")
        .unwrap()
        .props
        .insert("level".into(), Value::Number(0.7));
    let pin = digest(&d.components["badge"]).unwrap();
    for set in d.sets.values_mut() {
        for layout in set.layouts.values_mut() {
            for n in &mut layout.root.children {
                if let Content::Component { pin: p, .. } = &mut n.content {
                    *p = pin.clone();
                }
            }
        }
    }
    let (_, stats) = c.compile(&d).unwrap();
    assert_eq!(stats.layouts_built, 2);
}
#[test]
fn source_asset_time_maps_and_sorted_target_manifest_are_dependencies() {
    let mut d = fixture::nested_timeline();
    let mut c = Compiler::default();
    let (a, _) = c.compile(&d).unwrap();
    d.assets
        .get_mut("movie")
        .unwrap()
        .available
        .as_mut()
        .unwrap()
        .start = Time::seconds(-2);
    let (b, _) = c.compile(&d).unwrap();
    assert!(!Arc::ptr_eq(
        &a.sequences["timeline"],
        &b.sequences["timeline"]
    ));
    same(&d, &b);
    if let Source::Graphics { scene } = d.sources.get_mut("stage").unwrap() {
        let p = scene.parameters["key-light"].clone();
        scene.parameters.insert("aaa".into(), p);
    }
    let (e, stats) = c.compile(&d).unwrap();
    assert_eq!(stats.sequences_reused, 0);
    assert_eq!(stats.sequences_built, d.sequences.len());
    same(&d, &e);
}
#[test]
fn invalid_or_cancelled_candidate_cannot_poison_cache_or_bypass_validation() {
    let d = fixture::classic_like();
    let mut c = Compiler::default();
    let (a, _) = c.compile(&d).unwrap();
    let mut invalid = d.clone();
    invalid.components.get_mut("badge").unwrap().version += 1;
    assert!(c.compile(&invalid).is_err());
    assert_eq!(
        c.compile_cancellable(&d, &AtomicBool::new(true))
            .unwrap_err()
            .code,
        "COMPILE_CANCELLED"
    );
    let (b, stats) = c.compile(&d).unwrap();
    assert_eq!(stats.layouts_built, 0);
    assert!(Arc::ptr_eq(&a.nodes[0], &b.nodes[0]));
    let mut other = d.clone();
    other.id = "other".into();
    let (_, stats) = c.compile(&other).unwrap();
    assert_eq!(stats.layouts_reused, 0);
}
#[test]
fn removed_fragments_do_not_accumulate_and_old_readers_keep_valid_plans() {
    let mut d = fixture::nested_timeline();
    let mut c = Compiler::default();
    let (old, _) = c.compile(&d).unwrap();
    d.shows.clear();
    d.sequences.clear();
    d.sets.clear();
    let (_, stats) = c.compile(&d).unwrap();
    assert_eq!(c.fragment_count(), 0);
    assert_eq!(stats.layouts_built, 0);
    let mut out = vec![None; old.sequences["timeline"].tracks.len()];
    old.sequences["timeline"]
        .evaluate_into(Time::ZERO, &mut out)
        .unwrap();
    assert!(!out.is_empty());
}
