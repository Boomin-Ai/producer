use producer_production_core::{
    bounded::*, compile::*, contract::*, coordinator::*, drivers::*, lifecycle::*, storage::*,
    transport::*,
};
fn grant() -> RevokeFence {
    let mut c = Coordinator::new(
        Snapshot::new(fixture::classic_like()).unwrap(),
        MemoryStore::default(),
    );
    c.session(true).unwrap().1
}
fn prepared(r: &mut Runtime, d: &Document, revision: u64) -> Counter {
    let t = r.prepare(d, Counter(revision), 0).unwrap();
    for id in d.sources.keys() {
        let f = r.fence(t, id, Counter(1), Counter(1)).unwrap();
        r.ready(t, id, f, Counter(1), Counter(1)).unwrap();
    }
    t
}
fn take(r: &mut Runtime, t: Counter, revision: u64) {
    r.take(
        t,
        Counter(revision),
        1,
        &grant(),
        Counter(1),
        Counter(1),
        &[Output::Landscape, Output::Vertical],
        Swap::Confirmed,
    )
    .unwrap();
}

#[test]
fn identity_survives_prop_layout_edit_but_not_removal_or_definition_change() {
    let mut r = Runtime::default();
    let mut d = fixture::classic_like();
    let t = prepared(&mut r, &d, 0);
    take(&mut r, t, 0);
    let path = "sets/classic/layouts/wide/root/first-badge/badge/label";
    let original = r.instances[path].incarnation;
    r.instances.get_mut(path).unwrap().state = 0.75;
    if let Content::Component { props, .. } = &mut d
        .sets
        .get_mut("classic")
        .unwrap()
        .layouts
        .get_mut("wide")
        .unwrap()
        .root
        .children[2]
        .content
    {
        props.insert("level".into(), Value::Number(0.3));
    }
    let t2 = prepared(&mut r, &d, 1);
    take(&mut r, t2, 1);
    assert_eq!(r.instances[path].incarnation, original);
    assert_eq!(r.instances[path].state, 0.75);
    r.disposal_complete(t).unwrap();
    let saved = d
        .sets
        .get_mut("classic")
        .unwrap()
        .layouts
        .get_mut("wide")
        .unwrap()
        .root
        .children
        .remove(2);
    let t3 = prepared(&mut r, &d, 2);
    take(&mut r, t3, 2);
    r.disposal_complete(t2).unwrap();
    assert!(!r.instances.contains_key(path));
    d.sets
        .get_mut("classic")
        .unwrap()
        .layouts
        .get_mut("wide")
        .unwrap()
        .root
        .children
        .insert(2, saved);
    let t4 = prepared(&mut r, &d, 3);
    take(&mut r, t4, 3);
    r.disposal_complete(t3).unwrap();
    assert_ne!(r.instances[path].incarnation, original);
    let previous = r.instances[path].incarnation;
    d.components.get_mut("badge").unwrap().version += 1;
    let pin = digest(&d.components["badge"]).unwrap();
    for s in d.sets.values_mut() {
        for l in s.layouts.values_mut() {
            for n in &mut l.root.children {
                if let Content::Component { pin: p, .. } = &mut n.content {
                    *p = pin.clone();
                }
            }
        }
    }
    let t5 = prepared(&mut r, &d, 4);
    take(&mut r, t5, 4);
    assert_ne!(r.instances[path].incarnation, previous);
}
#[test]
fn cold_frames_revoke_and_timeout_never_claim_presentation() {
    let d = fixture::classic_like();
    let mut r = Runtime::default();
    let t = r.prepare(&d, Counter(0), 0).unwrap();
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
    let f = r.fence(t, "host", Counter(1), Counter(1)).unwrap();
    assert!(r.ready(t, "host", f, Counter(2), Counter(1)).is_err());
    r.cancel(t).unwrap();
    let t = prepared(&mut r, &d, 1);
    let g = grant();
    g.revoke();
    assert_eq!(
        r.take(
            t,
            Counter(1),
            1,
            &g,
            Counter(1),
            Counter(1),
            &[Output::Landscape],
            Swap::Confirmed
        )
        .unwrap_err()
        .code,
        "FORBIDDEN"
    );
    assert!(r
        .take(
            t,
            Counter(2),
            1,
            &grant(),
            Counter(1),
            Counter(1),
            &[Output::Landscape],
            Swap::Confirmed
        )
        .is_err());
    assert!(r.presentation(Output::Landscape).is_none());
    r.expire(30_001);
    assert!(r.state(t).is_none());
    assert_eq!(r.ledger.used(), Cost::default());
}
#[test]
fn unknown_and_retiring_resources_remain_charged_until_exact_reconciliation() {
    let d = fixture::classic_like();
    let mut r = Runtime::default();
    let a = prepared(&mut r, &d, 0);
    take(&mut r, a, 0);
    let before = r.ledger.used();
    assert_eq!(before.graphics.scenes, 1);
    assert_eq!(before.graphics.instances, 1000);
    let b = prepared(&mut r, &d, 1);
    let reserved = r.ledger.used();
    assert_eq!(reserved.graphics.scenes, 2);
    assert_eq!(reserved.graphics.instances, 2000);
    assert_eq!(reserved.graphics.buffers, before.graphics.buffers * 2);
    assert_eq!(reserved.graphics.textures, before.graphics.textures * 2);
    assert_eq!(reserved.graphics.pipelines, before.graphics.pipelines * 2);
    assert_eq!(
        reserved.graphics.render_passes,
        before.graphics.render_passes * 2
    );
    assert_eq!(
        r.take(
            b,
            Counter(1),
            1,
            &grant(),
            Counter(1),
            Counter(1),
            &[Output::Landscape, Output::Vertical],
            Swap::ResponseLost
        )
        .unwrap_err()
        .code,
        "TAKE_OUTCOME_UNKNOWN"
    );
    assert_eq!(
        r.presentation(Output::Landscape).unwrap().revision,
        Counter(0)
    );
    assert!(r.cancel(b).is_err());
    r.expire(u64::MAX);
    assert_eq!(r.ledger.used(), reserved);
    r.reconcile(b, true).unwrap();
    assert_eq!(
        r.presentation(Output::Vertical).unwrap().revision,
        Counter(1)
    );
    assert_eq!(r.ledger.used(), reserved);
    r.disposal_complete(a).unwrap();
    assert_eq!(r.ledger.used(), before);
    r.stop();
    assert!(r.presentation(Output::Landscape).is_none());
    r.disposal_complete(b).unwrap();
    assert_eq!(r.ledger.used(), Cost::default());
}
#[test]
fn resource_and_queue_saturation_have_independent_stop_path() {
    let mut ledger = Ledger::default();
    let _ = ledger.reserve(CAP).unwrap();
    assert!(ledger
        .reserve(Cost {
            cpu: 1,
            ..Cost::default()
        })
        .is_err());
    assert_eq!(ledger.used(), CAP);
    let mut q = Queue::default();
    for i in 0..256 {
        q.admit(i, 16 * 1024).unwrap();
    }
    assert!(q.admit(0, 1).is_err());
    q.stop();
    assert!(q.stop_requested);
    for i in 0..256 {
        assert_eq!(q.pop(), Some(i));
    }
    assert!(q.is_empty());
    let mut r = Runtime::default();
    let d = Document::empty("empty", "Empty");
    for _ in 0..4 {
        r.prepare(&d, Counter(0), 0).unwrap();
    }
    assert_eq!(
        r.prepare(&d, Counter(0), 0).unwrap_err().code,
        "PREPARE_LIMIT"
    );
    r.expire(30_001);
    assert_eq!(r.ledger.used(), Cost::default());
}
#[test]
fn leased_override_restores_current_driver_and_rejects_stale_incarnations() {
    let d = fixture::classic_like();
    let inv = validate_document(&d).unwrap();
    let target = d.sequences["opener"].tracks[0].target.clone();
    let g = grant();
    let mut o = Overrides::default();
    let at = |s: u64| OutputInstant(Counter(s * 1_000_000_000));
    o.acquire(
        "host",
        target.clone(),
        Counter(4),
        Value::Number(0.9),
        at(0),
        &g,
        &inv,
    )
    .unwrap();
    assert!(o
        .acquire(
            "agent",
            target.clone(),
            Counter(4),
            Value::Number(0.1),
            at(1),
            &g,
            &inv
        )
        .is_err());
    assert_eq!(
        o.resolve(&target, Counter(4), at(4), CompactValue::Number(0.5)),
        CompactValue::Number(0.9)
    );
    o.disconnect("host", at(0)).unwrap();
    assert_eq!(
        o.resolve(&target, Counter(4), at(5), CompactValue::Number(0.625)),
        CompactValue::Number(0.625)
    );
    assert_eq!(
        o.resolve(&target, Counter(5), at(4), CompactValue::Number(0.3)),
        CompactValue::Number(0.3)
    );
    g.revoke();
    assert_eq!(
        o.resolve(&target, Counter(4), at(4), CompactValue::Number(0.4)),
        CompactValue::Number(0.4)
    );
}
#[test]
fn hosted_authority_is_not_minted_or_changed_by_local_commands() {
    use producer_production_core::commands::*;
    let d = fixture::classic_like();
    let mut hosted = d.clone();
    hosted.shows.get_mut("pilot").unwrap().authority = Authority::Hosted;
    assert_eq!(
        apply(
            &d,
            &Command::Import {
                document: hosted.clone()
            }
        )
        .unwrap_err()
        .code,
        "HOSTED_AUTHORITY"
    );
    assert!(apply(
        &hosted,
        &Command::Transaction {
            operations: vec![Operation::RemoveShow { id: "pilot".into() }]
        }
    )
    .is_err());
}
#[test]
fn observer_snapshot_is_redacted_chunked_and_recovers_a_history_gap() {
    let mut d = fixture::classic_like();
    d.metadata
        .insert("private-key".into(), serde_json::json!("never-observe"));
    let mut o = Observers::default();
    o.publish(&d, Counter(0), vec![]).unwrap();
    let id = o.connect().unwrap();
    let m = o.poll(&id).unwrap().unwrap();
    let Message::Snapshot {
        cursor,
        digest,
        bytes,
        ..
    } = m
    else {
        panic!("snapshot required")
    };
    assert!(bytes.len() <= 64 * 1024);
    assert!(!String::from_utf8(bytes).unwrap().contains("never-observe"));
    o.snapshot_complete(&id, cursor, &digest).unwrap();
    for n in 1..=130 {
        o.publish(&d, Counter(n), vec!["title".into()]).unwrap();
    }
    assert!(matches!(
        o.poll(&id).unwrap(),
        Some(Message::ResnapshotRequired)
    ));
    o.begin_snapshot(&id).unwrap();
    let Message::Snapshot { cursor, digest, .. } = o.poll(&id).unwrap().unwrap() else {
        panic!()
    };
    o.snapshot_complete(&id, cursor, &digest).unwrap();
    o.publish(&d, Counter(131), vec!["title".into()]).unwrap();
    assert!(matches!(o.poll(&id).unwrap(), Some(Message::Delta { .. })));
    for _ in 1..8 {
        o.connect().unwrap();
    }
    assert!(o.connect().is_err());
}
#[test]
fn renderer_coalescing_requires_full_state_and_fences_stale_ack() {
    let mut c = RendererChannel::new(
        Counter(1),
        Counter(2),
        ParameterManifest::new(std::collections::BTreeMap::from([(1, Property::Opacity)])).unwrap(),
    );
    let v = [Sample {
        target: 1,
        value: CompactValue::Number(1.0),
    }];
    assert!(c.publish(Time::ZERO, &v, false, 0).is_err());
    c.publish(Time::ZERO, &v, true, 0).unwrap();
    c.publish(Time::seconds(1), &v, false, 1).unwrap();
    assert_eq!(
        c.publish(Time::seconds(2), &v, false, 2).unwrap_err().code,
        "RENDER_SNAPSHOT_REQUIRED"
    );
    assert_eq!(c.dropped, 2);
    let n = c.publish(Time::seconds(3), &v, true, 3).unwrap();
    assert!(c.acknowledge(Counter(0), Counter(2), n).is_err());
    c.acknowledge(Counter(1), Counter(2), n).unwrap();
    assert!(c.front().is_none());
    assert!(c.publish(Time::ZERO, &vec![v[0]; 257], true, 4).is_err());
}
#[test]
fn component_bindings_compile_per_instance_and_large_loop_cues_stay_exact() {
    let p = compile(&fixture::classic_like()).unwrap();
    let values: Vec<_> = p
        .nodes
        .iter()
        .filter(|n| n.path.ends_with("/badge/label"))
        .map(|n| n.bound[0].1)
        .collect();
    assert!(values.contains(&CompactValue::Number(0.8)));
    assert!(values.contains(&CompactValue::Number(0.4)));
    let mut c = CueCursor::new(
        Counter(1),
        Time::seconds(1),
        vec![Cue {
            id: "pulse".into(),
            at: Time::ZERO,
            at_start: true,
            each_loop: true,
        }],
    );
    assert_eq!(c.start().unwrap().len(), 1);
    assert!(c.start().unwrap().is_empty());
    c.seek_silent(Time::seconds(2_000_000)).unwrap();
    assert_eq!(
        c.advance(Time::seconds(2_000_001)).unwrap()[0].occurrence,
        Counter(2_000_001)
    );
}
