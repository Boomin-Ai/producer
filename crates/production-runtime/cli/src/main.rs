//! Isolated bounded stdio adapter. No listening socket, devices or app profile.
use producer_production_core::{
    commands, compile, contract::*, coordinator::*, host::ProductionHost, show::ShowEvent,
    storage::*, timeline::TimelineEvent,
};
use producer_production_service::{
    frame,
    protocol::{evaluate, rehearse_layout, simulate, simulate_show, Request},
    Executor,
};
use std::{
    io::{self, Read, Write},
    path::Path,
};

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
fn serve(dir: &str, id: &str) -> Result<()> {
    if !validate::valid_id(id) {
        return Err(error("ID", "explicit document ID required"));
    }
    let dir = dir.to_owned();
    let id = id.to_owned();
    let open_id = id.clone();
    let runtime = Executor::spawn(vec![id.clone()], move || {
        let mut c = ProductionHost::new()?;
        c.open(&open_id, || {
            FileStore::open(
                Path::new(&dir),
                Document::empty(&open_id, "Untitled production"),
            )
        })?;
        Ok(c)
    })?;
    // This adapter runs off the UI/media callbacks. Retry transient ingress
    // contention without turning a healthy inherited pipe into a disconnect.
    let client = loop {
        match runtime.connect(&id, true) {
            Ok(client) => break client,
            Err(e) if e.code == "EXECUTOR_BUSY" => {
                std::thread::sleep(std::time::Duration::from_millis(1))
            }
            Err(e) => return Err(e),
        }
    };
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let stdout = io::stdout();
    let mut out = stdout.lock();
    while let Some(bytes) = frame::read(&mut input)? {
        let mut pending = bytes;
        let task = loop {
            match client.try_request(pending) {
                Ok(task) => break task,
                Err(rejected) if rejected.error.code == "EXECUTOR_BUSY" => {
                    pending = rejected.bytes;
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
                Err(rejected) => return Err(rejected.error),
            }
        };
        let reply = task.wait()?;
        out.write_all(reply.bytes())
            .and_then(|_| out.write_all(b"\n"))
            .and_then(|_| out.flush())
            .map_err(|e| error("STDIO", e.to_string()))?;
    }
    client.disconnect();
    runtime.shutdown().join()?;
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
        "bundle-readiness" => {
            let bundle = producer_interchange::OpenBundle::open(Path::new(arg(1)?))?;
            let observations = ingress::parse(&read(arg(4)?, COMMAND_BYTES)?, COMMAND_BYTES)?;
            let observations = serde_json::from_value(observations).map_err(|e|error("BINDINGS",e.to_string()))?;
            bundle.readiness(arg(2)?,arg(3)?,&observations)?
        }
        "bundle-show" => {
            let bundle = producer_interchange::OpenBundle::open(Path::new(arg(1)?))?;
            let show = arg(2)?;
            let events = ingress::parse_envelope(arg(3)?.as_bytes(),COMMAND_BYTES)?;
            let events = serde_json::from_value(events).map_err(|e|error("EVENTS",e.to_string()))?;
            let grant = Coordinator::new(Snapshot::new(Document::empty("rehearsal","Rehearsal"))?, MemoryStore::default()).session(true)?.1;
            let mut result = simulate_show(&bundle.document,show,events,grant)?;
            result["revision"] = serde_json::json!(bundle.revision);
            result
        }
        "bundle-run" => {
            let bundle = producer_interchange::OpenBundle::open(Path::new(arg(1)?))?;
            let device = ingress::parse(&read(arg(2)?, COMMAND_BYTES)?, COMMAND_BYTES)?;
            let device = serde_json::from_value(device).map_err(|e|error("DEVICE",e.to_string()))?;
            let plan = bundle.plan(&device)?;
            let events = ingress::parse_envelope(arg(4)?.as_bytes(),COMMAND_BYTES)?;
            let events = serde_json::from_value(events).map_err(|e|error("STRUCTURE",e.to_string()))?;
            let transport = simulate(&bundle.document,arg(3)?,false,events)?;
            serde_json::json!({"plan":plan,"transport":transport})
        }
        "bundle-edit" => {
            let bundle = producer_interchange::OpenBundle::open(Path::new(arg(1)?))?;
            if bundle.revision != arg(2)? {return Err(error("STALE_REVISION","edit base differs from current manifest"));}
            let cmd = ingress::parse_envelope(&read(arg(3)?,COMMAND_BYTES)?,COMMAND_BYTES)?;
            let cmd = serde_json::from_value(cmd).map_err(|e|error("COMMAND",e.to_string()))?;
            let document = commands::apply(&bundle.document,&cmd)?;
            validate_document(&document)?;
            serde_json::to_value(document).map_err(|e|error("DOCUMENT",e.to_string()))?
        }
        "bundle-schema" => producer_interchange::schema(),
        "bundle-check" | "bundle-plan" | "bundle-sheet" => {
            let bundle = producer_interchange::OpenBundle::open(Path::new(arg(1)?))?;
            match a[0].as_str() {
                "bundle-plan" => {
                    let device = ingress::parse(&read(arg(2)?, COMMAND_BYTES)?, COMMAND_BYTES)?;
                    let device = serde_json::from_value(device).map_err(|e|error("DEVICE",e.to_string()))?;
                    bundle.plan(&device)?
                }
                "bundle-sheet" => bundle.sheet(arg(2)?)?,
                _ => serde_json::json!({"production":bundle.manifest.production,"revision":bundle.revision,
                    "workSha256":bundle.work_sha256,"author":bundle.manifest.actors[&bundle.manifest.author].identity,
                    "parent":bundle.manifest.parent,"authoredAt":bundle.manifest.authored_at}),
            }
        }
        "schema"=>schema(),"command-schema"=>commands::schema(),"tool-schema"=>serde_json::to_value(schemars::schema_for!(Request)).unwrap(),
        "fixture"=>serde_json::to_value(fixture::classic_like()).unwrap(),
        "nested-fixture"=>serde_json::to_value(fixture::nested_timeline()).unwrap(),
        "layout-fixture"=>serde_json::to_value(fixture::responsive_layout()).unwrap(),
        "analytic-fixture"=>serde_json::to_value(fixture::analytic_reconstruction()).unwrap(),
        "validate"=>{let d=parse_document(&read(arg(1)?,DOCUMENT_BYTES)?)?;serde_json::json!({"digest":digest(&d)?,"inventory":validate_document(&d)?})},
        "compile"=>{let d=parse_document(&read(arg(1)?,DOCUMENT_BYTES)?)?;serde_json::to_value(compile::compile(&d)?).unwrap()},
        "layout"=>{let d=parse_document(&read(arg(1)?,DOCUMENT_BYTES)?)?;let inputs=a.get(4).map(|s| ingress::parse_envelope(s.as_bytes(),COMMAND_BYTES).and_then(|v|serde_json::from_value::<LayoutInputs>(v).map_err(|e|error("STRUCTURE",e.to_string())))).transpose()?;rehearse_layout(&d,arg(2)?,arg(3)?,inputs.as_ref(),0,128)?},
        "evaluate"=>{let d=parse_document(&read(arg(1)?,DOCUMENT_BYTES)?)?;let t=serde_json::from_value::<Time>(ingress::parse_envelope(arg(3)?.as_bytes(),COMMAND_BYTES)?).map_err(|e|error("TIME",e.to_string()))?;evaluate(&d,arg(2)?,t)?},
        "simulate"=>{let d=parse_document(&read(arg(1)?,DOCUMENT_BYTES)?)?;let events=serde_json::from_value::<Vec<TimelineEvent>>(ingress::parse_envelope(arg(3)?.as_bytes(),COMMAND_BYTES)?).map_err(|e|error("STRUCTURE",e.to_string()))?;simulate(&d,arg(2)?,false,events)?},
        "simulate-show"=>{let d=parse_document(&read(arg(1)?,DOCUMENT_BYTES)?)?;let events=serde_json::from_value::<Vec<ShowEvent>>(ingress::parse_envelope(arg(3)?.as_bytes(),COMMAND_BYTES)?).map_err(|e|error("STRUCTURE",e.to_string()))?;let grant=Coordinator::new(Snapshot::new(Document::empty("rehearsal", "Rehearsal"))?,MemoryStore::default()).session(true)?.1;simulate_show(&d,arg(2)?,events,grant)?},
        "serve" if arg(1)?=="--store"&&arg(3)?=="--document-id"=>{serve(arg(2)?,arg(4)?)?;return Ok(None);},
        _=>return Err(error("USAGE","producer-core bundle-readiness DIR SET LAYOUT OBSERVATIONS_FILE|bundle-show DIR SHOW EVENTS_JSON|bundle-run DIR DEVICE SEQUENCE EVENTS_JSON|bundle-edit DIR BASE_REVISION COMMAND_FILE|bundle-schema|bundle-check DIR|bundle-plan DIR DEVICE_JSON_FILE|bundle-sheet DIR SHOT|schema|command-schema|tool-schema|fixture|nested-fixture|layout-fixture|validate FILE|compile FILE|layout FILE SET LAYOUT [INPUTS_JSON]|evaluate FILE SEQUENCE TIME_JSON|simulate FILE SEQUENCE EVENTS_JSON|simulate-show FILE SHOW EVENTS_JSON|serve --store EXPLICIT_DIRECTORY --document-id ID")),
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
