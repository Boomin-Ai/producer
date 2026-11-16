use producer_production_core::{
    compile::CompactValue, contract::*, coordinator::*, ownership::Lane, show::*, storage::*,
    transport::OutputInstant,
};
fn at(n: u64) -> Counter {
    Counter(n * 1_000_000_000)
}
fn now(n: u64) -> OutputInstant {
    OutputInstant(at(n))
}
fn doc() -> Document {
    let mut d = fixture::nested_timeline();
    let opening = d.shows["pilot"].segments[0].clone();
    for (id, sequence) in [("question", Some("timeline")), ("static", None)] {
        d.shows.get_mut("pilot").unwrap().segments.push(Segment {
            id: id.into(),
            title: id.into(),
            sequence: sequence.map(Into::into),
            ..opening.clone()
        });
    }
    d
}
fn coordinator() -> Coordinator<MemoryStore> {
    Coordinator::new(Snapshot::new(doc()).unwrap(), MemoryStore::default())
}
fn run() -> (ShowRun, RevokeFence) {
    let g = coordinator().session(true).unwrap().1;
    (
        ShowRun::compile(&doc(), "pilot", g.clone(), now(0)).unwrap(),
        g,
    )
}
fn start(s: &mut ShowRun, n: u64) -> ShowSample {
    s.apply(ShowEvent::Start {
        at: at(n),
        segment: None,
    })
    .unwrap()
}
fn advance(s: &mut ShowRun, n: u64) -> ShowSample {
    s.apply(ShowEvent::Advance { at: at(n) }).unwrap()
}
fn target(index: usize) -> Target {
    producer_production_core::compile::compile(&doc())
        .unwrap()
        .targets
        .into_iter()
        .filter(|t| t.property == Property::Opacity)
        .nth(index)
        .unwrap()
}
fn override_at(
    s: &mut ShowRun,
    scope: ExecutionScope,
    target: Target,
    value: f64,
    n: u64,
) -> ShowSample {
    s.apply(ShowEvent::Override {
        at: at(n),
        scope,
        owner: "host".into(),
        target,
        value: Value::Number(value),
    })
    .unwrap()
}
fn pause(s: &mut ShowRun, scope: ExecutionScope, owner: &str, reason: &str, n: u64) {
    s.apply(ShowEvent::Pause {
        at: at(n),
        scope,
        owner: owner.into(),
        reason: reason.into(),
    })
    .unwrap();
}
#[test]
fn reentry_restart_and_seek_fence_old_occurrences_and_keep_the_borrowed_set() {
    let (mut s, _) = run();
    let a = start(&mut s, 0);
    assert!(s.accepts_completion(&a.execution, a.run, a.occurrence, a.epoch));
    let b = s
        .apply(ShowEvent::Enter {
            at: at(1),
            segment: "opening".into(),
        })
        .unwrap();
    assert_eq!(b.run, a.run);
    assert!(b.occurrence > a.occurrence);
    assert_eq!(b.set_resource, a.set_resource);
    assert!(!s.accepts_completion(&a.execution, a.run, a.occurrence, a.epoch));
    assert!(b.cleanup.unwrap().retiring.is_empty());
    let c = s
        .apply(ShowEvent::Seek {
            at: at(2),
            to: Time::ZERO,
        })
        .unwrap();
    assert_eq!(c.occurrence, b.occurrence);
    assert!(c.epoch > b.epoch);
    assert!(c.timeline.unwrap().cues.is_empty());
    let restart = start(&mut s, 3);
    assert!(restart.run > a.run);
    assert!(restart.occurrence > b.occurrence);
    assert_eq!(restart.ownership.scopes, 4);
    assert_eq!(restart.ownership.resources, 1);
}
#[test]
fn segment_exit_clears_only_segment_overrides_stop_also_clears_set_and_run_leases() {
    let (mut s, _) = run();
    start(&mut s, 0);
    let (a, b, c) = (target(0), target(1), target(2));
    override_at(&mut s, ExecutionScope::Segment, a.clone(), 0.1, 0);
    override_at(&mut s, ExecutionScope::Run, b.clone(), 0.2, 0);
    override_at(&mut s, ExecutionScope::Set, c.clone(), 0.3, 0);
    let q = s.apply(ShowEvent::Next { at: at(1) }).unwrap();
    assert_eq!(q.overrides, 2);
    assert_eq!(
        s.resolve(&a, now(1), CompactValue::Number(0.7)),
        CompactValue::Number(0.7)
    );
    assert_eq!(
        s.resolve(&b, now(1), CompactValue::Number(0.7)),
        CompactValue::Number(0.2)
    );
    assert_eq!(
        s.resolve(&c, now(1), CompactValue::Number(0.7)),
        CompactValue::Number(0.3)
    );
    let stopped = s.apply(ShowEvent::Stop { at: at(1) }).unwrap();
    assert_eq!(stopped.overrides, 0);
    assert_eq!(stopped.ownership.scopes, 2);
    assert_eq!(stopped.ownership.resources, 1);
    assert!(!stopped.active);
    assert_eq!(
        s.resolve(&c, now(1), CompactValue::Number(0.8)),
        CompactValue::Number(0.8)
    );
}
#[test]
fn release_exposes_current_underlying_sample_and_stale_tokens_cannot_release_again() {
    let (mut s, _) = run();
    start(&mut s, 0);
    let t = target(0);
    let old = override_at(&mut s, ExecutionScope::Segment, t.clone(), 0.2, 0)
        .override_token
        .unwrap();
    let new = override_at(&mut s, ExecutionScope::Run, t.clone(), 0.6, 1)
        .override_token
        .unwrap();
    assert!(s
        .apply(ShowEvent::Release {
            at: at(2),
            owner: "host".into(),
            target: t.clone(),
            token: old
        })
        .is_err());
    assert_eq!(
        s.resolve(&t, now(2), CompactValue::Number(0.9)),
        CompactValue::Number(0.6)
    );
    s.apply(ShowEvent::Release {
        at: at(2),
        owner: "host".into(),
        target: t.clone(),
        token: new,
    })
    .unwrap();
    assert_eq!(
        s.resolve(&t, now(2), CompactValue::Number(0.9)),
        CompactValue::Number(0.9)
    );
}
#[test]
fn segment_visibility_pause_cannot_remove_an_operator_run_pause() {
    let (mut s, _) = run();
    start(&mut s, 0);
    pause(&mut s, ExecutionScope::Run, "operator", "manual", 1);
    pause(&mut s, ExecutionScope::Segment, "visibility", "hidden", 1);
    assert!(s
        .apply(ShowEvent::Resume {
            at: at(2),
            scope: ExecutionScope::Run,
            owner: "visibility".into(),
            reason: "manual".into()
        })
        .is_err());
    let q = s.apply(ShowEvent::Next { at: at(2) }).unwrap();
    assert!(q.paused);
    assert!(q.timeline.as_ref().unwrap().paused);
    assert_eq!(advance(&mut s, 4).timeline.unwrap().position, Time::ZERO);
    s.apply(ShowEvent::Resume {
        at: at(4),
        scope: ExecutionScope::Run,
        owner: "operator".into(),
        reason: "manual".into(),
    })
    .unwrap();
    assert_eq!(
        advance(&mut s, 5).timeline.unwrap().position,
        Time::seconds(1)
    );
    s.apply(ShowEvent::Seek {
        at: at(5),
        to: Time::ZERO,
    })
    .unwrap();
    assert!(advance(&mut s, 6).timeline.unwrap().cues.is_empty()); // effect frontier remains consumed
}
#[test]
fn static_segment_has_independent_controls_without_an_invented_timeline() {
    let (mut s, _) = run();
    start(&mut s, 0);
    let q = s
        .apply(ShowEvent::Enter {
            at: at(1),
            segment: "static".into(),
        })
        .unwrap();
    assert!(q.active);
    assert!(q.timeline.is_none());
    pause(&mut s, ExecutionScope::Segment, "operator", "manual", 1);
    assert!(advance(&mut s, 2).paused);
    assert!(s
        .apply(ShowEvent::Seek {
            at: at(2),
            to: Time::ZERO
        })
        .is_err());
    let mut out = vec![
        Some(producer_production_core::compile::Sample {
            target: 0,
            value: CompactValue::Bool(true),
        });
        s.scratch_len()
    ];
    s.evaluate_into(now(3), &mut out).unwrap();
    assert!(out.iter().all(Option::is_none));
}
#[test]
fn stopped_and_closed_executions_cannot_resurrect_or_dispose_the_wrong_resource() {
    let (mut s, _) = run();
    let a = start(&mut s, 0);
    s.halt(false);
    assert!(!s.accepts_completion(&a.execution, a.run, a.occurrence, a.epoch));
    assert_eq!(advance(&mut s, 1).ownership.scopes, 2);
    let closed = s.apply(ShowEvent::Close { at: at(2) }).unwrap();
    assert_eq!(closed.ownership.scopes, 0);
    assert_eq!(closed.ownership.retiring, 1);
    assert!(!s.closed_and_disposed());
    assert!(s.disposed(a.set_resource, Lane::Audio).is_err());
    s.disposed(a.set_resource, Lane::Video).unwrap();
    assert!(s.closed_and_disposed());
    assert!(s
        .apply(ShowEvent::Start {
            at: at(3),
            segment: None
        })
        .is_err());
}
#[test]
fn readonly_hosted_revoked_and_disconnected_authority_are_distinct() {
    let mut c = coordinator();
    let (reader, g) = c.session(false).unwrap();
    assert!(!g.is_current());
    assert!(c.author_grant(&reader).is_err());
    assert!(ShowRun::compile(&doc(), "pilot", g, now(0)).is_err());
    let (author, g) = c.session(true).unwrap();
    assert!(c.author_grant(&author).is_ok());
    let mut s = ShowRun::compile(&doc(), "pilot", g.clone(), now(0)).unwrap();
    let a = start(&mut s, 0);
    c.disconnect(&author);
    assert!(s.apply(ShowEvent::Next { at: at(1) }).is_err());
    assert!(advance(&mut s, 1).active); // clock may progress; disconnected UI cannot write
    g.revoke();
    assert!(!s.accepts_completion(&a.execution, a.run, a.occurrence, a.epoch));
    assert!(!advance(&mut s, 2).active);
    let mut d = doc();
    d.shows.get_mut("pilot").unwrap().authority = Authority::Hosted;
    let g = coordinator().session(true).unwrap().1;
    assert!(ShowRun::compile(&d, "pilot", g, now(0)).is_err());
}
#[test]
fn failed_events_are_atomic_and_do_not_advance_clock_or_consume_occurrences() {
    let (mut s, _) = run();
    let a = start(&mut s, 0);
    assert!(s
        .apply(ShowEvent::Enter {
            at: at(9),
            segment: "absent".into()
        })
        .is_err());
    assert!(s.apply(ShowEvent::Previous { at: at(9) }).is_err());
    let b = advance(&mut s, 1);
    assert_eq!(b.occurrence, a.occurrence);
    assert_eq!(b.epoch, a.epoch);
    assert_eq!(b.ownership, a.ownership);
    assert!(s.apply(ShowEvent::Advance { at: at(0) }).is_err());
    let c = advance(&mut s, 2);
    assert_eq!(c.run, a.run);
}
#[test]
fn native_disconnect_lease_uses_exact_expiry_and_cannot_renew_without_a_grant() {
    let mut c = coordinator();
    let (id, grant) = c.session(true).unwrap();
    let mut s = ShowRun::compile(&doc(), "pilot", grant.clone(), now(0)).unwrap();
    start(&mut s, 0);
    let t = doc().sequences["timeline"].instances[0].target_bindings[0]
        .to
        .clone();
    override_at(&mut s, ExecutionScope::Run, t, 0.9, 0);
    s.controller_disconnected("host", now(1)).unwrap();
    c.disconnect(&id);
    let mut out = vec![None; s.scratch_len()];
    s.evaluate_into(now(2), &mut out).unwrap();
    assert_eq!(out[0].unwrap().value, CompactValue::Number(0.9));
    assert!(s
        .apply(ShowEvent::Override {
            at: at(3),
            scope: ExecutionScope::Run,
            owner: "host".into(),
            target: target(0),
            value: Value::Number(0.8)
        })
        .is_err());
    s.controller_disconnected("host", now(4)).unwrap(); // repeat cannot extend original deadline
    s.evaluate_into(now(6), &mut out).unwrap();
    assert_eq!(out[0].unwrap().value, CompactValue::Number(0.0));
    grant.revoke();
    s.evaluate_into(now(7), &mut out).unwrap();
    assert!(out.iter().all(Option::is_none));
}
#[test]
fn finite_sequence_end_does_not_dispose_the_segment_or_restart_on_pause() {
    let (mut s, _) = run();
    start(&mut s, 0);
    let ended = advance(&mut s, 8);
    assert!(ended.active);
    assert!(!ended.timeline.unwrap().active);
    pause(&mut s, ExecutionScope::Segment, "operator", "manual", 9);
    let held = advance(&mut s, 10);
    assert!(held.paused);
    assert!(!held.timeline.as_ref().unwrap().active);
    assert!(held.timeline.unwrap().cues.is_empty());
    assert_eq!(held.ownership.resources, 1);
}
#[test]
fn repeated_segment_entries_do_not_accumulate_scopes_resources_or_effect_history() {
    let (mut s, _) = run();
    start(&mut s, 0);
    for n in 1..1000 {
        let q = s
            .apply(ShowEvent::Enter {
                at: at(n),
                segment: "opening".into(),
            })
            .unwrap();
        assert_eq!(q.ownership.scopes, 4);
        assert_eq!(q.ownership.resources, 1);
        assert_eq!(q.ownership.relations, 2);
        assert_eq!(q.occurrence, Counter(n + 1));
        assert_eq!(q.timeline.unwrap().cues.len(), 1);
    }
}

#[test]
fn static_and_inactive_properties_are_driven_without_a_timeline_track() {
    let (mut s, _) = run();
    s.apply(ShowEvent::Start {
        at: at(0),
        segment: Some("static".into()),
    })
    .unwrap();
    let t = target(0);
    let index = producer_production_core::compile::compile(&doc())
        .unwrap()
        .targets
        .iter()
        .position(|v| v == &t)
        .unwrap();
    let token = override_at(&mut s, ExecutionScope::Segment, t.clone(), 0.8, 0)
        .override_token
        .unwrap();
    let mut out = vec![None; s.scratch_len()];
    s.evaluate_into(now(0), &mut out).unwrap();
    assert_eq!(
        out.iter()
            .flatten()
            .map(|v| (v.target, v.value))
            .collect::<Vec<_>>(),
        vec![(index, CompactValue::Number(0.8))]
    );
    s.apply(ShowEvent::Release {
        at: at(1),
        owner: "host".into(),
        target: t,
        token,
    })
    .unwrap();
    s.evaluate_into(now(1), &mut out).unwrap();
    assert!(out.iter().all(Option::is_none));
    override_at(&mut s, ExecutionScope::Run, target(1), 0.3, 1);
    // Ended sequence still permits explicit controls, without reviving tracks.
    s.apply(ShowEvent::Enter {
        at: at(1),
        segment: "question".into(),
    })
    .unwrap();
    advance(&mut s, 10);
    s.evaluate_into(now(10), &mut out).unwrap();
    assert_eq!(out.iter().flatten().count(), 1);
    assert_eq!(
        out.iter().flatten().next().unwrap().value,
        CompactValue::Number(0.3)
    );
}
