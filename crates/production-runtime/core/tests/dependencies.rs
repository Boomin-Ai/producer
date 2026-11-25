use producer_production_core::{
    compile,
    contract::*,
    coordinator::*,
    dependencies::ResourceKind,
    incremental::Compiler,
    ownership::*,
    show::*,
    storage::{MemoryStore, Snapshot},
    transport::OutputInstant,
};

fn grant(d: &Document) -> RevokeFence {
    Coordinator::new(Snapshot::new(d.clone()).unwrap(), MemoryStore::default())
        .session(true)
        .unwrap()
        .1
}
fn run(d: &Document) -> ShowRun {
    ShowRun::compile(d, "pilot", grant(d), OutputInstant(Counter(0))).unwrap()
}
fn dispose(s: &mut ShowRun) {
    for _ in 0..RESOURCES {
        if s.closed_and_disposed() {
            return;
        }
        let ready = s.disposal_ready();
        assert!(!ready.is_empty(), "a read or dependency is still retained");
        for ack in ready {
            s.disposed(ack.resource, ack.lane).unwrap();
        }
    }
    panic!("cleanup did not converge");
}

#[test]
fn dependency_cycles_and_surviving_owners_reject_atomically() {
    let mut o = Ownership::new();
    let owner = o.enter(o.root(), ScopeKind::Component).unwrap();
    let user = o.enter(o.root(), ScopeKind::Component).unwrap();
    let asset = o.own(owner, Lane::Control).unwrap();
    let source = o.own(user, Lane::Video).unwrap();
    o.depend(source, asset).unwrap();
    let before = o.status();
    assert_eq!(
        o.depend(asset, source).unwrap_err().code,
        "DEPENDENCY_CYCLE"
    );
    assert_eq!(o.depend(asset, asset).unwrap_err().code, "DEPENDENCY_CYCLE");
    assert_eq!(o.status(), before);
    assert_eq!(o.leave(&[owner]).unwrap_err().code, "OWNER_BORROWED");
    assert_eq!(o.status(), before);
    o.leave(&[owner, user]).unwrap();
    assert_eq!(
        o.disposed(asset, Lane::Control).unwrap_err().code,
        "DISPOSAL_FENCE"
    );
    assert_eq!(
        o.disposal_ready(),
        vec![Disposal {
            resource: source,
            lane: Lane::Video
        }]
    );
    o.disposed(source, Lane::Video).unwrap();
    o.disposed(asset, Lane::Control).unwrap();
    assert_eq!(o.status().resources, 0);
}

#[test]
fn reads_retain_transitive_inputs_through_logical_close_and_lane_disposal() {
    let mut o = Ownership::new();
    let asset = o.own(o.root(), Lane::Control).unwrap();
    let player = o.own(o.root(), Lane::Video).unwrap();
    let audio = o.own(o.root(), Lane::Audio).unwrap();
    o.depend(player, asset).unwrap();
    o.depend(audio, player).unwrap();
    let read = o.read(o.root(), audio).unwrap();
    assert_eq!(o.status().read_holds, 3);
    o.leave(&[o.root()]).unwrap();
    assert!(o.disposal_ready().is_empty());
    for (r, lane) in [
        (asset, Lane::Control),
        (player, Lane::Video),
        (audio, Lane::Audio),
    ] {
        assert_eq!(o.disposed(r, lane).unwrap_err().code, "DISPOSAL_FENCE");
    }
    o.finish_read(read).unwrap();
    assert!(o.finish_read(read).is_err());
    assert!(o.disposed(audio, Lane::Video).is_err());
    o.disposed(audio, Lane::Audio).unwrap();
    o.disposed(player, Lane::Video).unwrap();
    o.disposed(asset, Lane::Control).unwrap();
    assert_eq!(o.status().resources + o.status().read_holds, 0);
}

#[test]
fn transitive_read_holds_and_combined_dependency_relations_are_bounded() {
    let mut o = Ownership::new();
    let resources: Vec<_> = (0..64)
        .map(|_| o.own(o.root(), Lane::Renderer).unwrap())
        .collect();
    for pair in resources.windows(2) {
        o.depend(pair[0], pair[1]).unwrap();
    }
    let reads: Vec<_> = (0..READ_HOLDS / resources.len())
        .map(|_| o.read(o.root(), resources[0]).unwrap())
        .collect();
    assert_eq!(o.status().read_holds, READ_HOLDS);
    let before = o.status();
    assert_eq!(
        o.read(o.root(), resources[0]).unwrap_err().code,
        "READ_LIMIT"
    );
    assert_eq!(o.status(), before);
    for read in reads {
        o.finish_read(read).unwrap();
    }
    let read = o.read(o.root(), resources[0]).unwrap();
    o.finish_read(read).unwrap();

    // Fill the common edge/user allowance; neither path gets a separate
    // 4,096-entry allowance and idempotent edges remain legal at capacity.
    let mut users = Vec::new();
    while o.status().relations + o.status().dependencies < RELATIONS {
        let user = o.enter(o.root(), ScopeKind::Component).unwrap();
        users.push(user);
        for r in &resources {
            if o.status().relations + o.status().dependencies == RELATIONS {
                break;
            }
            o.relate(user, *r, Relation::Borrow).unwrap();
        }
    }
    let before = o.status();
    o.depend(resources[0], resources[1]).unwrap();
    assert_eq!(
        o.depend(resources[0], resources[2]).unwrap_err().code,
        "RELATION_LIMIT"
    );
    assert_eq!(
        o.relate(o.root(), resources[0], Relation::Borrow)
            .unwrap_err()
            .code,
        "RELATION_LIMIT"
    );
    assert_eq!(o.status(), before);
}

#[test]
fn compiled_graph_separates_component_instances_players_and_shared_inputs() {
    let d = fixture::classic_like();
    let plan = compile::compile(&d).unwrap();
    let r = &plan.dependencies.resources;
    let a = "sets/classic/layouts/wide/root/first-badge";
    let b = "sets/classic/layouts/wide/root/second-badge";
    assert_eq!(r[a].kind, ResourceKind::Component);
    assert_eq!(r[b].kind, ResourceKind::Component);
    assert_ne!(r[a].owner, r[b].owner);
    let font = format!("fonts/{}", "d".repeat(64));
    assert!(r[a].dependencies.contains(&font) && r[b].dependencies.contains(&font));
    assert!(r["sets/classic/layouts/wide"]
        .dependencies
        .contains("sources/host"));
    assert!(r["sets/classic/layouts/tall"]
        .dependencies
        .contains("sources/host"));
    for source in ["sources/player-a", "sources/player-b"] {
        assert_eq!(r[source].dependencies, ["assets/movie".into()].into());
    }
    assert_eq!(
        r["sources/stage"].dependencies,
        ["sources/stage/batches/lights".into()].into()
    );
    assert_eq!(
        r["sources/stage/batches/lights"].dependencies,
        ["assets/geometry".into(), "assets/material".into()].into()
    );
    assert_eq!(r["assets/movie"].identity, Some("a".repeat(64)));
    let s = run(&d);
    assert_ne!(s.resources()[a].resource, s.resources()[b].resource);
    assert_ne!(
        s.resources()["sources/player-a"].resource,
        s.resources()["sources/player-b"].resource
    );
}

#[test]
fn layout_use_and_audio_contribution_have_independent_segment_relations() {
    let mut d = fixture::classic_like();
    // The file players have audio routes but no visual nodes in these layouts.
    let segment = d.shows["pilot"].segments[0].clone();
    d.shows.get_mut("pilot").unwrap().segments.push(Segment {
        id: "static".into(),
        title: "Static".into(),
        sequence: None,
        ..segment
    });
    let mut s = run(&d);
    s.apply(ShowEvent::Start {
        at: Counter(0),
        segment: None,
    })
    .unwrap();
    let route = s
        .resources()
        .iter()
        .find(|(path, r)| {
            path.starts_with("sequences/opener/") && r.kind == ResourceKind::AudioRoute
        })
        .map(|(path, _)| path.clone())
        .unwrap();
    let audio_read = s.begin_read(&route).unwrap();
    let layout_read = s.begin_read("sets/classic/layouts/wide").unwrap();
    assert!(s.status().ownership.read_holds >= 4);
    let handles = s.resources().clone();
    let next = s.apply(ShowEvent::Next { at: Counter(1) }).unwrap();
    assert!(next.cleanup.unwrap().retiring.is_empty());
    assert_eq!(*s.resources(), handles);
    assert_eq!(s.begin_read(&route).unwrap_err().code, "BORROW_REQUIRED");
    // The old audio read is still valid, even though the new static segment
    // does not contribute that route. Hiding video was never an audio mute.
    s.apply(ShowEvent::Close { at: Counter(2) }).unwrap();
    assert!(s.begin_read("sets/classic/layouts/wide").is_err());
    s.finish_read(layout_read).unwrap();
    s.finish_read(audio_read).unwrap();
    dispose(&mut s);
}

#[test]
fn a_late_read_cannot_alias_after_show_reentry_or_new_execution() {
    let d = fixture::classic_like();
    let mut a = run(&d);
    let mut b = run(&d);
    for s in [&mut a, &mut b] {
        s.apply(ShowEvent::Start {
            at: Counter(0),
            segment: None,
        })
        .unwrap();
    }
    let old = a.begin_read("sets/classic/layouts/wide").unwrap();
    a.apply(ShowEvent::Start {
        at: Counter(1),
        segment: None,
    })
    .unwrap();
    let current = a.begin_read("sets/classic/layouts/wide").unwrap();
    assert!(b.finish_read(old).is_err());
    a.finish_read(old).unwrap();
    assert_eq!(a.status().ownership.reads, 1);
    a.finish_read(current).unwrap();
    assert_eq!(a.status().ownership.reads, 0);
}

#[test]
fn dependency_capacity_failure_cannot_publish_an_incremental_cache() {
    let mut d = fixture::classic_like();
    let mut compiler = Compiler::default();
    let (before, _) = compiler.compile(&d).unwrap();
    let count = compiler.fragment_count();
    let layout = d
        .sets
        .get_mut("classic")
        .unwrap()
        .layouts
        .get_mut("wide")
        .unwrap();
    let mut component = layout.root.children[2].clone();
    for i in 0..SCOPES {
        component.id = format!("extra-{i}");
        layout.root.children.push(component.clone());
    }
    validate_document(&d).unwrap();
    assert_eq!(compiler.compile(&d).unwrap_err().code, "RESOURCE_LIMIT");
    assert_eq!(compiler.fragment_count(), count);
    let (again, stats) = compiler.compile(&fixture::classic_like()).unwrap();
    assert_eq!(again.dependencies, before.dependencies);
    assert_eq!(stats.layouts_built + stats.sequences_built, 0);
}

#[test]
fn changed_resolved_assets_update_dependencies_despite_reused_layouts() {
    let mut d = fixture::classic_like();
    let mut compiler = Compiler::default();
    let (old, _) = compiler.compile(&d).unwrap();
    d.assets.get_mut("movie").unwrap().hash = "e".repeat(64);
    let (new, stats) = compiler.compile(&d).unwrap();
    assert_eq!(stats.layouts_reused, 2);
    assert_eq!(new.dependencies, compile::compile(&d).unwrap().dependencies);
    assert_ne!(
        new.dependencies.resources["assets/movie"].identity,
        old.dependencies.resources["assets/movie"].identity
    );
    assert!(Arc::ptr_eq(&old.nodes[0], &new.nodes[0]));
}

use std::sync::Arc;
