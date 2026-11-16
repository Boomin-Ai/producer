//! Isolated local stdio authority. No listening socket, credentials, devices or app profile.
use producer_production_core::{
    commands::{self, Command},
    compile,
    contract::*,
    coordinator::*,
    storage::*,
    timeline::{Timeline, TimelineEvent},
    transport::OutputInstant,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::{
    io::{self, BufRead, Read, Write},
    path::Path,
    time::Instant,
};

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(tag = "method", rename_all = "camelCase", deny_unknown_fields)]
enum Request {
    Hello,
    Inspect {
        session: String,
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
}
fn error(code: &str, m: impl Into<String>) -> Error {
    Error::new(code, "cli", m)
}
fn read(path: &str, limit: usize) -> Result<Vec<u8>> {
    let mut f = std::fs::File::open(path).map_err(|e| error("FILE", e.to_string()))?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut f)
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| error("FILE", e.to_string()))?;
    if bytes.len() > limit {
        return Err(error("RAW_LIMIT", "file exceeds byte limit"));
    }
    Ok(bytes)
}
fn response<T: Serialize>(r: Result<T>) -> serde_json::Value {
    match r {
        Ok(result) => serde_json::json!({"ok":true,"result":result}),
        Err(e) => serde_json::json!({"ok":false,"error":e}),
    }
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
fn simulate(
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
    let per_event = sequence.tracks.len() + sequence.players.len() + sequence.cues.len() + 1;
    if events.len().saturating_mul(per_event) > 65_536 {
        return Err(error(
            "TIMELINE_LIMIT",
            "maximum 65536 aggregate simulated track/player/cue visits",
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
fn evaluate(d: &Document, sequence: &str, time: Time) -> Result<serde_json::Value> {
    let plan = compile::compile(d)?;
    let sequence = plan
        .sequences
        .get(sequence)
        .ok_or_else(|| error("SEQUENCE", "sequence missing"))?;
    let mut values = vec![None; sequence.tracks.len()];
    sequence
        .evaluate_into(time, &mut values)
        .map_err(|e| error("EVALUATE", format!("{e:?}")))?;
    Ok(serde_json::json!({"time":time,"values":values}))
}
fn rpc(c: &mut Coordinator<FileStore>, r: Request, now: u64) -> Result<serde_json::Value> {
    Ok(match r {
        // The inherited stdio pipe is the authenticated local transport. A future
        // socket/UI adapter must establish native grants before calling session().
        Request::Hello => {
            let (s, _) = c.session(true)?;
            serde_json::json!({"session":s,"boot":c.boot,"revision":c.state.revision,"synthetic":true})
        }
        Request::Inspect { session } => {
            c.status(&session, "")?;
            serde_json::json!({"revision":c.state.revision,"cursor":c.state.cursor,"digest":digest(&c.state.document)?,"document":c.state.document,"readOnly":c.read_only})
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
        } => serde_json::to_value(c.submit(&session, &ticket, &command, now)?).unwrap(),
        Request::Status { session, ticket } => {
            serde_json::to_value(c.status(&session, &ticket)?).unwrap()
        }
        Request::Undo { session } => serde_json::to_value(c.undo_command(&session)?).unwrap(),
        Request::Checkpoint { session } => {
            c.checkpoint(&session)?;
            serde_json::json!({"saved":true})
        }
        Request::Disconnect { session } => {
            c.status(&session, "")?;
            c.disconnect(&session);
            serde_json::json!({"disconnected":true})
        }
        Request::Evaluate {
            session,
            sequence,
            time,
        } => {
            c.status(&session, "")?;
            evaluate(&c.state.document, &sequence, time)?
        }
        Request::SimulateTimeline {
            session,
            sequence,
            looping,
            events,
        } => {
            c.status(&session, "")?;
            simulate(&c.state.document, &sequence, looping, events)?
        }
    })
}
fn serve(dir: &str, id: &str) -> Result<()> {
    if !validate::valid_id(id) {
        return Err(error("ID", "explicit document ID required"));
    }
    let (store, state) =
        FileStore::open(Path::new(dir), Document::empty(id, "Untitled production"))?;
    if state.document.id != id {
        return Err(error(
            "ID",
            "store document ID differs; refusing implicit adoption",
        ));
    }
    let mut c = Coordinator::new(state, store);
    let start = Instant::now();
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let stdout = io::stdout();
    let mut out = stdout.lock();
    loop {
        let mut bytes = Vec::new();
        let n = Read::by_ref(&mut input)
            .take((DOCUMENT_BYTES + 64 * 1024 + 1) as u64)
            .read_until(b'\n', &mut bytes)
            .map_err(|e| error("STDIO", e.to_string()))?;
        if n == 0 {
            break;
        }
        let r = if bytes.len() > DOCUMENT_BYTES + 64 * 1024 {
            Err(error(
                "RAW_LIMIT",
                "RPC envelope too large; transport closed",
            ))
        } else {
            ingress::parse_envelope(&bytes, DOCUMENT_BYTES + 64 * 1024)
                .and_then(|v| {
                    serde_json::from_value::<Request>(v)
                        .map_err(|e| error("STRUCTURE", e.to_string()))
                })
                .and_then(|r| rpc(&mut c, r, start.elapsed().as_millis() as u64))
        };
        serde_json::to_writer(&mut out, &response(r)).map_err(|e| error("STDIO", e.to_string()))?;
        out.write_all(b"\n")
            .and_then(|_| out.flush())
            .map_err(|e| error("STDIO", e.to_string()))?;
        if n > DOCUMENT_BYTES + 64 * 1024 {
            break;
        }
    }
    Ok(())
}
fn main_result() -> Result<Option<serde_json::Value>> {
    let a: Vec<_> = std::env::args().skip(1).collect();
    let arg = |n: usize| {
        a.get(n)
            .map(String::as_str)
            .ok_or_else(|| error("USAGE", "missing argument"))
    };
    let v=match arg(0)? {
        "schema"=>schema(),"command-schema"=>commands::schema(),"tool-schema"=>serde_json::to_value(schemars::schema_for!(Request)).unwrap(),
        "fixture"=>serde_json::to_value(fixture::classic_like()).unwrap(),
        "nested-fixture"=>serde_json::to_value(fixture::nested_timeline()).unwrap(),
        "validate"=>{let d=parse_document(&read(arg(1)?,DOCUMENT_BYTES)?)?;serde_json::json!({"digest":digest(&d)?,"inventory":validate_document(&d)?})},
        "compile"=>{let d=parse_document(&read(arg(1)?,DOCUMENT_BYTES)?)?;serde_json::to_value(compile::compile(&d)?).unwrap()},
        "evaluate"=>{let d=parse_document(&read(arg(1)?,DOCUMENT_BYTES)?)?;let t=serde_json::from_value::<Time>(ingress::parse_envelope(arg(3)?.as_bytes(),COMMAND_BYTES)?).map_err(|e|error("TIME",e.to_string()))?;evaluate(&d,arg(2)?,t)?},
        "simulate"=>{let d=parse_document(&read(arg(1)?,DOCUMENT_BYTES)?)?;let events=serde_json::from_value::<Vec<TimelineEvent>>(ingress::parse_envelope(arg(3)?.as_bytes(),COMMAND_BYTES)?).map_err(|e|error("STRUCTURE",e.to_string()))?;simulate(&d,arg(2)?,false,events)?},
        "serve" if arg(1)?=="--store"&&arg(3)?=="--document-id"=>{serve(arg(2)?,arg(4)?)?;return Ok(None);},
        _=>return Err(error("USAGE","producer-core schema|command-schema|tool-schema|fixture|nested-fixture|validate FILE|compile FILE|evaluate FILE SEQUENCE TIME_JSON|simulate FILE SEQUENCE EVENTS_JSON|serve --store EXPLICIT_DIRECTORY --document-id ID")),
    };
    Ok(Some(v))
}
fn main() {
    match main_result() {
        Ok(Some(v)) => {
            serde_json::to_writer_pretty(io::stdout(), &v).unwrap();
            println!();
        }
        Ok(None) => {}
        Err(e) => {
            eprintln!("{}", serde_json::to_string(&e).unwrap());
            std::process::exit(1);
        }
    }
}
