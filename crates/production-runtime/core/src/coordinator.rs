//! Serialized control-lane document authority. Render/audio never borrow it.
use crate::{
    commands::{self, Command},
    contract::*,
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
    fn disconnect(&self) {
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

pub struct Coordinator<S: Storage> {
    pub state: Snapshot,
    pub storage: S,
    pub boot: String,
    sessions: BTreeMap<String, Session>,
    tickets: BTreeMap<String, Ticket>,
    volatile: VecDeque<Receipt>,
    undo: VecDeque<(Counter, Document)>,
    pub read_only: bool,
}
fn fail(code: &str, message: &str) -> Error {
    Error::new(code, "coordinator", message)
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
        // Bound and validate raw payload before retaining even a hash/ticket.
        let bytes = serde_json::to_vec(command).map_err(|e| fail("STRUCTURE", &e.to_string()))?;
        ingress::parse_envelope(
            &bytes,
            if matches!(command, Command::Import { .. } | Command::Restore { .. }) {
                DOCUMENT_BYTES + 1024
            } else {
                COMMAND_BYTES
            },
        )?;
        let t = Ticket {
            session: session.into(),
            expected,
            hash: digest(command)?,
            expires: now_ms
                .checked_add(120_000)
                .ok_or_else(|| fail("TIME_UNREPRESENTABLE", "ticket deadline overflow"))?,
            fence: s.fence.0.load(Ordering::SeqCst),
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
        let payload_hash = digest(command)?;
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
                .is_some_and(|(cursor, d)| cursor == history_entry && d == document),
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
            commands::apply(&self.state.document, command)
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
            digest: digest(&document)?,
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
        let mut next = self.state.clone();
        next.document = document;
        next.revision = revision;
        next.cursor = record.cursor;
        next.retain(receipt.clone())?;
        match self.storage.append(&record) {
            Ok(()) => {
                if receipt.outcome == Outcome::Saved {
                    if matches!(command, Command::Restore { .. }) {
                        self.undo.pop_back();
                    } else {
                        self.undo
                            .push_back((self.state.cursor, self.state.document.clone()));
                    }
                    while self.undo.len() > 16 {
                        self.undo.pop_front();
                    }
                }
                self.state = next;
                self.tickets.remove(id);
                Ok(receipt)
            }
            Err(AppendError::NotWritten(e)) => {
                self.tickets.remove(id);
                let r = Receipt {
                    revision: self.state.revision,
                    digest: digest(&self.state.document)?,
                    outcome: Outcome::Rejected(e),
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
                Err(fail("SAVE_OUTCOME_UNKNOWN", &e.message))
            }
        }
    }
    pub fn undo_command(&self, session: &str) -> Result<Command> {
        self.reader(session)?;
        let (history_entry, d) = self.undo.back().cloned().ok_or_else(|| {
            fail(
                "UNDO_UNAVAILABLE",
                "bounded current-session history unavailable",
            )
        })?;
        Ok(Command::Restore {
            document: d,
            history_entry,
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
