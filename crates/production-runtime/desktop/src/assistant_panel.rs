use super::*;
use crate::assistant::{self, Chip, Reply};
use anyhow::{bail, Context as AnyContext, Result};
use producer_production_contract::Set;
use serde_json::{json, Value};

#[derive(Clone, Copy, PartialEq, Eq)]
enum AccountState {
    Checking,
    Connected,
    Disconnected,
    Waiting,
    Unavailable,
}
impl AccountState {
    fn label(self) -> &'static str {
        match self {
            Self::Checking => "Checking account…",
            Self::Connected => "✓ ChatGPT connected",
            Self::Disconnected => "Connect ChatGPT",
            Self::Waiting => "Signing in…",
            Self::Unavailable => "Retry account check",
        }
    }
}
pub(super) struct Panel {
    popout: bool,
    anchor: std::rc::Rc<std::cell::Cell<Option<Bounds<Pixels>>>>,
    trigger: FocusHandle,
    provider: fn(Value, &[(String, String)], &assistant::Turn) -> Result<Reply>,
    active: Option<(Instant, Arc<assistant::Turn>)>,
    input: Entity<set_text_field::SetTextField>,
    history: Vec<(String, String)>,
    chips: Vec<Chip>,
    attachments: Vec<crate::assistant_image::Attachment>,
    attachment_menu: bool,
    choosing_image: bool,
    account: AccountState,
    next_account_check: Option<Instant>,
    busy: bool,
    expanded_checks: std::collections::BTreeSet<usize>,
    receipts: std::collections::BTreeMap<usize, Arc<assistant::Turn>>,
    generation: u64,
    pub(super) status: String,
    pending: Option<Proposal>,
    failure: Option<Value>,
    reviewed: bool,
}
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
impl Panel {
    pub(super) fn working(&self)->bool{self.busy}
    pub fn new(cx: &mut Context<Room>) -> Self {
        Self {
            popout: false,
            anchor: Default::default(),
            trigger: cx.focus_handle(),
            provider: assistant::turn,
            active: None,
            input: cx.new(|c| set_text_field::SetTextField::new(String::new(), c)),
            history: vec![],
            chips: vec![],
            attachments: vec![],
            attachment_menu: false,
            choosing_image: false,
            account: AccountState::Checking,
            next_account_check: Some(Instant::now()),
            busy: false,
            expanded_checks: Default::default(),
            receipts: Default::default(),
            generation: 0,
            status: String::new(),
            pending: None,
            failure: None,
            reviewed: false,
        }
    }
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
impl Room {
    pub(super) fn assistant_compact(&self, width: f32, cx: &mut Context<Self>) -> Div {
        let status = if self.assistant.busy {
            "Working…"
        } else if self.assistant.failure.is_some() {
            "Needs attention"
        } else if self.assistant.history.is_empty() {
            "Assistant"
        } else {
            "View reply"
        };
        let anchor = self.assistant.anchor.clone();
        let expanded = self.assistant.popout;
        let trigger = if width < 205. {
            tool("assistant-expand", "assistant-bubble", status, expanded, true)
                .size(px(28.))
        } else {
            Self::edit_button("assistant-expand", status, expanded)
                .max_w(px(100.))
                .truncate()
        };
        div()
            .w_full()
            .min_w_0()
            .flex()
            .items_center()
            .gap(px(4.))
            .on_children_prepainted(move |children, _, _| anchor.set(children.first().copied()))
            .child(
                trigger.flex_none()
                    .debug_selector(|| "assistant-expand".into())
                    .track_focus(&self.assistant.trigger)
                    .on_click(cx.listener(|room, _, window, cx| {
                        if !room.close_assistant_popout(window, cx) {
                            room.assistant.popout = true;
                            room.assistant.input.read(cx).focus_handle(cx).focus(window, cx);
                            cx.notify();
                        }
                    })),
            )
            .when(!expanded, |d| d.child(self.assistant_composer(true, cx)))
    }

    pub(super) fn close_assistant_popout(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if !std::mem::take(&mut self.assistant.popout) {
            return false;
        }
        self.assistant.attachment_menu = false;
        self.assistant.trigger.focus(window, cx);
        cx.notify();
        true
    }

    pub(super) fn assistant_popout(
        &self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Option<Stateful<Div>> {
        let anchor = self.assistant.anchor.get()?;
        if !self.assistant.popout || self.set_editor.is_some() || !self.assistant_dock_compact() {
            return None;
        }
        let viewport = window.viewport_size();
        let margin = px(12.);
        let gap = px(7.);
        let width = px(380.).min((viewport.width - margin * 2.).max(px(1.)));
        let above = anchor.top() - gap - margin;
        let below = viewport.height - anchor.bottom() - gap - margin;
        let height = px(640.).min(above.max(below).max(px(1.)));
        let left = anchor.left().max(margin).min((viewport.width - width - margin).max(margin));
        let top = if above >= below { anchor.top() - gap - height } else { anchor.bottom() + gap };
        Some(div().id("assistant-popout-layer").absolute().inset_0()
            .child(div().id("assistant-popout-dismiss").absolute().inset_0().occlude()
                .on_click(cx.listener(|room, _, window, cx| {
                    room.close_assistant_popout(window, cx);
                })))
            .child(div().id("assistant-popout").debug_selector(|| "assistant-popout".into())
                .absolute().left(left).top(top).w(width).h(height)
                .min_h_0().overflow_hidden().rounded(px(10.)).border_1().border_color(rgb(LINE))
                .bg(rgb(PANEL)).shadow_lg().occlude()
                .child(self.assistant_panel(true, cx))))
    }

    fn assistant_dock_compact(&self) -> bool {
        let workspace = self.workspace();
        let panel = &workspace.panels[&PanelId::Assistant];
        let dock = &workspace.docks[&panel.edge];
        panel.visible && !panel.edge.side() && dock.collapsed && !dock.hidden
    }
    fn assistant_target(&self) -> Option<(String, SetLayoutPair)> {
        let (id, pair) = self.selected_set()?;
        let p = &self.snapshot.project;
        let picked = self
            .set_selection
            .as_ref()
            .is_some_and(|(scene, set, _)| scene == &p.active_scene && set == &id);
        (picked || p.mounted_set.as_ref() == Some(&id)).then_some((id, pair))
    }
    fn choose_assistant_image(&mut self, production: bool, cx: &mut Context<Self>) {
        if self.assistant.choosing_image
            || self.assistant.busy
            || self.assistant.attachments.len() >= 3
        {
            return;
        }
        self.assistant.attachment_menu = false;
        self.assistant.choosing_image = true;
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some(
                if production {
                    "Add to set"
                } else {
                    "Use as inspiration"
                }
                .into(),
            ),
        });
        let handle = self.handle.clone();
        cx.spawn(async move |this, cx| {
            let result = match paths.await {
                Ok(Ok(Some(paths))) if !paths.is_empty() => {
                    cx.background_executor()
                        .spawn(async move {
                            let image = crate::assistant_image::load(
                                paths.into_iter().next().unwrap(),
                                production,
                                &crate::root(),
                            )?;
                            if let Some((id, asset)) = &image.asset {
                                if handle.snapshot().project.production.assets.get(id)
                                    != Some(asset)
                                {
                                    use producer_production_core::commands::{Command, Operation};
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
                                        && handle.snapshot().project.production.assets.get(id)
                                            != Some(asset)
                                    {
                                        result?;
                                    }
                                }
                            }
                            Ok::<_, anyhow::Error>(Some(image))
                        })
                        .await
                }
                Ok(Err(e)) => Err(e.into()),
                _ => Ok(None),
            };
            let _ = this.update(cx, |r, cx| {
                r.assistant.choosing_image = false;
                match result {
                    Ok(Some(image)) => r.assistant.attachments.push(image),
                    Err(e) => r.assistant.status = e.to_string(),
                    _ => {}
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    fn assistant_send(&mut self, cx: &mut Context<Self>) {
        if self.assistant.busy || self.assistant.choosing_image {
            return;
        }
        let mut prompt = self.assistant.input.read(cx).value.trim().to_string();
        if prompt.is_empty() {
            if self.assistant.attachments.is_empty() {
                return;
            }
            prompt = if self.assistant.attachments.iter().any(|a| a.asset.is_some()) {
                "Place the attached production image in the set."
            } else {
                "Suggest a set design inspired by the attached image."
            }
            .into();
        }
        let (id, layout) = self.assistant_target().unwrap_or_default();
        let snap = self.handle.snapshot();
        let mut context = assistant::context(&snap, &id);
        let desk=&self.handle.studio_audio;
        context["audioStatus"]=json!(desk.status());
        let count=desk.catalog(None,"",0,0).total;
        let audio=(0..count).step_by(64).flat_map(|offset|desk.catalog(None,"",offset,64).items).collect::<Vec<_>>();
        context["resources"]["audio"]=json!(audio);
        let journal = match crate::assistant_log::Journal::start(
            &self.handle.root,
            self.assistant.generation + 1,
            json!({
                "prompt":prompt,"setId":id,"layout":layout,"scene":snap.project.active_scene,
                "roomRevision":snap.revision,"build":env!("CARGO_PKG_VERSION"),
                "attachments":self.assistant.attachments.iter().map(|image|json!({"name":image.name,"assetId":image.asset.as_ref().map(|(id,_)|id)})).collect::<Vec<_>>()
            }),
        ) {
            Ok(journal) => journal,
            Err(error) => {
                self.assistant.status = format!("{error:#}");
                cx.notify();
                return;
            }
        };
        self.assistant
            .input
            .update(cx, |f, c| f.reset(String::new(), c));
        let a = &mut self.assistant;
        a.history.push(("user".into(), prompt));
        a.pending = None;
        a.failure = None;
        a.reviewed = false;
        a.chips.clear();
        a.busy = true;
        a.status = "Thinking…".into();
        a.generation += 1;
        let generation = a.generation;
        let mut turn = assistant::Turn::new(generation);
        turn.journal = Some(journal);
        let attachments = std::mem::take(&mut a.attachments);
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
        context["attachmentContent"] = Value::Array(
            attachments
                .iter()
                .flat_map(|image| image.content())
                .collect(),
        );
        let turn = Arc::new(turn);
        a.receipts.insert(a.history.len() - 1, turn.clone());
        a.active = Some((Instant::now(), turn.clone()));
        let history = a
            .history
            .iter()
            .rev()
            .take(24)
            .cloned()
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>();
        let provider = a.provider;
        let handle = self.handle.clone();
        cx.spawn(async move |this,cx|{
            let outcome=cx.background_executor().spawn(async move{
                let mut report=None;
                let result=(||->Result<_>{
                    let mut chat=history;let mut input=context.clone();
                    for attempt in 0..2{
                        turn.check()?;
                        turn.record("authoring_attempt",json!({"attempt":attempt+1}))?;
                        let reply=provider(input.clone(),&chat,&turn)?;
                        turn.record("proposal",json!({"attempt":attempt+1,"reply":reply}))?;
                        turn.check()?;
                        turn.step(if reply.room_command.is_some(){"Validate room command"}else if reply.edits.is_empty(){"Read reply"}else{"Apply set edits to private draft"});
                        let mut candidate=None;
                        if attempt>0 && reply.edits.is_empty() && reply.room_command.is_none(){
                            turn.record("validation_failed",json!({"attempt":attempt+1,"error":"Repair returned no edits"}))?;
                            bail!("Repair returned no edits");
                        }
                        match prepare(&handle,&snap,&id,&layout,&reply,&mut candidate,&input["set"],&turn){
                            Ok(p)=>{
                                if p.is_some(){turn.record("validation_passed",json!({"attempt":attempt+1}))?;}
                                return Ok((reply,p));
                            },
                            Err(e)=>{
                                turn.finish(Some(&format!("{e:#}")));
                                report=Some(json!({"setId":id,"layout":layout,"candidate":candidate,"originalSet":context["set"],"edits":reply.edits,"error":format!("{e:#}"),"build":env!("CARGO_PKG_VERSION"),"sources":context["sources"],"assets":context["assets"]}));
                                turn.record("validation_failed",json!({"attempt":attempt+1,"error":format!("{e:#}"),"candidate":candidate,"steps":turn.receipt()}))?;
                                if attempt==1{return Err(e)}
                                turn.record("authoring_retry",json!({"nextAttempt":2,"reason":format!("{e:#}")}))?;
                                if reply.room_command.is_none(){
                                    if let Some(document)=candidate {input["set"]=document.clone();input["resources"]["sets"][&id]=document;}
                                    chat.push(("validator".into(),format!("Validation failed: {e:#}. input.set already includes every successful edit up to the failure. Return only the corrections and any remaining edits needed for the original request.")));
                                }else{
                                    chat.push(("assistant".into(),serde_json::to_string(&reply)?));
                                    chat.push(("validator".into(),format!("Room command failed: {e:#}. Correct that command.")));
                                }
                            }
                        }
                    }
                    unreachable!()
                })();
                let error=result.as_ref().err().map(|e|format!("{e:#}"));
                turn.finish(error.as_deref());
                let outcome=if error.is_some(){"failed"}else{"succeeded"};
                let result=match turn.finish_log(outcome,error.as_deref()){
                    Ok(())=>result,
                    Err(log_error)=>Err(log_error.context(error.unwrap_or_else(||"Assistant trace could not be finalized".into()))),
                };
                (result,report)
            }).await;
            let _=this.update(cx,|r,cx|{
                let a=&mut r.assistant;if a.generation!=generation{return}
                a.active=None;a.busy=false;
                match outcome{
                    (Ok((reply,p)),_)=>{a.status=if p.is_some(){"Ready for review".into()}else{String::new()};a.pending=p;a.history.push(("assistant".into(),reply.message));a.chips=reply.suggestions;
                    if a.chips.is_empty(){
                        let topic=a.history.iter().rev().find(|(role,_)|role=="user").map(|(_,m)|m.chars().take(100).collect::<String>()).unwrap_or_default();
                        a.chips=vec![Chip{label:"Refine the look".into(),prompt:format!("Explore two refinements to {topic}. Describe them before editing.")},Chip{label:"Check portrait".into(),prompt:format!("How will {topic} read on a phone?")}];
                    }}
                    (Err(e),report)=>{a.status=e.to_string();a.failure=report;}
                }
                cx.notify();
            });
        }).detach();
        cx.notify();
    }
    fn assistant_stop(&mut self, message: &str, outcome: &str, cx: &mut Context<Self>) {
        if let Some((_, turn)) = self.assistant.active.take() {
            turn.stopped
                .store(true, std::sync::atomic::Ordering::Release);
            turn.finish(Some(message));
            let error = turn.finish_log(outcome, Some(message)).err();
            cx.background_executor()
                .spawn(async move { assistant::cancel(&turn.id) })
                .detach();
            self.assistant.generation += 1;
            self.assistant.busy = false;
            self.assistant.status =
                error.map_or_else(|| message.into(), |e| format!("{message} · {e:#}"));
            cx.notify();
        }
    }
    fn check_assistant_account(&mut self, connect: bool, cx: &mut Context<Self>) {
        self.assistant.next_account_check = None;
        self.assistant.account = AccountState::Checking;
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    if connect {
                        assistant::connect()?;
                    }
                    assistant::account_status()
                })
                .await;
            let _ = this.update(cx, |r, cx| {
                let a = &mut r.assistant;
                a.account = match result {
                    Ok((true, _, _)) => AccountState::Connected,
                    Ok((false, true, _)) => AccountState::Waiting,
                    Ok((false, false, error)) => {
                        if let Some(error) = error {
                            a.status = error;
                        }
                        AccountState::Disconnected
                    }
                    Err(error) => {
                        a.status = error.to_string();
                        AccountState::Unavailable
                    }
                };
                if a.account == AccountState::Waiting {
                    a.next_account_check = Some(Instant::now() + Duration::from_secs(1));
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    pub(super) fn assistant_tick(&mut self, cx: &mut Context<Self>) {
        if self.assistant.popout && (!self.assistant_dock_compact() || self.set_editor.is_some()) {
            self.assistant.popout = false;
        }
        if self
            .assistant
            .next_account_check
            .is_some_and(|at| Instant::now() >= at)
            && self.workspace().panels[&PanelId::Assistant].visible
        {
            self.check_assistant_account(false, cx);
        }
        if let Some((since, turn)) = &self.assistant.active {
            let elapsed = since.elapsed().as_secs();
            if elapsed >= 180 {
                self.assistant_stop(
                    "Request timed out. You can retry your message.",
                    "timed_out",
                    cx,
                );
            } else {
                self.assistant.status = format!("{} · {}s", turn.stage.lock().unwrap(), elapsed);
            }
        }
        let queued = self
            .handle
            .assistant_requests
            .lock()
            .unwrap()
            .drain(..)
            .collect::<Vec<_>>();
        use crate::ipc::AssistantRequest::*;
        for (command, tx, received) in queued {
            if received.elapsed().as_secs() >= 3 {
                continue;
            }
            let a = &self.assistant;
            let response = match command {
                AssistantStatus => {
                    json!({"ok":true,"logTurnId":a.receipts.values().next_back().and_then(|t|t.journal.as_ref()).map(|j|&j.id),"generation":a.generation,"busy":a.busy,"status":a.status,"account":a.account.label(),"reviewReady":a.pending.is_some(),"editor":self.set_editor.as_ref().map(|e|e.review_state()),"steps":a.receipts.values().next_back().map(|t|t.receipt()),"modelCalls":a.receipts.values().next_back().map(|t|t.calls.load(std::sync::atomic::Ordering::Relaxed)),"reply":a.history.last().filter(|(role,_)|role=="assistant").map(|(_,msg)|msg)})
                }
                AssistantReview { generation }
                    if generation == a.generation
                        && !a.busy
                        && matches!(a.pending, Some(Proposal::Set { .. })) =>
                {
                    self.assistant_review(cx);
                    json!({"ok":self.assistant.reviewed,"status":self.assistant.status})
                }
                AssistantStop { generation }
                    if a.generation == generation && a.active.is_some() =>
                {
                    self.assistant_stop("Stopped", "cancelled", cx);
                    json!({"ok":true})
                }
                AssistantSend { prompt }
                    if !a.busy && !prompt.trim().is_empty() && prompt.len() <= 4096 =>
                {
                    self.assistant.input.update(cx, |f, c| f.reset(prompt, c));
                    self.assistant_send(cx);
                    json!({"ok":true,"generation":self.assistant.generation})
                }
                _ => json!({"ok":false,"error":"Request is stale, busy, or invalid"}),
            };
            let _ = tx.send(response);
        }
    }
    fn open_assistant_logs(&mut self, cx: &mut Context<Self>) {
        let path = crate::assistant_log::directory(&self.handle.root);
        if !path.is_dir() {
            self.assistant.status = "No assistant turns logged in this studio yet.".into();
            cx.notify();
            return;
        }
        cx.spawn(async move |this, cx| {
            let opened = cx
                .background_executor()
                .spawn(async move {
                    std::process::Command::new("/usr/bin/open")
                        .arg(path)
                        .status()
                        .is_ok_and(|s| s.success())
                })
                .await;
            if !opened {
                let _ = this.update(cx, |r, cx| {
                    r.assistant.status = "Could not open the assistant log folder.".into();
                    cx.notify();
                });
            }
        })
        .detach();
    }
    fn assistant_review(&mut self, cx: &mut Context<Self>) {
        self.assistant.reviewed = match &self.assistant.pending {
            Some(Proposal::Set {
                id,
                old,
                draft,
                layout,
            }) => self.review_assistant_set(
                id.clone(),
                old.clone(),
                draft.clone(),
                layout.clone(),
                cx,
            ),
            Some(Proposal::Room { .. }) => true,
            None => false,
        };
        cx.notify();
    }
    fn assistant_task(
        &mut self,
        cx: &mut Context<Self>,
        task: impl FnOnce() -> Result<String> + Send + 'static,
    ) {
        if self.assistant.busy {
            return;
        }
        self.assistant.busy = true;
        self.assistant.status = "Working…".into();
        cx.spawn(async move |this, cx| {
            let result = cx.background_executor().spawn(async move { task() }).await;
            let _ = this.update(cx, |r, cx| {
                r.assistant.busy = false;
                r.assistant.status = result.unwrap_or_else(|e| e.to_string());
                cx.notify();
            });
        })
        .detach();
    }
    fn assistant_apply(&mut self, cx: &mut Context<Self>) {
        let Some(p) = self.assistant.pending.take() else {
            return;
        };
        let h = self.handle.clone();
        self.assistant_task(cx, move || {
            match p {
                Proposal::Set {
                    id,
                    old,
                    draft,
                    layout,
                } => request(
                    &h,
                    RoomCommand::SetEditSave {
                        id,
                        expected: old,
                        draft,
                        layout: Some(layout),
                    },
                )?,
                Proposal::Room { revision, command } => {
                    anyhow::ensure!(
                        h.snapshot().revision == revision,
                        "Studio changed. Ask for a fresh proposal."
                    );
                    request(&h, command)?;
                }
            }
            Ok("Saved to studio".into())
        });
    }
    pub(super) fn assistant_panel(&self, popout: bool, cx: &mut Context<Self>) -> Div {
        let a = &self.assistant;
        let mut panel = div().size_full().min_w_0().flex().flex_col();
        let mut header = div()
            .flex_none()
            .p(px(9.))
            .border_b_1()
            .border_color(rgb(LINE))
            .child(
                div()
                    .flex()
                    .justify_between()
                    .items_center()
                    .gap(px(5.))
                    .child(
                        div()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Studio Assistant"),
                    )
                    .child(match a.account {
                        AccountState::Disconnected | AccountState::Unavailable => {
                            let connect = a.account == AccountState::Disconnected;
                            Self::edit_button("assistant-connect", a.account.label(), false)
                                .debug_selector(|| "assistant-account-action".to_owned())
                                .on_click(cx.listener(move |r, _, _, cx| {
                                    r.check_assistant_account(connect, cx)
                                }))
                                .into_any_element()
                        }
                        state => div()
                            .text_size(px(11.))
                            .text_color(rgb(if state == AccountState::Connected {
                                ACCENT
                            } else {
                                MUTED
                            }))
                            .child(state.label())
                            .debug_selector(move || state.label().to_owned())
                            .into_any_element(),
                    })
                    .when(popout, |row| row.child(
                        Self::edit_button("assistant-popout-close", "×", false)
                            .debug_selector(|| "assistant-popout-close".into())
                            .tooltip(|_, cx| cx.new(|_| HeaderTip("Close Assistant".into())).into())
                            .on_click(cx.listener(|room, _, window, cx| {
                                room.close_assistant_popout(window, cx);
                            })),
                    )),
            );
        header = header.child(
            Self::edit_button("assistant-logs", "Logs", false)
                .tooltip(|_, cx| {
                    cx.new(|_| HeaderTip("Open local assistant logs".into()))
                        .into()
                })
                .on_click(cx.listener(|room, _, _, cx| room.open_assistant_logs(cx))),
        );
        if a.active.is_some() {
            header = header.child(
                Self::edit_button("assistant-stop", "Stop request", false).on_click(
                    cx.listener(|room, _, _, cx| room.assistant_stop("Stopped", "cancelled", cx)),
                ),
            );
        }
        let target = match &a.pending {
            Some(Proposal::Set { id, .. }) => Some(id.clone()),
            _ => self.assistant_target().map(|v| v.0),
        };
        if let Some(id) = target {
            header = header.child(
                div()
                    .text_color(rgb(MUTED))
                    .text_size(px(11.))
                    .child(set_label(&id)),
            )
        }
        panel = panel.child(header);
        let mut body = div().flex().flex_col().p(px(9.)).gap(px(8.));
        if a.history.is_empty() {
            body = body.child(
                div()
                    .text_color(rgb(MUTED))
                    .child("What would you like to change in this studio?"),
            )
        }
        for (index, (role, msg)) in a.history.iter().enumerate() {
            let message = div()
                .px(px(8.))
                .py(px(5.))
                .text_color(rgb(TEXT))
                .child(msg.clone());
            body = body.child(if role == "user" {
                message.bg(rgb(0x182b38)).rounded(px(6.))
            } else {
                message
            });
            if let Some(turn) = a.receipts.get(&index) {
                for label in &turn.attachment_labels {
                    body = body.child(
                        div()
                            .text_size(px(11.))
                            .text_color(rgb(MUTED))
                            .child(label.clone()),
                    );
                }
                let steps = turn.receipt();
                let checks = steps
                    .iter()
                    .filter(|step| {
                        let label = step["label"].as_str().unwrap_or_default();
                        step["state"] != "failed"
                            && (label.starts_with("Inspect ")
                                || matches!(
                                    label,
                                    "Read ChatGPT account" | "Load available models"
                                ))
                    })
                    .collect::<Vec<_>>();
                let is_expanded = a.expanded_checks.contains(&index);
                if !checks.is_empty() {
                    let active = checks.iter().any(|step| step["state"] == "active");
                    let elapsed = checks
                        .iter()
                        .filter_map(|step| step["ms"].as_u64())
                        .sum::<u64>() as f64
                        / 1000.;
                    let label = format!(
                        "{}  Context checks ({}) · {elapsed:.1}s  {}",
                        if active { "◌" } else { "✓" },
                        checks.len(),
                        if is_expanded { "▾" } else { "▸" }
                    );
                    body = body.child(
                        Self::edit_button(format!("assistant-checks-{index}"), label, false)
                            .debug_selector(|| "assistant-context-checks".into())
                            .on_click(cx.listener(move |r, _, _, cx| {
                                if !r.assistant.expanded_checks.remove(&index) {
                                    r.assistant.expanded_checks.insert(index);
                                }
                                cx.notify();
                            })),
                    );
                }
                for step in &steps {
                    let label = step["label"].as_str().unwrap_or_default();
                    if label.starts_with("Model call ") || (!is_expanded && checks.contains(&step))
                    {
                        continue;
                    }
                    let (mark, color) = match step["state"].as_str() {
                        Some("failed") => ("×", 0xff9185),
                        Some("done") => ("✓", ACCENT),
                        _ => ("◌", TEXT),
                    };
                    let elapsed = step["ms"].as_u64().unwrap_or_default() as f64 / 1000.;
                    body = body.child(
                        div()
                            .text_size(px(11.))
                            .text_color(rgb(color))
                            .child(format!("{mark}  {label}  ·  {elapsed:.1}s")),
                    );
                }
            }
        }
        if !a.status.is_empty()
            && !a.status.starts_with("Model call ")
            && !a.status.starts_with("Inspect ")
        {
            body = body.child(div().text_color(rgb(MUTED)).child(a.status.clone()))
        }
        if let Some(p) = &a.pending {
            let title = match p {
                Proposal::Set { id, layout, .. } => format!(
                    "Review {} · {}",
                    set_label(id),
                    set_label(&layout.landscape)
                ),
                Proposal::Room { command, .. } => {
                    serde_json::to_string(command).unwrap_or_default()
                }
            };
            body = body.child(
                Self::edit_button("assistant-review", title, false)
                    .debug_selector(|| "assistant-review".to_string())
                    .on_click(cx.listener(|r, _, _, cx| {
                        r.assistant_review(cx);
                    })),
            );
            if a.reviewed && matches!(p, Proposal::Room { .. }) {
                body = body.child(
                    Self::edit_button("assistant-apply", "Apply studio change", true)
                        .on_click(cx.listener(|r, _, _, cx| r.assistant_apply(cx))),
                )
            }
        }
        if let Some(report) = &a.failure {
            body = body.child(
                Self::edit_button("assistant-report", "Review diagnostic file", false).on_click(
                    cx.listener(|r, _, _, cx| {
                        let Some(report) = &r.assistant.failure else {
                            return;
                        };
                        let path = crate::root().join("assistant-diagnostic.json");
                        match std::fs::write(&path, serde_json::to_vec_pretty(report).unwrap())
                            .and_then(|_| {
                                std::process::Command::new("/usr/bin/open")
                                    .arg("-t")
                                    .arg(path)
                                    .status()
                            }) {
                            Ok(status) if status.success() => {
                                r.assistant.reviewed = true;
                                r.assistant.status =
                                "This file will be included in a draft PR to Boomin-Ai/producer."
                                    .into();
                            }
                            _ => r.assistant.status = "Could not open the diagnostic file.".into(),
                        }
                        cx.notify();
                    }),
                ),
            );
            if a.reviewed {
                let payload = report.clone();
                body = body.child(
                    Self::edit_button("assistant-pr", "Create diagnostic PR", false).on_click(
                        cx.listener(move |r, _, _, cx| {
                            let p = payload.clone();
                            r.assistant_task(cx, move || assistant::diagnostic_pr(&p))
                        }),
                    ),
                )
            }
        }
        panel = panel.child(
            div()
                .id("assistant-transcript")
                .flex_1()
                .min_h_0()
                .overflow_y_scroll()
                .child(body),
        );
        let mut body = div()
            .flex_none()
            .flex()
            .flex_col()
            .gap(px(6.))
            .p(px(8.))
            .border_t_1()
            .border_color(rgb(LINE));
        let mut chips = div()
            .id("assistant-suggestions")
            .flex()
            .min_w_0()
            .gap(px(4.))
            .overflow_x_scroll();
        let initial = if self.assistant_target().is_some() {
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
        if a.history.is_empty() {
            for (i, (label, prompt)) in initial.into_iter().enumerate() {
                chips = chips.child(
                    Self::edit_button(format!("starter-{i}"), label, false)
                        .flex_none()
                        .on_click(cx.listener(move |r, _, _, cx| {
                            r.assistant
                                .input
                                .update(cx, |f, c| f.reset(prompt.into(), c))
                        })),
                );
            }
        }
        for (i, c) in a.chips.iter().enumerate() {
            let prompt = c.prompt.clone();
            chips = chips.child(
                Self::edit_button(format!("reply-{i}"), c.label.clone(), false)
                    .flex_none()
                    .debug_selector(move || format!("assistant-chip-{i}"))
                    .on_click(cx.listener(move |r, _, _, cx| {
                        r.assistant
                            .input
                            .update(cx, |f, c| f.reset(prompt.clone(), c))
                    })),
            )
        }
        if let Some(turn) = a.receipts.values().next_back() {
            if let Some((number, start, duration)) = *turn.call_clock.lock().unwrap() {
                body = body.child(
                    div()
                        .debug_selector(|| "assistant-call-indicator".into())
                        .flex()
                        .justify_between()
                        .text_size(px(11.))
                        .text_color(rgb(MUTED))
                        .child(format!("Model call {number}"))
                        .child(format!(
                            "{:.1}s",
                            duration.unwrap_or_else(|| start.elapsed()).as_secs_f32()
                        )),
                );
            }
        }
        body = body.child(chips);
        for (i, attachment) in a.attachments.iter().enumerate() {
            let purpose = if attachment.asset.is_some() {
                "Set asset"
            } else {
                "Inspiration"
            };
            body = body.child(
                div()
                    .flex()
                    .justify_between()
                    .child(
                        div()
                            .flex_1()
                            .truncate()
                            .child(format!("{purpose} · {}", attachment.name)),
                    )
                    .child(
                        Self::edit_button(format!("remove-image-{i}"), "×", false).on_click(
                            cx.listener(move |r, _, _, cx| {
                                if i < r.assistant.attachments.len() {
                                    r.assistant.attachments.remove(i);
                                }
                                cx.notify();
                            }),
                        ),
                    ),
            );
        }
        if a.attachment_menu {
            for (production, label) in [(false, "Use as inspiration"), (true, "Add to set")] {
                body = body.child(Self::edit_button(label, label, false).on_click(
                    cx.listener(move |r, _, _, cx| r.choose_assistant_image(production, cx)),
                ));
            }
        }
        let attach = Self::edit_button("assistant-attach", "＋", a.attachment_menu)
            .debug_selector(|| "assistant-attach".into())
            .tooltip(|_, cx| cx.new(|_| HeaderTip("Attach image".into())).into());
        let attach = if !a.busy && !a.choosing_image && a.attachments.len() < 3 {
            attach.on_click(cx.listener(|r, _, _, cx| {
                r.assistant.attachment_menu = !r.assistant.attachment_menu;
                cx.notify();
            }))
        } else {
            attach.opacity(0.5)
        };
        panel.child(
            body.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .child(attach)
                    .child(self.assistant_composer(false, cx)),
            ),
        )
    }
    fn assistant_composer(&self, compact: bool, cx: &mut Context<Self>) -> Stateful<Div> {
        let a = &self.assistant;
        let empty = a.input.read(cx).value.is_empty();
        let enabled = !a.busy && !a.choosing_image
            && (!a.input.read(cx).value.trim().is_empty() || !a.attachments.is_empty());
        let field = div().relative().flex_1().min_w_0()
            .debug_selector(move || if compact { "assistant-inline-input".into() } else { "assistant-input".into() })
            .child(a.input.clone())
            .when(empty, |d| d.child(
                div().absolute().left(px(8.)).right(px(4.)).top(px(7.))
                    .truncate().text_size(px(11.)).text_color(rgb(MUTED))
                    .child(if compact { "Ask…" } else { "Ask Producer…" }),
            ));
        let arrow = div().id("assistant-send")
            .debug_selector(|| "assistant-send".into())
            .tooltip(|_, cx| cx.new(|_| HeaderTip("Send message".into())).into())
            .size(px(if compact { 23. } else { 26. }))
            .flex_none().flex().items_center().justify_center().rounded(px(5.))
            .bg(rgb(if enabled { ACCENT } else { LINE }))
            .text_color(rgb(if enabled { BG } else { MUTED }))
            .child("↑")
            .when(enabled, |d| d.cursor_pointer()
                .on_click(cx.listener(|r, _, _, cx| r.assistant_send(cx))));
        div().id(if compact { "assistant-inline-composer" } else { "assistant-composer" })
            .min_w_0().flex_1().flex().items_center().gap(px(4.))
            .child(field).child(arrow)
            .on_key_down(cx.listener(|r, e: &KeyDownEvent, _, cx| {
                if e.keystroke.key == "enter" && !e.keystroke.modifiers.shift
                    && !r.assistant.input.read(cx).is_composing()
                {
                    r.assistant_send(cx);
                    cx.stop_propagation();
                }
            }))
    }

}

#[cfg(test)]
mod tests {
    use super::{PanelId, Room, RoomCommand, WorkspaceCommand};
    use gpui::prelude::*;
    use gpui::{
        px, size, Bounds, Modifiers, TestAppContext, VisualTestContext, WindowBounds, WindowOptions,
    };
    use serde_json::json;
    use std::sync::Arc;

    #[test]
    fn compact_assistant_pops_out_without_expanding_its_dock() {
        let temp = tempfile::tempdir().unwrap();
        let mut project = crate::model::RoomProject::demo();
        let w = &mut project.workspace;
        w.apply(WorkspaceCommand::Place {
            panel: PanelId::Assistant, edge: super::Edge::Bottom, before: Some(PanelId::Timeline),
        }).unwrap();
        w.apply(WorkspaceCommand::Visibility {
            panel: PanelId::Assistant, visible: true,
        }).unwrap();
        w.apply(WorkspaceCommand::Collapse {
            edge: super::Edge::Bottom, collapsed: true,
        }).unwrap();
        w.apply(WorkspaceCommand::ResizeSplit {
            first: PanelId::Assistant, second: PanelId::Timeline, ratio: 0.10,
        }).unwrap();
        std::fs::write(temp.path().join("room.json"), serde_json::to_vec(&project).unwrap()).unwrap();
        let (handle, commands, _) = crate::engine::initial_room(temp.path()).unwrap();
        let app = &mut TestAppContext::single();
        let window = app.update(|cx| {
            cx.open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                        None, size(px(1180.), px(780.)), cx,
                    ))),
                    ..Default::default()
                },
                |_, cx| cx.new(|cx| Room::new(handle, cx)),
            ).unwrap()
        });
        let mut ui = VisualTestContext::from_window(window.into(), app);
        let room = window.root(&mut ui).unwrap();
        ui.update(|_, cx| room.update(cx, |r, cx| {
            r.assistant.account = super::AccountState::Connected;
            r.assistant.next_account_check = None;
            r.assistant.provider = |_, _, _| {
                Ok(serde_json::from_value(json!({"message":"Inline reply","edits":[]}))?)
            };
        }));
        ui.run_until_parked();
        let inline = ui.debug_bounds("assistant-inline-input").unwrap();
        assert!(inline.size.width >= px(55.));
        ui.simulate_click(inline.center(), Modifiers::default());
        ui.simulate_input("draft");
        for close in ["assistant-popout-close", "escape", "outside"] {
            let anchor = ui.debug_bounds("assistant-expand").unwrap();
            ui.simulate_click(anchor.center(), Modifiers::default());
            ui.run_until_parked();
            let popout = ui.debug_bounds("assistant-popout").unwrap();
            assert!(popout.top() >= px(12.) && popout.bottom() < anchor.top());
            assert!(ui.debug_bounds("assistant-send").is_some());
            assert!(ui.debug_bounds("assistant-inline-input").is_none());
            match close {
                "escape" => ui.simulate_keystrokes("escape"),
                "outside" => ui.simulate_click(gpui::point(px(5.), px(70.)), Modifiers::default()),
                button => {
                    let rect = ui.debug_bounds(button).unwrap();
                    ui.simulate_click(rect.center(), Modifiers::default());
                }
            }
            ui.run_until_parked();
            assert!(ui.debug_bounds("assistant-popout").is_none(), "Dismissal failed via {close}");
            room.read_with(&ui, |r, cx| {
                assert!(r.workspace().docks[&super::Edge::Bottom].collapsed);
                assert_eq!(r.assistant.input.read(cx).value, "draft");
            });
        }
        let inline = ui.debug_bounds("assistant-inline-input").unwrap();
        ui.simulate_click(inline.center(), Modifiers::default());
        ui.simulate_keystrokes("enter");
        ui.run_until_parked();
        room.read_with(&ui, |r, cx| {
            assert_eq!(r.assistant.history[0].1, "draft");
            assert_eq!(r.assistant.history.last().unwrap().1, "Inline reply");
            assert!(r.assistant.input.read(cx).value.is_empty());
            assert!(!r.assistant.popout);
        });
        assert!(commands.try_recv().is_err());
    }

    #[test]
    fn failed_prompt_keeps_its_log_after_the_panel_closes() {
        let fixture_root = std::env::var_os("PRODUCER_ASSISTANT_LOG_TEST_ROOM");
        let temp = tempfile::tempdir().unwrap();
        let root = fixture_root
            .as_deref()
            .map(std::path::Path::new)
            .unwrap_or_else(|| temp.path());
        let mut project = crate::model::RoomProject::demo();
        project.mount_set(Some("studio".into()), None).unwrap();
        project
            .workspace
            .apply(WorkspaceCommand::Visibility {
                panel: PanelId::Controls,
                visible: false,
            })
            .unwrap();
        project
            .workspace
            .apply(WorkspaceCommand::Activate {
                panel: PanelId::Assistant,
            })
            .unwrap();
        std::fs::write(
            root.join("room.json"),
            serde_json::to_vec(&project).unwrap(),
        )
        .unwrap();
        let (handle, _commands, _) = crate::engine::initial_room(root).unwrap();
        let log_id = {
            let app = &mut TestAppContext::single();
            let window = app
                .update(|cx| {
                    cx.open_window(
                        WindowOptions {
                            window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                                None,
                                size(px(1300.), px(900.)),
                                cx,
                            ))),
                            ..Default::default()
                        },
                        |_, cx| cx.new(|cx| Room::new(handle, cx)),
                    )
                })
                .unwrap();
            let mut cx = VisualTestContext::from_window(window.into(), app);
            let room = window.root(&mut cx).unwrap();
            cx.update(|_,cx|room.update(cx,|r,cx|{
                r.assistant.account=super::AccountState::Connected;
                r.assistant.next_account_check=None;
                r.assistant.provider=|_,_,turn|{
                    let call=turn.calls.fetch_add(1,std::sync::atomic::Ordering::Relaxed)+1;
                    let failed=if call==1 {"missing-masthead"}else{"missing-camera"};
                    turn.record("model_call_started",json!({"call":call,"model":"test-model"}))?;
                    turn.record("provider_event",json!({"call":call,"detail":{"type":"provider_response","httpStatus":200,"requestId":format!("test-{call}")}}))?;
                    turn.record("model_call_finished",json!({"call":call,"output":[{"type":"function_call","name":"inspect_authoring"}]}))?;
                    turn.record("tool_result",json!({"call":call,"tool":"inspect_authoring","arguments":{"section":"sets","id":"studio"},"result":{"example":"studio"}}))?;
                    Ok(serde_json::from_value(json!({"message":"Proposed change","edits":[{"op":"replace","path":format!("/layouts/landscape/root/{failed}"),"value":true}]}))?)
                };
                r.assistant.input.update(cx,|f,c|f.reset("Update a missing studio layer.".into(),c));
            }));
            let send = cx.debug_bounds("assistant-send").unwrap().center();
            cx.simulate_click(send, Modifiers::default());
            cx.run_until_parked();
            assert!(!room.read_with(&cx, |r, _| r.assistant.busy));
            assert!(room.read_with(&cx, |r, _| r.assistant.failure.is_some()));
            room.read_with(&cx, |r, _| {
                r.assistant.receipts[&0]
                    .journal
                    .as_ref()
                    .unwrap()
                    .id
                    .clone()
            })
        };
        let path = crate::assistant_log::directory(root).join(format!("{log_id}.jsonl"));
        let trace = std::fs::read_to_string(path).unwrap();
        let records = trace
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .collect::<Vec<_>>();
        let event_count = |event: &str| records.iter().filter(|row| row["event"] == event).count();
        assert_eq!(
            records[0]["data"]["prompt"],
            "Update a missing studio layer."
        );
        assert_eq!(records[0]["data"]["setId"], "studio");
        assert_eq!(event_count("model_call_started"), 2);
        assert_eq!(event_count("model_call_finished"), 2);
        assert_eq!(event_count("tool_result"), 2);
        assert_eq!(event_count("validation_failed"), 2);
        assert_eq!(event_count("authoring_retry"), 1);
        assert_eq!(event_count("turn_finished"), 1);
        assert!(trace.contains("missing-masthead") && trace.contains("missing-camera"));
        assert_eq!(records.last().unwrap()["data"]["outcome"], "failed");
    }
    #[test]
    #[ignore = "uses an Orbital Desk Native Dev room fixture"]
    fn orbital_desk_panel_edit() {
        let source = std::path::PathBuf::from(std::env::var_os("ORBITAL_ROOM_FIXTURE").unwrap());
        let root = std::env::temp_dir().join(format!("producer-panel-test-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let mut project: crate::model::RoomProject =
            serde_json::from_slice(&std::fs::read(source).unwrap()).unwrap();
        project
            .mount_set(Some("orbital-desk".into()), None)
            .unwrap();
        project
            .workspace
            .apply(WorkspaceCommand::Visibility {
                panel: PanelId::Controls,
                visible: false,
            })
            .unwrap();
        project
            .workspace
            .apply(WorkspaceCommand::Activate {
                panel: PanelId::Assistant,
            })
            .unwrap();
        std::fs::write(
            root.join("room.json"),
            serde_json::to_vec(&project).unwrap(),
        )
        .unwrap();
        let (handle, commands, _) = crate::engine::initial_room(&root).unwrap();
        let saved = Arc::new(std::sync::Mutex::new(None));
        let result = saved.clone();
        let base = project.clone();
        std::thread::spawn(move || {
            for env in commands {
                let is_save = matches!(env.command, RoomCommand::SetEditSave { .. });
                let ok = match env.command {
                    RoomCommand::SetEditPreview {
                        id: Some(id),
                        draft: Some(draft),
                        ..
                    }
                    | RoomCommand::SetEditSave { id, draft, .. } => {
                        crate::engine::set_edit_project(&base, &id, &draft)
                            .unwrap()
                            .compile()
                            .unwrap();
                        crate::render_graph::inspect(&draft).unwrap();
                        if is_save {
                            *result.lock().unwrap() = Some(draft);
                        }
                        json!({"ok":true,"slots":{}})
                    }
                    _ => json!({"ok":true}),
                };
                if let Some(tx) = env.reply {
                    let _ = tx.send(ok);
                }
            }
        });
        let app = &mut TestAppContext::single();
        let window = app.update(|cx| {
            cx.open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                        None,
                        size(px(1440.), px(940.)),
                        cx,
                    ))),
                    ..Default::default()
                },
                |_, cx| cx.new(|cx| Room::new(handle, cx)),
            )
            .unwrap()
        });
        let mut cx = VisualTestContext::from_window(window.into(), app);
        let room = window.root(&mut cx).unwrap();
        cx.update(|_,cx|room.update(cx,|r,cx|{
            if std::env::var_os("PRODUCER_REAL_ASSISTANT_TEST").is_none(){
                let shot=root.join("inspiration.png");
                image::DynamicImage::new_rgba8(16,16).save(&shot).unwrap();
                r.assistant.attachments.push(crate::assistant_image::load(shot,false,&root).unwrap());
                r.assistant.provider=|v,h,turn|{
                    assert_eq!(v["attachmentContent"][1]["type"],"input_image");
                    turn.step("Inspect schema Set");
                    let call=turn.calls.fetch_add(1,std::sync::atomic::Ordering::Relaxed)+1;
                    *turn.call_clock.lock().unwrap()=Some((call,std::time::Instant::now(),Some(std::time::Duration::from_secs(call as u64))));

                    assert_eq!(v["setId"],"orbital-desk");
                    if h.last().unwrap().0=="validator"{
                        assert!(v["set"]["layouts"]["isobar-landscape"].is_object());
                        return Ok(serde_json::from_value(json!({"message":"Prepared Isobar.","edits":[{"op":"copy","from":"/layouts/vertical","path":"/layouts/isobar-vertical"}],"suggestions":[{"label":"Color","prompt":"Adjust the colors."}]}))?);
                    }
                    assert!(h.last().unwrap().1.contains("Evening Desk"));
                    let mut edits=vec![];
                    for layout in ["landscape","vertical"]{
                        let groups=v["set"]["layouts"][layout]["root"]["children"].as_array().unwrap();
                        let (g,mast)=groups.iter().enumerate().find(|(_,g)|g["id"]=="masthead").unwrap();
                        let n=mast["children"].as_array().unwrap().iter().position(|n|n["content"]["value"]=="Atmosphere").unwrap();
                        edits.push(json!({"op":"replace","path":format!("/layouts/{layout}/root/children/{g}/children/{n}/content/value"),"value":"Evening Desk"}));
                    }
                    edits.push(json!({"op":"copy","from":"/layouts/landscape","path":"/layouts/isobar-landscape"}));
                    edits.push(json!({"op":"copy","from":"/layouts/missing","path":"/layouts/isobar-vertical"}));
                    Ok(serde_json::from_value(json!({"message":"Prepared the new masthead in both formats.","edits":edits,"suggestions":[{"label":"Adjust title color","prompt":"Warm the Evening Desk title color."}]}))?)
                };
            }
            r.assistant.input.update(cx,|f,c|f.reset("Change the Atmosphere masthead to Evening Desk in both layouts.".into(),c));
        }));
        for state in [
            super::AccountState::Disconnected,
            super::AccountState::Connected,
        ] {
            cx.update(|_, cx| {
                room.update(cx, |r, cx| {
                    r.assistant.account = state;
                    r.assistant.next_account_check = None;
                    cx.notify();
                })
            });
            cx.run_until_parked();
            assert_eq!(
                cx.debug_bounds("assistant-account-action").is_some(),
                state == super::AccountState::Disconnected
            );
            assert_eq!(
                cx.debug_bounds("✓ ChatGPT connected").is_some(),
                state == super::AccountState::Connected
            );
        }
        let click = |cx: &mut VisualTestContext, id: &'static str| {
            let bounds = cx
                .debug_bounds(id)
                .unwrap_or_else(|| panic!("Missing {id}"));
            cx.simulate_click(bounds.center(), Modifiers::default());
            cx.run_until_parked();
        };
        click(&mut cx, "assistant-attach");
        assert!(room.read_with(&cx, |r, _| r.assistant.attachment_menu));
        click(&mut cx, "assistant-attach");
        click(&mut cx, "assistant-send");
        if std::env::var_os("PRODUCER_REAL_ASSISTANT_TEST").is_none() {
            assert!(cx.debug_bounds("assistant-call-indicator").is_some());
            assert!(cx.debug_bounds("assistant-context-checks").is_some());
            assert!(room.read_with(&cx, |r, _| r.assistant.expanded_checks.is_empty()));
            click(&mut cx, "assistant-context-checks");
            assert!(room.read_with(&cx, |r, _| r.assistant.expanded_checks.contains(&0)));
            click(&mut cx, "assistant-context-checks");
            assert_eq!(
                room.read_with(&cx, |r, _| r.assistant.receipts[&0]
                    .call_clock
                    .lock()
                    .unwrap()
                    .unwrap()
                    .0),
                2
            );
        }
        assert!(
            room.read_with(&cx, |r, _| r.assistant.pending.is_some()),
            "{}",
            room.read_with(&cx, |r, _| r.assistant.status.clone())
        );
        click(&mut cx, "assistant-chip-0");
        assert!(room.read_with(&cx, |r, c| !r.assistant.input.read(c).value.is_empty()));
        // Change controller context after generation. Review must open the pinned draft.
        if std::env::var_os("PRODUCER_REAL_ASSISTANT_TEST").is_none() {
            cx.update(|_, cx| {
                room.update(cx, |r, _| {
                    r.set_selection = Some((
                        r.snapshot.project.active_scene.clone(),
                        "atmosphere".into(),
                        Default::default(),
                    ))
                })
            });
        }
        click(&mut cx, "assistant-review");
        let editor = room.read_with(&cx, |r, _| r.set_editor.as_ref().unwrap().review_state());
        assert_eq!(editor["set"], "orbital-desk");
        if std::env::var_os("PRODUCER_REAL_ASSISTANT_TEST").is_none() {
            assert_eq!(
                editor["displayed"],
                json!({"landscape":"isobar-landscape","vertical":"isobar-vertical"})
            );
            assert!(
                room.read_with(&cx, |r, _| r.assistant.receipts[&0].receipt().iter().any(
                    |s| s["state"] == "failed"
                        && s["label"]
                            .as_str()
                            .unwrap()
                            .contains("Source layout missing")
                ))
            );
        }
        click(&mut cx, "assistant-save");
        let result = saved.lock().unwrap();
        if let Some(path) = std::env::var_os("ASSISTANT_PROOF_OUTPUT") {
            std::fs::write(
                path,
                serde_json::to_vec_pretty(result.as_ref().expect("Save must submit a draft"))
                    .unwrap(),
            )
            .unwrap();
        }
        for layout in ["vertical", "landscape"] {
            assert!(
                serde_json::to_string(&result.as_ref().unwrap().layouts[layout])
                    .unwrap()
                    .contains("Evening Desk")
            );
        }
        drop(result);
        cx.update(|_, cx| {
            room.update(cx, |r, cx| {
                use crate::ipc::AssistantRequest::*;
                let request = |r: &mut Room, op, cx: &mut gpui::Context<Room>| {
                    let (tx, rx) = std::sync::mpsc::sync_channel(1);
                    r.handle.assistant_requests.lock().unwrap().push_back((
                        op,
                        tx,
                        std::time::Instant::now(),
                    ));
                    r.assistant_tick(cx);
                    rx.try_recv().unwrap()
                };
                let generation = r.assistant.generation;
                let turn = Arc::new(crate::assistant::Turn::new(generation));
                r.assistant.active = Some((std::time::Instant::now(), turn.clone()));
                r.assistant.busy = true;
                assert_eq!(request(r, AssistantStatus, cx)["busy"], true);
                assert_eq!(
                    request(
                        r,
                        AssistantStop {
                            generation: generation + 1
                        },
                        cx
                    )["ok"],
                    false
                );
                assert_eq!(request(r, AssistantStop { generation }, cx)["ok"], true);
                assert!(turn.check().is_err());
                assert_eq!(request(r, AssistantStatus, cx)["busy"], false);
                let turn = Arc::new(crate::assistant::Turn::new(r.assistant.generation));
                r.assistant.active = Some((
                    std::time::Instant::now() - std::time::Duration::from_secs(181),
                    turn,
                ));
                r.assistant.busy = true;
                assert_eq!(request(r, AssistantStatus, cx)["busy"], false);
                assert!(r.assistant.status.contains("timed out"));
            })
        });
        std::fs::remove_dir_all(root).unwrap();
    }
}
