use producer_production_core::{
    contract::*, coordinator::*, lifecycle::*, storage::*, workspace::*,
};
use std::{
    thread,
    time::{Duration, Instant},
};
fn grant() -> RevokeFence {
    Coordinator::new(
        Snapshot::new(fixture::classic_like()).unwrap(),
        MemoryStore::default(),
    )
    .session(true)
    .unwrap()
    .1
}

#[test]
fn never_started_show_can_be_inspected_and_disposed_after_close() {
    use producer_production_core::{ownership::Lane, transport::OutputInstant};
    let mut w = Workspace::new().unwrap();
    let d = fixture::classic_like();
    w.open(&d.id).unwrap();
    let t = prepare(&mut w, d.clone(), 0);
    w.load_show(&d.id, t, "pilot", 1, OutputInstant(Counter(0)), grant())
        .unwrap();
    w.close(&d.id).unwrap();
    let status = w.show_status(&d.id).unwrap();
    assert!(status.closed && !status.active);
    assert_eq!(status.ownership.retiring, 1);
    w.show_disposed(&d.id, status.set_resource, Lane::Video)
        .unwrap();
    w.finish_close(&d.id).unwrap();
    assert_eq!(w.status().used, Cost::default());
}

#[test]
fn show_plan_stays_charged_until_logical_close_and_exact_disposal_ack() {
    use producer_production_core::{ownership::Lane, show::ShowEvent, transport::OutputInstant};
    let mut w = Workspace::new().unwrap();
    let d = fixture::classic_like();
    w.open(&d.id).unwrap();
    let t = prepare(&mut w, d.clone(), 0);
    let before = w.status().used.cpu;
    w.load_show(&d.id, t, "pilot", 1, OutputInstant(Counter(0)), grant())
        .unwrap();
    assert_eq!(w.status().used.cpu, before + (64 << 20));
    let start = w
        .show_event(
            &d.id,
            ShowEvent::Start {
                at: Counter(0),
                segment: None,
            },
        )
        .unwrap();
    assert!(start.active);
    w.stop(&d.id).unwrap();
    assert!(
        !w.show_event(&d.id, ShowEvent::Advance { at: Counter(1) })
            .unwrap()
            .active
    );
    w.close(&d.id).unwrap();
    assert!(w.finish_close(&d.id).is_err());
    assert_eq!(w.status().used.cpu, 64 << 20);
    assert!(w
        .show_disposed(&d.id, start.set_resource, Lane::Audio)
        .is_err());
    w.show_disposed(&d.id, start.set_resource, Lane::Video)
        .unwrap();
    w.finish_close(&d.id).unwrap();
    assert_eq!(w.status().reservations, 0);
    assert_eq!(w.status().documents, 0);
}

#[test]
fn shows_in_two_documents_never_share_component_or_disposal_identity() {
    use producer_production_core::{ownership::Lane, show::ShowEvent, transport::OutputInstant};
    let mut w = Workspace::new().unwrap();
    let a = fixture::classic_like();
    let mut b = a.clone();
    b.id = "other-show".into();
    w.open(&a.id).unwrap();
    w.open(&b.id).unwrap();
    let ta = prepare(&mut w, a.clone(), 0);
    let tb = prepare(&mut w, b.clone(), 0);
    w.load_show(&a.id, ta, "pilot", 1, OutputInstant(Counter(0)), grant())
        .unwrap();
    w.load_show(&b.id, tb, "pilot", 1, OutputInstant(Counter(0)), grant())
        .unwrap();
    let sa = w
        .show_event(
            &a.id,
            ShowEvent::Start {
                at: Counter(0),
                segment: None,
            },
        )
        .unwrap();
    let sb = w
        .show_event(
            &b.id,
            ShowEvent::Start {
                at: Counter(0),
                segment: None,
            },
        )
        .unwrap();
    assert_ne!(sa.execution, sb.execution);
    assert_ne!(sa.set_resource, sb.set_resource);
    w.close(&a.id).unwrap();
    w.close(&b.id).unwrap();
    assert!(w
        .show_disposed(&b.id, sa.set_resource, Lane::Video)
        .is_err());
    w.show_disposed(&a.id, sa.set_resource, Lane::Video)
        .unwrap();
    w.show_disposed(&b.id, sb.set_resource, Lane::Video)
        .unwrap();
    w.finish_close(&a.id).unwrap();
    w.finish_close(&b.id).unwrap();
    assert_eq!(w.status().reservations, 0);
}

#[test]
fn old_or_expired_preparations_cannot_open_a_show_or_leak_reservations() {
    use producer_production_core::transport::OutputInstant;
    let mut w = Workspace::new().unwrap();
    let mut d = fixture::classic_like();
    w.open(&d.id).unwrap();
    let old = prepare(&mut w, d.clone(), 0);
    let used = w.status().reservations;
    assert!(w
        .load_show(
            &d.id,
            old,
            "pilot",
            30_001,
            OutputInstant(Counter(0)),
            grant()
        )
        .is_err());
    assert_eq!(w.status().reservations, used);
    d.title = "next revision".into();
    prepare(&mut w, d.clone(), 1);
    let used = w.status().reservations;
    assert!(w
        .load_show(&d.id, old, "pilot", 1, OutputInstant(Counter(0)), grant())
        .is_err());
    assert_eq!(w.status().reservations, used);
}
fn wait(w: &mut Workspace, now: u64) -> Vec<CompileOutcome> {
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut out = vec![];
    loop {
        w.dispatch().unwrap();
        out.extend(w.poll(now));
        let s = w.status();
        if s.pending + s.running == 0 {
            return out;
        }
        assert!(Instant::now() < deadline, "compile workers did not drain");
        thread::sleep(Duration::from_millis(1));
    }
}
fn prepare(w: &mut Workspace, d: Document, revision: u64) -> Counter {
    w.submit(d, Counter(revision), 0, grant()).unwrap();
    let out = wait(w, 1);
    assert_eq!(out.len(), 1);
    match &out[0] {
        CompileOutcome::Prepared { token, .. } => *token,
        other => panic!("{other:?}"),
    }
}
fn ready(w: &mut Workspace, id: &str, t: Counter, d: &Document) {
    for s in d.sources.keys() {
        let f = w.fence(id, t, s, Counter(1), Counter(1)).unwrap();
        w.ready(id, t, s, f, Counter(1), Counter(1)).unwrap();
    }
}
fn take(w: &mut Workspace, id: &str, t: Counter, swap: Swap) -> Result<()> {
    w.take(
        id,
        t,
        1,
        &grant(),
        Counter(1),
        Counter(1),
        &[Output::Landscape],
        swap,
    )
}
#[test]
fn two_documents_share_global_ledger_but_never_tokens_or_presentation() {
    let mut w = Workspace::new().unwrap();
    let a = fixture::classic_like();
    let mut b = a.clone();
    b.id = "second".into();
    w.open(&a.id).unwrap();
    w.open(&b.id).unwrap();
    assert!(w.open("third").is_err());
    let t1 = prepare(&mut w, a.clone(), 0);
    let first = w.status().used;
    let t2 = prepare(&mut w, b.clone(), 0);
    assert_ne!(t1, t2);
    let all = w.status().used;
    let delta = serde_json::to_vec(&a).unwrap().len() - serde_json::to_vec(&b).unwrap().len();
    assert_eq!(all.cpu, first.cpu * 2 - 2 * delta as u64);
    assert_eq!(all.gpu, first.gpu * 2);
    assert!(w.fence(&b.id, t1, "host", Counter(1), Counter(1)).is_err());
    ready(&mut w, &a.id, t1, &a);
    take(&mut w, &a.id, t1, Swap::Confirmed).unwrap();
    assert!(w.presentation(&b.id, Output::Landscape).unwrap().is_none());
}
#[test]
fn latest_pending_intent_coalesces_without_retaining_every_document() {
    let mut w = Workspace::new().unwrap();
    let mut d = fixture::classic_like();
    w.open(&d.id).unwrap();
    for n in 0..1000 {
        d.title = format!("edit-{n}");
        w.submit(d.clone(), Counter(n), 0, grant()).unwrap();
        assert_eq!(w.status().pending, 1);
        assert_eq!(w.status().reservations, 1);
    }
    assert_eq!(w.dispatch().unwrap(), 1);
    let out = wait(&mut w, 1);
    assert!(matches!(
        &out[0],
        CompileOutcome::Prepared {
            revision: Counter(999),
            ..
        }
    ));
    assert!(w.submit(d.clone(), Counter(0), 0, grant()).is_err());
    d.title = "changed at same revision".into();
    assert!(w.submit(d, Counter(999), 0, grant()).is_err());
}
#[test]
fn stop_and_supersession_fence_already_completed_but_unpolled_workers() {
    let mut w = Workspace::new().unwrap();
    let mut d = fixture::classic_like();
    w.open(&d.id).unwrap();
    w.submit(d.clone(), Counter(0), 0, grant()).unwrap();
    w.dispatch().unwrap();
    w.stop(&d.id).unwrap();
    assert_eq!(w.status().running, 1);
    assert!(w.status().reservations > 0);
    assert!(matches!(
        &wait(&mut w, 1)[0],
        CompileOutcome::Discarded { .. }
    ));
    assert_eq!(w.status().used, Cost::default());
    w.submit(d.clone(), Counter(1), 0, grant()).unwrap();
    w.dispatch().unwrap();
    d.title = "newest".into();
    w.submit(d.clone(), Counter(2), 0, grant()).unwrap();
    let out = wait(&mut w, 1);
    assert_eq!(out.len(), 2);
    assert_eq!(
        out.iter()
            .filter(|o| matches!(o, CompileOutcome::Discarded { .. }))
            .count(),
        1
    );
    assert!(out.iter().any(|o| matches!(
        o,
        CompileOutcome::Prepared {
            revision: Counter(2),
            ..
        }
    )));
}
#[test]
fn two_worker_slots_remain_occupied_until_results_are_consumed() {
    let mut w = Workspace::new().unwrap();
    for id in ["one", "two"] {
        w.open(id).unwrap();
        w.submit(Document::empty(id, id), Counter(0), 0, grant())
            .unwrap();
    }
    assert_eq!(w.dispatch().unwrap(), 2);
    assert_eq!(w.status().running, 2);
    assert_eq!(w.dispatch().unwrap(), 0);
    assert_eq!(wait(&mut w, 1).len(), 2);
}
#[test]
fn revocation_expiry_and_invalid_submissions_leave_previous_cache_usable() {
    let mut w = Workspace::new().unwrap();
    let mut d = fixture::classic_like();
    w.open(&d.id).unwrap();
    let a = prepare(&mut w, d.clone(), 0);
    w.cancel(&d.id, a).unwrap();
    let cache = w.status().used;
    let g = grant();
    w.submit(d.clone(), Counter(1), 0, g.clone()).unwrap();
    g.revoke();
    assert!(
        matches!(&wait(&mut w,1)[0],CompileOutcome::Rejected {error,..} if error.code=="FORBIDDEN")
    );
    assert_eq!(w.status().used, cache);
    w.submit(d.clone(), Counter(2), 0, grant()).unwrap();
    assert!(
        matches!(&wait(&mut w,30_001)[0],CompileOutcome::Rejected {error,..} if error.code=="PREPARE_EXPIRED")
    );
    assert_eq!(w.status().used, cache);
    let mut invalid = d.clone();
    invalid.components.get_mut("badge").unwrap().version += 1;
    assert!(w.submit(invalid, Counter(3), 0, grant()).is_err());
    d.title = "still good".into();
    w.submit(d.clone(), Counter(3), 0, grant()).unwrap();
    assert!(
        matches!(&wait(&mut w,1)[0],CompileOutcome::Prepared {stats,..} if stats.layouts_built==0 && stats.sequences_built==0)
    );
}
#[test]
fn uncertain_retiring_and_cache_allocations_are_charged_until_exact_cleanup() {
    let mut w = Workspace::new().unwrap();
    let d = fixture::classic_like();
    let id = &d.id;
    w.open(id).unwrap();
    let a = prepare(&mut w, d.clone(), 0);
    ready(&mut w, id, a, &d);
    take(&mut w, id, a, Swap::Confirmed).unwrap();
    let active = w.status().used;
    let b = prepare(&mut w, d.clone(), 1);
    ready(&mut w, id, b, &d);
    assert_eq!(
        take(&mut w, id, b, Swap::ResponseLost).unwrap_err().code,
        "TAKE_OUTCOME_UNKNOWN"
    );
    let uncertain = w.status().used;
    assert!(uncertain.cpu > active.cpu);
    assert!(w.cancel(id, b).is_err());
    w.close(id).unwrap();
    assert!(w.finish_close(id).is_err());
    assert!(w.open(id).is_err());
    assert!(w.status().used.gpu > 0);
    w.disposal_complete(id, a).unwrap();
    assert!(w.finish_close(id).is_err());
    w.reconcile(id, b, true).unwrap();
    assert!(w.presentation(id, Output::Landscape).unwrap().is_none());
    w.disposal_complete(id, b).unwrap();
    w.finish_close(id).unwrap();
    assert_eq!(w.status().used, Cost::default());
    w.open(id).unwrap();
    assert!(w.fence(id, a, "host", Counter(1), Counter(1)).is_err());
}
#[test]
fn closing_workers_hold_document_slot_and_resource_charge() {
    let mut w = Workspace::new().unwrap();
    w.open("one").unwrap();
    w.open("two").unwrap();
    w.submit(Document::empty("one", "One"), Counter(0), 0, grant())
        .unwrap();
    w.dispatch().unwrap();
    w.close("one").unwrap();
    assert!(w.finish_close("one").is_err());
    assert!(w.open("three").is_err());
    wait(&mut w, 1);
    w.finish_close("one").unwrap();
    w.open("three").unwrap();
}
#[test]
fn unopened_descriptors_are_bounded_and_paged() {
    let mut w = Workspace::new().unwrap();
    for n in 0..100 {
        let id = format!("doc-{n}");
        w.open(&id).unwrap();
        w.close(&id).unwrap();
        w.finish_close(&id).unwrap();
    }
    assert_eq!(w.status().descriptors, 16);
    assert_eq!(w.descriptors(0, usize::MAX).len(), 16);
    assert_eq!(w.descriptors(0, 1), vec!["doc-84"]);
    assert!(w.descriptors(16, 1).is_empty());
    assert_eq!(w.status().used, Cost::default());
}
#[test]
fn resource_overflow_is_rejected_without_partial_reservation() {
    let mut ledger = Ledger::default();
    assert!(ledger
        .reserve(Cost {
            players: u32::MAX,
            ..Cost::default()
        })
        .is_err());
    assert!(ledger
        .reserve(Cost {
            cpu: u64::MAX,
            ..Cost::default()
        })
        .is_err());
    assert_eq!(ledger.used(), Cost::default());
}

#[test]
fn four_preparations_backpressure_does_not_block_stop_or_forge_frame_readiness() {
    let mut w = Workspace::new().unwrap();
    let mut d = Document::empty("small", "Small");
    d.sources.insert(
        "host".into(),
        Source::Live {
            role: Role::HostCamera,
        },
    );
    let id = &d.id;
    w.open(id).unwrap();
    let mut tokens = vec![];
    for revision in 0..4 {
        tokens.push(prepare(&mut w, d.clone(), revision));
    }
    assert_eq!(
        w.submit(d.clone(), Counter(4), 0, grant())
            .unwrap_err()
            .code,
        "PREPARE_LIMIT"
    );
    let old = w
        .fence(id, tokens[0], "host", Counter(1), Counter(1))
        .unwrap();
    assert!(w
        .ready(id, tokens[3], "host", old, Counter(1), Counter(1))
        .is_err());
    w.stop(id).unwrap();
    assert_eq!(w.status().reservations, 5); // four superseded plans plus immutable cache
    for token in tokens {
        w.cancel(id, token).unwrap();
    }
    w.close(id).unwrap();
    w.finish_close(id).unwrap();
    assert_eq!(w.status().used, Cost::default());
}

#[test]
fn expired_pending_work_is_not_dispatched_or_retained() {
    let mut w = Workspace::new().unwrap();
    w.open("one").unwrap();
    w.submit(Document::empty("one", "One"), Counter(0), 0, grant())
        .unwrap();
    w.expire(30_001);
    assert_eq!(w.status().pending, 0);
    assert_eq!(w.status().used, Cost::default());
    assert_eq!(w.dispatch().unwrap(), 0);
}

#[test]
fn closing_a_warm_document_does_not_uncharge_the_workers_base_cache() {
    let mut w = Workspace::new().unwrap();
    let d = fixture::classic_like();
    let id = &d.id;
    w.open(id).unwrap();
    let token = prepare(&mut w, d.clone(), 0);
    w.cancel(id, token).unwrap();
    let cache = w.status().used;
    w.submit(d.clone(), Counter(1), 0, grant()).unwrap();
    w.dispatch().unwrap();
    w.close(id).unwrap();
    assert_eq!(w.status().reservations, 2); // worker input plus its base-cache lease
    assert!(w.status().used.cpu > cache.cpu);
    wait(&mut w, 1);
    w.finish_close(id).unwrap();
    assert_eq!(w.status().used, Cost::default());
}
