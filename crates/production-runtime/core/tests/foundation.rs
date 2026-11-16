use producer_production_core::{
    commands::{Command, Operation},
    compile::*,
    contract::*,
    coordinator::*,
    storage::*,
    transport::*,
};
use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};
fn edit(title: &str) -> Command {
    Command::Transaction {
        operations: vec![Operation::SetTitle {
            title: title.into(),
        }],
    }
}
fn memory() -> (Coordinator<MemoryStore>, String) {
    let s = Snapshot::new(fixture::classic_like()).unwrap();
    let mut c = Coordinator::new(s, MemoryStore::default());
    let (session, _) = c.session(true).unwrap();
    (c, session)
}
fn temp() -> PathBuf {
    std::env::temp_dir().join(format!("producer-core-test-{}", uuid::Uuid::new_v4()))
}
fn submit(c: &mut Coordinator<MemoryStore>, s: &str, cmd: &Command) -> Receipt {
    let t = c.issue(s, c.state.revision, cmd, 0).unwrap();
    c.submit(s, &t, cmd, 1).unwrap()
}

#[test]
fn lost_response_retries_have_one_durable_effect() {
    let (mut c, s) = memory();
    let cmd = edit("New title");
    let ticket = c.issue(&s, Counter(0), &cmd, 0).unwrap();
    let a = c.submit(&s, &ticket, &cmd, 1).unwrap();
    let b = c.submit(&s, &ticket, &cmd, 2).unwrap();
    assert_eq!(a, b);
    assert_eq!(c.storage.records.len(), 1);
    assert_eq!(c.state.revision, Counter(1));
    assert!(c.submit(&s, &ticket, &edit("Other"), 3).is_err());
    let recovered = MemoryStore::recover(fixture::classic_like(), &c.storage.records).unwrap();
    let mut other = Coordinator::new(recovered, MemoryStore::default());
    let (s2, _) = other.session(true).unwrap();
    assert_eq!(other.submit(&s2, &ticket, &cmd, 4).unwrap(), a);
    assert!(other.submit(&s2, "never-issued", &cmd, 4).is_err());
}
#[test]
fn stale_revision_rejection_is_terminal_and_does_not_partially_apply() {
    let (mut c, s) = memory();
    let ticket = c.issue(&s, Counter(0), &edit("stale"), 0).unwrap();
    submit(&mut c, &s, &edit("current"));
    let r = c.submit(&s, &ticket, &edit("stale"), 1).unwrap();
    assert!(matches!(r.outcome, Outcome::Rejected(_)));
    assert_eq!(c.state.document.title, "current");
    assert_eq!(c.state.revision, Counter(1));
    assert_eq!(c.submit(&s, &ticket, &edit("stale"), 2).unwrap(), r);
    let cmd = Command::Transaction {
        operations: vec![
            Operation::SetTitle {
                title: "partial".into(),
            },
            Operation::RemoveSource { id: "host".into() },
        ],
    };
    assert!(matches!(
        submit(&mut c, &s, &cmd).outcome,
        Outcome::Rejected(_)
    ));
    assert_eq!(c.state.document.title, "current");
}
#[test]
fn revoke_fences_queued_work_but_not_already_ordered_commit() {
    let (mut c, s) = memory();
    let cmd = edit("denied");
    let ticket = c.issue(&s, Counter(0), &cmd, 0).unwrap();
    c.disconnect(&s);
    assert!(c.submit(&s, &ticket, &cmd, 1).is_err());
    let (s, _) = c.session(true).unwrap();
    let ticket = c.issue(&s, Counter(0), &cmd, 0).unwrap();
    let status = c.submit(&s, &ticket, &cmd, 120_001).unwrap_err();
    assert_eq!(status.code, "OUTCOME_EXPIRED_OR_UNKNOWN");
    // A store hook revokes through the reserved atomic fence during durable IO.
    struct RevokingStore {
        fence: Arc<Mutex<Option<RevokeFence>>>,
        inner: MemoryStore,
    }
    impl Storage for RevokingStore {
        fn append(&mut self, r: &Record) -> std::result::Result<(), AppendError> {
            self.fence.lock().unwrap().as_ref().unwrap().revoke();
            self.inner.append(r)
        }
        fn checkpoint(&mut self, _: &Snapshot) -> Result<()> {
            Ok(())
        }
    }
    let hook = Arc::new(Mutex::new(None));
    let state = Snapshot::new(fixture::classic_like()).unwrap();
    let mut c = Coordinator::new(
        state,
        RevokingStore {
            fence: hook.clone(),
            inner: MemoryStore::default(),
        },
    );
    let (s, fence) = c.session(true).unwrap();
    *hook.lock().unwrap() = Some(fence);
    let ticket = c.issue(&s, Counter(0), &cmd, 0).unwrap();
    let receipt = c.submit(&s, &ticket, &cmd, 1).unwrap();
    assert_eq!(receipt.outcome, Outcome::Saved);
    assert!(c.issue(&s, Counter(1), &cmd, 2).is_err());
    let recovered =
        MemoryStore::recover(fixture::classic_like(), &c.storage.inner.records).unwrap();
    assert_eq!(recovered.revision, receipt.revision);
}
#[test]
fn unknown_flush_fails_closed_then_recovers_the_exact_commit() {
    let (mut c, s) = memory();
    c.storage.failure = Some(Failure::AfterWrite);
    let cmd = edit("durable, response lost");
    let t = c.issue(&s, Counter(0), &cmd, 0).unwrap();
    assert_eq!(
        c.submit(&s, &t, &cmd, 1).unwrap_err().code,
        "SAVE_OUTCOME_UNKNOWN"
    );
    assert!(c.read_only);
    assert_eq!(c.state.revision, Counter(0));
    assert!(c.issue(&s, Counter(0), &edit("later"), 2).is_err());
    let recovered = MemoryStore::recover(fixture::classic_like(), &c.storage.records).unwrap();
    assert_eq!(recovered.revision, Counter(1));
    assert_eq!(recovered.receipts.back().unwrap().ticket, t);
}
#[test]
fn disk_full_retains_previous_state_and_undo_is_a_fresh_revision() {
    let (mut c, s) = memory();
    c.storage.failure = Some(Failure::BeforeWrite);
    let r = submit(&mut c, &s, &edit("not saved"));
    assert!(matches!(r.outcome, Outcome::Rejected(_)));
    assert_eq!(c.state.revision, Counter(0));
    let initial = c.state.document.clone();
    submit(&mut c, &s, &edit("saved"));
    let undo = c.undo_command(&s).unwrap();
    submit(&mut c, &s, &undo);
    assert_eq!(c.state.revision, Counter(2));
    assert_eq!(c.state.document, initial);
}
#[test]
fn one_writer_crash_tail_checkpoint_and_corrupt_middle() {
    let dir = temp();
    let initial = fixture::classic_like();
    let (store, state) = FileStore::open(&dir, initial.clone()).unwrap();
    assert!(FileStore::open(&dir, initial.clone()).is_err());
    let mut c = Coordinator::new(state, store);
    let (s, _) = c.session(true).unwrap();
    let cmd = edit("durable title");
    let t = c.issue(&s, Counter(0), &cmd, 0).unwrap();
    let r = c.submit(&s, &t, &cmd, 1).unwrap();
    drop(c);
    use std::io::Write;
    let mut f = fs::OpenOptions::new()
        .append(true)
        .open(dir.join("journal.jsonl"))
        .unwrap();
    f.write_all(b"{\"torn").unwrap();
    drop(f);
    let (store, state) = FileStore::open(&dir, initial.clone()).unwrap();
    assert_eq!(state.revision, Counter(1));
    assert_eq!(state.receipts.back().unwrap(), &r);
    assert_eq!(store.diagnostics.len(), 1);
    assert!(dir.join("recovered-tail.bin").exists());
    let mut c = Coordinator::new(state, store);
    let (s, _) = c.session(true).unwrap();
    c.checkpoint(&s).unwrap();
    drop(c);
    let (store, state) = FileStore::open(&dir, initial.clone()).unwrap();
    assert_eq!(state.document.title, "durable title");
    drop(store);
    fs::write(dir.join("journal.jsonl"), b"{\"bad\":true}\n").unwrap();
    assert!(FileStore::open(&dir, initial).is_err());
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn existing_product_folder_is_never_adopted() {
    let dir = temp();
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("user-content.txt"), "keep").unwrap();
    assert!(FileStore::open(&dir, fixture::classic_like()).is_err());
    assert_eq!(
        fs::read_to_string(dir.join("user-content.txt")).unwrap(),
        "keep"
    );
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn compiled_numeric_tracks_seek_without_history_or_scene_side_effects() {
    let d = fixture::classic_like();
    let p = compile(&d).unwrap();
    let q = &p.sequences["opener"];
    let mut out = vec![None; q.tracks.len()];
    q.evaluate_into(Time::seconds(6), &mut out).unwrap();
    q.evaluate_into(Time::seconds(2), &mut out).unwrap();
    let after_seek = out.clone();
    let mut direct = vec![None; q.tracks.len()];
    q.evaluate_into(Time::seconds(2), &mut direct).unwrap();
    assert_eq!(after_seek, direct);
    assert_eq!(direct[0].unwrap().value, CompactValue::Number(0.25));
    q.evaluate_into(Time::seconds(8), &mut out).unwrap();
    assert!(out.iter().all(Option::is_none));
    assert!(q.evaluate_into(Time::ZERO, &mut []).is_err());
    assert_eq!(p.nodes.len(), p.inventory.expanded_nodes);
}
#[test]
fn recording_clock_cannot_follow_content_backwards_or_pause() {
    let at = |s: u64| OutputInstant(Counter(s * 1_000_000_000));
    let mut clock = OutputClock {
        epoch: Counter(1),
        last: at(0),
    };
    let mut t = Transport::new(Time::seconds(100), at(0)).unwrap();
    t.play(at(0)).unwrap();
    clock.advance(at(12)).unwrap();
    assert_eq!(t.position(at(12)).unwrap(), Time::seconds(12));
    t.seek(Time::seconds(3), at(12)).unwrap();
    assert_eq!(clock.last, at(12));
    clock.new_epoch(at(13)).unwrap();
    assert!(clock.advance(at(2)).is_err());
    t.pause("operator", at(13)).unwrap();
    t.pause("hidden", at(14)).unwrap();
    t.resume("hidden", at(15)).unwrap();
    assert_eq!(t.position(at(20)).unwrap(), Time::seconds(4));
    t.resume("operator", at(20)).unwrap();
    assert_eq!(t.position(at(21)).unwrap(), Time::seconds(5));
}
#[test]
fn cue_cursor_dedupes_crossing_and_silent_seek() {
    let cue = Cue {
        id: "sound".into(),
        at: Time::seconds(2),
        at_start: false,
        each_loop: true,
    };
    let mut c = CueCursor::new(Counter(1), Time::seconds(4), vec![cue]);
    assert_eq!(c.advance(Time::seconds(3)).unwrap().len(), 1);
    assert!(c.advance(Time::seconds(3)).unwrap().is_empty());
    c.seek_silent(Time::seconds(1)).unwrap();
    assert!(c.advance(Time::seconds(1)).unwrap().is_empty());
    assert_eq!(c.advance(Time::seconds(3)).unwrap().len(), 1);
    let r = c.advance(Time::seconds(400));
    assert_eq!(r.unwrap_err().code, "CUE_CATCHUP_LIMIT");
    c.seek_silent(Time::seconds(400)).unwrap();
    assert!(c.advance(Time::seconds(400)).unwrap().is_empty());
}
#[test]
fn deterministic_row_allocation_and_infeasible_limits() {
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
    root.flow = Flow::Row {
        gap: 8.0,
        sizes: vec![
            Size::Weight {
                weight: 1.0,
                min: 1.0,
                max: 2000.0,
            },
            Size::Weight {
                weight: 1.0,
                min: 1.0,
                max: 2000.0,
            },
        ],
    };
    // Remove actions/tracks referencing the removed/changed layout only if needed; host remains.
    let p = compile(&d).unwrap();
    let hosts: Vec<_> = p
        .nodes
        .iter()
        .filter(|n| n.path == "sets/classic/layouts/wide/root/host")
        .collect();
    assert_eq!(hosts[0].frame.width, 956.0);
    if let Flow::Row { sizes, .. } = &mut d
        .sets
        .get_mut("classic")
        .unwrap()
        .layouts
        .get_mut("wide")
        .unwrap()
        .root
        .flow
    {
        *sizes = vec![
            Size::Fixed { pixels: 2000.0 },
            Size::Fixed { pixels: 2000.0 },
        ];
    }
    assert!(compile(&d).is_err());
}
