//! Serialized control-lane document authority. Render/audio never borrow it.
use crate::{
    commands::{self, Command},
    contract::*,
    retention::{self, Weight},
    storage::*,
};
use serde::Serialize;
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

#[derive(Clone)]
pub struct RevokeFence(Arc<AtomicU64>);
impl RevokeFence {
    pub fn revoke(&self) {
        self.0.store(3, Ordering::SeqCst);
    }
    pub fn is_current(&self) -> bool {
        self.0.load(Ordering::SeqCst) == 1
    }
    pub fn is_revoked(&self) -> bool {
        self.0.load(Ordering::SeqCst) >= 3
    }
    pub(crate) fn disconnect(&self) {
        let _ = self
            .0
            .compare_exchange(1, 2, Ordering::SeqCst, Ordering::SeqCst);
    }
}
struct Session {
    author: bool,
    fence: RevokeFence,
}
#[derive(Clone)]
struct Ticket {
    session: String,
    expected: Counter,
    hash: String,
    expires: u64,
    fence: u64,
}
#[derive(Serialize)]
#[serde(tag = "status", content = "value", rename_all = "camelCase")]
pub enum Status {
    Issued,
    Terminal(Receipt),
    Unknown,
}

pub const HISTORY_ENTRIES: usize = 16;
pub const HISTORY_BYTES: usize = 32 * 1024 * 1024;
pub const HISTORY_UNITS: usize = RAW_VALUES * 2;
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryStatus {
    pub entries: usize,
    pub encoded_bytes: usize,
    pub structural_units: usize,
    pub max_entries: usize,
    pub max_encoded_bytes: usize,
    pub max_structural_units: usize,
}
struct HistoryEntry {
    cursor: Counter,
    document: Document,
    weight: Weight,
}
pub struct Coordinator<S: Storage> {
    pub state: Snapshot,
    pub storage: S,
    pub boot: String,
    sessions: BTreeMap<String, Session>,
    tickets: BTreeMap<String, Ticket>,
    volatile: VecDeque<Receipt>,
    undo: VecDeque<HistoryEntry>,
    history_weight: Weight,
    pub(crate) scratch: wire::Scratch,
    pub read_only: bool,
}
fn fail(code: &str, message: &str) -> Error {
    Error::new(code, "coordinator", message)
}
fn bounded_storage_error(mut e: Error) -> Error {
    // A trusted IO adapter can still return an unexpectedly large diagnostic.
    // Terminal retries retain it, so cap it before entering the receipt cache.
    fn trim(s: &mut String, max: usize) {
        let mut end = s.len().min(max);
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        s.truncate(end);
    }
    trim(&mut e.code, 256);
    trim(&mut e.path, 1024);
    trim(&mut e.message, 8192);
    e
}
impl<S: Storage> Coordinator<S> {
    pub fn new(state: Snapshot, storage: S) -> Self {
        Self {
            state,
            storage,
            boot: uuid::Uuid::new_v4().to_string(),
            sessions: BTreeMap::new(),
            tickets: BTreeMap::new(),
            volatile: VecDeque::new(),
            undo: VecDeque::new(),
            history_weight: Weight::default(),
            scratch: wire::Scratch::default(),
            read_only: false,
        }
    }
    /// Trusted transport policy grants this capability, never a deserialized role.
    pub fn session(&mut self, author: bool) -> Result<(String, RevokeFence)> {
        if self.sessions.len() >= 8 {
            return Err(fail(
                "SESSION_LIMIT",
                "maximum eight authenticated sessions",
            ));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let fence = RevokeFence(Arc::new(AtomicU64::new(if author { 1 } else { 0 })));
        self.sessions.insert(
            id.clone(),
            Session {
                author,
                fence: fence.clone(),
            },
        );
        Ok((id, fence))
    }
    fn reader(&self, s: &str) -> Result<&Session> {
        self.sessions
            .get(s)
            .ok_or_else(|| fail("AUTH_REQUIRED", "authenticated local session required"))
    }
    /// A reader session can never lend a write/runtime capability to an adapter.
    pub fn author_grant(&self, session: &str) -> Result<RevokeFence> {
        let s = self.reader(session)?;
        if !s.author || !s.fence.is_current() || self.read_only {
            return Err(fail(
                "FORBIDDEN",
                "current author grant and known save state required",
            ));
        }
        Ok(s.fence.clone())
    }
    pub fn disconnect(&mut self, s: &str) {
        if let Some(session) = self.sessions.remove(s) {
            session.fence.disconnect();
        }
        self.tickets.retain(|_, t| t.session != s);
    }
    pub fn issue(
        &mut self,
        session: &str,
        expected: Counter,
        command: &Command,
        now_ms: u64,
    ) -> Result<String> {
        self.tickets.retain(|_, t| t.expires >= now_ms);
        let s = self.reader(session)?;
        if !s.author || s.fence.0.load(Ordering::SeqCst) != 1 {
            return Err(fail("FORBIDDEN", "session cannot author"));
        }
        if self.read_only {
            return Err(fail(
                "RECOVERY_REQUIRED",
                "save outcome unknown; restart/reconcile before new writes",
            ));
        }
        if self.tickets.len() >= 256 {
            return Err(fail("TICKET_LIMIT", "ticket capacity exhausted"));
        }
        let fence = s.fence.0.load(Ordering::SeqCst);
        // Bound and validate raw payload before retaining even a hash/ticket.
        let limit = if matches!(command, Command::Import { .. } | Command::Restore { .. }) {
            DOCUMENT_BYTES + 1024
        } else {
            COMMAND_BYTES
        };
        ingress::check_envelope(self.scratch.serialize(command, limit)?, limit)?;
        let t = Ticket {
            session: session.into(),
            expected,
            hash: self.scratch.digest(command)?,
            expires: now_ms
                .checked_add(120_000)
                .ok_or_else(|| fail("TIME_UNREPRESENTABLE", "ticket deadline overflow"))?,
            fence,
        };
        let id = uuid::Uuid::new_v4().to_string();
        self.tickets.insert(id.clone(), t);
        Ok(id)
    }
    fn receipt(&self, ticket: &str) -> Option<&Receipt> {
        let cutoff = wall_time_ms().saturating_sub(RECEIPT_TTL_MS);
        self.state
            .receipts
            .iter()
            .chain(self.volatile.iter())
            .find(|r| r.ticket == ticket && r.completed_at_ms.0 >= cutoff)
    }
    pub fn status(&self, session: &str, ticket: &str) -> Result<Status> {
        self.reader(session)?;
        Ok(if let Some(r) = self.receipt(ticket) {
            Status::Terminal(r.clone())
        } else if self.tickets.contains_key(ticket) {
            Status::Issued
        } else {
            Status::Unknown
        })
    }
    pub fn submit(
        &mut self,
        session: &str,
        id: &str,
        command: &Command,
        now_ms: u64,
    ) -> Result<Receipt> {
        self.reader(session)?;
        let payload_hash = self.scratch.digest(command)?;
        // Historical outcomes precede current revision/grant checks, but require read access.
        if let Some(r) = self.receipt(id) {
            if r.payload_hash != payload_hash {
                return Err(fail("PAYLOAD_MISMATCH", "ticket cannot be rebound"));
            }
            return Ok(r.clone());
        }
        if self.read_only {
            return Err(fail(
                "RECOVERY_REQUIRED",
                "uncertain save: writes disabled until recovery",
            ));
        }
        let t = self.tickets.get(id).cloned().ok_or_else(|| {
            fail(
                "OUTCOME_EXPIRED_OR_UNKNOWN",
                "unknown/previous-boot ticket never executes",
            )
        })?;
        if t.hash != payload_hash || t.session != session {
            return Err(fail(
                "PAYLOAD_MISMATCH",
                "ticket is bound to another payload/session",
            ));
        }
        if now_ms > t.expires {
            self.tickets.remove(id);
            return Err(fail(
                "OUTCOME_EXPIRED_OR_UNKNOWN",
                "ticket admission expired",
            ));
        }
        let history_ok = match command {
            Command::Restore {
                document,
                history_entry,
            } => self
                .undo
                .back()
                .is_some_and(|e| &e.cursor == history_entry && &e.document == document),
            _ => true,
        };
        let candidate = if !history_ok {
            Err(fail(
                "UNDO_CONFLICT",
                "history entry changed; request current undo",
            ))
        } else if self.state.revision != t.expected {
            Err(fail(
                "REVISION_CONFLICT",
                "inspect current state and issue a fresh command",
            ))
        } else {
            commands::apply_with_scratch(&self.state.document, command, &mut self.scratch)
        };
        // This SeqCst load is the commit authorization point. Revocation ordered
        // after it cannot undo the authored commit, but still fences later takes.
        let s = self.reader(session)?;
        let candidate = if !s.author || s.fence.0.load(Ordering::SeqCst) != t.fence {
            Err(fail(
                "FORBIDDEN",
                "grant revoked before commit authorization",
            ))
        } else {
            candidate
        };
        let (revision, document, outcome) =
            match candidate {
                Ok(d) => (
                    Counter(self.state.revision.0.checked_add(1).ok_or_else(|| {
                        fail("REVISION_EXHAUSTED", "new document lineage required")
                    })?),
                    d,
                    Outcome::Saved,
                ),
                Err(e) => (
                    self.state.revision,
                    self.state.document.clone(),
                    Outcome::Rejected(e),
                ),
            };
        let receipt = Receipt {
            ticket: id.into(),
            payload_hash,
            revision,
            digest: self.scratch.digest(&document)?,
            outcome,
            completed_at_ms: Counter(wall_time_ms()),
        };
        let record = Record {
            cursor: Counter(
                self.state
                    .cursor
                    .0
                    .checked_add(1)
                    .ok_or_else(|| fail("CURSOR_EXHAUSTED", "new lineage required"))?,
            ),
            base_revision: self.state.revision,
            command: if receipt.outcome == Outcome::Saved {
                Some(command.clone())
            } else {
                None
            },
            receipt: receipt.clone(),
        };
        // Admission/accounting must be complete before durable append. No fallible
        // history work is allowed after ACK, and failed IO cannot evict undo.
        let previous_weight =
            if receipt.outcome == Outcome::Saved && !matches!(command, Command::Restore { .. }) {
                Some(retention::measure(&self.state.document)?)
            } else {
                None
            };
        let mut next = Snapshot {
            schema: self.state.schema.clone(),
            cursor: record.cursor,
            revision,
            document,
            receipts: self.state.receipts.clone(),
        };
        next.retain_with_scratch(receipt.clone(), &mut self.scratch)?;
        match self.storage.append(&record) {
            Ok(()) => {
                let previous = std::mem::replace(&mut self.state, next);
                if receipt.outcome == Outcome::Saved {
                    if matches!(command, Command::Restore { .. }) {
                        if let Some(e) = self.undo.pop_back() {
                            self.release_history(e.weight);
                        }
                    } else if let Some(weight) = previous_weight {
                        // Evict before retaining the previous document. Move its
                        // allocation into history instead of making another copy.
                        while self.undo.len() >= HISTORY_ENTRIES
                            || self.history_weight.encoded_bytes + weight.encoded_bytes
                                > HISTORY_BYTES
                            || self.history_weight.structural_units + weight.structural_units
                                > HISTORY_UNITS
                        {
                            let e = self
                                .undo
                                .pop_front()
                                .expect("single admitted document fits history");
                            self.release_history(e.weight);
                        }
                        self.history_weight.encoded_bytes += weight.encoded_bytes;
                        self.history_weight.structural_units += weight.structural_units;
                        self.undo.push_back(HistoryEntry {
                            cursor: previous.cursor,
                            document: previous.document,
                            weight,
                        });
                    }
                }
                self.tickets.remove(id);
                Ok(receipt)
            }
            Err(AppendError::NotWritten(e)) => {
                self.tickets.remove(id);
                let r = Receipt {
                    revision: self.state.revision,
                    digest: self.scratch.digest(&self.state.document)?,
                    outcome: Outcome::Rejected(bounded_storage_error(e)),
                    ..receipt
                };
                self.volatile.push_back(r.clone());
                while self.volatile.len() > 256 {
                    self.volatile.pop_front();
                }
                Ok(r)
            }
            Err(AppendError::Unknown(e)) => {
                self.read_only = true;
                Err(fail(
                    "SAVE_OUTCOME_UNKNOWN",
                    &bounded_storage_error(e).message,
                ))
            }
        }
    }
    fn release_history(&mut self, weight: Weight) {
        self.history_weight.encoded_bytes -= weight.encoded_bytes;
        self.history_weight.structural_units -= weight.structural_units;
    }
    pub fn history_status(&self, session: &str) -> Result<HistoryStatus> {
        self.reader(session)?;
        Ok(HistoryStatus {
            entries: self.undo.len(),
            encoded_bytes: self.history_weight.encoded_bytes,
            structural_units: self.history_weight.structural_units,
            max_entries: HISTORY_ENTRIES,
            max_encoded_bytes: HISTORY_BYTES,
            max_structural_units: HISTORY_UNITS,
        })
    }
    pub fn undo_command(&self, session: &str) -> Result<Command> {
        self.reader(session)?;
        let e = self.undo.back().ok_or_else(|| {
            fail(
                "UNDO_UNAVAILABLE",
                "bounded current-session history unavailable",
            )
        })?;
        Ok(Command::Restore {
            document: e.document.clone(),
            history_entry: e.cursor,
        })
    }
    pub fn checkpoint(&mut self, session: &str) -> Result<()> {
        let s = self.reader(session)?;
        if !s.author || s.fence.0.load(Ordering::SeqCst) != 1 || self.read_only {
            return Err(fail(
                "FORBIDDEN",
                "checkpoint requires current author grant and known save state",
            ));
        }
        self.storage.checkpoint(&self.state)
    }
}
