//! Trusted, room-owned WebGL resource. Packages cannot choose URLs or scripts.
use super::{contract::Clock, ffi, Source};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    ffi::CString,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    rc::Rc,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
const SCRIPT: &[u8] =
    include_bytes!("../../../../src/features/presentation/vendor/scene3d-renderer.js");
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Spec {
    pub cue_sequence: Option<u64>,
    pub id: String,
    pub pass: String,
    pub world: Value,
    pub cue: String,
    pub view: Option<String>,
}
fn obj<'a>(v: &'a Value, keys: &[&str]) -> Result<&'a serde_json::Map<String, Value>, String> {
    let o = v.as_object().ok_or("Invalid 3D object")?;
    if o.keys().any(|k| !keys.contains(&k.as_str())) {
        return Err("Unknown 3D field".into());
    }
    Ok(o)
}
fn number(v: &Value, min: f64, max: f64) -> bool {
    v.as_f64()
        .is_some_and(|n| n.is_finite() && n >= min && n <= max)
}
fn vector(v: &Value, min: f64, max: f64) -> bool {
    v.as_array()
        .is_some_and(|a| a.len() == 3 && a.iter().all(|v| number(v, min, max)))
}
fn color(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|c| c.is_ascii_hexdigit())
    })
}
fn camera(v: &Value) -> Result<(), String> {
    obj(v, &["position", "target", "fov"])?;
    if !vector(&v["position"], -200., 200.)
        || !vector(&v["target"], -200., 200.)
        || !number(&v["fov"], 20., 90.)
        || v["position"] == v["target"]
    {
        return Err("Invalid 3D camera".into());
    }
    Ok(())
}
fn ident(v: &str) -> bool {
    !["constructor", "prototype"].contains(&v)
        && !v.is_empty()
        && v.len() <= 64
        && v.bytes().next().is_some_and(|b| b.is_ascii_lowercase())
        && v.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
pub fn validate(s: &Spec) -> Result<(), String> {
    if s.cue_sequence.is_some_and(|v| v > 9_007_199_254_740_991) {
        return Err("Invalid cue sequence".into());
    }
    if !ident(&s.id) || !["background", "foreground"].contains(&s.pass.as_str()) || !ident(&s.cue) {
        return Err("Invalid 3D layer identity/pass/cue".into());
    }
    let w = &s.world;
    obj(
        w,
        &[
            "schema",
            "fps",
            "clearColor",
            "fog",
            "camera",
            "objects",
            "slots",
            "views",
            "environment",
            "environmentIntensity",
            "frameStyles",
            "exposure",
            "cueDurationMs",
            "lights",
            "cues",
        ],
    )?;
    if w["schema"] != "producer.scene3d/1"
        || ![Some(30), Some(60)].contains(&w["fps"].as_u64())
        || !color(&w["clearColor"])
    {
        return Err("Invalid 3D world".into());
    }
    obj(&w["fog"], &["color", "near", "far"])?;
    if !color(&w["fog"]["color"])
        || !number(&w["fog"]["near"], 1., 100.)
        || !number(
            &w["fog"]["far"],
            w["fog"]["near"].as_f64().unwrap() + 1.,
            200.,
        )
    {
        return Err("Invalid 3D fog".into());
    }
    camera(&w["camera"])?;
    if w.get("environmentIntensity")
        .is_some_and(|v| !number(v, 0., 2.))
    {
        return Err("Invalid environment intensity".into());
    }
    if w.get("environment")
        .is_some_and(|v| !matches!(v.as_str(), Some("none" | "studio")))
        || w.get("exposure").is_some_and(|v| !number(v, 0.5, 2.))
        || w.get("cueDurationMs")
            .is_some_and(|v| !number(v, 0., 2000.))
    {
        return Err("Invalid 3D environment".into());
    }
    if let Some(views) = w.get("views") {
        let views = views.as_object().ok_or("Invalid 3D views")?;
        if views.len() > 12 {
            return Err("View budget exceeded".into());
        }
        for (k, v) in views {
            if !ident(k) {
                return Err("Invalid view identity".into());
            }
            camera(v)?;
        }
    }
    if let Some(view) = &s.view {
        if !ident(view) || w.get("views").and_then(|v| v.get(view)).is_none() {
            return Err("Unknown 3D view".into());
        }
    }
    let nodes = w["objects"].as_array().ok_or("Missing 3D objects")?;
    if nodes.len() > 128 {
        return Err("3D object budget exceeded".into());
    }
    let mut ids = HashSet::new();
    for n in nodes {
        obj(
            n,
            &[
                "id",
                "kind",
                "args",
                "position",
                "rotation",
                "color",
                "metalness",
                "roughness",
                "emissive",
                "emissiveIntensity",
                "opacity",
                "unlit",
                "motion",
                "castShadow",
                "receiveShadow",
                "pass",
                "visible",
            ],
        )?;
        let id = n["id"].as_str().ok_or("Invalid 3D identity")?;
        if !ident(id) || !ids.insert(id) {
            return Err("Duplicate/invalid 3D identity".into());
        }
        let kind = n["kind"].as_str().unwrap_or("");
        let count = match kind {
            "box" | "sphere" | "cone" => 3,
            "roundedBox" => 5,
            "cylinder" | "torus" => 4,
            "plane" => 2,
            _ => return Err("Unsupported 3D geometry".into()),
        };
        let a = n["args"].as_array().ok_or("Invalid geometry arguments")?;
        if a.len() != count || a.iter().any(|v| !number(v, 0.001, 64.)) {
            return Err("Geometry budget exceeded".into());
        }
        let indices = match kind {
            "torus" => vec![2, 3],
            "cylinder" | "cone" => vec![count - 1],
            "sphere" => vec![1, 2],
            "roundedBox" => vec![3],
            _ => vec![],
        };
        for i in indices {
            let max = if kind == "roundedBox" { 5. } else { 64. };
            if !number(&a[i], 3., max) || a[i].as_f64().unwrap().fract() != 0. {
                return Err("Subdivision budget exceeded".into());
            }
        }
        if kind == "roundedBox"
            && a[4].as_f64().unwrap()
                > a[..3]
                    .iter()
                    .map(|n| n.as_f64().unwrap())
                    .fold(f64::INFINITY, f64::min)
                    / 2.
        {
            return Err("Invalid bevel radius".into());
        }
        if !vector(&n["position"], -200., 200.)
            || !vector(&n["rotation"], -7., 7.)
            || !color(&n["color"])
            || !number(&n["metalness"], 0., 1.)
            || !number(&n["roughness"], 0., 1.)
        {
            return Err("Invalid 3D transform/material".into());
        }
        for k in ["visible", "unlit", "castShadow", "receiveShadow"] {
            if n.get(k).is_some_and(|v| !v.is_boolean()) {
                return Err("Invalid material flag".into());
            }
        }
        if n.get("pass")
            .is_some_and(|v| !matches!(v.as_str(), Some("background" | "foreground")))
        {
            return Err("Invalid mesh pass".into());
        }
        if n.get("emissive").is_some_and(|v| !color(v))
            || n.get("emissiveIntensity")
                .is_some_and(|v| !number(v, 0., 5.))
            || n.get("opacity").is_some_and(|v| !number(v, 0., 1.))
        {
            return Err("Invalid material".into());
        }
        if let Some(m) = n.get("motion") {
            obj(m, &["kind", "speed", "amplitude", "phase", "clock"])?;
            if m.get("clock")
                .is_some_and(|v| !matches!(v.as_str(), Some("set" | "cue")))
            {
                return Err("Invalid motion clock".into());
            }
            if !matches!(m["kind"].as_str(), Some("rotateY" | "swayZ" | "moveY"))
                || !number(&m["speed"], -2., 2.)
                || !number(&m["amplitude"], 0., 1.)
                || !number(&m["phase"], 0., 7.)
            {
                return Err("Invalid 3D motion".into());
            }
        }
    }
    let slots = w["slots"].as_array().ok_or("Invalid 3D slots")?;
    if slots.len() > 8 {
        return Err("3D slot budget exceeded".into());
    }
    for slot in slots {
        let a = slot.as_array().ok_or("Invalid slot")?;
        if a.len() != 4
            || a.iter().any(|v| !number(v, 0., 1.))
            || a[2].as_f64().unwrap() <= 0.
            || a[3].as_f64().unwrap() <= 0.
            || a[0].as_f64().unwrap() + a[2].as_f64().unwrap() > 1.
            || a[1].as_f64().unwrap() + a[3].as_f64().unwrap() > 1.
        {
            return Err("Invalid slot bounds".into());
        }
    }
    if let Some(frames) = w.get("frameStyles") {
        let frames = frames.as_array().ok_or("Invalid frame styles")?;
        if frames.len() > slots.len() {
            return Err("Invalid frame style count".into());
        }
        for f in frames {
            obj(
                f,
                &[
                    "color",
                    "metalness",
                    "roughness",
                    "thickness",
                    "depth",
                    "radius",
                ],
            )?;
            if f.get("color").is_some_and(|v| !color(v))
                || f.get("metalness").is_some_and(|v| !number(v, 0., 1.))
                || f.get("roughness").is_some_and(|v| !number(v, 0., 1.))
                || ["thickness", "depth", "radius"]
                    .iter()
                    .any(|k| f.get(*k).is_some_and(|v| !number(v, 0.5, 32.)))
            {
                return Err("Invalid frame material".into());
            }
        }
    }
    if let Some(lights) = w.get("lights") {
        let lights = lights.as_array().ok_or("Invalid lights")?;
        if lights.len() > 8 {
            return Err("Light budget exceeded".into());
        }
        for l in lights {
            obj(l, &["id", "position", "color", "intensity"])?;
            if !l["id"].as_str().is_some_and(ident)
                || !vector(&l["position"], -200., 200.)
                || !color(&l["color"])
                || !number(&l["intensity"], 0., 400.)
            {
                return Err("Invalid 3D light".into());
            }
        }
    }
    if let Some(lights) = w.get("lights").and_then(Value::as_array) {
        let mut ids = HashSet::new();
        for l in lights {
            if !ids.insert(l["id"].as_str()) {
                return Err("Duplicate light".into());
            }
        }
    }
    if let Some(cues) = w.get("cues") {
        let cues = cues.as_object().ok_or("Invalid cues")?;
        if cues.len() > 32 || !cues.contains_key("neutral") || !cues.contains_key(&s.cue) {
            return Err("Unknown cue or cue budget exceeded".into());
        }
        for (key, cue) in cues {
            if !ident(key) {
                return Err("Invalid cue identity".into());
            }
            obj(cue, &["lights", "view", "durationMs", "visibility"])?;
            if let Some(targets) = cue.get("visibility") {
                for (key, value) in targets.as_object().ok_or("Invalid visibility targets")? {
                    if !ids.contains(key.as_str()) || !value.is_boolean() {
                        return Err("Unknown visibility target".into());
                    }
                }
            }
            if cue.get("durationMs").is_some_and(|v| !number(v, 0., 2000.)) {
                return Err("Invalid cue duration".into());
            }
            if let Some(view) = cue.get("view") {
                let view = view.as_str().ok_or("Invalid cue view")?;
                if w.get("views").and_then(|v| v.get(view)).is_none() {
                    return Err("Unknown cue view".into());
                }
            }
            if let Some(targets) = cue.get("lights") {
                for (key, value) in targets.as_object().ok_or("Invalid light targets")? {
                    if !number(value, 0., 400.)
                        || !w["lights"]
                            .as_array()
                            .is_some_and(|a| a.iter().any(|l| l["id"].as_str() == Some(key)))
                    {
                        return Err("Unknown light target".into());
                    }
                }
            }
        }
    } else if s.cue != "neutral" {
        return Err("Unknown cue".into());
    }
    Ok(())
}
fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
        * 1000.
}
#[derive(Clone, Serialize)]
struct Control {
    #[serde(rename = "cueSequence", skip_serializing_if = "Option::is_none")]
    cue_sequence: Option<u64>,
    rendering: bool,
    revision: u64,
    anchor: f64,
    paused: bool,
    elapsed: f64,
    cue: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    view: Option<String>,
}
#[derive(Default)]
struct Receipt {
    at: Option<std::time::Instant>,
    revision: u64,
    ready: bool,
    error: Option<String>,
}
struct State {
    session: u64,
    sequence: u64,
    control: Control,
    receipt: Receipt,
}
pub struct Bridge {
    active: AtomicBool,
    connections: AtomicUsize,
    origin: String,
    token: String,
    world: Value,
    state: Mutex<State>,
}
impl Bridge {
    fn start(spec: &Spec, w: u32, h: u32) -> Result<Arc<Self>, String> {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let mut entropy = [0u8; 32];
        std::fs::File::open("/dev/urandom")
            .and_then(|mut f| f.read_exact(&mut entropy))
            .map_err(|e| e.to_string())?;
        let token = entropy
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let bridge = Arc::new(Self {
            active: AtomicBool::new(true),
            connections: AtomicUsize::new(0),
            origin: format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port()),
            token,
            world: json!({"world":spec.world,"pass":spec.pass,"width":w,"height":h}),
            state: Mutex::new(State {
                session: 0,
                sequence: 0,
                control: Control {
                    cue_sequence: spec.cue_sequence,
                    rendering: false,
                    revision: 1,
                    anchor: now(),
                    elapsed: 0.,
                    paused: true,
                    cue: spec.cue.clone(),
                    view: spec.view.clone(),
                },
                receipt: Receipt::default(),
            }),
        });
        let weak = Arc::downgrade(&bridge);
        std::thread::spawn(move || loop {
            let Some(b) = weak.upgrade() else { break };
            if !b.active.load(Ordering::Acquire) {
                break;
            }
            match listener.accept() {
                Ok((stream, _)) => {
                    if b.connections.fetch_add(1, Ordering::AcqRel) >= 16 {
                        b.connections.fetch_sub(1, Ordering::AcqRel);
                        continue;
                    }
                    std::thread::spawn(move || {
                        b.serve(stream);
                        b.connections.fetch_sub(1, Ordering::AcqRel);
                    });
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    drop(b);
                    std::thread::sleep(Duration::from_millis(8));
                }
                Err(_) => break,
            }
        });
        Ok(bridge)
    }
    fn snapshot(&self) -> String {
        serde_json::to_string(&self.state.lock().unwrap().control).unwrap()
    }
    fn serve(&self, mut stream: TcpStream) {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
        let mut buffer = Vec::new();
        let mut part = [0u8; 4096];
        let end = loop {
            match stream.read(&mut part) {
                Ok(0) | Err(_) => return,
                Ok(n) => buffer.extend_from_slice(&part[..n]),
            }
            if let Some(i) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
                break i + 4;
            }
            if buffer.len() > 8192 {
                return;
            }
        };
        let headers = String::from_utf8_lossy(&buffer[..end]).to_string();
        let mut first = headers.lines().next().unwrap_or("").split_whitespace();
        let method = first.next().unwrap_or("");
        let path = first.next().unwrap_or("");
        let Some(route) = path.strip_prefix(&format!("/{}/", self.token)) else {
            return;
        };
        let route = route.split('?').next().unwrap_or(route);
        if headers
            .lines()
            .filter_map(|l| l.split_once(':'))
            .any(|(k, v)| k.eq_ignore_ascii_case("origin") && v.trim() != self.origin)
        {
            return;
        }
        if method == "GET" && route == "events" {
            if stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n").is_err(){return}
            let mut previous = String::new();
            let mut heartbeat = std::time::Instant::now();
            while self.active.load(Ordering::Acquire) {
                let value = self.snapshot();
                if value != previous || heartbeat.elapsed() > Duration::from_secs(1) {
                    if stream
                        .write_all(format!("data: {value}\n\n").as_bytes())
                        .is_err()
                    {
                        return;
                    }
                    previous = value;
                    heartbeat = std::time::Instant::now();
                }
                std::thread::sleep(Duration::from_millis(8));
            }
            return;
        }
        if method == "POST" && route == "receipt" {
            let length = headers
                .lines()
                .filter_map(|l| l.split_once(':'))
                .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                .and_then(|(_, v)| v.trim().parse::<usize>().ok())
                .unwrap_or(0);
            if length > 65536 {
                return;
            }
            while buffer.len() < end + length {
                match stream.read(&mut part) {
                    Ok(0) | Err(_) => return,
                    Ok(n) => buffer.extend_from_slice(&part[..n]),
                }
            }
            if let Ok(v) = serde_json::from_slice::<Value>(&buffer[end..end + length]) {
                let mut s = self.state.lock().unwrap();
                let revision = v["revision"].as_u64().unwrap_or(0);
                let serial = v["serial"].as_u64().unwrap_or(0);
                if v["session"].as_u64() == Some(s.session)
                    && serial > s.sequence
                    && revision <= s.control.revision
                    && revision >= s.receipt.revision
                {
                    s.sequence = serial;
                    let software = v["software"].as_bool().unwrap_or(false);
                    let ready = v["ready"] == true && v["webgl2"] == true && !software;
                    s.receipt = Receipt {
                        at: Some(std::time::Instant::now()),
                        revision,
                        ready,
                        error: if software {
                            Some("Hardware 3D rendering is unavailable".into())
                        } else if v["lost"] == true {
                            None
                        } else {
                            v["error"].as_str().map(|v| v.chars().take(160).collect())
                        },
                    };
                }
            }
            Self::response(&mut stream, "application/json", b"{}");
            return;
        }
        if method != "GET" {
            return;
        }
        match route {
            "world" => {
                let mut state = self.state.lock().unwrap();
                state.session += 1;
                state.sequence = 0;
                state.receipt = Receipt::default();
                let mut world = self.world.clone();
                world["session"] = json!(state.session);
                drop(state);
                Self::response(
                    &mut stream,
                    "application/json",
                    world.to_string().as_bytes(),
                );
            }
            "state" => Self::response(&mut stream, "application/json", self.snapshot().as_bytes()),
            "renderer.js" => Self::response(&mut stream, "text/javascript", SCRIPT),
            "view" => {
                let page=format!("<!doctype html><html data-scene3d-host=\"1\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'nonce-{}'; style-src 'unsafe-inline'; connect-src {}; img-src data:; object-src 'none'; base-uri 'none'\"><style>html,body{{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}}</style><body><script nonce=\"{}\" src=\"renderer.js\"></script></body></html>",self.token,self.origin,self.token);
                Self::response(&mut stream, "text/html", page.as_bytes());
            }
            _ => {}
        }
    }
    fn response(stream: &mut TcpStream, mime: &str, body: &[u8]) {
        let _=write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",body.len());
        let _ = stream.write_all(body);
    }
    fn publish(&self, spec: &Spec, clock: Option<&Clock>) {
        let at = now();
        let mut s = self.state.lock().unwrap();
        let old = &s.control;
        let current = if old.paused {
            old.elapsed
        } else {
            (at - old.anchor).max(0.)
        };
        let (elapsed, paused) = clock
            .map(|c| {
                let (show, _, running) = super::contract::clock_positions(Some(c));
                (show, !running)
            })
            .unwrap_or((current, false));
        if old.cue_sequence != spec.cue_sequence
            || !old.rendering
            || old.cue != spec.cue
            || old.view != spec.view
            || old.paused != paused
            || (elapsed - current).abs() > 50.
        {
            let revision = old.revision + 1;
            s.control = Control {
                cue_sequence: spec.cue_sequence,
                rendering: true,
                revision,
                anchor: at - elapsed,
                elapsed,
                paused,
                cue: spec.cue.clone(),
                view: spec.view.clone(),
            };
        }
    }
    fn hide(&self) {
        let mut s = self.state.lock().unwrap();
        if s.control.rendering {
            s.control.rendering = false;
            s.control.revision += 1;
        }
    }
    fn pause(&self, paused: bool) {
        let mut s = self.state.lock().unwrap();
        let c = &mut s.control;
        if c.paused != paused {
            let elapsed = if c.paused {
                c.elapsed
            } else {
                (now() - c.anchor).max(0.)
            };
            c.elapsed = elapsed;
            c.anchor = now() - elapsed;
            c.paused = paused;
            c.revision += 1;
        }
    }
    fn fence(&self) -> Option<(u64, u64)> {
        let s = self.state.lock().unwrap();
        let valid = s.receipt.ready
            && s.receipt.revision == s.control.revision
            && s.receipt
                .at
                .is_some_and(|at| at.elapsed() < Duration::from_secs(4));
        if !valid && std::env::var_os("PRODUCER_SCENE3D_DEBUG").is_some() {
            static MISSES: AtomicUsize = AtomicUsize::new(0);
            if MISSES.fetch_add(1, Ordering::Relaxed) % 120 == 0 {
                eprintln!(
                    "3D receipt ready={} reported={} wanted={} ageMs={:?}",
                    s.receipt.ready,
                    s.receipt.revision,
                    s.control.revision,
                    s.receipt.at.map(|at| at.elapsed().as_millis())
                );
            }
        }
        valid.then_some((s.session, s.control.revision))
    }

    fn error(&self) -> Option<String> {
        self.state.lock().unwrap().receipt.error.clone()
    }
    fn stop(&self) {
        self.active.store(false, Ordering::Release);
    }
}
static LIVE: AtomicUsize = AtomicUsize::new(0);
pub fn live_count() -> usize {
    LIVE.load(Ordering::Relaxed)
}
pub struct Lease {
    pub source: Rc<Source>,
    bridge: Arc<Bridge>,
    raw: Rc<Source>,
    height: u32,
    verified: std::cell::RefCell<Option<(u64, u64)>>,
    navigation: std::cell::RefCell<(Instant, u8)>,
}
impl Lease {
    pub unsafe fn create(spec: &Spec, w: u32, h: u32) -> Result<Rc<Self>, String> {
        validate(spec)?;
        if w < 16 || h < 16 || w > 3840 || h > 3840 || u64::from(w) * u64::from(h) > 9_000_000 {
            return Err("3D surface budget exceeded".into());
        }
        let bridge = Bridge::start(spec, w, h)?;
        let url = format!("{}/{}/view", bridge.origin, bridge.token);
        let config = json!({"url":url,"width":w,"height":h+1,"fps":60,"fps_custom":true,"shutdown":false,"restart_when_active":false,"reroute_audio":true,"webpage_control_level":0,"css":""});
        let settings =
            ffi::obs_data_create_from_json(CString::new(config.to_string()).unwrap().as_ptr());
        let source = ffi::obs_source_create_private(
            c"browser_source".as_ptr(),
            c"Set 3D world".as_ptr(),
            settings,
        );
        ffi::obs_data_release(settings);
        if source.is_null() {
            bridge.stop();
            return Err("3D renderer allocation failed".into());
        }
        let raw = Rc::new(Source(source));
        let clip = super::producer_set_v2_group_create(w, h, 0., 1.);
        if clip.is_null() {
            bridge.stop();
            return Err("3D crop allocation failed".into());
        }
        let clip = Rc::new(Source(clip));
        if !super::producer_set_v2_group_add(clip.0, raw.0, 0., 0., w as f32, (h + 1) as f32, false)
            || !super::producer_set_v2_group_seal(clip.0)
        {
            bridge.stop();
            return Err("3D crop attachment failed".into());
        }
        ffi::obs_source_inc_active(raw.0);
        ffi::obs_source_inc_showing(raw.0);
        ffi::obs_source_set_audio_mixers(raw.0, 0);
        ffi::obs_source_set_muted(raw.0, true);
        LIVE.fetch_add(1, Ordering::Relaxed);
        Ok(Rc::new(Self {
            source: clip,
            raw,
            bridge,
            height: h,
            verified: std::cell::RefCell::new(None),
            navigation: std::cell::RefCell::new((Instant::now(), 0)),
        }))
    }
    pub fn pixels(&self) -> usize {
        unsafe { ffi::obs_source_get_width(self.source.0) as usize * self.height as usize }
    }
    pub fn hide(&self) {
        self.bridge.hide();
    }
    pub fn ready(&self) -> bool {
        let Some(key) = self.bridge.fence() else {
            *self.verified.borrow_mut() = None;
            // CEF can fail its first loopback navigation while its network
            // service is starting. Retry only if /world has never been read;
            // a healthy renderer, compilation, or a reported error is never
            // restarted. Every retry still needs the session/revision fence.
            let not_started = self.bridge.state.lock().unwrap().session == 0;
            let mut navigation = self.navigation.borrow_mut();
            if not_started && navigation.1 < 2 && navigation.0.elapsed() >= Duration::from_secs(10)
            {
                navigation.0 = Instant::now();
                navigation.1 += 1;
                let url = CString::new(format!(
                    "{}/{}/view?attempt={}",
                    self.bridge.origin, self.bridge.token, navigation.1
                ))
                .unwrap();
                unsafe {
                    let settings = ffi::obs_source_get_settings(self.raw.0);
                    ffi::obs_data_set_string(settings, c"url".as_ptr(), url.as_ptr());
                    ffi::obs_source_update(self.raw.0, settings);
                    ffi::obs_data_release(settings);
                }
            }
            return false;
        };
        if *self.verified.borrow() == Some(key) {
            return true;
        }
        let mut expected = [0u8; 18];
        for (i, value) in [key.1, key.0].iter().enumerate() {
            for part in 0..3 {
                let chunk = value >> (part * 24);
                let at = (i * 3 + part) * 3;
                expected[at] = chunk as u8;
                expected[at + 1] = (chunk >> 8) as u8;
                expected[at + 2] = (chunk >> 16) as u8;
            }
        }
        if !unsafe {
            super::producer_set_v2_surface_fence(self.raw.0, self.height, expected.as_ptr())
        } {
            return false;
        }
        *self.verified.borrow_mut() = Some(key);
        true
    }
    pub fn error(&self) -> Option<String> {
        self.bridge.error()
    }
    pub fn publish(&self, spec: &Spec, clock: Option<&Clock>) {
        self.bridge.publish(spec, clock);
    }
    pub fn pause(&self, paused: bool) {
        self.bridge.pause(paused);
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        self.bridge.stop();
        LIVE.fetch_sub(1, Ordering::Relaxed);
        unsafe {
            ffi::obs_source_dec_showing(self.raw.0);
            ffi::obs_source_dec_active(self.raw.0);
        }
    }
}
pub fn key(instance: &str, spec: &Spec, w: u32, h: u32) -> String {
    format!(
        "{instance}:{}:{}:{w}:{h}:{:x}",
        spec.id,
        spec.pass,
        Sha256::digest(spec.world.to_string().as_bytes())
    )
}
