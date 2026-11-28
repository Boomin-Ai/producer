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
    let tools = vec![
        tool("draft_threads", "Create or replace the current Threads draft. Give the complete revised text. Include the latest saved clip only when requested.",json!({"text":{"type":"string"},"latest_clip":{"type":"boolean"},"account":{"type":"string","description":"Requested Threads handle, or empty to use the only connected account"}}), &["text","latest_clip","account"]),
        tool("publish_draft", "Queue the current reviewed draft only after the operator explicitly asks to publish it. Pass the revision returned by draft_threads.",json!({"revision":{"type":"string"}}), &["revision"]),
        tool("studio_request","Send the operator's request to the existing Producer studio assistant.",json!({"prompt":{"type":"string"}}), &["prompt"]),
    ];
    json!({"model":"gpt-live-1.1","instructions":include_str!("duce_voice_prompt.txt"),
        "audio":{"format":{"type":"audio/pcm","rate":24000},"output":{"voice":"marin"}},
        "delegation":{"type":"responses","responses":{"model":"gpt-5.6-luna","tools":tools,"parallel_tool_calls":false,
        "instructions":"Use tools on behalf of the speaking operator. Preserve their wording and tone. For a draft with no account specified, call draft_threads with an empty account so Producer can resolve it. Ask the operator only when the tool returns multiple choices. Treat revision as an opaque identifier and never read it aloud. Only call publish_draft after an explicit spoken instruction to publish the current draft."}}})
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

fn run(s: &mut Studio, name: &str, args: &Value, call: &str) -> Result<Option<String>> {
    match name {
        "draft_threads" => {
            let text = args["text"].as_str().context("Missing draft")?.trim();
            ensure!(
                !text.is_empty() && text.chars().count() <= 500,
                "Use 1 to 500 characters for a Threads post"
            );
            let draft = publish::voice_draft(
                s,
                text,
                args["account"].as_str().unwrap_or(""),
                args["latest_clip"] == true,
            )?;
            let result = format!("Draft {} for {}: {}", draft.revision, draft.account, text);
            s.chat.voice.draft = Some(draft);
            Ok(Some(result))
        }
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
            let rx = publish::queue_voice(s, draft)?;
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
                let result = if s.chat.voice.pending.is_some() {
                    Err(anyhow::anyhow!("A post is being queued"))
                } else {
                    serde_json::from_str(item["arguments"].as_str().unwrap_or(""))
                        .context("Invalid tool arguments")
                        .and_then(|args| run(s, item["name"].as_str().unwrap_or(""), &args, call))
                };
                if let Some(reply) = result.unwrap_or_else(|e| Some(e.to_string())) {
                    s.chat.voice.status = if item["name"] == "draft_threads"
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
                            .map(|d| format!("Draft for {} · {}", d.account, d.text))
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
