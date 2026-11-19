use producer_production_core::{
    commands::{Command, Operation},
    contract::*,
    coordinator::*,
    retention,
    storage::*,
};
#[derive(Default)]
struct DiscardStore {
    failure: bool,
}
impl Storage for DiscardStore {
    fn append(&mut self, _: &Record) -> std::result::Result<(), AppendError> {
        if self.failure {
            self.failure = false;
            Err(AppendError::NotWritten(Error::new(
                "FULL",
                "test",
                "not written",
            )))
        } else {
            Ok(())
        }
    }
    fn checkpoint(&mut self, _: &Snapshot) -> Result<()> {
        Ok(())
    }
}
fn edit(title: &str) -> Command {
    Command::Transaction {
        operations: vec![Operation::SetTitle {
            title: title.into(),
        }],
    }
}
fn send(c: &mut Coordinator<DiscardStore>, s: &str, cmd: &Command) -> Receipt {
    let t = c.issue(s, c.state.revision, cmd, 0).unwrap();
    c.submit(s, &t, cmd, 1).unwrap()
}
#[test]
fn history_byte_budget_evicts_oldest_only_after_successful_save() {
    let mut d = Document::empty("large", "initial");
    for n in 0..96 {
        d.metadata.insert(
            format!("text-{n}"),
            serde_json::Value::String("x".repeat(STRING_BYTES)),
        );
    }
    let weight = retention::measure(&d).unwrap();
    let mut c = Coordinator::new(Snapshot::new(d).unwrap(), DiscardStore::default());
    let (s, _) = c.session(true).unwrap();
    for n in 0..7 {
        assert_eq!(
            send(&mut c, &s, &edit(&format!("edit-{n}"))).outcome,
            Outcome::Saved
        );
    }
    let before = c.history_status(&s).unwrap();
    assert_eq!(before.entries, HISTORY_BYTES / weight.encoded_bytes);
    assert!(before.entries < HISTORY_ENTRIES && before.encoded_bytes <= HISTORY_BYTES);
    let undo = c.undo_command(&s).unwrap();
    c.storage.failure = true;
    assert!(matches!(
        send(&mut c, &s, &edit("failed")).outcome,
        Outcome::Rejected(_)
    ));
    assert_eq!(c.history_status(&s).unwrap(), before);
    assert_eq!(
        serde_json::to_value(c.undo_command(&s).unwrap()).unwrap(),
        serde_json::to_value(&undo).unwrap()
    );
    assert_eq!(send(&mut c, &s, &undo).outcome, Outcome::Saved);
    let after = c.history_status(&s).unwrap();
    assert_eq!(after.entries, before.entries - 1);
    assert!(after.encoded_bytes < before.encoded_bytes);
    assert!(after.structural_units < before.structural_units);
    assert!(c.history_status("untrusted").is_err());
}
#[test]
fn history_entry_cap_and_complete_undo_release_all_accounting() {
    let mut c = Coordinator::new(
        Snapshot::new(Document::empty("small", "initial")).unwrap(),
        DiscardStore::default(),
    );
    let (s, _) = c.session(true).unwrap();
    for n in 0..32 {
        send(&mut c, &s, &edit(&format!("edit-{n}")));
    }
    assert_eq!(c.history_status(&s).unwrap().entries, HISTORY_ENTRIES);
    for _ in 0..HISTORY_ENTRIES {
        let undo = c.undo_command(&s).unwrap();
        send(&mut c, &s, &undo);
    }
    let history = c.history_status(&s).unwrap();
    assert_eq!(
        (
            history.entries,
            history.encoded_bytes,
            history.structural_units
        ),
        (0, 0, 0)
    );
    assert_eq!(c.undo_command(&s).unwrap_err().code, "UNDO_UNAVAILABLE");
    assert_eq!(c.state.document.title, "edit-15");
}
#[test]
fn maximum_work_document_with_full_receipt_history_fits_store_envelope() {
    fn values(v: &serde_json::Value) -> usize {
        1 + match v {
            serde_json::Value::Array(a) => a.iter().map(values).sum(),
            serde_json::Value::Object(m) => m.values().map(values).sum(),
            _ => 0,
        }
    }
    let mut d = Document::empty("max-work", "max work");
    let base = values(&serde_json::to_value(&d).unwrap());
    d.metadata.insert(
        "dense".into(),
        serde_json::Value::Array(vec![serde_json::Value::Null; RAW_VALUES - base - 1]),
    );
    validate_document(&d).unwrap();
    let mut s = Snapshot::new(d).unwrap();
    let r = Receipt {
        ticket: "ticket".into(),
        payload_hash: "0".repeat(64),
        revision: Counter(0),
        digest: "1".repeat(64),
        outcome: Outcome::Rejected(Error::new("TEST", "test", "bounded rejection")),
        completed_at_ms: Counter(wall_time_ms()),
    };
    s.receipts = std::iter::repeat_n(r.clone(), RECEIPTS - 1).collect();
    s.retain(r).unwrap();
    assert_eq!(s.receipts.len(), RECEIPTS);
    s.validate_receipts().unwrap();
    // Receipt count is enforced on load as well as on append.
    s.receipts.push_back(s.receipts[0].clone());
    assert_eq!(s.validate_receipts().unwrap_err().code, "RECEIPT_LIMIT");
    // Envelope headroom must never weaken the embedded authored-document limit.
    if let serde_json::Value::Array(a) = s.document.metadata.get_mut("dense").unwrap() {
        a.push(serde_json::Value::Null);
    }
    assert_eq!(validate_document(&s.document).unwrap_err().code, "RAW_JSON");
}
#[test]
fn recovered_checkpoint_and_host_factory_reject_over_profile_receipts() {
    use producer_production_core::host::ProductionHost;
    let dir = std::env::temp_dir().join(format!(
        "producer-receipt-limit-test-{}",
        uuid::Uuid::new_v4()
    ));
    let d = Document::empty("receipts", "test");
    let (store, mut s) = FileStore::open(&dir, d.clone()).unwrap();
    drop(store);
    let r = Receipt {
        ticket: "t".into(),
        payload_hash: "h".into(),
        revision: Counter(0),
        digest: "d".into(),
        outcome: Outcome::Saved,
        completed_at_ms: Counter(wall_time_ms()),
    };
    s.receipts = std::iter::repeat_n(r, RECEIPTS + 1).collect();
    let envelope = serde_json::json!({"body":s,"checksum":digest(&s).unwrap()});
    std::fs::write(
        dir.join("checkpoint-a.json"),
        serde_json::to_vec(&envelope).unwrap(),
    )
    .unwrap();
    let error = FileStore::open(&dir, d).err().unwrap();
    assert_eq!(error.code, "RECEIPT_LIMIT");
    std::fs::remove_dir_all(dir).unwrap();
    let mut host = ProductionHost::<DiscardStore>::new().unwrap();
    assert_eq!(
        host.open("receipts", || Ok((DiscardStore::default(), s)))
            .unwrap_err()
            .code,
        "RECEIPT_LIMIT"
    );
    assert_eq!(host.services().documents, 0);
}
#[test]
fn title_edits_share_unchanged_maps_and_mutations_detach_without_changing_prior_versions() {
    use producer_production_core::commands;
    let mut a = fixture::classic_like();
    a.metadata.insert(
        "content".into(),
        serde_json::json!({"text":"preserve","array":[1,2,3]}),
    );
    let mut b = commands::apply(&a, &edit("renamed")).unwrap();
    assert!(std::ptr::eq(&*a.metadata, &*b.metadata));
    assert!(std::ptr::eq(&*a.sets, &*b.sets));
    assert!(std::ptr::eq(&*a.assets, &*b.assets));
    assert!(std::ptr::eq(&*a.sources, &*b.sources));
    assert!(std::ptr::eq(&*a.components, &*b.components));
    assert!(std::ptr::eq(&*a.sequences, &*b.sequences));
    assert!(std::ptr::eq(&*a.shows, &*b.shows));
    b.metadata.get_mut("content").unwrap()["text"] = serde_json::json!("detached");
    b.sets
        .get_mut("classic")
        .unwrap()
        .theme
        .insert("detached".into(), "#000000".into());
    assert_eq!(a.metadata["content"]["text"], "preserve");
    assert!(!a.sets["classic"].theme.contains_key("detached"));
    assert!(std::ptr::eq(&*a.sources, &*b.sources));
    assert!(!std::ptr::eq(&*a.metadata, &*b.metadata));
    assert!(!std::ptr::eq(&*a.sets, &*b.sets));
    let encoded = serde_json::to_vec(&a).unwrap();
    let decoded =
        producer_production_core::contract::ingress::parse(&encoded, DOCUMENT_BYTES).unwrap();
    assert_eq!(serde_json::from_value::<Document>(decoded).unwrap(), a);
}

#[test]
fn value_encoded_checkpoint_and_journal_still_recover_with_borrowed_hashing() {
    use producer_production_core::commands;
    use sha2::{Digest, Sha256};
    fn old_hash<T: serde::Serialize>(value: &T) -> String {
        let raw = serde_json::to_value(value).unwrap();
        let mut h = Sha256::new();
        h.update(b"producer.production/1\0");
        h.update(ingress::canonical(&raw).unwrap());
        format!("{:x}", h.finalize())
    }
    fn old_envelope<T: serde::Serialize>(value: &T) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({"body":value,"checksum":old_hash(value)})).unwrap()
    }
    let dir = std::env::temp_dir().join(format!("producer-wire-compat-{}", uuid::Uuid::new_v4()));
    let mut d = Document::empty("legacy-wire", "Before");
    d.metadata.insert(
        "unicode".into(),
        serde_json::json!({"😀":0.1,"\u{e000}":[true,null,"\\\n"]}),
    );
    d.metadata.insert(
        "literal".into(),
        serde_json::json!({"$serde_json::private::RawValue":"{\"constructor\":0}","extra":true}),
    );
    let (store, s) = FileStore::open(&dir, d.clone()).unwrap();
    drop(store);
    std::fs::write(dir.join("checkpoint-a.json"), old_envelope(&s)).unwrap();
    let cmd = edit("After");
    let changed = commands::apply(&d, &cmd).unwrap();
    let r = Record {
        cursor: Counter(1),
        base_revision: Counter(0),
        command: Some(cmd.clone()),
        receipt: Receipt {
            ticket: "old-ticket".into(),
            payload_hash: old_hash(&cmd),
            revision: Counter(1),
            digest: old_hash(&changed),
            outcome: Outcome::Saved,
            completed_at_ms: Counter(wall_time_ms()),
        },
    };
    let mut bytes = old_envelope(&r);
    bytes.push(b'\n');
    std::fs::write(dir.join("journal.jsonl"), bytes).unwrap();
    let (mut store, recovered) = FileStore::open(&dir, d.clone()).unwrap();
    assert_eq!(recovered.document, changed);
    assert_eq!(recovered.receipts.back(), Some(&r.receipt));
    store.checkpoint(&recovered).unwrap();
    drop(store);
    let (store, again) = FileStore::open(&dir, d).unwrap();
    assert_eq!(again.document, changed);
    assert_eq!(again.revision, Counter(1));
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}
