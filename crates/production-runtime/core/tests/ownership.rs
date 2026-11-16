use producer_production_core::ownership::*;

#[test]
fn borrowed_set_survives_run_and_segment_exit_without_owner_transfer() {
    let mut o = Ownership::new();
    let set = o.enter(o.root(), ScopeKind::Component).unwrap();
    let run = o.enter(o.root(), ScopeKind::Run).unwrap();
    let segment = o.enter(run, ScopeKind::Segment).unwrap();
    let video = o.own(set, Lane::Video).unwrap();
    o.relate(run, video, Relation::Borrow).unwrap();
    o.relate(segment, video, Relation::Presentation).unwrap();
    assert!(o.leave(&[segment]).unwrap().retiring.is_empty());
    assert_eq!(o.status().relations, 1);
    assert!(o.leave(&[run]).unwrap().retiring.is_empty());
    assert!(o.active(set));
    assert_eq!(o.status().resources, 1);
    assert!(o.disposed(video, Lane::Video).is_err());
    assert_eq!(o.leave(&[set]).unwrap().retiring, vec![video]);
    o.disposed(video, Lane::Video).unwrap();
}

#[test]
fn owner_removal_rejects_surviving_users_atomically_but_joint_removal_works() {
    let mut o = Ownership::new();
    let set = o.enter(o.root(), ScopeKind::Component).unwrap();
    let run = o.enter(o.root(), ScopeKind::Run).unwrap();
    let video = o.own(set, Lane::Video).unwrap();
    o.relate(run, video, Relation::Audio).unwrap();
    let read = o.read(run, video).unwrap();
    let before = o.status();
    assert_eq!(o.leave(&[set]).unwrap_err().code, "OWNER_BORROWED");
    assert_eq!(o.status(), before);
    assert_eq!(o.leave(&[set, run]).unwrap().retiring, vec![video]);
    assert_eq!(o.status().scopes, 1);
    assert_eq!(o.status().reads, 1);
    assert_eq!(o.read(run, video).unwrap_err().code, "SCOPE_CLOSED");
    assert!(o.disposed(video, Lane::Video).is_err());
    o.finish_read(read).unwrap();
    assert!(o.disposed(video, Lane::Audio).is_err());
    o.disposed(video, Lane::Video).unwrap();
    assert!(o.finish_read(read).is_err());
    assert!(o.disposed(video, Lane::Video).is_err());
}

#[test]
fn control_and_contributions_are_separate_from_lifetime_and_reads() {
    let mut o = Ownership::new();
    let a = o.enter(o.root(), ScopeKind::Component).unwrap();
    let b = o.enter(o.root(), ScopeKind::Run).unwrap();
    let c = o.enter(b, ScopeKind::Segment).unwrap();
    let resource = o.own(a, Lane::Renderer).unwrap();
    let independent = o.own(a, Lane::Renderer).unwrap();
    assert_ne!(resource, independent); // No identity coalescing by equal payload.
    assert_eq!(o.read(b, resource).unwrap_err().code, "BORROW_REQUIRED");
    o.relate(b, resource, Relation::Control).unwrap();
    o.relate(c, resource, Relation::Audio).unwrap();
    o.relate(c, resource, Relation::Presentation).unwrap();
    assert_eq!(
        o.relate(c, resource, Relation::Control).unwrap_err().code,
        "CONTROL_CONFLICT"
    );
    o.unrelate(c, resource, Relation::Presentation).unwrap();
    assert_eq!(o.status().relations, 2); // Hiding doesn't mute or stop control.
    o.unrelate(b, resource, Relation::Control).unwrap();
    o.relate(c, resource, Relation::Control).unwrap();
    assert_eq!(o.status().resources, 2);
}

#[test]
fn handles_from_another_document_execution_cannot_alias_after_reopen() {
    let mut a = Ownership::new();
    let mut b = Ownership::new();
    let x = a.own(a.root(), Lane::Video).unwrap();
    let y = b.own(b.root(), Lane::Video).unwrap();
    assert_ne!(a.root(), b.root());
    assert_ne!(x, y);
    assert!(b.enter(a.root(), ScopeKind::Run).is_err());
    assert!(b.relate(b.root(), x, Relation::Borrow).is_err());
    assert!(b.disposed(x, Lane::Video).is_err());
    a.leave(&[a.root()]).unwrap();
    assert!(a.own(a.root(), Lane::Video).is_err());
    assert!(a.enter(a.root(), ScopeKind::Run).is_err());
}

#[test]
fn closed_reader_can_finish_its_read_but_cannot_admit_more_work() {
    let mut o = Ownership::new();
    let r = o.own(o.root(), Lane::Audio).unwrap();
    let run = o.enter(o.root(), ScopeKind::Run).unwrap();
    o.relate(run, r, Relation::Borrow).unwrap();
    let read = o.read(run, r).unwrap();
    o.leave(&[run]).unwrap();
    o.leave(&[o.root()]).unwrap();
    assert!(o.read(run, r).is_err());
    assert!(o.disposed(r, Lane::Audio).is_err());
    o.finish_read(read).unwrap();
    o.disposed(r, Lane::Audio).unwrap();
    assert_eq!(
        o.status().resources + o.status().reads + o.status().scopes,
        0
    );
}

#[test]
fn all_owner_graph_collections_are_bounded_including_retirement() {
    let mut o = Ownership::new();
    let scopes: Vec<_> = (1..SCOPES)
        .map(|_| o.enter(o.root(), ScopeKind::Component).unwrap())
        .collect();
    assert_eq!(
        o.enter(o.root(), ScopeKind::Run).unwrap_err().code,
        "SCOPE_LIMIT"
    );
    let resources: Vec<_> = (0..RESOURCES)
        .map(|_| o.own(scopes[0], Lane::Control).unwrap())
        .collect();
    assert_eq!(
        o.own(scopes[0], Lane::Control).unwrap_err().code,
        "RESOURCE_LIMIT"
    );
    for s in &scopes[1..=4] {
        for r in &resources {
            o.relate(*s, *r, Relation::Borrow).unwrap();
        }
    }
    assert_eq!(o.status().relations, RELATIONS);
    o.relate(scopes[1], resources[0], Relation::Borrow).unwrap(); // idempotent at capacity
    assert_eq!(
        o.relate(scopes[5], resources[0], Relation::Borrow)
            .unwrap_err()
            .code,
        "RELATION_LIMIT"
    );
    let reads: Vec<_> = (0..READS)
        .map(|_| o.read(scopes[1], resources[0]).unwrap())
        .collect();
    assert_eq!(
        o.read(scopes[1], resources[0]).unwrap_err().code,
        "READ_LIMIT"
    );
    o.leave(&scopes[..=4]).unwrap();
    assert_eq!(
        o.own(o.root(), Lane::Control).unwrap_err().code,
        "RESOURCE_LIMIT"
    );
    for read in reads {
        o.finish_read(read).unwrap();
    }
    for resource in resources {
        o.disposed(resource, Lane::Control).unwrap();
    }
    assert_eq!(o.status().resources, 0);
}
