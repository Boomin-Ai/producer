//! Shared CLI/native protocol. Transport scope and author policy are native-only.
use producer_production_core::{
    commands::Command,
    compile,
    contract::*,
    coordinator::*,
    host::ProductionHost,
    show::{ShowEvent, ShowRun},
    storage::*,
    timeline::{Timeline, TimelineEvent},
    transport::OutputInstant,
};
use schemars::JsonSchema;
use serde::Deserialize;
use std::io::{self, Write};
fn error(code: &str, m: impl Into<String>) -> Error {
    Error::new(code, "service", m)
}
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(tag = "method", rename_all = "camelCase", deny_unknown_fields)]
pub enum Request {
    Hello {},
    Inspect {
        session: String,
    },
    Services {
        session: String,
    },
    Observe {
        session: String,
    },
    ObserverPoll {
        session: String,
        observer: String,
    },
    ObserverSnapshot {
        session: String,
        observer: String,
    },
    ObserverComplete {
        session: String,
        observer: String,
        cursor: Counter,
        digest: String,
    },
    Unobserve {
        session: String,
        observer: String,
    },
    /// Paged headless layout rehearsal. Observed ratios do not mutate the saved
    /// document, take output, or prove a source/device is physically ready.
    Layout {
        session: String,
        set: String,
        layout: String,
        #[serde(default)]
        inputs: Option<LayoutInputs>,
        #[serde(default)]
        offset: u32,
        #[schemars(range(min = 1, max = 128))]
        limit: u16,
    },
    Issue {
        session: String,
        expected: Counter,
        command: Command,
    },
    Submit {
        session: String,
        ticket: String,
        command: Command,
    },
    Status {
        session: String,
        ticket: String,
    },
    Undo {
        session: String,
    },
    Checkpoint {
        session: String,
    },
    Disconnect {
        session: String,
    },
    /// Pure numeric sampling of the saved production document. No effects fire.
    Evaluate {
        session: String,
        sequence: String,
        time: Time,
    },
    /// Bounded headless transport rehearsal; emits cue intents but never dispatches them.
    SimulateTimeline {
        session: String,
        sequence: String,
        #[serde(default)]
        looping: bool,
        #[schemars(length(max = 128))]
        events: Vec<TimelineEvent>,
    },
    /// Pure Show rehearsal with scoped cleanup. No output take or effect dispatch.
    SimulateShow {
        session: String,
        show: String,
        #[schemars(length(max = 128))]
        events: Vec<ShowEvent>,
    },
}
struct ByteBudget(usize);
impl Write for ByteBudget {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0 = self
            .0
            .checked_sub(bytes.len())
            .ok_or_else(|| io::Error::other("simulation response budget exceeded"))?;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
pub fn simulate(
    d: &Document,
    sequence: &str,
    looping: bool,
    events: Vec<TimelineEvent>,
) -> Result<serde_json::Value> {
    if events.len() > 128 {
        return Err(error("TIMELINE_LIMIT", "maximum 128 simulation events"));
    }
    let bytes = serde_json::to_vec(&events).map_err(|e| error("STRUCTURE", e.to_string()))?;
    ingress::parse_envelope(&bytes, COMMAND_BYTES)?;
    let plan = compile::compile(d)?;
    let sequence = plan
        .sequences
        .get(sequence)
        .ok_or_else(|| error("SEQUENCE", "sequence missing"))?;
    let per_event = sequence.tracks.len()
        + sequence.players.len()
        + sequence.cues.len()
        + sequence.effects.len()
        + 1;
    if events.len().saturating_mul(per_event) > 65_536 {
        return Err(error(
            "TIMELINE_LIMIT",
            "maximum 65536 aggregate simulated control-work units",
        ));
    }
    let mut timeline = Timeline::new(sequence.clone(), looping, OutputInstant(Counter(0)))?;
    let mut samples = Vec::new();
    let mut budget = ByteBudget(DOCUMENT_BYTES - 1024);
    for event in events {
        let sample = timeline.apply(event)?;
        serde_json::to_writer(&mut budget, &sample)
            .map_err(|_| error("TIMELINE_LIMIT", "simulation response exceeds 8 MiB"))?;
        samples.push(sample);
    }
    Ok(serde_json::json!({"synthetic":true,"samples":samples}))
}
pub fn evaluate(d: &Document, sequence: &str, time: Time) -> Result<serde_json::Value> {
    let plan = compile::compile(d)?;
    let sequence = plan
        .sequences
        .get(sequence)
        .ok_or_else(|| error("SEQUENCE", "sequence missing"))?;
    let mut values = vec![None; sequence.tracks.len()];
    sequence
        .evaluate_into(time, &mut values)
        .map_err(|e| error("EVALUATE", format!("{e:?}")))?;
    let mut effects = vec![None; sequence.effects.len()];
    sequence
        .evaluate_effects_into(time, &mut effects)
        .map_err(|e| error("EVALUATE", format!("{e:?}")))?;
    Ok(serde_json::json!({"time":time,"values":values,"effects":effects}))
}
pub fn simulate_show(
    d: &Document,
    id: &str,
    events: Vec<ShowEvent>,
    grant: RevokeFence,
) -> Result<serde_json::Value> {
    if events.len() > 128 {
        return Err(error("SHOW_LIMIT", "maximum 128 simulation events"));
    }
    let bytes = serde_json::to_vec(&events).map_err(|e| error("STRUCTURE", e.to_string()))?;
    ingress::parse_envelope(&bytes, COMMAND_BYTES)?;
    let mut show = ShowRun::compile(d, id, grant, OutputInstant(Counter(0)))?;
    if events.len().saturating_mul(show.work_per_event()) > 65_536 {
        return Err(error(
            "SHOW_LIMIT",
            "maximum 65536 aggregate simulated control-work units",
        ));
    }
    let mut samples = Vec::new();
    let mut budget = ByteBudget(DOCUMENT_BYTES - 1024);
    for event in events {
        let sample = show.apply(event)?;
        serde_json::to_writer(&mut budget, &sample)
            .map_err(|_| error("SHOW_LIMIT", "simulation response exceeds 8 MiB"))?;
        samples.push(sample);
    }
    Ok(serde_json::json!({"synthetic":true,"samples":samples}))
}
pub fn rehearse_layout(
    d: &Document,
    set: &str,
    layout: &str,
    inputs: Option<&LayoutInputs>,
    offset: u32,
    limit: u16,
) -> Result<serde_json::Value> {
    if !(1..=128).contains(&limit) {
        return Err(error("LAYOUT_LIMIT", "page size must be in [1,128]"));
    }
    let authored = d
        .sets
        .get(set)
        .and_then(|s| s.layouts.get(layout))
        .ok_or_else(|| error("LAYOUT", "Set/layout is missing"))?;
    let fallback = LayoutInputs::empty(&d.id);
    let plan = compile::compile_with_layout_inputs(d, inputs.unwrap_or(&fallback))?;
    let prefix = format!("sets/{set}/layouts/{layout}/");
    let count = plan
        .nodes
        .iter()
        .filter(|n| n.path.starts_with(&prefix))
        .count();
    let nodes: Vec<_> = plan
        .nodes
        .iter()
        .filter(|n| n.path.starts_with(&prefix))
        .skip(offset as usize)
        .take(usize::from(limit))
        .collect();
    let mut identities = std::collections::BTreeMap::new();
    for source in nodes
        .iter()
        .filter_map(|n| n.aspect.as_ref()?.source.as_ref())
    {
        identities.insert(source.clone(), layout::source_layout_identity(d, source)?);
    }
    let reply = serde_json::json!({"documentDigest":plan.digest,"geometryDigest":plan.geometry_digest,"set":set,"layout":layout,"width":authored.width,"height":authored.height,"total":count,"offset":offset,"nodes":nodes,"sourceIdentities":identities,"next":if (offset as usize)+nodes.len()<count {Some((offset as usize)+nodes.len())} else {None}});
    let mut budget = ByteBudget(COMMAND_BYTES);
    serde_json::to_writer(&mut budget, &reply).map_err(|_| {
        error(
            "LAYOUT_LIMIT",
            "layout page exceeds 256 KiB; request a smaller page",
        )
    })?;
    Ok(reply)
}
pub(crate) fn rpc<S: Storage>(
    c: &mut ProductionHost<S>,
    _document: &str,
    _author: bool,
    r: Request,
    now: u64,
) -> Result<serde_json::Value> {
    Ok(match r {
        Request::Hello {} => {
            return Err(error(
                "EXECUTOR_ROUTE",
                "hello requires native connection policy",
            ))
        }
        Request::Inspect { session } => serde_json::to_value(c.inspect(&session)?).unwrap(),
        Request::Services { session } => {
            serde_json::to_value(c.inspect_services(&session)?).unwrap()
        }
        Request::Observe { session } => serde_json::json!({"observer":c.observe(&session)?}),
        Request::ObserverPoll { session, observer } => {
            serde_json::to_value(c.observer_poll(&session, &observer)?).unwrap()
        }
        Request::ObserverSnapshot { session, observer } => {
            c.observer_snapshot(&session, &observer)?;
            serde_json::json!({"snapshotStarted":true})
        }
        Request::ObserverComplete {
            session,
            observer,
            cursor,
            digest,
        } => {
            c.observer_complete(&session, &observer, cursor, &digest)?;
            serde_json::json!({"snapshotCompleted":true})
        }
        Request::Unobserve { session, observer } => {
            c.unobserve(&session, &observer)?;
            serde_json::json!({"disconnected":true})
        }
        Request::Layout {
            session,
            set,
            layout,
            inputs,
            offset,
            limit,
        } => {
            let read = c.inspect(&session)?;
            rehearse_layout(
                read.document(),
                &set,
                &layout,
                inputs.as_ref(),
                offset,
                limit,
            )?
        }
        Request::Issue {
            session,
            expected,
            command,
        } => serde_json::json!({"ticket":c.issue(&session,expected,&command,now)?}),
        Request::Submit {
            session,
            ticket,
            command,
        } => {
            let _ = (session, ticket, command);
            return Err(error("EXECUTOR_ROUTE", "submission requires writer lane"));
        }
        Request::Status { session, ticket } => {
            serde_json::to_value(c.status(&session, &ticket)?).unwrap()
        }
        Request::Undo { session } => serde_json::to_value(c.undo_command(&session)?).unwrap(),
        Request::Checkpoint { session } => {
            let _ = session;
            return Err(error("EXECUTOR_ROUTE", "checkpoint requires writer lane"));
        }
        Request::Disconnect { session } => {
            c.disconnect(&session)?;
            serde_json::json!({"disconnected":true})
        }
        Request::Evaluate {
            session,
            sequence,
            time,
        } => evaluate(c.inspect(&session)?.document(), &sequence, time)?,
        Request::SimulateTimeline {
            session,
            sequence,
            looping,
            events,
        } => simulate(c.inspect(&session)?.document(), &sequence, looping, events)?,
        Request::SimulateShow {
            session,
            show,
            events,
        } => simulate_show(
            c.inspect(&session)?.document(),
            &show,
            events,
            c.author_grant(&session)?,
        )?,
    })
}

impl Request {
    pub(crate) fn session(&self) -> &str {
        match self {
            Self::Hello {} => "",
            Self::Inspect { session, .. } => session,
            Self::Services { session, .. } => session,
            Self::Observe { session, .. } => session,
            Self::ObserverPoll { session, .. } => session,
            Self::ObserverSnapshot { session, .. } => session,
            Self::ObserverComplete { session, .. } => session,
            Self::Unobserve { session, .. } => session,
            Self::Layout { session, .. } => session,
            Self::Issue { session, .. } => session,
            Self::Submit { session, .. } => session,
            Self::Status { session, .. } => session,
            Self::Undo { session, .. } => session,
            Self::Checkpoint { session, .. } => session,
            Self::Disconnect { session, .. } => session,
            Self::Evaluate { session, .. } => session,
            Self::SimulateTimeline { session, .. } => session,
            Self::SimulateShow { session, .. } => session,
        }
    }
}
pub(crate) fn rpc_hello<S: Storage>(
    c: &ProductionHost<S>,
    session: &str,
) -> Result<Option<serde_json::Value>> {
    let read = c.inspect(session)?;
    Ok(Some(
        serde_json::json!({"session":session,"boot":c.boot(session)?,"revision":read.revision,"synthetic":true}),
    ))
}
