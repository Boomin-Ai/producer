//! Adversarial combined-profile and recovery checks. No native allocations.
#[path = "../examples/support/pressure.rs"]
mod pressure;
use producer_production_core::{
    commands::{Command, Operation},
    compile::compile,
    contract::*,
    coordinator::*,
    storage::*,
};
use std::{fs, io::Write, path::PathBuf};
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!(
            "producer-recovery-pressure-{}",
            uuid::Uuid::new_v4()
        )))
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn edit(title: &str) -> Command {
    Command::Transaction {
        operations: vec![Operation::SetTitle {
            title: title.into(),
        }],
    }
}
fn saved(c: &mut Coordinator<FileStore>, session: &str, command: &Command) -> (String, Receipt) {
    let t = c.issue(session, c.state.revision, command, 0).unwrap();
    let r = c.submit(session, &t, command, 1).unwrap();
    assert_eq!(r.outcome, Outcome::Saved);
    (t, r)
}
fn sample(d: &Document) -> Vec<Option<producer_production_core::analytic::EffectInputs>> {
    let p = compile(d).unwrap();
    let q = &p.sequences["timeline"];
    let mut out = vec![None; q.effects.len()];
    q.evaluate_effects_into(Time::new(5, 4).unwrap(), &mut out)
        .unwrap();
    out
}
#[test]
fn combined_node_track_key_and_effect_limits_do_not_override_ownership_limits() {
    for nested in [false, true] {
        let d = pressure::document("limits", nested);
        let p = compile(&d).unwrap();
        assert_eq!(p.nodes.len(), NODES);
        assert_eq!(p.inventory.expanded_tracks, TRACKS);
        assert!(serde_json::to_vec(&d).unwrap().len() > DOCUMENT_BYTES - 8192);
        assert_eq!(
            p.sequences["timeline"].effects.len(),
            if nested { 256 } else { 768 }
        );
        let mut node_over = d.clone();
        node_over
            .sets
            .get_mut("pressure")
            .unwrap()
            .layouts
            .get_mut("wide")
            .unwrap()
            .root
            .children
            .push(Node {
                style: None,
                id: "overflow".into(),
                frame: None,
                placement: None,
                flow: Flow::Overlay,
                content: Content::Group,
                children: vec![],
                bindings: vec![],
            });
        assert!(validate_document(&node_over).is_err());
        let mut track_over = d.clone();
        track_over.metadata.clear();
        let unused = p
            .inventory
            .targets
            .iter()
            .find(|target| {
                target.property == Property::Opacity
                    && !d
                        .sequences
                        .values()
                        .flat_map(|s| &s.tracks)
                        .any(|t| &t.target == *target)
            })
            .unwrap()
            .clone();
        let q = track_over
            .sequences
            .get_mut(if nested { "leaf" } else { "timeline" })
            .unwrap();
        let mut t = q.tracks[0].clone();
        t.id = "overflow".into();
        t.target = unused;
        q.tracks.push(t);
        assert!(validate_document(&track_over).is_err());
        if nested {
            let mut key_over = d.clone();
            key_over.metadata.clear();
            let t = &mut key_over.sequences.get_mut("leaf").unwrap().tracks[0];
            t.keys = (0..=KEYS)
                .map(|k| Key {
                    at: Time::new(k as i64, (KEYS / 4) as u32).unwrap(),
                    value: Value::Number((k % 2) as f64),
                })
                .collect();
            assert!(validate_document(&key_over).is_err());
        }
    }
    let mut over = pressure::document("ownership", false);
    over.metadata.clear();
    let q = over.sequences.get_mut("timeline").unwrap();
    let template = q.placements[0].clone();
    q.placements = (0..NODES)
        .map(|i| {
            let mut p = template.clone();
            p.id = format!("fx-{i}");
            p
        })
        .collect();
    validate_document(&over).unwrap(); // Wire/temporal limits pass; ownership is a separate bound.
    let e = compile(&over).unwrap_err();
    assert_eq!(e.code, "RESOURCE_LIMIT");
    assert_eq!(e.path, "dependencies");
}
#[test]
fn repeated_reopen_torn_tail_and_historical_retry_preserve_exact_analytic_inputs() {
    let tmp = Temp::new();
    let initial = fixture::analytic_reconstruction();
    let reference = sample(&initial);
    let (store, state) = FileStore::open(&tmp.0, initial.clone()).unwrap();
    let mut c = Coordinator::new(state, store);
    let (s, _) = c.session(true).unwrap();
    let (ticket, receipt) = saved(&mut c, &s, &edit("saved-first"));
    drop(c);
    for n in 0..8 {
        let tail = format!("{{\"interrupted-at\":{n}");
        let mut f = fs::OpenOptions::new()
            .append(true)
            .open(tmp.0.join("journal.jsonl"))
            .unwrap();
        f.write_all(tail.as_bytes()).unwrap();
        f.sync_all().unwrap();
        drop(f);
        let (store, state) = FileStore::open(&tmp.0, Document::empty("unused", "unused")).unwrap();
        assert_eq!(store.diagnostics.len(), 1);
        assert_eq!(
            fs::read(tmp.0.join("recovered-tail.bin")).unwrap(),
            tail.as_bytes()
        );
        assert_eq!(sample(&state.document), reference);
        let mut c = Coordinator::new(state, store);
        let (s, _) = c.session(true).unwrap();
        let bytes = fs::read(tmp.0.join("journal.jsonl")).unwrap();
        assert_eq!(
            c.submit(&s, &ticket, &edit("saved-first"), 2).unwrap(),
            receipt
        );
        assert_eq!(fs::read(tmp.0.join("journal.jsonl")).unwrap(), bytes);
        let (_, r) = saved(&mut c, &s, &edit(&format!("reopen-{n}")));
        assert_eq!(r.revision, Counter(n + 2));
        if n % 2 == 0 {
            c.checkpoint(&s).unwrap();
        }
        drop(c);
        let (store, state) = FileStore::open(&tmp.0, initial.clone()).unwrap();
        assert!(store.diagnostics.is_empty());
        assert_eq!(sample(&state.document), reference);
        drop(store);
    }
}
#[test]
fn full_unique_receipt_checkpoint_reopens_with_outcomes_and_analytic_inputs_intact() {
    let tmp = Temp::new();
    let initial = fixture::analytic_reconstruction();
    let reference = sample(&initial);
    let (mut store, mut state) = FileStore::open(&tmp.0, initial).unwrap();
    let hash = digest(&state.document).unwrap();
    // Seed the legal retention boundary directly. This is recovery qualification,
    // not a claim that 4,096 real requests or fsyncs ran in this test.
    state.cursor = Counter(RECEIPTS as u64);
    state.receipts = (0..RECEIPTS)
        .map(|i| Receipt {
            ticket: format!("historical-{i}"),
            payload_hash: "0".repeat(64),
            revision: Counter(0),
            digest: hash.clone(),
            outcome: Outcome::Rejected(Error::new("TEST", "recovery", "not executed")),
            completed_at_ms: Counter(wall_time_ms()),
        })
        .collect();
    store.checkpoint(&state).unwrap();
    drop(store);
    for _ in 0..8 {
        let (mut store, recovered) =
            FileStore::open(&tmp.0, Document::empty("unused", "unused")).unwrap();
        assert_eq!(recovered.receipts, state.receipts);
        assert_eq!(recovered.revision, Counter(0));
        assert_eq!(sample(&recovered.document), reference);
        store.checkpoint(&recovered).unwrap();
        drop(store);
    }
}
#[test]
fn complete_corruption_fails_closed_and_never_silently_uses_an_older_checkpoint() {
    let tmp = Temp::new();
    let initial = fixture::analytic_reconstruction();
    let (store, state) = FileStore::open(&tmp.0, initial.clone()).unwrap();
    let mut c = Coordinator::new(state, store);
    let (s, _) = c.session(true).unwrap();
    saved(&mut c, &s, &edit("newest"));
    c.checkpoint(&s).unwrap();
    drop(c);
    assert!(tmp.0.join("checkpoint-a.json").exists());
    assert!(tmp.0.join("checkpoint-b.json").exists());
    let newest = fs::read(tmp.0.join("checkpoint-b.json")).unwrap();
    fs::write(
        tmp.0.join("checkpoint-b.json"),
        b"{\"body\":{\"schema\":\"unsupported\"},\"checksum\":\"wrong\"}",
    )
    .unwrap();
    let corrupt = fs::read(tmp.0.join("checkpoint-b.json")).unwrap();
    assert!(FileStore::open(&tmp.0, initial.clone()).is_err());
    assert_eq!(fs::read(tmp.0.join("checkpoint-b.json")).unwrap(), corrupt);
    fs::write(tmp.0.join("checkpoint-b.json"), newest).unwrap();
    fs::write(
        tmp.0.join("journal.jsonl"),
        b"{\"completeButCorrupt\":true}\n{\"torn",
    )
    .unwrap();
    let corrupt = fs::read(tmp.0.join("journal.jsonl")).unwrap();
    assert!(FileStore::open(&tmp.0, initial).is_err());
    assert_eq!(fs::read(tmp.0.join("journal.jsonl")).unwrap(), corrupt);
    assert!(!tmp.0.join("recovered-tail.bin").exists());
}
