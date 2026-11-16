//! Counterexamples supplied by the independent read-only adversarial review.
use producer_production_core::{
    bounded::*, commands::*, compile::*, contract::*, coordinator::*, drivers::*, lifecycle::*,
    storage::*, transport::*,
};
use std::collections::BTreeMap;
fn grant() -> RevokeFence {
    Coordinator::new(
        Snapshot::new(fixture::classic_like()).unwrap(),
        MemoryStore::default(),
    )
    .session(true)
    .unwrap()
    .1
}
fn ready(r: &mut Runtime) -> Counter {
    let d = fixture::classic_like();
    let t = r.prepare(&d, Counter(0), 0).unwrap();
    for id in d.sources.keys() {
        let f = r.fence(t, id, Counter(1), Counter(1)).unwrap();
        r.ready(t, id, f, Counter(1), Counter(1)).unwrap();
    }
    t
}
fn apply(c: &mut Coordinator<MemoryStore>, s: &str, command: Command) -> Receipt {
    let t = c.issue(s, c.state.revision, &command, 0).unwrap();
    c.submit(s, &t, &command, 1).unwrap()
}

#[test]
fn stop_fences_old_preparations_and_unknown_reconciliation() {
    let mut r = Runtime::default();
    let t = ready(&mut r);
    r.stop();
    assert!(r
        .take(
            t,
            Counter(0),
            1,
            &grant(),
            Counter(1),
            Counter(1),
            &[Output::Landscape],
            Swap::Confirmed
        )
        .is_err());
    r.cancel(t).unwrap();
    let t = ready(&mut r);
    assert!(r
        .take(
            t,
            Counter(0),
            1,
            &grant(),
            Counter(1),
            Counter(1),
            &[Output::Landscape],
            Swap::ResponseLost
        )
        .is_err());
    r.stop();
    r.reconcile(t, true).unwrap();
    assert_eq!(r.state(t), Some(TakeState::Retiring));
    assert!(r.presentation(Output::Landscape).is_none());
    assert!(r.instances.is_empty());
    r.disposal_complete(t).unwrap();
    assert_eq!(r.ledger.used(), Cost::default());
}
#[test]
fn partial_output_take_cannot_retire_an_unreplaced_output() {
    let mut r = Runtime::default();
    let a = ready(&mut r);
    r.take(
        a,
        Counter(0),
        1,
        &grant(),
        Counter(1),
        Counter(1),
        &[Output::Landscape, Output::Vertical],
        Swap::Confirmed,
    )
    .unwrap();
    let b = ready(&mut r);
    assert_eq!(
        r.take(
            b,
            Counter(0),
            1,
            &grant(),
            Counter(1),
            Counter(1),
            &[Output::Landscape],
            Swap::Confirmed
        )
        .unwrap_err()
        .code,
        "OUTPUT_CONFIGURATION_CHANGE"
    );
    assert_eq!(r.presentation(Output::Vertical).unwrap().token, a);
    assert!(r.disposal_complete(a).is_err());
}
#[test]
fn renderer_rejects_unknown_duplicate_and_wrong_type_targets_atomically() {
    let manifest = ParameterManifest::new(BTreeMap::from([
        (0, Property::Opacity),
        (1, Property::CameraPosition),
    ]))
    .unwrap();
    let mut receiver = RendererReceiver::new(Counter(1), Counter(1), manifest.clone());
    let mut p = RenderPacket {
        context: Counter(1),
        generation: Counter(1),
        sequence: Counter(1),
        time: Time::ZERO,
        full: true,
        values: vec![
            Sample {
                target: 0,
                value: CompactValue::Number(0.5),
            },
            Sample {
                target: 1,
                value: CompactValue::Vec3([0.0, 0.0, 5.0]),
            },
        ],
    };
    receiver.receive(&p).unwrap();
    let before = receiver.values.clone();
    p.full = false;
    p.sequence = Counter(2);
    for id in 2..1002 {
        p.values = vec![Sample {
            target: id,
            value: CompactValue::Number(1.0),
        }];
        assert!(receiver.receive(&p).is_err());
        assert_eq!(receiver.values, before);
    }
    p.values = vec![
        Sample {
            target: 0,
            value: CompactValue::Number(0.4)
        };
        2
    ];
    assert!(receiver.receive(&p).is_err());
    p.values = vec![Sample {
        target: 0,
        value: CompactValue::Vec3([0.0; 3]),
    }];
    assert!(receiver.receive(&p).is_err());
    assert_eq!(receiver.values, before);
    p.sequence = Counter(3);
    p.values = vec![Sample {
        target: 0,
        value: CompactValue::Number(0.4),
    }];
    assert_eq!(
        receiver.receive(&p).unwrap_err().code,
        "RENDER_SNAPSHOT_REQUIRED"
    );
    let mut sender = RendererChannel::new(Counter(1), Counter(1), manifest);
    assert!(sender.publish(Time::ZERO, &p.values, true, 0).is_err());
}
#[test]
fn stale_override_release_cannot_clear_a_newer_acquisition() {
    let d = fixture::classic_like();
    let inv = validate_document(&d).unwrap();
    let target = d.sequences["opener"].tracks[0].target.clone();
    let mut o = Overrides::default();
    let g = grant();
    let at = |s: u64| OutputInstant(Counter(s * 1_000_000_000));
    let old = o
        .acquire(
            "host",
            target.clone(),
            Counter(4),
            Value::Number(0.9),
            at(0),
            &g,
            &inv,
        )
        .unwrap();
    assert_eq!(
        o.resolve(&target, Counter(4), at(100), CompactValue::Number(0.1)),
        CompactValue::Number(0.9)
    );
    o.disconnect("host", at(100)).unwrap();
    assert_eq!(
        o.resolve(&target, Counter(4), at(104), CompactValue::Number(0.1)),
        CompactValue::Number(0.9)
    );
    assert_eq!(
        o.resolve(&target, Counter(4), at(105), CompactValue::Number(0.1)),
        CompactValue::Number(0.1)
    );
    let new = o
        .acquire(
            "host",
            target.clone(),
            Counter(5),
            Value::Number(0.7),
            at(106),
            &g,
            &inv,
        )
        .unwrap();
    assert!(o.release("host", &target, old).is_err());
    assert_eq!(
        o.resolve(&target, Counter(5), at(107), CompactValue::Number(0.1)),
        CompactValue::Number(0.7)
    );
    o.release("host", &target, new).unwrap();
}
#[test]
fn repeated_undo_traverses_history_and_failed_save_does_not_consume_it() {
    let d = fixture::classic_like();
    let initial = d.title.clone();
    let mut c = Coordinator::new(Snapshot::new(d).unwrap(), MemoryStore::default());
    let (s, _) = c.session(true).unwrap();
    for title in ["A", "B"] {
        apply(
            &mut c,
            &s,
            Command::Transaction {
                operations: vec![Operation::SetTitle {
                    title: title.into(),
                }],
            },
        );
    }
    let undo = c.undo_command(&s).unwrap();
    c.storage.failure = Some(Failure::BeforeWrite);
    assert!(matches!(
        apply(&mut c, &s, undo).outcome,
        Outcome::Rejected(_)
    ));
    assert_eq!(c.state.document.title, "B");
    for expected in ["A", &initial] {
        let undo = c.undo_command(&s).unwrap();
        assert_eq!(apply(&mut c, &s, undo).outcome, Outcome::Saved);
        assert_eq!(c.state.document.title, expected);
    }
    assert_eq!(c.state.revision, Counter(4));
    assert!(c.undo_command(&s).is_err());
}
#[test]
fn reusable_scratch_does_not_leak_drivers_from_a_longer_sequence() {
    let plan = compile(&fixture::classic_like()).unwrap();
    let long = &plan.sequences["opener"];
    let mut short = (**long).clone();
    short.tracks.truncate(1);
    let mut scratch = vec![None; 16];
    long.evaluate_into(Time::seconds(2), &mut scratch).unwrap();
    assert!(scratch[1].is_some());
    short.evaluate_into(Time::seconds(2), &mut scratch).unwrap();
    assert!(scratch[1..].iter().all(Option::is_none));
}
#[test]
fn mixed_min_max_layout_constraints_find_the_feasible_allocation() {
    let mut d = fixture::classic_like();
    let root = &mut d
        .sets
        .get_mut("classic")
        .unwrap()
        .layouts
        .get_mut("wide")
        .unwrap()
        .root;
    root.children.truncate(2);
    root.frame.as_mut().unwrap().width = 100.0;
    root.flow = Flow::Row {
        gap: 0.0,
        sizes: vec![
            Size::Weight {
                weight: 1.0,
                min: 80.0,
                max: 100.0,
            },
            Size::Weight {
                weight: 1.0,
                min: 0.0,
                max: 10.0,
            },
        ],
    };
    let p = compile(&d).unwrap();
    let host = p
        .nodes
        .iter()
        .find(|n| n.path == "sets/classic/layouts/wide/root/host")
        .unwrap();
    assert_eq!(host.frame.width, 90.0);
}
#[test]
fn finite_source_loops_wrap_from_negative_preroll_exactly() {
    let mut p = fixture::classic_like().sequences["opener"].placements[0].clone();
    p.looping = true;
    p.source_in = Time::seconds(1);
    let available = Range {
        start: Time::seconds(-1),
        duration: Time::seconds(4),
    };
    assert_eq!(
        p.source_time(Time::seconds(2), available).unwrap(),
        Some(Time::seconds(-1))
    );
    assert_eq!(p.source_time(Time::seconds(8), available).unwrap(), None);
}

#[test]
fn resolved_file_identity_resets_player_even_when_asset_alias_is_unchanged() {
    let mut r = Runtime::default();
    let a = ready(&mut r);
    r.take(
        a,
        Counter(0),
        1,
        &grant(),
        Counter(1),
        Counter(1),
        &[Output::Landscape],
        Swap::Confirmed,
    )
    .unwrap();
    let old = r.instances["sources/player-a"].incarnation;
    let mut d = fixture::classic_like();
    d.assets.get_mut("movie").unwrap().hash = "f".repeat(64);
    let b = r.prepare(&d, Counter(1), 0).unwrap();
    for id in d.sources.keys() {
        let f = r.fence(b, id, Counter(1), Counter(1)).unwrap();
        r.ready(b, id, f, Counter(1), Counter(1)).unwrap();
    }
    r.take(
        b,
        Counter(1),
        1,
        &grant(),
        Counter(1),
        Counter(1),
        &[Output::Landscape],
        Swap::Confirmed,
    )
    .unwrap();
    assert_ne!(r.instances["sources/player-a"].incarnation, old);
    let unchanged = r.instances["sources/stage"].incarnation;
    r.disposal_complete(a).unwrap();
    if let Source::Graphics { scene } = &mut d.sources.get_mut("stage").unwrap() {
        scene.parameters.get_mut("key-light").unwrap().initial = Value::Number(2.0);
    }
    let c = r.prepare(&d, Counter(2), 0).unwrap();
    for id in d.sources.keys() {
        let f = r.fence(c, id, Counter(1), Counter(1)).unwrap();
        r.ready(c, id, f, Counter(1), Counter(1)).unwrap();
    }
    r.take(
        c,
        Counter(2),
        1,
        &grant(),
        Counter(1),
        Counter(1),
        &[Output::Landscape],
        Swap::Confirmed,
    )
    .unwrap();
    assert_eq!(r.instances["sources/stage"].incarnation, unchanged);
    r.disposal_complete(b).unwrap();
    d.assets.get_mut("geometry").unwrap().hash = "e".repeat(64);
    let next = r.prepare(&d, Counter(3), 0).unwrap();
    for id in d.sources.keys() {
        let f = r.fence(next, id, Counter(1), Counter(1)).unwrap();
        r.ready(next, id, f, Counter(1), Counter(1)).unwrap();
    }
    r.take(
        next,
        Counter(3),
        1,
        &grant(),
        Counter(1),
        Counter(1),
        &[Output::Landscape],
        Swap::Confirmed,
    )
    .unwrap();
    assert_ne!(r.instances["sources/stage"].incarnation, unchanged);
}
