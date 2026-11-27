use super::*;
use crate::assistant::{self, Reply, Turn};
use crate::assistant_image::Attachment;
use crate::model::SetLayoutPair;
use anyhow::{bail, Context as AnyContext, Result};
use producer_production_contract::Set;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
enum Proposal {
    Set {
        id: String,
        old: Set,
        draft: Set,
        layout: SetLayoutPair,
    },
    Room {
        revision: u64,
        previews: Vec<(String, rune::Pixels, rune::Pixels)>,
        command: RoomCommand,
    },
}
fn request(handle: &Handle, c: RoomCommand) -> Result<()> {
    let reply = handle.request(c)?;
    if reply["ok"] != true {
        bail!(
            "{}",
            reply["error"].as_str().unwrap_or("Studio rejected edit")
        )
    }
    Ok(())
}
fn prepare(
    room_root: &std::path::Path,
    s: &Snapshot,
    id: &str,
    pair: &SetLayoutPair,
    reply: &Reply,
    candidate: &mut Option<Value>,
    base: &Value,
    turn: &assistant::Turn,
) -> Result<Option<Proposal>> {
    if let Some(v) = &reply.room_command {
        *candidate = Some(v.clone());
        let mut previews = Vec::new();
        let command = if matches!(v["op"].as_str(), Some("authorSet" | "editAuthoredSet" | "recoverAuthoredSet")) {
            let candidate = crate::authored_set::prepare(&s.project, v.clone())?;
            let mut project = s.project.clone();
            candidate.install(&mut project)?;
            let id = candidate.id();
            crate::render_graph::inspect(&project.production.sets[id])?;
            let scratch = tempfile::tempdir()?;
            for (label, dir) in crate::posters::authored_pairs_in(room_root,&project,id,scratch.path(),384,|label| {
                turn.check()?;
                turn.step(&format!("Render {label}"));
                Ok(())
            })? {
                let thumbnail = |file: &str| -> Result<rune::Pixels> {
                    let bitmap = image::open(dir.join(file))?.to_rgba8();
                    let pixels = rune::Pixels::new();
                    pixels.set(bitmap.width(),bitmap.height(),bitmap.into_raw());
                    Ok(pixels)
                };
                previews.push((label,thumbnail("landscape.png")?,thumbnail("portrait.png")?));
            }
            turn.record("rehearsal", serde_json::from_slice(&std::fs::read(scratch.path().join("rehearsal.json"))?)?)?;
            RoomCommand::ApplyAuthoredDesign { revision: s.revision, candidate: Arc::new(candidate) }
        } else {
            let command = assistant::room_action(v.clone())?;
            match &command {
                RoomCommand::Workspace { command } => { s.project.workspace.clone().apply_studio(command.clone())?; }
                RoomCommand::CameraGrade { source, grade } => s.project.validate_grade(source, *grade)?,
                RoomCommand::Document { command: transaction } => {
                    let mut project = s.project.clone();
                    project.command(transaction.clone())?;
                    for (id, set) in &project.production.sets {
                        if s.project.production.sets.get(id) != Some(set) {
                            crate::render_graph::inspect(set)?;
                        }
                    }
                }
                _ => {}
            }
            command
        };
        return Ok(Some(Proposal::Room {
            revision: s.revision,
            previews,
            command,
        }));
    }
    if reply.edits.is_empty() {
        return Ok(None);
    }
    let old = s
        .project
        .production
        .sets
        .get(id)
        .context("Select a set first")?
        .clone();
    let value = candidate.insert(if base.is_null() { serde_json::to_value(&old)? } else { base.clone() });
    for (i, edit) in reply.edits.iter().enumerate() {
        assistant::apply_edit(value, edit)
            .with_context(|| format!("Edit {} at {}", i + 1, edit.path))?;
    }
    let draft: Set = serde_json::from_value(value.clone())?;
    let choices = s.project.draft_layout_choices(id, &draft);
    let pair = choices
        .iter()
        .find(|c| {
            c.pair
                .ids()
                .iter()
                .any(|key| !old.layouts.contains_key(*key))
        })
        .or_else(|| choices.iter().find(|c| &c.pair == pair))
        .or_else(|| choices.first())
        .context("Draft needs a landscape and portrait preview")?;
    let pair = &pair.pair;
    turn.step("Check render graphs");
    crate::render_graph::inspect(&draft)?;
    let mut candidate_project = engine::set_edit_project(&s.project, id, &draft)?;
    candidate_project.mount_set(Some(id.into()), Some(pair.clone()))?;
    candidate_project.live_set()?.compile()?;
    Ok(Some(Proposal::Set {
        id: id.into(),
        old,
        draft,
        layout: pair.clone(),
    }))
}

struct Answer {
    reply: Reply,
    candidate: Option<Proposal>,
}

#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum Account {
    #[default]
    Unchecked,
    Checking,
    Connected,
    Disconnected,
    Waiting,
    Unavailable,
}
impl Account {
    fn label(self) -> &'static str {
        match self {
            Self::Unchecked | Self::Checking => "Checking account…",
            Self::Connected => "ChatGPT connected",
            Self::Disconnected => "Connect ChatGPT",
            Self::Waiting => "Signing in…",
            Self::Unavailable => "Retry account check",
        }
    }
}

fn receive<T>(job: &mut Option<mpsc::Receiver<Result<T>>>, ended: &str) -> Option<Result<T>> {
    let result = match job.as_ref()?.try_recv() {
        Ok(value) => value,
        Err(mpsc::TryRecvError::Empty) => return None,
        Err(mpsc::TryRecvError::Disconnected) => Err(anyhow::anyhow!("{ended}")),
    };
    *job = None;
    Some(result)
}

#[derive(Default)]
pub(super) struct Chat {
    pub input: TextEdit,
    history: Vec<(String, String)>,
    proposal: Option<Proposal>,
    chips: Vec<assistant::Chip>,
    receipts: BTreeMap<usize, Arc<Turn>>,
    expanded_checks: BTreeSet<usize>,
    started: Option<Instant>,
    status: String,
    progress: String,
    account: Account,
    account_job: Option<mpsc::Receiver<Result<(bool, bool, Option<String>)>>>,
    account_retry: Option<Instant>,
    account_error: String,
    log_job: Option<mpsc::Receiver<Result<()>>>,
    attachment_job: Option<mpsc::Receiver<Result<Attachment>>>,
    attachments: Vec<Attachment>,
    attachment_menu: bool,
    picking_image: bool,
    requested_review: bool,
    applying: Option<mpsc::Receiver<Result<Option<String>>>>,
    saved_authored_set: Option<String>,
    room_reviewed: bool,
    turn: Option<Arc<Turn>>,
    generation: u64,
    rx: Option<mpsc::Receiver<Result<Answer>>>,
}
impl Chat {
    pub(super) fn busy(&self) -> bool {
        self.turn.is_some() || self.applying.is_some() || self.requested_review
    }
    fn latest(&self) -> Option<&Turn> {
        self.receipts.values().next_back().map(Arc::as_ref)
    }
    fn check_account(&mut self, connect: bool) {
        self.account_action(move || {
            if connect { assistant::connect().map(|_| ()) } else { Ok(()) }
        });
    }
    fn account_action(&mut self, operation: impl FnOnce() -> Result<()> + Send + 'static) {
        if self.account_job.is_some() {
            return;
        }
        self.account_retry = None;
        self.account_error.clear();
        self.account = Account::Checking;
        let (tx, rx) = mpsc::channel();
        self.account_job = Some(rx);
        std::thread::spawn(move || {
            let _ = tx.send(operation().and_then(|_| assistant::account_status()));
        });
    }
    fn start(&mut self, live: &Live, selected: Option<(String, SetLayoutPair)>) {
        if self.busy() || self.picking_image || self.attachment_job.is_some() {
            return;
        }
        let mut prompt = self.input.text.trim().to_owned();
        if prompt.is_empty() {
            if self.attachments.is_empty() {
                return;
            }
            prompt = if self.attachments.iter().any(|image| image.asset.is_some()) {
                "Place the attached production image in the set."
            } else {
                "Suggest a set design inspired by the attached image."
            }
            .into();
        }
        if prompt.len() > 4096 {
            self.status = "Shorten the prompt to 4,096 bytes and try again.".into();
            return;
        }
        let snapshot = live.handle.snapshot();
        let (id, pair) = selected
            .filter(|(id, _)| snapshot.project.production.sets.contains_key(id))
            .or_else(|| {
                snapshot.project.mounted_set.clone().map(|id| {
                    let pair = snapshot
                        .project
                        .mounted_layout
                        .clone()
                        .unwrap_or_else(|| snapshot.project.default_set_selection(&id));
                    (id, pair)
                })
            })
            .unwrap_or_default();
        self.room_reviewed = false;
        self.generation += 1;
        let mut turn = Turn::new(self.generation);
        match crate::assistant_log::Journal::start(
            &live.handle.root,
            self.generation,
            json!({"setId":id,"prompt":prompt,"layout":pair,"scene":snapshot.project.active_scene,
                "roomRevision":snapshot.revision,"build":env!("CARGO_PKG_VERSION"),
                "attachments":self.attachments.iter().map(|image| json!({
                    "name":image.name,"assetId":image.asset.as_ref().map(|(id,_)| id)
                })).collect::<Vec<_>>()}),
        ) {
            Ok(j) => turn.journal = Some(j),
            Err(e) => {
                self.status = format!("{e:#}");
                return;
            }
        }
        let attachments = std::mem::take(&mut self.attachments);
        turn.attachment_labels = attachments
            .iter()
            .map(|image| {
                format!(
                    "{} · {}",
                    if image.asset.is_some() {
                        "Set asset"
                    } else {
                        "Inspiration"
                    },
                    image.name
                )
            })
            .collect();
        self.attachment_menu = false;
        self.history.push(("user".into(), prompt.to_owned()));
        self.input = TextEdit::new("");
        self.proposal = None;
        self.saved_authored_set = None;
        let turn = Arc::new(turn);
        self.turn = Some(turn.clone());
        self.receipts.insert(self.history.len() - 1, turn.clone());
        self.started = Some(Instant::now());
        self.chips.clear();
        self.status.clear();
        self.progress = "Connecting to ChatGPT".into();
        let snap = snapshot;
        let handle = live.handle.clone();
        let history = self.history[self.history.len().saturating_sub(24)..].to_vec();
        let (tx, rx) = mpsc::channel();
        self.rx = Some(rx);
        std::thread::spawn(move || {
            let result = (|| -> Result<Answer> {
                let mut ctx = assistant::context(&snap, &id);
                ctx["layout"] = json!(pair);
                ctx["attachmentContent"] =
                    Value::Array(attachments.iter().flat_map(Attachment::content).collect());
                let desk = &handle.studio_audio;
                ctx["audioStatus"] = json!(desk.status());
                let count = desk.catalog(None, "", 0, 0).total;
                let audio = (0..count)
                    .step_by(64)
                    .flat_map(|offset| desk.catalog(None, "", offset, 64).items)
                    .collect::<Vec<_>>();
                ctx["resources"]["audio"] = json!(audio);
                let mut history = history;
                for attempt in 1..=2 {
                    turn.check()?;
                    turn.record("authoring_attempt", json!({"attempt":attempt}))?;
                    let reply = assistant::turn(&handle.root, &snap.project, &ctx, &history, &turn)?;
                    turn.check()?;
                    turn.record("proposal", json!({"attempt":attempt,"reply":reply}))?;
                    turn.step(if reply.room_command.is_some() {
                        "Validate studio change"
                    } else if reply.edits.is_empty() {
                        "Read reply"
                    } else {
                        "Prepare set draft"
                    });
                    let mut candidate = None;
                    match prepare(
                        &handle.root,
                        &snap,
                        &id,
                        &pair,
                        &reply,
                        &mut candidate,
                        &ctx["set"],
                        &turn,
                    ) {
                        Ok(p) => {
                            turn.check()?;
                            anyhow::ensure!(
                                attempt == 1 || p.is_some(),
                                "Repair returned no edits"
                            );
                            if p.is_some() {
                                turn.record("validation_passed", json!({"attempt":attempt}))?;
                            }
                            return Ok(Answer {
                                reply,
                                candidate: p,
                            });
                        }
                        Err(e) if attempt == 1 && !turn.recovered() => {
                            turn.step("Repair draft");
                            turn.record(
                                "validation_failed",
                                json!({"attempt":attempt,"error":e.to_string()}),
                            )?;
                            if reply.room_command.is_none() {
                                if let Some(doc) = candidate {
                                    ctx["set"] = doc;
                                }
                            }
                            if let Some(command) = reply.room_command.as_ref().filter(|v|matches!(v["op"].as_str(),Some("authorSet"|"editAuthoredSet"|"recoverAuthoredSet"))) {
                                ctx["resources"]["failedProposal"] = command.clone();
                                history.push(("validator".into(),format!("Validation failed: {e:#}. Your previous proposal is retained locally. Inspect failedProposal by JSON pointer as needed. Return room_command {{op:'repairProposal',edits:[...]}} with add/replace/remove patches relative to the retained command, or return a full corrected proposal.")));
                            } else {
                                history.push(("validator".into(),format!("Validation failed: {e:#}. Correct the proposed edits against the supplied draft.")));
                            }
                        }
                        Err(e) => return Err(e),
                    }
                }
                unreachable!()
            })();
            let err = result.as_ref().err().map(|e| format!("{e:#}"));
            turn.finish(err.as_deref());
            let stop = turn.stop_reason();
            let (outcome, error) = match &stop {
                Some((outcome, reason)) => (*outcome, Some(reason.as_str())),
                None => (
                    if err.is_some() { "failed" } else if turn.recovered() { "recovered" } else { "completed" },
                    err.as_deref(),
                ),
            };
            let receipt = turn.finish_log(outcome, error);
            let _ = tx.send(receipt.context("Finalize assistant log").and(result));
        });
    }
    fn cancel(&mut self, status: &str, outcome: &'static str) {
        if let Some(turn) = self.turn.take() {
            let reason = status.to_owned();
            turn.stop(outcome, status);
            std::thread::spawn(move || {
                let _ = turn.finish_log(outcome, Some(&reason));
            });
            self.generation += 1;
        }
        self.rx = None;
        self.started = None;
        self.progress.clear();
        self.status = status.into();
    }
    fn review(&mut self) -> bool {
        if self.busy() {
            return false;
        }
        match &self.proposal {
            Some(Proposal::Set { .. }) => {
                self.requested_review = true;
                true
            }
            Some(Proposal::Room { .. }) => {
                self.room_reviewed = true;
                true
            }
            None => false,
        }
    }
    pub(super) fn take_review(&mut self, live: &Live) -> Option<super::editor::Editor> {
        if !std::mem::take(&mut self.requested_review) {
            return None;
        }
        let Some(Proposal::Set {
            id,
            old,
            draft,
            layout,
        }) = &self.proposal
        else {
            return None;
        };
        match super::editor::assistant_draft(
            live,
            id.clone(),
            old.clone(),
            draft.clone(),
            layout.clone(),
        ) {
            Ok(editor) => {
                self.status.clear();
                Some(editor)
            }
            Err(e) => {
                self.status = e.to_string();
                None
            }
        }
    }
    pub(super) fn saved_set(&mut self) {
        self.proposal = None;
        self.saved_authored_set = None;
        self.status = "Saved to studio".into();
    }
    fn apply(&mut self, live: &Live) {
        if self.busy() {
            return;
        }
        let Some(Proposal::Room { revision, command, .. }) = &self.proposal else {
            return;
        };
        if !self.room_reviewed {
            return;
        }
        let (revision, cmd) = (*revision, command.clone());
        let saved = match &cmd {
            RoomCommand::ApplyAuthoredDesign { candidate, .. } => Some(candidate.id().to_owned()),
            _ => None,
        };
        let h = live.handle.clone();
        let (tx, rx) = mpsc::channel();
        self.applying = Some(rx);
        self.status = "Saving to studio…".into();
        std::thread::spawn(move || {
            let result = (|| -> Result<Option<String>> {
                anyhow::ensure!(
                    h.snapshot().revision == revision,
                    "Studio changed. Ask for a fresh proposal."
                );
                request(&h, cmd)?;
                Ok(saved)
            })();
            let _ = tx.send(result);
        });
    }
    fn open_logs(&mut self, live: &Live, index: Option<usize>) {
        if self.log_job.is_some() {
            return;
        }
        let mut path = crate::assistant_log::directory(&live.handle.root);
        if let Some(id) = index
            .and_then(|i| self.receipts.get(&i))
            .and_then(|turn| turn.journal.as_ref())
            .map(|journal| &journal.id)
        {
            path.push(format!("{id}.jsonl"));
        }
        let (tx, rx) = mpsc::channel();
        self.log_job = Some(rx);
        std::thread::spawn(move || {
            let result = (|| -> Result<()> {
                anyhow::ensure!(
                    path.exists(),
                    "No assistant turns logged in this studio yet."
                );
                let mut command = std::process::Command::new("/usr/bin/open");
                if path.is_file() {
                    command.arg("-t");
                }
                anyhow::ensure!(
                    command.arg(path).status()?.success(),
                    "Could not open the assistant logs."
                );
                Ok(())
            })();
            let _ = tx.send(result);
        });
    }
    fn choose_image(&mut self, live: &Live, path: PathBuf, production: bool) {
        let handle = live.handle.clone();
        let (tx, rx) = mpsc::channel();
        self.attachment_job = Some(rx);
        std::thread::spawn(move || {
            let result = (|| -> Result<Attachment> {
                let image = crate::assistant_image::load(path, production, &handle.root)?;
                if let Some((id, asset)) = &image.asset {
                    use producer_production_core::commands::{Command, Operation};
                    if handle.snapshot().project.production.assets.get(id) != Some(asset) {
                        let result = request(
                            &handle,
                            RoomCommand::Document {
                                command: Command::Transaction {
                                    operations: vec![Operation::AddAsset {
                                        id: id.clone(),
                                        value: asset.clone(),
                                    }],
                                },
                            },
                        );
                        if result.is_err()
                            && handle.snapshot().project.production.assets.get(id) != Some(asset)
                        {
                            result?;
                        }
                    }
                }
                Ok(image)
            })();
            let _ = tx.send(result);
        });
    }
    pub(super) fn tick(
        &mut self,
        live: &Live,
        editor: Option<&super::editor::Editor>,
        visible: bool,
        selected: Option<(String, SetLayoutPair)>,
    ) -> bool {
        let mut changed = false;
        if visible
            && !rune::is_headless()
            && (self.account == Account::Unchecked
                || self
                    .account_retry
                    .is_some_and(|when| Instant::now() >= when))
        {
            self.check_account(false);
            changed = true;
        }
        if let Some(result) = receive(&mut self.account_job, "Assistant account check ended") {
            self.account = match result {
                Ok((true, _, _)) => Account::Connected,
                Ok((false, true, _)) => {
                    self.account_retry = Some(Instant::now() + Duration::from_secs(1));
                    Account::Waiting
                }
                Ok((false, false, error)) => {
                    self.account_error = error.unwrap_or_default();
                    Account::Disconnected
                }
                Err(e) => {
                    self.account_error = e.to_string();
                    Account::Unavailable
                }
            };
            changed = true;
        }
        if let Some(result) = receive(&mut self.attachment_job, "Assistant image import ended") {
            match result {
                Ok(image) => self.attachments.push(image),
                Err(e) => self.status = e.to_string(),
            }
            changed = true;
        }
        if let Some(result) = receive(&mut self.log_job, "Could not open the assistant logs.") {
            if let Err(e) = result {
                self.status = e.to_string();
            }
            changed = true;
        }
        let answer = receive(&mut self.rx, "Assistant connection ended");
        if let Some(reason) = self.turn.as_ref().and_then(|turn| turn.timeout()).filter(|_| answer.is_none()) {
            self.cancel(reason, "timed_out");
            changed = true;
        } else if let Some((started, turn)) = self.started.zip(self.turn.as_ref()) {
            let stage = turn.stage.lock().unwrap();
            let next = format!("{} · {:.1}s", *stage, started.elapsed().as_secs_f32());
            if self.progress != next {
                self.progress = next;
                changed = true;
            }
        }
        if let Some(result) = receive(&mut self.applying, "Assistant save ended") {
            match result {
                Ok(saved) => {
                    self.room_reviewed = false;
                    self.proposal = None;
                    self.status = saved.as_deref().map_or_else(
                        || "Saved to studio".into(),
                        |id| format!("Saved {} to studio", crate::model::set_label(id)),
                    );
                    self.saved_authored_set = saved;
                }
                Err(e) => self.status = e.to_string(),
            }
            changed = true;
        }
        if let Some(result) = answer {
            let turn = self.turn.take();
            self.started = None;
            self.progress.clear();
            match result {
                Ok(a) => {
                    self.chips = a.reply.suggestions;
                    self.history.push(("assistant".into(), a.reply.message));
                    self.proposal = a.candidate;
                    self.status.clear();
                }
                Err(e) => {
                    let error = e.to_string();
                    if let Some(turn) = turn {
                        turn.finish(Some(&error));
                        let cause = error.clone();
                        std::thread::spawn(move || {
                            let _ = turn.finish_log("failed", Some(&cause));
                        });
                    }
                    if error.contains("Connect ChatGPT") {
                        self.account = Account::Disconnected;
                    }
                    self.status = error;
                }
            }
            changed = true;
        }
        let queued = live
            .handle
            .assistant_requests
            .lock()
            .unwrap()
            .drain(..)
            .collect::<Vec<_>>();
        use crate::ipc::AssistantRequest::*;
        for (cmd, tx, received) in queued {
            if received.elapsed() >= Duration::from_secs(3) {
                continue;
            }
            let busy = self.busy() || editor.is_some();
            let reply = match cmd {
                AssistantStatus => {
                    let editor = editor.and_then(super::editor::Editor::assistant_review_state);
                    json!({"ok":true,"generation":self.generation,"busy":busy,"status":if self.progress.is_empty(){&self.status}else{&self.progress},"account":self.account.label(),"reviewReady":self.proposal.is_some(),"editor":editor,
                        "steps":self.latest().map(|t|t.receipt()),"logTurnId":self.latest().and_then(|t|t.journal.as_ref()).map(|j|&j.id),
                        "modelCalls":self.latest().map(|t|t.calls.load(Ordering::Relaxed)),
                        "reply":self.history.last().filter(|(role,_)|role=="assistant").map(|(_,msg)|msg)})
                }
                AssistantReview { generation }
                    if generation == self.generation && !busy && self.review() =>
                {
                    changed = true;
                    json!({"ok":true,"status":self.status})
                }
                AssistantStop { generation }
                    if generation == self.generation && self.turn.is_some() =>
                {
                    self.cancel("Stopped", "cancelled");
                    changed = true;
                    json!({"ok":true})
                }
                AssistantSend { prompt }
                    if !busy && !prompt.trim().is_empty() && prompt.len() <= 4096 =>
                {
                    self.input = TextEdit::new(prompt);
                    self.start(live, selected.clone());
                    changed = true;
                    json!({"ok":self.turn.is_some(),"generation":self.generation})
                }
                _ => json!({"ok":false,"error":"Request is stale, busy, or invalid"}),
            };
            let _ = tx.send(reply);
        }
        changed
    }
}
impl Drop for Chat {
    fn drop(&mut self) {
        if self.turn.is_some() {
            self.cancel("Studio closed", "cancelled");
        }
    }
}

pub(super) fn target(s: &Studio, p: &crate::model::RoomProject) -> Option<(String, SetLayoutPair)> {
    let (id, pair) = super::editor::selection(s, p)?;
    let selected = s
        .set_selection
        .as_ref()
        .is_some_and(|selection| selection.scene == p.active_scene && selection.set == id);
    if selected {
        return Some((id, pair));
    }
    (p.mounted_set.as_ref() == Some(&id)).then(|| (id, p.mounted_layout.clone().unwrap_or(pair)))
}

fn submit(s: &mut Studio, compact: bool) {
    if let Some(live) = &s.live {
        let selected = target(s, &live.snapshot.project);
        s.chat.start(live, selected);
        if compact && s.chat.turn.is_some() {
            s.show_chat = true;
        }
    }
}

pub(super) fn close_popout(s: &mut Studio) {
    s.show_chat = false;
    s.chat.attachment_menu = false;
}

const LINE: u32 = 0x273746;

fn paragraph(value: &str, size: f32, ink: u32) -> El {
    text(value.to_owned())
        .font(TextStyle::new(size, 475.))
        .color(color(ink))
        .wrap()
        .min_w(0.)
}

fn action(
    key: impl Into<String>,
    label: impl Into<String>,
    active: bool,
    press: impl Fn(&mut Studio) + 'static,
) -> El {
    button(key, label, active, press)
        .h(24.)
        .hover_fill(color(if active { 0x245047 } else { 0x223542 }))
}

fn composer(s: &Studio, compact: bool) -> El {
    let chat = &s.chat;
    let editing = chat.picking_image || chat.attachment_job.is_some();
    let enabled = !chat.busy()
        && !editing
        && (!chat.input.text.trim().is_empty() || !chat.attachments.is_empty());
    let mut input = field(
        if compact {
            "assistant-quick"
        } else {
            "assistant-input"
        },
        &chat.input,
        |s| &mut s.chat.input,
    )
    .on_submit(move |s: &mut Studio, _| submit(s, compact))
    .w(0.)
    .grow(1.)
    .h(28.)
    .border(1., color(LINE));
    if s.show_chat && !compact {
        input = input.autofocus();
    }
    let send = if chat.turn.is_some() {
        super::panels::tool("stop-turn", "stop", "Stop request", false, |s| {
            s.chat.cancel("Stopped", "cancelled")
        })
    } else {
        super::panels::tool(
            if compact {
                "assistant-send"
            } else {
                "send-turn"
            },
            "stage-in",
            "Send message",
            enabled,
            move |s| submit(s, compact),
        )
        .disabled(!enabled)
    }
    .size(28., 28.);
    row()
        .key(if compact {
            "assistant-inline-composer"
        } else {
            "assistant-composer"
        })
        .gap(5.)
        .items_center()
        .min_w(0.)
        .grow(1.)
        .child(input)
        .child(send)
}

pub(super) fn compact(s: &Studio) -> El {
    let label = if s.chat.turn.is_some() {
        "Working…"
    } else if s.chat.proposal.is_some() {
        "Review draft"
    } else {
        "Assistant"
    };
    let trigger = action("assistant-open", label, s.show_chat, |s| {
        if s.show_chat {
            close_popout(s);
        } else {
            s.show_chat = true;
        }
    })
    .help("Open Assistant conversation");
    let bar = row().h(34.).items_center().gap(5.).min_w(0.).child(trigger);
    if s.show_chat {
        bar
    } else {
        bar.child(composer(s, true))
    }
}

pub(super) fn popout(s: &Studio, workspace: &crate::workspace::Workspace) -> Option<El> {
    let assistant = &workspace.panels[&PanelId::Assistant];
    let dock = &workspace.docks[&assistant.edge];
    if !s.show_chat
        || s.editing_docks
        || !assistant.visible
        || assistant.edge.side()
        || !dock.collapsed
        || dock.hidden
    {
        return None;
    }
    let side = if assistant.edge == Edge::Bottom {
        rune::Side::Top
    } else {
        rune::Side::Bottom
    };
    Some(
        col()
            .key("assistant-popout")
            .role("dialog")
            .label("Studio Assistant")
            .anchored_fit("assistant-open", side, rune::Align::Start, 7.)
            .size(390., 580.)
            .radius(10.)
            .clip_rounded(10.)
            .border(1., color(LINE))
            .fill(color(PANEL))
            .modal(true, close_popout)
            .focus_return("assistant-open")
            .child(panel(s, true)),
    )
}

fn attachment_choice(key: &str, label: &str, production: bool) -> El {
    el().key(key.to_string())
        .role("button")
        .label(label.to_string())
        .focusable(true)
        .px(8.)
        .h(24.)
        .center()
        .radius(5.)
        .fill(color(SURFACE))
        .hover_fill(color(0x223542))
        .child(title(label, 11., 500., TEXT))
        .on_press_tx(move |s: &mut Studio, tx| {
            let Some(handle) = s.live.as_ref().map(|live| live.handle.clone()) else {
                return;
            };
            if s.chat.busy()
                || s.chat.picking_image
                || s.chat.attachment_job.is_some()
                || s.chat.attachments.len() >= 3
            {
                return;
            }
            s.chat.attachment_menu = false;
            s.chat.picking_image = true;
            tx.open_file(
                rune::FileDialogOptions::default()
                    .filter("Image", &["png", "jpg", "jpeg", "webp", "gif"]),
                move |s: &mut Studio, result, _| {
                    let Some(live) = &s.live else { return };
                    if !Arc::ptr_eq(&handle, &live.handle) {
                        return;
                    }
                    s.chat.picking_image = false;
                    match result {
                        Ok(Some(path)) => s.chat.choose_image(live, path, production),
                        Ok(None) => {}
                        Err(e) => s.chat.status = e.to_string(),
                    }
                },
            );
        })
}

fn context_check(step: &Value) -> bool {
    let label = step["label"].as_str().unwrap_or_default();
    step["state"] != "failed"
        && (label.starts_with("Inspect ")
            || matches!(label, "Read ChatGPT account" | "Load available models"))
}

fn receipt(chat: &Chat, index: usize, turn: &Turn) -> El {
    let steps = turn.receipt();
    let expanded = chat.expanded_checks.contains(&index);
    let mut stack = col()
        .key(format!("assistant-turn-{index}"))
        .gap(4.)
        .min_w(0.)
        .px(5.);
    for label in &turn.attachment_labels {
        stack = stack.child(title(label, 11., 500., MUTED));
    }
    let checks: Vec<_> = steps.iter().filter(|step| context_check(step)).collect();
    let mut controls = row().gap(5.).items_center().min_w(0.);
    if !checks.is_empty() {
        let running = checks.iter().any(|step| step["state"] == "active");
        let ms = checks
            .iter()
            .filter_map(|step| step["ms"].as_u64())
            .sum::<u64>();
        let label = format!(
            "{}  Context checks ({}) · {:.1}s  {}",
            if running { "◌" } else { "✓" },
            checks.len(),
            ms as f64 / 1000.,
            if expanded { "▾" } else { "▸" }
        );
        controls = controls.child(action(
            format!("assistant-context-checks-{index}"),
            label,
            expanded,
            move |s| {
                if !s.chat.expanded_checks.remove(&index) {
                    s.chat.expanded_checks.insert(index);
                }
            },
        ));
    }
    if turn.journal.is_some() {
        controls = controls.child(
            action(
                format!("assistant-turn-log-{index}"),
                "Log",
                false,
                move |s| {
                    if let Some(live) = &s.live {
                        s.chat.open_logs(live, Some(index));
                    }
                },
            )
            .help("Open this turn's local log"),
        );
    }
    stack = stack.child(controls);
    for (step_index, step) in steps.iter().enumerate() {
        let label = step["label"].as_str().unwrap_or_default();
        if label.starts_with("Model call ") || (!expanded && context_check(step)) {
            continue;
        }
        let (mark, tint) = match step["state"].as_str() {
            Some("failed") => ("×", 0xff9185),
            Some("done") => ("✓", MINT),
            _ => ("◌", MUTED),
        };
        let label = format!(
            "{mark}  {label} · {:.1}s",
            step["ms"].as_u64().unwrap_or_default() as f64 / 1000.
        );
        stack = stack.child(
            paragraph(&label, 11., tint).key(format!("assistant-step-{index}-{step_index}")),
        );
    }
    stack
}

fn proposal_card(s: &Studio) -> Option<El> {
    let chat = &s.chat;
    let proposal = chat.proposal.as_ref()?;
    let (heading, detail) = match proposal {
        Proposal::Set { id, layout, .. } => (
            "Set draft",
            format!(
                "{} · {}",
                crate::model::set_label(id),
                crate::model::set_label(&layout.landscape)
            ),
        ),
        Proposal::Room { previews, .. } if !previews.is_empty() => ("Set draft", format!("{} layouts · Landscape and portrait", previews.len())),
        Proposal::Room { command, .. } => {
            let name = serde_json::to_value(command)
                .ok()
                .and_then(|v| v["op"].as_str().map(str::to_owned))
                .unwrap_or_default();
            let caption = match name.as_str() {
                "addInput" | "configureInput" => "Source configuration",
                "sceneAdd" | "sceneSelect" => "Scene change",
                "scaffoldSet" | "setMount" => "Set selection",
                "workspace" => "Dock layout",
                "studioAudio" => "Studio audio",
                "canvasView" | "canvasSize" => "Studio output",
                _ => "Studio document",
            };
            ("Studio change", caption.to_string())
        }
    };
    let reviewed = chat.room_reviewed;
    let review_label = if matches!(proposal, Proposal::Set { .. }) {
        "Preview set edits"
    } else {
        "Review change"
    };
    let mut card = col()
        .key("assistant-proposal")
        .border(1., color(LINE))
        .radius(8.)
        .fill(color(0x11212a))
        .padding(9.)
        .gap(6.)
        .min_w(0.)
        .child(title(heading, 12., 650., TEXT))
        .child(paragraph(&detail, 11., MUTED));
    if let Proposal::Room { command, previews, .. } = proposal {
        if chat.room_reviewed && !previews.is_empty() {
            card = card.child(paragraph("Test inputs · blue host, amber guest",11.,MUTED));
            for (label,landscape,portrait) in previews {
                card=card.child(title(label,12.,650.,TEXT)).child(row().gap(4.)
                    .child(el().size(136.,77.).pixels_fit(landscape,SurfaceFit::Fit))
                    .child(el().size(44.,77.).pixels_fit(portrait,SurfaceFit::Fit)));
            }
        } else if chat.room_reviewed {
            card = card.child(
                paragraph(
                    &serde_json::to_string_pretty(command).unwrap_or_default(),
                    11.,
                    MUTED,
                )
                .selectable(true),
            );
        }
    }
    let controls = if reviewed {
        row()
            .gap(6.)
            .child(action("apply-proposal", "Apply to studio", true, apply).disabled(chat.busy()))
            .child(
                action("assistant-close-review", "Done reviewing", false, |s| {
                    s.chat.room_reviewed = false;
                })
                .disabled(chat.busy()),
            )
    } else {
        row().gap(6.).child(
            action("review-edits", review_label, false, |s| {
                s.chat.review();
            })
            .disabled(chat.busy()),
        )
    };
    Some(card.child(controls.scroll_x()))
}

fn apply(s: &mut Studio) {
    if let Some(live) = &s.live {
        s.chat.apply(live);
    }
}

fn model_call(chat: &Chat) -> Option<El> {
    let clock = *chat.latest()?.call_clock.lock().unwrap();
    let (number, start, duration) = clock?;
    let elapsed = duration.unwrap_or_else(|| start.elapsed());
    let label = format!("Model call {number}");
    let phase = chat
        .progress
        .strip_prefix(&format!("{label} · "))
        .and_then(|status| status.rsplit_once(" · ").map(|(phase, _)| phase))
        .unwrap_or("");
    Some(
        row()
            .key("assistant-call-indicator")
            .role("status")
            .label(label.clone())
            .h(18.)
            .gap(6.)
            .items_center()
            .min_w(0.)
            .child(title(label, 11., 600., MUTED))
            .child(title(phase, 11., 450., MUTED).grow(1.))
            .child(title(
                format!("{:.1}s", elapsed.as_secs_f32()),
                11.,
                500.,
                MUTED,
            )),
    )
}

pub(super) fn logs_button() -> El {
            action("assistant-logs", "Logs", false, |s| {
                if let Some(live) = &s.live {
                    s.chat.open_logs(live, None);
                }
            })
            .help("Open local assistant logs")
}
pub(super) fn panel(s: &Studio, popout: bool) -> El {
    let chat = &s.chat;
    let mut header = row()
        .key("assistant-header")
        .items_center()
        .gap(5.)
        .h(27.)
        .min_w(0.)
        .child(if popout { title("Studio Assistant", 13., 680., TEXT).grow(1.) } else { el().grow(1.) })
        .child(
            logs_button(),
        );
    if popout {
        header = header.child(
            action("close-chat", "×", false, close_popout)
                .label("Close Assistant conversation")
                .help("Close Assistant conversation"),
        );
    }
    let account = match chat.account {
        Account::Disconnected | Account::Unavailable => {
            let connect = chat.account == Account::Disconnected;
            action(
                "assistant-account-action",
                chat.account.label(),
                connect,
                move |s| s.chat.check_account(connect),
            )
            .self_start()
        }
        Account::Connected => row().gap(5.).items_center()
            .child(title("ChatGPT connected", 11., 500., MINT))
            .child(action("assistant-sign-out", "Sign out", false, |s| {
                s.chat.account_action(assistant::sign_out);
            }).disabled(chat.busy())),
        state => title(
            state.label(),
            11.,
            500.,
            if state == Account::Connected {
                MINT
            } else {
                MUTED
            },
        ),
    };
    let active_set = s
        .live
        .as_ref()
        .and_then(|live| target(s, &live.snapshot.project))
        .map(|(id, _)| id);
    let target = match &chat.proposal {
        Some(Proposal::Set { id, .. }) => Some(id.as_str()),
        _ => active_set.as_deref(),
    };
    let mut top = col().min_w(0.).px(9.).py(6.).gap(4.);
    if popout { top = top.child(header); }
    top = top.child(
        row()
            .items_center()
            .gap(6.)
            .min_w(0.)
            .child(account)
            .child(el().grow(1.))
            .child(title(
                target.map_or_else(|| "Studio".into(), crate::model::set_label),
                11.,
                500.,
                MUTED,
            )),
    );
    if !chat.account_error.is_empty() && chat.account_error != chat.status {
        top = top.child(paragraph(&chat.account_error, 11., MUTED));
    }
    let mut transcript = col().gap(8.).padding(9.).min_w(0.);
    if chat.history.is_empty() {
        transcript = transcript.child(paragraph(
            "What would you like to change in this studio?",
            12.,
            MUTED,
        ));
    }
    for (index, (role, message)) in chat.history.iter().enumerate() {
        let from_user = role == "user";
        let card = col()
            .key(format!("assistant-message-{index}"))
            .gap(4.)
            .padding(8.)
            .min_w(0.)
            .radius(6.)
            .fill(color(if from_user { 0x192b38 } else { 0x101c27 }))
            .child(title(
                if from_user { "You" } else { "Assistant" },
                10.,
                650.,
                if from_user { MINT } else { MUTED },
            ))
            .child(paragraph(message, 13., TEXT).selectable(true));
        transcript = transcript.child(card);
        if let Some(turn) = chat.receipts.get(&index) {
            transcript = transcript.child(receipt(chat, index, turn));
        }
    }
    if !chat.status.is_empty() {
        transcript = transcript.child(
            paragraph(&chat.status, 12., MUTED)
                .key("assistant-status")
                .role("status"),
        );
    }
    if let Some((id, live)) = chat.saved_authored_set.as_ref().zip(s.live.as_ref()) {
        let output = &live.snapshot;
        let project = &output.project;
        if output.program_kind == "set" && project.mounted_set.as_ref() == Some(id) {
            transcript = transcript.child(
                paragraph("On output", 12., MINT)
                    .key("assistant-saved-set-output")
                    .role("status"),
            );
        } else if project.production.sets.contains_key(id) {
            let id = id.clone();
            transcript = transcript.child(
                action("assistant-show-saved-set", "Show on output", true, move |s| {
                    s.set_selection = None;
                    s.send(RoomCommand::SetMount { id: Some(id.clone()), layout: None });
                })
                .self_start()
                .disabled(chat.busy()),
            );
        }
    }
    if !chat.progress.is_empty()
        && !chat.progress.starts_with("Model call ")
        && !chat.progress.starts_with("Inspect ")
    {
        transcript = transcript.child(
            paragraph(&chat.progress, 11., MUTED)
                .key("assistant-progress")
                .role("status"),
        );
    }
    if let Some(card) = proposal_card(s) {
        transcript = transcript.child(card);
    }
    let mut footer = col()
        .key("assistant-footer")
        .min_w(0.)
        .px(9.)
        .py(7.)
        .gap(5.);
    if let Some(call) = model_call(chat) {
        footer = footer.child(call);
    }
    let initial = if target.is_some() {
        [
            ("Refine this Set", "Help me refine this set for my show."),
            ("Add a layout", "Design another layout for this set."),
            (
                "Design live controls",
                "Suggest live controls for this set.",
            ),
        ]
    } else {
        [
            ("Create a Set", "Help me create a set for this studio."),
            ("Plan a show", "Help me plan a show."),
            ("Help me get started", "What can I do in this studio?"),
        ]
    };
    let mut chips = row().key("assistant-suggestions").gap(5.).min_w(0.);
    let suggestions: Vec<_> = if chat.history.is_empty() {
        initial.to_vec()
    } else {
        chat.chips
            .iter()
            .map(|chip| (chip.label.as_str(), chip.prompt.as_str()))
            .collect()
    };
    if !suggestions.is_empty() {
        for (i, (label, prompt)) in suggestions.into_iter().enumerate() {
            let prompt = prompt.to_owned();
            chips = chips.child(action(format!("suggest-{i}"), label, false, move |s| {
                s.chat.input = TextEdit::new(prompt.clone())
            }));
        }
        footer = footer.child(chips.scroll_x());
    }
    for (index, image) in chat.attachments.iter().enumerate() {
        let purpose = if image.asset.is_some() {
            "Set asset"
        } else {
            "Inspiration"
        };
        footer = footer.child(
            row()
                .gap(5.)
                .items_center()
                .min_w(0.)
                .child(title(format!("{purpose} · {}", image.name), 11., 500., MUTED).grow(1.))
                .child(
                    action(
                        format!("assistant-remove-image-{index}"),
                        "×",
                        false,
                        move |s| {
                            if index < s.chat.attachments.len() {
                                s.chat.attachments.remove(index);
                            }
                        },
                    )
                    .label("Remove attachment"),
                ),
        );
    }
    if chat.attachment_menu {
        footer = footer.child(
            row()
                .gap(5.)
                .min_w(0.)
                .child(attachment_choice(
                    "assistant-image-reference",
                    "Use as inspiration",
                    false,
                ))
                .child(attachment_choice(
                    "assistant-image-asset",
                    "Add to set",
                    true,
                ))
                .scroll_x(),
        );
    }
    if chat.picking_image || chat.attachment_job.is_some() {
        footer = footer.child(title("Adding image…", 11., 500., MUTED));
    }
    let attach = super::panels::tool(
        "assistant-attach",
        "plus",
        "Attach image",
        chat.attachment_menu,
        |s| {
            s.chat.attachment_menu = !s.chat.attachment_menu;
        },
    )
    .size(28., 28.)
    .disabled(
        chat.busy()
            || chat.picking_image
            || chat.attachment_job.is_some()
            || chat.attachments.len() >= 3,
    );
    col()
        .key("assistant-conversation")
        .w_full()
        .h(0.)
        .grow(1.)
        .min_h(0.)
        .min_w(0.)
        .child(top)
        .child(el().w_full().h(1.).fill(color(LINE)))
        .child(
            col()
                .key("assistant-transcript")
                .role("log")
                .label("Assistant messages")
                .w_full()
                .h(0.)
                .grow(1.)
                .min_h(0.)
                .child(transcript)
                .scroll(rune::ScrollSpec::stick_bottom()),
        )
        .child(el().w_full().h(1.).fill(color(LINE)))
        .child(
            footer.child(
                row()
                    .gap(5.)
                    .items_center()
                    .min_w(0.)
                    .child(attach)
                    .child(composer(s, false)),
            ),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime() -> rune::Runtime<Studio> {
        rune::App::new(AppSpec::new(
            "Assistant test",
            (390., 560.),
            || Studio::new(PathBuf::new()),
            |studio, _| col().h_full().child(panel(studio, true)),
        ))
        .headless_runtime((390., 560.), rune::Env::default())
    }

    #[test]
    fn assistant_offers_the_account_action_for_the_current_session() {
        let mut rt = runtime();
        for (state, sign_out, connect) in [
            (Account::Connected, true, false),
            (Account::Checking, false, false),
            (Account::Disconnected, false, true),
            (Account::Waiting, false, false),
            (Account::Connected, true, false),
        ] {
            rt.update(|studio, _| studio.chat.account = state);
            rt.frame(0.);
            assert_eq!(rt.find("assistant-sign-out").is_some(), sign_out);
            assert_eq!(rt.find("assistant-account-action").is_some(), connect);
        }
    }

    #[test]
    fn assistant_model_call_keeps_one_key_and_updates_to_the_latest_call() {
        let mut rt = runtime();
        let first = Arc::new(Turn::new(1));
        first.step("Read ChatGPT account");
        first.begin_call();
        rt.update(|studio, _| {
            studio
                .chat
                .history
                .push(("user".into(), "Plan a show".into()));
            studio.chat.receipts.insert(0, first.clone());
        });
        let assert_call = |rt: &rune::Runtime<Studio>, expect: &str| {
            let calls = rt
                .elements()
                .into_iter()
                .filter(|el| el.key.as_deref() == Some("assistant-call-indicator"))
                .collect::<Vec<_>>();
            assert_eq!(calls.len(), 1);
            assert_eq!(calls[0].label.as_deref(), Some(expect));
        };
        rt.frame(0.);
        assert_call(&rt, "Model call 1");
        rt.update(|_, _| {
            first.step("Inspect schema");
            first.begin_call();
        });
        rt.frame(0.);
        assert_call(&rt, "Model call 2");
        first.finish(None);
        let second = Arc::new(Turn::new(2));
        second.begin_call();
        rt.update(|studio, _| {
            studio.chat.history.extend([
                ("assistant".into(), "Here’s a plan.".into()),
                ("user".into(), "Refine it".into()),
            ]);
            studio.chat.receipts.insert(2, second);
        });
        rt.frame(0.);
        assert_call(&rt, "Model call 1");
        assert!(rt.find("assistant-context-checks-0").is_some());
        assert!(rt.find("assistant-message-1").is_some());
    }

    #[test]
    fn assistant_returned_room_change_requires_review_before_apply() {
        let mut rt = runtime();
        rt.update(|studio, _| {
            studio
                .chat
                .history
                .push(("assistant".into(), "I can change the studio output.".into()));
            studio.chat.proposal = Some(Proposal::Room {
                revision: 2,
                previews: Vec::new(),
                command: RoomCommand::CanvasView {
                    view: CanvasView::Landscape,
                },
            });
        });
        rt.frame(0.);
        assert!(rt.find("assistant-proposal").is_some());
        assert!(rt.find("review-edits").is_some());
        assert!(rt.find("apply-proposal").is_none());
        rt.update(|studio, _| assert!(studio.chat.review()));
        rt.frame(0.);
        assert!(rt.find("apply-proposal").is_some());
        assert!(rt.find("review-edits").is_none());
    }
}
