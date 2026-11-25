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
        Self::new_with_scratch(document, &mut wire::Scratch::default())
    }
    fn new_with_scratch(document: Document, scratch: &mut wire::Scratch) -> Result<Self> {
        validate::validate_with_scratch(&document, scratch)?;
        Ok(Self {
            schema: "producer.production-store/1".into(),
            cursor: Counter(0),
            revision: Counter(0),
            document,
            receipts: VecDeque::new(),
        })
    }
    /// Store recovery must reject over-profile history rather than admitting
    /// an oversized receipt collection until the next mutation prunes it.
    pub fn validate_receipts(&self) -> Result<()> {
        if self.receipts.len() > RECEIPTS
            || encoded_size(&self.receipts, RECEIPT_BYTES).is_err()
            || self
                .receipts
                .iter()
                .any(|r| encoded_size(r, 64 * 1024).is_err())
        {
            return Err(Error::new(
                "RECEIPT_LIMIT",
                "store.receipts",
                "receipt history exceeds store profile",
            ));
        }
        Ok(())
    }
    pub fn retain(&mut self, r: Receipt) -> Result<()> {
        self.retain_with_scratch(r, &mut wire::Scratch::default())
    }
    pub fn retain_with_scratch(&mut self, r: Receipt, scratch: &mut wire::Scratch) -> Result<()> {
        if encoded_size(&r, 64 * 1024).is_err() {
            return Err(Error::new(
                "RECEIPT_LIMIT",
                "receipt",
                "receipt is over limit",
            ));
        }
        self.receipts.push_back(r);
        let cutoff = wall_time_ms().saturating_sub(RECEIPT_TTL_MS);
        self.receipts.retain(|r| r.completed_at_ms.0 >= cutoff);
        while self.receipts.len() > RECEIPTS || encoded_size(&self.receipts, RECEIPT_BYTES).is_err()
        {
            self.receipts.pop_front();
        }
        let encoded = encode_into(self, scratch)?;
        if encoded.len() > CHECKPOINT_BYTES {
            return Err(Error::new(
                "CHECKPOINT_LIMIT",
                "store",
                "complete checkpoint cannot fit",
            ));
        }
        ingress::check_envelope(encoded, CHECKPOINT_BYTES)?;
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
fn encoded_size(value: &impl Serialize, limit: usize) -> Result<usize> {
    struct Count {
        bytes: usize,
        limit: usize,
    }
    impl Write for Count {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            self.bytes = self
                .bytes
                .checked_add(data.len())
                .filter(|n| *n <= self.limit)
                .ok_or_else(|| std::io::Error::other("encoded byte limit exceeded"))?;
            Ok(data.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut count = Count { bytes: 0, limit };
    serde_json::to_writer(&mut count, value).map_err(|e| ioerr(&e))?;
    Ok(count.bytes)
}
fn ioerr(e: &impl std::fmt::Display) -> Error {
    Error::new("STORE_IO", "store", e.to_string())
}
fn encode<T: Serialize>(body: &T) -> Result<Vec<u8>> {
    Ok(encode_into(body, &mut wire::Scratch::default())?.to_vec())
}
fn encode_into<'a, T: Serialize>(body: &T, scratch: &'a mut wire::Scratch) -> Result<&'a [u8]> {
    let checksum = scratch.digest(body)?;
    scratch.serialize(&Envelope { body, checksum }, CHECKPOINT_BYTES)
}
fn decode<T: serde::de::DeserializeOwned + Serialize>(
    bytes: &[u8],
    max: usize,
    scratch: &mut wire::Scratch,
) -> Result<T> {
    // Store ingress has the same duplicate/number/UTF8 guarantees. Checkpoints may
    // contain a full 8MiB document plus bounded historical receipts.
    ingress::check_envelope(bytes, max)?;
    let e: Envelope<T> = serde_json::from_slice(bytes).map_err(|e| ioerr(&e))?;
    if scratch.digest(&e.body)? != e.checksum {
        return Err(Error::new("CHECKSUM", "store", "record checksum mismatch"));
    }
    Ok(e.body)
}
fn advance(s: &mut Snapshot, r: &Record, scratch: &mut wire::Scratch) -> Result<()> {
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
            if scratch.digest(command)? != r.receipt.payload_hash {
                return Err(ioerr(&"command hash mismatch"));
            }
            let d = commands::apply_with_scratch(&s.document, command, scratch)?;
            if r.receipt.revision.0
                != s.revision
                    .0
                    .checked_add(1)
                    .ok_or_else(|| ioerr(&"revision exhausted"))?
                || scratch.digest(&d)? != r.receipt.digest
            {
                return Err(ioerr(&"replay outcome mismatch"));
            }
            s.document = d;
            s.revision = r.receipt.revision;
        }
        Outcome::Rejected(_) => {
            if r.command.is_some()
                || r.receipt.revision != s.revision
                || r.receipt.digest != scratch.digest(&s.document)?
            {
                return Err(ioerr(&"rejected record changed document"));
            }
        }
    }
    s.cursor = r.cursor;
    s.retain_with_scratch(r.receipt.clone(), scratch)?;
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
        let mut scratch = wire::Scratch::default();
        let mut s = Snapshot::new_with_scratch(initial, &mut scratch)?;
        for r in records {
            advance(&mut s, r, &mut scratch)?;
        }
        Ok(s)
    }
}

pub struct FileStore {
    dir: PathBuf,
    _lock: File,
    journal: File,
    pub diagnostics: Vec<String>,
    scratch: wire::Scratch,
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
        let mut scratch = wire::Scratch::default();
        let mut checkpoints = Vec::new();
        let mut diagnostics = Vec::new();
        for name in ["checkpoint-a.json", "checkpoint-b.json"] {
            let p = dir.join(name);
            if p.exists() {
                if fs::metadata(&p).map_err(|e| ioerr(&e))?.len() > CHECKPOINT_BYTES as u64 {
                    return Err(ioerr(&"checkpoint exceeds profile"));
                }
                let bytes = fs::read(p).map_err(|e| ioerr(&e))?;
                let s: Snapshot = decode(&bytes, CHECKPOINT_BYTES, &mut scratch)?;
                if s.schema != "producer.production-store/1" {
                    return Err(ioerr(&"unsupported store version; recovery-only"));
                }
                validate::validate_with_scratch(&s.document, &mut scratch)?;
                s.validate_receipts()?;
                checkpoints.push(s);
            }
        }
        checkpoints.sort_by_key(|s| s.cursor);
        let mut state = checkpoints
            .pop()
            .unwrap_or(Snapshot::new_with_scratch(initial, &mut scratch)?);
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
            let r: Record = decode(line, DOCUMENT_BYTES + 64 * 1024, &mut scratch)?;
            if r.cursor > state.cursor {
                advance(&mut state, &r, &mut scratch)?;
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
            scratch,
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
        let bytes = encode_into(r, &mut self.scratch).map_err(AppendError::NotWritten)?;
        let len = self
            .journal
            .metadata()
            .map_err(|e| AppendError::NotWritten(ioerr(&e)))?
            .len();
        if len + bytes.len() as u64 + 1 > JOURNAL_BYTES {
            return Err(AppendError::NotWritten(ioerr(
                &"journal full: checkpoint required",
            )));
        }
        // Reserve space for both bounded checkpoints plus this record before ACK.
        if fs2::available_space(&self.dir).map_err(|e| AppendError::NotWritten(ioerr(&e)))?
            < 2 * CHECKPOINT_BYTES as u64 + bytes.len() as u64 + 1
        {
            return Err(AppendError::NotWritten(ioerr(
                &"insufficient checkpoint/journal disk reserve",
            )));
        }
        self.journal
            .write_all(bytes)
            .and_then(|_| self.journal.write_all(b"\n"))
            .and_then(|_| self.journal.sync_all())
            .map_err(|e| AppendError::Unknown(ioerr(&e)))
    }
    fn checkpoint(&mut self, s: &Snapshot) -> Result<()> {
        s.validate_receipts()?;
        let bytes = encode_into(s, &mut self.scratch)?;
        if bytes.len() > CHECKPOINT_BYTES {
            return Err(ioerr(&"aggregate checkpoint exceeds profile"));
        }
        if fs2::available_space(&self.dir).map_err(|e| ioerr(&e))? < 2 * CHECKPOINT_BYTES as u64 {
            return Err(ioerr(&"insufficient checkpoint disk reserve"));
        }
        let tmp = self.dir.join("checkpoint-next.json");
        let mut f = File::create(&tmp).map_err(|e| ioerr(&e))?;
        f.write_all(bytes)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typed_store_decode_keeps_strict_raw_checks_literal_metadata_and_checksums() {
        let mut d = Document::empty("codec", "Before");
        d.metadata.insert(
            "literal".into(),
            serde_json::json!({"$serde_json::private::RawValue":"{\"constructor\":0}","extra":true}),
        );
        let snapshot = Snapshot::new(d).unwrap();
        let bytes = encode(&snapshot).unwrap();
        let text = std::str::from_utf8(&bytes).unwrap();
        let mut scratch = wire::Scratch::default();
        let decoded: Snapshot = decode(&bytes, CHECKPOINT_BYTES, &mut scratch).unwrap();
        assert_eq!(decoded.document, snapshot.document);
        let invalid = [
            (
                text.replace("\"title\":", "\"ti\\u0074le\":\"duplicate\",\"title\":"),
                "RAW_JSON",
            ),
            (
                text.replace("\"metadata\":{", "\"metadata\":{\"__proto__\":null,"),
                "RAW_JSON",
            ),
            (
                text.replace("\"metadata\":{", "\"metadata\":{\"number\":1e999,"),
                "RAW_JSON",
            ),
            (text.replace("Before", "After"), "CHECKSUM"),
            (format!("{text} null"), "RAW_JSON"),
        ];
        for (bad, code) in invalid {
            assert_eq!(
                decode::<Snapshot>(bad.as_bytes(), CHECKPOINT_BYTES, &mut scratch)
                    .unwrap_err()
                    .code,
                code
            );
            let retry: Snapshot = decode(&bytes, CHECKPOINT_BYTES, &mut scratch).unwrap();
            assert_eq!(retry.document, snapshot.document);
        }
        assert_eq!(
            decode::<Snapshot>(&bytes, bytes.len() - 1, &mut scratch)
                .unwrap_err()
                .code,
            "RAW_LIMIT"
        );
        assert!(scratch.capacity() <= wire::SCRATCH_BYTES);
    }
}
