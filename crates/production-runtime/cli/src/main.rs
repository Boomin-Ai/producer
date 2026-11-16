//! Isolated local stdio authority. No listening socket, credentials, devices or app profile.
use producer_production_core::{
    commands::{self, Command},
    compile,
    contract::*,
    coordinator::*,
    storage::*,
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
        "validate"=>{let d=parse_document(&read(arg(1)?,DOCUMENT_BYTES)?)?;serde_json::json!({"digest":digest(&d)?,"inventory":validate_document(&d)?})},
        "compile"=>{let d=parse_document(&read(arg(1)?,DOCUMENT_BYTES)?)?;serde_json::to_value(compile::compile(&d)?).unwrap()},
        "evaluate"=>{let d=parse_document(&read(arg(1)?,DOCUMENT_BYTES)?)?;let p=compile::compile(&d)?;let s=p.sequences.get(arg(2)?).ok_or_else(||error("SEQUENCE","sequence missing"))?;let t=serde_json::from_str::<Time>(arg(3)?).map_err(|e|error("TIME",e.to_string()))?;let mut values=vec![None;s.tracks.len()];s.evaluate_into(t,&mut values).map_err(|e|error("EVALUATE",format!("{e:?}")))?;serde_json::json!({"time":t,"values":values})},
        "serve" if arg(1)?=="--store"&&arg(3)?=="--document-id"=>{serve(arg(2)?,arg(4)?)?;return Ok(None);},
        _=>return Err(error("USAGE","producer-core schema|command-schema|tool-schema|fixture|validate FILE|compile FILE|evaluate FILE SEQUENCE TIME_JSON|serve --store EXPLICIT_DIRECTORY --document-id ID")),
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
