//! One experimental store writer. IO never runs on render/audio callback lanes.
use crate::{
    commands::{self, Command},
    contract::*,
};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub const JOURNAL_BYTES: u64 = 64 * 1024 * 1024;
pub const CHECKPOINT_BYTES: usize = 48 * 1024 * 1024;
pub const RECEIPTS: usize = 4096;
pub const RECEIPT_BYTES: usize = 16 * 1024 * 1024;
const MARKER: &str = "PRODUCER_EXPERIMENTAL_CORE_1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "status", content = "error", rename_all = "camelCase")]
pub enum Outcome {
    Saved,
    Rejected(Error),
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Receipt {
    pub ticket: String,
    pub payload_hash: String,
    pub revision: Counter,
    pub digest: String,
    pub outcome: Outcome,
    pub completed_at_ms: Counter,
}
pub fn wall_time_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
pub const RECEIPT_TTL_MS: u64 = 7 * 24 * 60 * 60 * 1000;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Snapshot {
    pub schema: String,
    pub cursor: Counter,
    pub revision: Counter,
    pub document: Document,
    pub receipts: VecDeque<Receipt>,
}
impl Snapshot {
    pub fn new(document: Document) -> Result<Self> {
        validate_document(&document)?;
        Ok(Self {
            schema: "producer.production-store/1".into(),
            cursor: Counter(0),
            revision: Counter(0),
            document,
            receipts: VecDeque::new(),
        })
    }
    pub fn retain(&mut self, r: Receipt) -> Result<()> {
        let size = serde_json::to_vec(&r).map_err(|e| ioerr(&e))?.len();
        if size > 64 * 1024 {
            return Err(Error::new(
                "RECEIPT_LIMIT",
                "receipt",
                "receipt is over limit",
            ));
        }
        self.receipts.push_back(r);
        let cutoff = wall_time_ms().saturating_sub(RECEIPT_TTL_MS);
        self.receipts.retain(|r| r.completed_at_ms.0 >= cutoff);
        while self.receipts.len() > RECEIPTS
            || serde_json::to_vec(&self.receipts)
                .map_err(|e| ioerr(&e))?
                .len()
                > RECEIPT_BYTES
        {
            self.receipts.pop_front();
        }
        let encoded = encode(self)?;
        if encoded.len() > CHECKPOINT_BYTES {
            return Err(Error::new(
                "CHECKPOINT_LIMIT",
                "store",
                "complete checkpoint cannot fit",
            ));
        }
        ingress::parse_envelope(&encoded, CHECKPOINT_BYTES)?;
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Record {
    pub cursor: Counter,
    pub base_revision: Counter,
    pub command: Option<Command>,
    pub receipt: Receipt,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope<T> {
    body: T,
    checksum: String,
}
fn ioerr(e: &impl std::fmt::Display) -> Error {
    Error::new("STORE_IO", "store", e.to_string())
}
fn encode<T: Serialize>(body: &T) -> Result<Vec<u8>> {
    serde_json::to_vec(&Envelope {
        body,
        checksum: digest(body)?,
    })
    .map_err(|e| ioerr(&e))
}
fn decode<T: serde::de::DeserializeOwned + Serialize>(bytes: &[u8], max: usize) -> Result<T> {
    // Store ingress has the same duplicate/number/UTF8 guarantees. Checkpoints may
    // contain a full 8MiB document plus bounded historical receipts.
    let v = ingress::parse_envelope(bytes, max)?;
    let e: Envelope<T> = serde_json::from_value(v).map_err(|e| ioerr(&e))?;
    if digest(&e.body)? != e.checksum {
        return Err(Error::new("CHECKSUM", "store", "record checksum mismatch"));
    }
    Ok(e.body)
}
fn advance(s: &mut Snapshot, r: &Record) -> Result<()> {
    if r.cursor.0
        != s.cursor
            .0
            .checked_add(1)
            .ok_or_else(|| ioerr(&"cursor exhausted"))?
        || r.base_revision != s.revision
    {
        return Err(Error::new(
            "JOURNAL_ORDER",
            "store",
            "history lineage mismatch",
        ));
    }
    match &r.receipt.outcome {
        Outcome::Saved => {
            let command = r
                .command
                .as_ref()
                .ok_or_else(|| ioerr(&"saved record lacks command"))?;
            if digest(command)? != r.receipt.payload_hash {
                return Err(ioerr(&"command hash mismatch"));
            }
            let d = commands::apply(&s.document, command)?;
            if r.receipt.revision.0
                != s.revision
                    .0
                    .checked_add(1)
                    .ok_or_else(|| ioerr(&"revision exhausted"))?
                || digest(&d)? != r.receipt.digest
            {
                return Err(ioerr(&"replay outcome mismatch"));
            }
            s.document = d;
            s.revision = r.receipt.revision;
        }
        Outcome::Rejected(_) => {
            if r.command.is_some()
                || r.receipt.revision != s.revision
                || r.receipt.digest != digest(&s.document)?
            {
                return Err(ioerr(&"rejected record changed document"));
            }
        }
    }
    s.cursor = r.cursor;
    s.retain(r.receipt.clone())?;
    Ok(())
}
#[derive(Debug, Clone)]
pub enum AppendError {
    NotWritten(Error),
    Unknown(Error),
}
pub trait Storage {
    fn append(&mut self, record: &Record) -> std::result::Result<(), AppendError>;
    fn checkpoint(&mut self, state: &Snapshot) -> Result<()>;
}
#[derive(Default)]
pub struct MemoryStore {
    pub records: Vec<Record>,
    pub failure: Option<Failure>,
}
#[derive(Debug, Clone, Copy)]
pub enum Failure {
    BeforeWrite,
    AfterWrite,
}
impl Storage for MemoryStore {
    fn append(&mut self, r: &Record) -> std::result::Result<(), AppendError> {
        let bytes = encode(r).map_err(AppendError::NotWritten)?;
        if self
            .records
            .iter()
            .map(|r| encode(r).unwrap().len())
            .sum::<usize>()
            + bytes.len()
            > JOURNAL_BYTES as usize
        {
            return Err(AppendError::NotWritten(ioerr(&"journal full")));
        }
        let failure = self.failure.take();
        if matches!(failure, Some(Failure::BeforeWrite)) {
            return Err(AppendError::NotWritten(ioerr(&"injected disk full")));
        }
        self.records.push(r.clone());
        if matches!(failure, Some(Failure::AfterWrite)) {
            return Err(AppendError::Unknown(ioerr(
                &"injected flush outcome unknown",
            )));
        }
        Ok(())
    }
    fn checkpoint(&mut self, _: &Snapshot) -> Result<()> {
        Ok(())
    }
}
impl MemoryStore {
    pub fn recover(initial: Document, records: &[Record]) -> Result<Snapshot> {
        let mut s = Snapshot::new(initial)?;
        for r in records {
            advance(&mut s, r)?;
        }
        Ok(s)
    }
}

pub struct FileStore {
    dir: PathBuf,
    _lock: File,
    journal: File,
    pub diagnostics: Vec<String>,
}
#[cfg(unix)]
fn sync_dir(dir: &Path) -> Result<()> {
    File::open(dir)
        .and_then(|f| f.sync_all())
        .map_err(|e| ioerr(&e))
}
#[cfg(not(unix))]
fn sync_dir(_: &Path) -> Result<()> {
    Ok(())
}
impl FileStore {
    pub fn open(dir: &Path, initial: Document) -> Result<(Self, Snapshot)> {
        if dir.is_symlink() {
            return Err(ioerr(&"store root must not be a symlink"));
        }
        fs::create_dir_all(dir).map_err(|e| ioerr(&e))?;
        let marker = dir.join(MARKER);
        for name in [
            MARKER,
            "writer.lock",
            "journal.jsonl",
            "checkpoint-a.json",
            "checkpoint-b.json",
            "checkpoint-next.json",
            "recovered-tail.bin",
        ] {
            if dir.join(name).is_symlink() {
                return Err(ioerr(&"store members must not be symlinks"));
            }
        }
        if !marker.exists() {
            if fs::read_dir(dir).map_err(|e| ioerr(&e))?.next().is_some() {
                return Err(ioerr(&"refusing a nonempty non-experimental store"));
            }
            let mut f = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&marker)
                .map_err(|e| ioerr(&e))?;
            f.write_all(b"isolated production core / 1\n")
                .and_then(|_| f.sync_all())
                .map_err(|e| ioerr(&e))?;
            sync_dir(dir)?;
        }
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(dir.join("writer.lock"))
            .map_err(|e| ioerr(&e))?;
        FileExt::try_lock_exclusive(&lock).map_err(|_| {
            Error::new(
                "STORE_BUSY",
                "store",
                "one writer already owns this namespace",
            )
        })?;
        let mut checkpoints = Vec::new();
        let mut diagnostics = Vec::new();
        for name in ["checkpoint-a.json", "checkpoint-b.json"] {
            let p = dir.join(name);
            if p.exists() {
                if fs::metadata(&p).map_err(|e| ioerr(&e))?.len() > CHECKPOINT_BYTES as u64 {
                    return Err(ioerr(&"checkpoint exceeds profile"));
                }
                let bytes = fs::read(p).map_err(|e| ioerr(&e))?;
                let s: Snapshot = decode(&bytes, CHECKPOINT_BYTES)?;
                if s.schema != "producer.production-store/1" {
                    return Err(ioerr(&"unsupported store version; recovery-only"));
                }
                validate_document(&s.document)?;
                checkpoints.push(s);
            }
        }
        checkpoints.sort_by_key(|s| s.cursor);
        let mut state = checkpoints.pop().unwrap_or(Snapshot::new(initial)?);
        let journal_path = dir.join("journal.jsonl");
        let mut journal = OpenOptions::new()
            .read(true)
            .append(true)
            .create(true)
            .open(&journal_path)
            .map_err(|e| ioerr(&e))?;
        let len = journal.metadata().map_err(|e| ioerr(&e))?.len();
        if len > JOURNAL_BYTES {
            return Err(ioerr(&"journal exceeds profile; recovery-only"));
        }
        let mut bytes = Vec::with_capacity(len as usize);
        journal.read_to_end(&mut bytes).map_err(|e| ioerr(&e))?;
        let complete = bytes
            .iter()
            .rposition(|b| *b == b'\n')
            .map(|i| i + 1)
            .unwrap_or(0);
        for line in bytes[..complete]
            .split(|b| *b == b'\n')
            .filter(|l| !l.is_empty())
        {
            let r: Record = decode(line, DOCUMENT_BYTES + 64 * 1024)?;
            if r.cursor > state.cursor {
                advance(&mut state, &r)?;
            }
        }
        if complete < bytes.len() {
            // Preserve one bounded tail before repair. Never skip corrupt complete records.
            let tail = &bytes[complete..];
            if tail.len() > DOCUMENT_BYTES + 64 * 1024 {
                return Err(ioerr(&"over-limit corrupt tail; recovery-only"));
            }
            let mut f = File::create(dir.join("recovered-tail.bin")).map_err(|e| ioerr(&e))?;
            f.write_all(tail)
                .and_then(|_| f.sync_all())
                .map_err(|e| ioerr(&e))?;
            journal
                .set_len(complete as u64)
                .and_then(|_| journal.sync_all())
                .map_err(|e| ioerr(&e))?;
            diagnostics.push("Truncated journal tail preserved in recovered-tail.bin; prior complete commits recovered.".into());
        }
        let mut store = Self {
            dir: dir.into(),
            _lock: lock,
            journal,
            diagnostics,
        };
        if !store.dir.join("checkpoint-a.json").exists()
            && !store.dir.join("checkpoint-b.json").exists()
        {
            store.checkpoint(&state)?;
        }
        sync_dir(dir)?;
        Ok((store, state))
    }
}
impl Storage for FileStore {
    fn append(&mut self, r: &Record) -> std::result::Result<(), AppendError> {
        let mut bytes = encode(r).map_err(AppendError::NotWritten)?;
        bytes.push(b'\n');
        let len = self
            .journal
            .metadata()
            .map_err(|e| AppendError::NotWritten(ioerr(&e)))?
            .len();
        if len + bytes.len() as u64 > JOURNAL_BYTES {
            return Err(AppendError::NotWritten(ioerr(
                &"journal full: checkpoint required",
            )));
        }
        // Reserve space for both bounded checkpoints plus this record before ACK.
        if fs2::available_space(&self.dir).map_err(|e| AppendError::NotWritten(ioerr(&e)))?
            < 2 * CHECKPOINT_BYTES as u64 + bytes.len() as u64
        {
            return Err(AppendError::NotWritten(ioerr(
                &"insufficient checkpoint/journal disk reserve",
            )));
        }
        self.journal
            .write_all(&bytes)
            .and_then(|_| self.journal.sync_all())
            .map_err(|e| AppendError::Unknown(ioerr(&e)))
    }
    fn checkpoint(&mut self, s: &Snapshot) -> Result<()> {
        let bytes = encode(s)?;
        if bytes.len() > CHECKPOINT_BYTES {
            return Err(ioerr(&"aggregate checkpoint exceeds profile"));
        }
        if fs2::available_space(&self.dir).map_err(|e| ioerr(&e))? < 2 * CHECKPOINT_BYTES as u64 {
            return Err(ioerr(&"insufficient checkpoint disk reserve"));
        }
        let tmp = self.dir.join("checkpoint-next.json");
        let mut f = File::create(&tmp).map_err(|e| ioerr(&e))?;
        f.write_all(&bytes)
            .and_then(|_| f.sync_all())
            .map_err(|e| ioerr(&e))?;
        let name = if s.cursor.0.is_multiple_of(2) {
            "checkpoint-a.json"
        } else {
            "checkpoint-b.json"
        };
        fs::rename(tmp, self.dir.join(name)).map_err(|e| ioerr(&e))?;
        sync_dir(&self.dir)?;
        self.journal
            .set_len(0)
            .and_then(|_| self.journal.sync_all())
            .map_err(|e| ioerr(&e))?;
        Ok(())
    }
}
