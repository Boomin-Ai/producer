//! A private GPT-Live conversation owned by the native Assistant.
use super::*;
use anyhow::{bail, ensure, Context, Result};
use serde_json::Value;
use std::collections::HashSet;
use std::ffi::{c_char, c_void, CStr, CString};
use std::ptr::NonNull;

extern "C" {
    fn producer_voice_open(config: *const c_char) -> *mut c_void;
    fn producer_voice_close(session: *mut c_void);
    fn producer_voice_next(session: *mut c_void) -> *mut c_char;
    fn producer_voice_send(session: *mut c_void, event: *const c_char);
}

struct Connection(NonNull<c_void>);

impl Drop for Connection {
    fn drop(&mut self) {
        unsafe { producer_voice_close(self.0.as_ptr()) }
    }
}

impl Connection {
    fn send(&self, event: Value) {
        let encoded = CString::new(event.to_string()).unwrap();
        unsafe { producer_voice_send(self.0.as_ptr(), encoded.as_ptr()) }
    }

    fn next(&self) -> Option<Value> {
        let ptr = NonNull::new(unsafe { producer_voice_next(self.0.as_ptr()) })?;
        let event = unsafe { serde_json::from_slice(CStr::from_ptr(ptr.as_ptr()).to_bytes()) };
        unsafe { libc::free(ptr.as_ptr().cast()) };
        event.ok()
    }

    fn reply(&self, call: &str, result: String) {
        self.send(
            json!({"type":"response.item.create","item":{"type":"function_call_output",
            "call_id":call,"output":result}}),
        );
        self.send(json!({"type":"response.create"}));
    }
}

fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({"type":"function","name":name,"description":description,"strict":true,
        "parameters":{"type":"object","properties":properties,"required":required,"additionalProperties":false}})
}

fn config() -> Value {
    let surfaces: Vec<_> = ["boominSignIn", "publishingAccounts", "newPost"].into_iter()
        .chain(PanelId::launch_panels().map(PanelId::key)).collect();
    let tools = vec![
        tool("open_surface", "Open the requested native modal or studio panel. Use boominSignIn for sign-in, publishingAccounts to connect Threads and newPost for the manual composer.", json!({"surface":{"type":"string","enum":surfaces}}), &["surface"]),
        tool("inspect_studio", "Read current program, visible panels, publishing readiness and the current voice draft.", json!({}), &[]),
        tool("review_threads", "Read the saved voice draft and resolve the destination after signing in or choosing a Threads account. Use an empty account to keep the previous choice.", json!({"account":{"type":"string"}}), &["account"]),
        tool("draft_threads", "Create or replace the current Threads draft. Give the complete revised text. Include the latest saved clip only when requested.",json!({"text":{"type":"string"},"latest_clip":{"type":"boolean"},"account":{"type":"string","description":"Requested Threads handle, or empty to use the only connected account"}}), &["text","latest_clip","account"]),
        tool("publish_draft", "Queue the current reviewed draft only after the operator explicitly asks to publish it. Pass the revision returned by draft_threads.",json!({"revision":{"type":"string"}}), &["revision"]),
        tool("studio_request","Send the operator's request to the existing Producer studio assistant.",json!({"prompt":{"type":"string"}}), &["prompt"]),
    ];
    json!({"model":"gpt-live-1.1","instructions":include_str!("duce_voice_prompt.txt"),
        "audio":{"format":{"type":"audio/pcm","rate":24000},"output":{"voice":"marin"}},
        "delegation":{"type":"responses","responses":{"model":"gpt-5.6-luna","tools":tools,"parallel_tool_calls":false,
        "instructions":"Use tools on behalf of the speaking operator. Preserve their wording and tone. For a draft with no account specified, call draft_threads with an empty account so Producer can resolve it. Use review_threads after sign-in, connection or account selection. Ask the operator to enter credentials in the native form. Open native surfaces on request. Inspect studio state before guessing. Route design, input, scene, layout, audio and workspace changes through studio_request for native validation and review. Treat revision as an opaque identifier and never read it aloud. Only call publish_draft after an explicit spoken instruction to publish the current draft."}}})
}

#[derive(Default)]
pub(super) struct Voice {
    connection: Option<Connection>,
    pub status: String,
    draft: Option<publish::VoiceDraft>,
    seen: HashSet<String>,
    transcript_row: Option<usize>,
    pending: Option<(String, mpsc::Receiver<Result<()>>)>,
}

impl Voice {
    pub(super) fn listening(&self) -> bool {
        self.connection.is_some()
    }
}

pub(super) fn control(s: &Studio, compact: bool) -> El {
    let on = s.chat.voice.connection.is_some();
    super::panels::tool(
        if compact { "duce-quick" } else { "duce-voice" },
        if on { "stop" } else { "mic" },
        if on {
            "End Duce voice session"
        } else {
            "Talk to Duce"
        },
        on,
        move |s| {
            if s.chat.voice.connection.is_some() {
                s.chat.voice = Voice::default();
            } else {
                let cfg = CString::new(config().to_string()).unwrap();
                s.chat.voice = Voice {
                    connection: NonNull::new(unsafe { producer_voice_open(cfg.as_ptr()) })
                        .map(Connection),
                    status: "Connecting to Duce…".into(),
                    ..Default::default()
                };
                if compact {
                    s.show_chat = true;
                }
            }
        },
    )
    .size(28., 28.)
}

fn open_accounts(s: &mut Studio) -> Result<&'static str> {
    use quick_controls::PublishPopout;
    match &s.quick_controls.publish {
        None | Some(PublishPopout::DuceAccounts) => {
            s.quick_controls.publish = Some(PublishPopout::DuceAccounts);
        }
        Some(PublishPopout::SignIn { .. }) => return Ok("The Boomin sign-in form is open"),
        Some(PublishPopout::Composer) => bail!("Close the current post composer to open publishing accounts"),
    }
    Ok(if s.publish.scope.is_none() {
        "The Boomin sign-in form is open. Enter credentials directly in Producer."
    } else {
        "Publishing accounts is open. Connect or refresh Threads there."
    })
}

fn review_draft(s: &mut Studio, account: &str) -> Result<String> {
    let mut draft = s.chat.voice.draft.take().context("Prepare a draft first")?;
    let result = draft.review(s, account);
    let text = draft.text.clone();
    s.chat.voice.draft = Some(draft);
    match result {
        Ok(result) => {
            if matches!(s.quick_controls.publish, Some(quick_controls::PublishPopout::DuceAccounts)) {
                quick_controls::dismiss_publish(s);
            }
            Ok(result)
        }
        Err(error) => {
            let mut message = format!("Draft held in this voice session: {text}\n{error}.");
            if !publish::has_threads(s) {
                match open_accounts(s) {
                    Ok(status) => message.push_str(&format!(" {status}")),
                    Err(error) => message.push_str(&format!(" {error}.")),
                }
            }
            Ok(format!("{message} Review this draft after connecting or choosing an account."))
        }
    }
}

fn open_surface(s: &mut Studio, surface: &str) -> Result<String> {
    match surface {
        "boominSignIn" if s.publish.scope.is_some() => Ok("Already signed in to Boomin".into()),
        "boominSignIn" | "publishingAccounts" => Ok(open_accounts(s)?.into()),
        "newPost" => {
            ensure!(s.publish.can_open_composer(), "Publishing is busy");
            if !quick_controls::publish_open(s) {
                quick_controls::open_publish(s, None);
            }
            match s.quick_controls.publish {
                Some(quick_controls::PublishPopout::Composer) => Ok("New post composer is open".into()),
                Some(_) if s.publish.scope.is_none() => Ok("Boomin sign-in form is open".into()),
                _ => bail!("Close publishing accounts before opening a new post"),
            }
        }
        name => {
            let panel = PanelId::launch_panels().find(|p| p.key() == name).context("Unknown studio surface")?;
            let live = s.live.as_mut().context("Open a studio first")?;
            live.handle.send(RoomCommand::Workspace { command: WorkspaceCommand::Activate { panel } })?;
            live.updated = Instant::now() - Duration::from_secs(1);
            Ok(format!("Requested the {} panel", panel.label()))
        }
    }
}

pub(super) fn run(s: &mut Studio, name: &str, args: &Value, call: &str) -> Result<Option<String>> {
    match name {
        "open_surface" => Ok(Some(open_surface(s, args["surface"].as_str().context("Missing surface")?)?)),
        "inspect_studio" => {
            let live = s.live.as_ref().context("Open a studio first")?;
            let snap = &live.snapshot;
            let panels: Vec<_> = PanelId::launch_panels()
                .filter(|p| snap.project.workspace.visible(*p)).map(PanelId::key).collect();
            Ok(Some(json!({"program": snap.program_kind, "mountedSet":snap.project.mounted_set,
                "layout":snap.program_layout, "recording":snap.recording, "visiblePanels":panels,
                "boominSignedIn":s.publish.scope.is_some(), "threadsAvailable":publish::has_threads(s),
                "draft":s.chat.voice.draft.as_ref().map(|d| &d.text)}).to_string()))
        }
        "draft_threads" => {
            let draft = publish::VoiceDraft::prepare(s, args["text"].as_str().context("Missing draft")?,
                args["account"].as_str().unwrap_or(""), args["latest_clip"] == true)?;
            s.chat.voice.draft = Some(draft);
            Ok(Some(review_draft(s, "")?))
        }
        "review_threads" => Ok(Some(review_draft(s, args["account"].as_str().unwrap_or(""))?)),
        "publish_draft" => {
            let draft = s
                .chat
                .voice
                .draft
                .as_ref()
                .context("Prepare a draft first")?;
            ensure!(
                args["revision"].as_str() == Some(draft.revision.as_str()),
                "Review the current draft first"
            );
            let rx = match publish::queue_voice(s, draft) {
                Ok(rx) => rx,
                Err(error) if !publish::has_threads(s) => {
                    let status = open_accounts(s)?;
                    bail!("{error}. {status} Review the draft before publishing.");
                }
                Err(error) => return Err(error),
            };
            s.chat.voice.pending = Some((call.to_owned(), rx));
            Ok(None)
        }
        "studio_request" => {
            ensure!(
                !s.chat.busy() && s.chat.input.text.is_empty(),
                "Assistant is busy or has an unsent message"
            );
            let prompt = args["prompt"]
                .as_str()
                .filter(|t| !t.trim().is_empty())
                .context("Missing request")?;
            s.chat.input = TextEdit::new(prompt);
            chat::submit(s, false);
            ensure!(
                s.chat.busy(),
                "Check the Assistant account and request status"
            );
            Ok(Some(
                "Studio Assistant started the request. Its progress appears in the conversation."
                    .into(),
            ))
        }
        _ => bail!("Unknown Producer action"),
    }
}

pub(super) fn poll(s: &mut Studio) -> bool {
    let mut changed = false;
    if let Some((call, rx)) = &s.chat.voice.pending {
        let result = match rx.try_recv() {
            Ok(result) => Some(result),
            Err(mpsc::TryRecvError::Disconnected) => {
                Some(Err(anyhow::anyhow!("Delivery queue interrupted")))
            }
            _ => None,
        };
        if let Some(result) = result {
            let status = match result {
                Ok(()) => {
                    s.chat.voice.draft = None;
                    s.publish.refresh_voice_queue();
                    "Queued for Threads".to_owned()
                }
                Err(e) => e.to_string(),
            };
            if let Some(c) = &s.chat.voice.connection {
                c.reply(call, status.clone());
            }
            s.chat.voice.status = status;
            s.chat.voice.pending = None;
            changed = true;
        }
    }
    while let Some(event) = s.chat.voice.connection.as_ref().and_then(Connection::next) {
        changed = true;
        match event["type"].as_str() {
            Some("listening") => s.chat.voice.status = "Duce is listening".into(),
            Some("failure") => {
                s.chat.voice.status = event["message"]
                    .as_str()
                    .unwrap_or("Voice session ended")
                    .into();
                s.chat.voice.connection = None;
            }
            Some("session.input_transcript.delta" | "session.output_transcript.delta") => {
                let speaker = if event["type"] == "session.input_transcript.delta" {
                    "user"
                } else {
                    "assistant"
                };
                if let Some(delta) = event["delta"].as_str() {
                    let index = s.chat.history.len().checked_sub(1);
                    if let Some((_, line)) =
                        s.chat.history.last_mut().filter(|(role, _)| {
                            role == speaker && index == s.chat.voice.transcript_row
                        })
                    {
                        line.push_str(delta);
                    } else {
                        s.chat.voice.transcript_row = Some(s.chat.history.len());
                        s.chat.history.push((speaker.into(), delta.into()));
                    }
                }
            }
            Some("response.event") if event["event"]["type"] == "response.failed" => {
                s.chat.voice.status = event["event"]["response"]["error"]["message"]
                    .as_str()
                    .unwrap_or("Duce could not complete the action")
                    .to_string();
            }
            Some("response.event") if event["event"]["type"] == "response.output_item.done" => {
                let item = &event["event"]["item"];
                if item["type"] != "function_call" {
                    continue;
                }
                let Some(call) = item["call_id"].as_str() else {
                    continue;
                };
                if !s.chat.voice.seen.insert(call.to_owned()) {
                    continue;
                }
                let result = if s.chat.voice.pending.is_some() && matches!(item["name"].as_str(), Some("draft_threads" | "review_threads" | "publish_draft")) {
                    Err(anyhow::anyhow!("A post is being queued"))
                } else {
                    serde_json::from_str(item["arguments"].as_str().unwrap_or(""))
                        .context("Invalid tool arguments")
                        .and_then(|args| run(s, item["name"].as_str().unwrap_or(""), &args, call))
                };
                if let Some(reply) = result.unwrap_or_else(|e| Some(e.to_string())) {
                    s.chat.voice.status = if matches!(item["name"].as_str(), Some("draft_threads" | "review_threads"))
                        && s.chat
                            .voice
                            .draft
                            .as_ref()
                            .is_some_and(|d| reply.contains(&d.revision))
                    {
                        s.chat
                            .voice
                            .draft
                            .as_ref()
                            .map(publish::VoiceDraft::summary)
                            .unwrap_or_default()
                    } else {
                        reply.clone()
                    };
                    if let Some(c) = &s.chat.voice.connection {
                        c.reply(call, reply);
                    }
                }
            }
            _ => {}
        }
    }
    changed
}
