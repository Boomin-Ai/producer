use super::*;
use crate::assistant::{self, Reply, Turn};
use crate::model::SetLayoutPair;
use anyhow::{bail, Context as AnyContext, Result};
use producer_production_contract::Set;
use serde_json::Value;
enum Proposal {
    Set {
        id: String,
        old: Set,
        draft: Set,
        layout: SetLayoutPair,
    },
    Room {
        revision: u64,
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
    handle: &Handle,
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
        let command = assistant::room_action(v.clone())?;
        if let RoomCommand::Document {
            command: transaction,
        } = &command
        {
            let mut project = s.project.clone();
            project.command(transaction.clone())?;
            for (id, set) in &project.production.sets {
                if s.project.production.sets.get(id) != Some(set) {
                    crate::render_graph::inspect(set)?;
                }
            }
        }
        return Ok(Some(Proposal::Room {
            revision: s.revision,
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
    let value = candidate.insert(base.clone());
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
    turn.step("Prepare landscape and portrait preview");
    request(
        handle,
        RoomCommand::SetEditPreview {
            id: Some(id.into()),
            draft: Some(draft.clone()),
            layout: Some(pair.clone()),
        },
    )?;
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
#[derive(Default)]
pub(super) struct Chat {
    pub input: TextEdit,
    history: Vec<(String, String)>,
    proposal: Option<Proposal>,
    chips: Vec<assistant::Chip>,
    latest: Option<Arc<Turn>>,
    started: Option<Instant>,
    status: String,
    applying: Option<mpsc::Receiver<Result<()>>>,
    pub(super) reviewing: bool,
    turn: Option<Arc<Turn>>,
    generation: u64,
    rx: Option<mpsc::Receiver<Result<Answer>>>,
}
impl Chat {
    pub(super) fn busy(&self) -> bool {
        self.turn.is_some() || self.applying.is_some()
    }
    pub(super) fn start(&mut self, live: &Live) {
        let prompt = self.input.text.trim().to_owned();
        if prompt.is_empty() || self.turn.is_some() || self.applying.is_some() {
            return;
        }
        let snapshot = &live.snapshot;
        let Some(id) = snapshot.project.mounted_set.clone() else {
            return;
        };
        let Some(_) = snapshot.project.production.sets.get(&id) else {
            return;
        };
        self.close_review(live);
        self.generation += 1;
        let mut turn = Turn::new(self.generation);
        match crate::assistant_log::Journal::start(
            &live.handle.root,
            self.generation,
            json!({"setId":id,"prompt":prompt}),
        ) {
            Ok(j) => turn.journal = Some(j),
            Err(e) => {
                self.history.push(("assistant".into(), e.to_string()));
                return;
            }
        }
        self.history.push(("user".into(), prompt.to_owned()));
        self.input = TextEdit::new("");
        self.proposal = None;
        let turn = Arc::new(turn);
        self.turn = Some(turn.clone());
        self.latest = Some(turn.clone());
        self.started = Some(Instant::now());
        self.chips.clear();
        self.status = "Thinking…".into();
        let snap = snapshot.clone();
        let handle = live.handle.clone();
        let history = self.history[self.history.len().saturating_sub(24)..].to_vec();
        let (tx, rx) = mpsc::channel();
        self.rx = Some(rx);
        std::thread::spawn(move || {
            let result = (|| -> Result<Answer> {
                let mut ctx = assistant::context(&snap, &id);
                let desk = &handle.studio_audio;
                ctx["audioStatus"] = json!(desk.status());
                let count = desk.catalog(None, "", 0, 0).total;
                let audio = (0..count)
                    .step_by(64)
                    .flat_map(|offset| desk.catalog(None, "", offset, 64).items)
                    .collect::<Vec<_>>();
                ctx["resources"]["audio"] = json!(audio);
                let pair = snap
                    .project
                    .mounted_layout
                    .clone()
                    .unwrap_or_else(|| snap.project.default_set_selection(&id));
                let mut history = history;
                for attempt in 1..=2 {
                    turn.check()?;
                    let reply = assistant::turn(ctx.clone(), &history, &turn)?;
                    turn.check()?;
                    turn.record("proposal", json!({"attempt":attempt,"reply":reply}))?;
                    let mut candidate = None;
                    match prepare(
                        &handle,
                        &snap,
                        &id,
                        &pair,
                        &reply,
                        &mut candidate,
                        &ctx["set"],
                        &turn,
                    ) {
                        Ok(p) => {
                            anyhow::ensure!(
                                attempt == 1 || p.is_some(),
                                "Repair returned no edits"
                            );
                            return Ok(Answer {
                                reply,
                                candidate: p,
                            });
                        }
                        Err(e) if attempt == 1 => {
                            turn.record(
                                "validation_failed",
                                json!({"attempt":attempt,"error":e.to_string()}),
                            )?;
                            if reply.room_command.is_none() {
                                if let Some(doc) = candidate {
                                    ctx["resources"]["sets"][&id] = doc.clone();
                                    ctx["set"] = doc;
                                }
                            }
                            history.push(("validator".into(),format!("Validation failed: {e:#}. Correct the proposed edits against the supplied draft.")));
                        }
                        Err(e) => return Err(e),
                    }
                }
                unreachable!()
            })();
            let err = result.as_ref().err().map(ToString::to_string);
            turn.finish(err.as_deref());
            let _ = turn.finish_log(
                if turn.stopped.load(Ordering::Acquire) {
                    "cancelled"
                } else if err.is_some() {
                    "failed"
                } else {
                    "completed"
                },
                err.as_deref(),
            );
            let _ = tx.send(result);
        });
    }
    fn cancel(&mut self, status: &str) {
        if let Some(turn) = self.turn.take() {
            turn.stopped.store(true, Ordering::Release);
            let id = turn.id.clone();
            std::thread::spawn(move || assistant::cancel(&id));
            self.generation += 1;
        }
        self.rx = None;
        self.started = None;
        self.status = status.into();
    }
    pub(super) fn close_review(&mut self, live: &Live) {
        live.reviewing.store(false, Ordering::Release);
        self.reviewing = false;
    }
    fn review(&mut self, live: &Live) -> bool {
        if matches!(self.proposal, Some(Proposal::Set { .. })) {
            self.reviewing = true;
            live.reviewing.store(true, Ordering::Release);
            return true;
        }
        false
    }
    fn apply(&mut self, live: &Live) {
        if self.applying.is_some() {
            return;
        }
        let cmd = match &self.proposal {
            Some(Proposal::Set {
                id,
                old,
                draft,
                layout,
            }) if self.reviewing => RoomCommand::SetEditSave {
                id: id.clone(),
                expected: old.clone(),
                draft: draft.clone(),
                layout: Some(layout.clone()),
            },
            Some(Proposal::Room { revision, command }) => {
                if live.handle.snapshot().revision != *revision {
                    self.status = "Studio changed. Ask for a fresh proposal.".into();
                    return;
                }
                command.clone()
            }
            _ => return,
        };
        let h = live.handle.clone();
        let (tx, rx) = mpsc::channel();
        self.applying = Some(rx);
        std::thread::spawn(move || {
            let _ = tx.send(request(&h, cmd));
        });
    }
    pub(super) fn tick(&mut self, live: &Live, editing: bool) -> bool {
        let mut changed = false;
        if self.started.is_some_and(|at| at.elapsed().as_secs() >= 180) {
            self.cancel("Request timed out");
            changed = true;
        }
        if let Some(rx) = &self.applying {
            if let Ok(result) = rx.try_recv() {
                self.applying = None;
                match result {
                    Ok(()) => {
                        self.close_review(live);
                        self.proposal = None;
                        self.status = "Saved to studio".into();
                    }
                    Err(e) => self.status = e.to_string(),
                };
                changed = true;
            }
        }
        if let Some(rx) = &self.rx {
            let result = match rx.try_recv() {
                Ok(v) => Some(v),
                Err(mpsc::TryRecvError::Disconnected) => {
                    Some(Err(anyhow::anyhow!("Assistant connection ended")))
                }
                _ => None,
            };
            if let Some(result) = result {
                self.rx = None;
                self.turn = None;
                self.started = None;
                match result {
                    Ok(a) => {
                        self.chips = a.reply.suggestions;
                        self.history.push(("assistant".into(), a.reply.message));
                        self.proposal = a.candidate;
                        self.status = if self.proposal.is_some() {
                            "Ready for review".into()
                        } else {
                            String::new()
                        };
                    }
                    Err(e) => self.status = e.to_string(),
                }
                changed = true;
            }
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
            let busy = self.busy() || editing;
            let reply = match cmd {
                AssistantStatus => {
                    let editor = match (&self.proposal, self.reviewing) {
                        (Some(Proposal::Set { id, layout, .. }), true) => Some(
                            json!({"set":id,"layout":layout,"displayed":layout,"ready":true,"error":null}),
                        ),
                        _ => None,
                    };
                    json!({"ok":true,"generation":self.generation,"busy":busy,"status":self.status,"reviewReady":self.proposal.is_some(),"editor":editor,
                        "steps":self.latest.as_ref().map(|t|t.receipt()),"logTurnId":self.latest.as_ref().and_then(|t|t.journal.as_ref()).map(|j|&j.id),
                        "modelCalls":self.latest.as_ref().map(|t|t.calls.load(Ordering::Relaxed)),
                        "reply":self.history.last().filter(|(role,_)|role=="assistant").map(|(_,msg)|msg)})
                }
                AssistantReview { generation }
                    if generation == self.generation && !busy && self.review(live) =>
                {
                    changed = true;
                    json!({"ok":true,"status":"Reviewing draft"})
                }
                AssistantStop { generation }
                    if generation == self.generation && self.turn.is_some() =>
                {
                    self.cancel("Stopped");
                    changed = true;
                    json!({"ok":true})
                }
                AssistantSend { prompt }
                    if !busy && !prompt.trim().is_empty() && prompt.len() <= 4096 =>
                {
                    self.input = TextEdit::new(prompt);
                    self.start(live);
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
        if let Some(t) = &self.turn {
            t.stopped.store(true, Ordering::Release);
        }
    }
}
pub(super) fn panel(s: &Studio, mut b: El) -> El {
    let chat = &s.chat;
    for (role, line) in &chat.history {
        b = b.child(
            text(line.clone())
                .color(color(if role == "user" { MINT } else { TEXT }))
                .font(TextStyle::new(13., 500.)),
        );
    }
    b = b.child(
        field("assistant-input", &chat.input, |s| &mut s.chat.input).on_submit(
            |s: &mut Studio, _| {
                if let Some(l) = &s.live {
                    s.chat.start(l);
                }
            },
        ),
    );
    if !chat.status.is_empty() {
        b = b.child(title(&chat.status, 12., 500., MUTED));
    }
    if chat.turn.is_some() {
        return b.child(button("stop-turn", "Stop", false, |s| {
            s.chat.cancel("Stopped")
        }));
    }
    b = b.child(row().gap(4.).child(button("send-turn", "Send", true, |s| {
        if let Some(l) = &s.live {
            s.chat.start(l);
        }
    })));
    for (i, chip) in chat.chips.iter().enumerate() {
        let prompt = chip.prompt.clone();
        b = b.child(button(
            format!("suggest-{i}"),
            &chip.label,
            false,
            move |s| s.chat.input = TextEdit::new(prompt.clone()),
        ));
    }
    if matches!(chat.proposal, Some(Proposal::Set { .. })) && !chat.reviewing {
        b = b.child(button("review-edits", "Preview set edits", false, |s| {
            if let Some(l) = &s.live {
                s.chat.review(l);
            }
        }));
    } else if chat.proposal.is_some() {
        b = b.child(button("apply-proposal", "Apply to studio", false, |s| {
            if let Some(l) = &s.live {
                s.chat.apply(l);
            }
        }));
    }
    b
}
