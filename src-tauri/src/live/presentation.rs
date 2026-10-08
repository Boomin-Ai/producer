//! Private, read-only set output. Packages supply resolved visual data, never
//! URLs, browser settings, native handles, audio policy or execution authority.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Framing {
    pub mode: String,
    pub x: f64,
    pub y: f64,
}
impl Framing {
    fn validate(&self) -> Result<(), String> {
        if !["fill", "fit"].contains(&self.mode.as_str())
            || ![self.x, self.y]
                .iter()
                .all(|v| v.is_finite() && *v >= 0. && *v <= 1.)
        {
            Err("Invalid slot framing".into())
        } else {
            Ok(())
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Node {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shader: Option<super::shaders::ShaderEffect>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub playback: Option<MediaTransport>,
    pub id: String,
    pub r#type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, rename = "assetId", skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub autoplay: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#loop: Option<bool>,
    #[serde(default, rename = "slotId", skip_serializing_if = "Option::is_none")]
    pub slot_id: Option<String>,
    #[serde(default, rename = "slotLabel", skip_serializing_if = "Option::is_none")]
    pub slot_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub appearance: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub framing: Option<Framing>,
    pub styles: HashMap<String, Value>,
    pub children: Vec<Node>,
    #[serde(
        default,
        rename = "motionClass",
        skip_serializing_if = "Option::is_none"
    )]
    pub motion_class: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MediaTransport {
    pub playing: bool,
    pub position_ms: f64,
    pub anchor_ms: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_after_pause: Option<bool>,
}
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Asset {
    pub name: String,
    pub mime: String,
    pub data: Arc<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Projection {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeline: Option<super::animation::Timeline>,
    pub width: u32,
    pub height: u32,
    pub revision: u64,
    pub root: Node,
    pub css: String,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub assets: HashMap<String, Asset>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    #[serde(default, rename = "assetIds", skip_serializing_if = "Option::is_none")]
    pub asset_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preload: Option<Projection>,
    pub generation: u64,
    pub lease: String,
    pub projection: Projection,
    pub bindings: HashMap<String, String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Placement {
    #[serde(rename = "nodeId")]
    pub node_id: String,
    #[serde(rename = "slotId")]
    pub slot_id: String,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    #[serde(default)]
    pub appearance: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub framing: Option<Framing>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    #[serde(default)]
    pub serial: u64,
    pub revision: u64,
    pub width: u32,
    pub height: u32,
    pub slots: Vec<Placement>,
    pub surface: String,
}
#[derive(Clone, Debug, Serialize)]
pub struct Status {
    pub generation: u64,
    pub lease: Option<String>,
    pub revision: u64,
}

pub fn validate(request: &Request) -> Result<(), String> {
    validate_cached(request, None)
}
pub fn validate_cached(
    request: &Request,
    cached: Option<&HashMap<String, Asset>>,
) -> Result<(), String> {
    if request.lease.len() != 36 || uuid::Uuid::parse_str(&request.lease).is_err() {
        return Err("Invalid set lease".into());
    }
    if request
        .asset_ids
        .as_ref()
        .is_some_and(|ids| ids.len() > 24 || ids.iter().any(|id| id.len() > 80))
    {
        return Err("Asset manifest exceeds budget".into());
    }
    if let Some(preload) = &request.preload {
        if preload.width != request.projection.width || preload.height != request.projection.height
        {
            return Err("Preloaded layout dimensions must match output".into());
        }
        let next = Request {
            asset_ids: request.asset_ids.clone(),
            generation: request.generation,
            lease: request.lease.clone(),
            projection: preload.clone(),
            bindings: HashMap::new(),
            preload: None,
        };
        validate_cached(&next, cached)?;
    }
    let mut verified = cached.cloned().unwrap_or_default();
    if let Some(preload) = &request.preload {
        verified.extend(preload.assets.clone());
    }
    let cached = Some(&verified);
    let p = &request.projection;
    if !(320..=3840).contains(&p.width)
        || !(320..=3840).contains(&p.height)
        || p.css.len() > 65536
        || request.bindings.len() > 8
    {
        return Err("Set output exceeds its budget".into());
    }
    if p.assets.len() > 24 {
        return Err("Asset count exceeds budget".into());
    }
    for (id, asset) in &p.assets {
        if cached.is_some_and(|c| c.get(id) == Some(asset)) {
            continue;
        }
        use base64::Engine;
        if ![
            "image/png",
            "image/jpeg",
            "image/webp",
            "image/gif",
            "video/mp4",
            "video/webm",
            "video/quicktime",
            "application/lottie+json",
        ]
        .contains(&asset.mime.as_str())
            || asset.name.len() > 160
            || asset.data.len() > 17 * 1024 * 1024
        {
            return Err("Invalid embedded media asset".into());
        }
        if asset.data.starts_with("producer-media:") {
            crate::set_media::validate(&asset.data, &asset.mime)?;
            continue;
        }
        let prefix = format!("data:{};base64,", asset.mime);
        let encoded = asset
            .data
            .strip_prefix(&prefix)
            .ok_or("Asset must be embedded")?;
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| "Invalid embedded asset encoding")?;
        if decoded.len() > 12 * 1024 * 1024 {
            return Err("Asset exceeds 12 MB".into());
        }
        if asset.mime == "application/lottie+json" {
            fn safe(v: &Value, depth: usize) -> bool {
                if depth > 40 {
                    return false;
                }
                match v {
                    Value::Object(o) => o.iter().all(|(k, v)| {
                        if k == "x" && v.is_string() {
                            return false;
                        }
                        if (k == "p" || k == "u")
                            && v.as_str().is_some_and(|s| {
                                !s.is_empty()
                                    && !s.starts_with("data:image/png;base64,")
                                    && !s.starts_with("data:image/jpeg;base64,")
                                    && !s.starts_with("data:image/webp;base64,")
                            })
                        {
                            return false;
                        }
                        safe(v, depth + 1)
                    }),
                    Value::Array(a) => a.iter().all(|v| safe(v, depth + 1)),
                    _ => true,
                }
            }
            let v: Value = serde_json::from_slice(&decoded).map_err(|_| "Invalid Lottie JSON")?;
            if !v["layers"].is_array()
                || v["fonts"]["list"].as_array().is_some_and(|a| !a.is_empty())
                || !safe(&v, 0)
            {
                return Err("Lottie must be self-contained without expressions or fonts".into());
            }
        }
    }
    fn media_refs(n: &Node, assets: &HashMap<String, Asset>) -> bool {
        (n.r#type != "media"
            || n.asset_id
                .as_ref()
                .is_some_and(|id| assets.contains_key(id))
                && n.fit
                    .as_ref()
                    .is_none_or(|f| ["contain", "cover"].contains(&f.as_str())))
            && n.children.iter().all(|n| media_refs(n, assets))
    }
    if !media_refs(&p.root, &p.assets) {
        return Err("Missing media asset or invalid media fit".into());
    }
    fn valid_transport(n: &Node) -> bool {
        n.playback.as_ref().is_none_or(|t| {
            n.r#type == "media"
                && t.position_ms.is_finite()
                && t.position_ms >= 0.0
                && t.anchor_ms.is_finite()
                && t.anchor_ms >= 0.0
        }) && n.children.iter().all(valid_transport)
    }
    if !valid_transport(&p.root) {
        return Err("Invalid media transport".into());
    }
    if let Some(timeline) = &p.timeline {
        timeline.validate(&p.root)?;
    }
    let css = p.css.to_ascii_lowercase();
    if ["url(", "@import", "@font", "expression(", "<", ">", "\\"]
        .iter()
        .any(|s| css.contains(s))
    {
        return Err("Unsafe output CSS".into());
    }
    let allowed = [
        "position",
        "inset",
        "left",
        "top",
        "right",
        "bottom",
        "width",
        "height",
        "display",
        "gap",
        "padding",
        "background",
        "color",
        "border",
        "borderRadius",
        "boxShadow",
        "fontSize",
        "fontWeight",
        "letterSpacing",
        "textAlign",
        "lineHeight",
        "alignItems",
        "justifyContent",
        "gridTemplateColumns",
        "opacity",
        "overflow",
        "transform",
        "minHeight",
        "maxWidth",
        "fontFamily",
        "fontStyle",
        "textTransform",
        "textShadow",
        "whiteSpace",
        "wordSpacing",
        "backgroundSize",
        "backgroundPosition",
        "filter",
        "mixBlendMode",
        "clipPath",
        "isolation",
    ];
    fn visit(
        n: &Node,
        allowed: &[&str],
        count: &mut usize,
        ids: &mut std::collections::HashSet<String>,
        slots: &mut Vec<String>,
        ancestor_effect: bool,
    ) -> Result<bool, String> {
        *count += 1;
        if let Some(f) = &n.framing {
            f.validate()?;
        }
        if *count > 600
            || n.id.is_empty()
            || n.id.len() > 1024
            || !ids.insert(n.id.clone())
            || !["box", "text", "slot", "media", "shader"].contains(&n.r#type.as_str())
            || n.children.len() > 128
            || n.text.as_ref().is_some_and(|s| s.len() > 4096)
        {
            return Err("Invalid output tree".into());
        }
        for (key, v) in &n.styles {
            if !allowed.contains(&key.as_str()) {
                return Err("Unsupported output style".into());
            }
            if let Some(s) = v.as_str() {
                let lower = s.to_ascii_lowercase();
                if s.len() > 240
                    || s.chars().any(|c| c.is_control() || "\\/;{}<>@".contains(c))
                    || ["url(", "expression(", "image(", "image-set(", "paint("]
                        .iter()
                        .any(|s| lower.contains(s))
                {
                    return Err("Unsafe output style".into());
                }
            } else if !v
                .as_f64()
                .is_some_and(|x| x.is_finite() && x.abs() <= 10000.)
            {
                return Err("Invalid output style value".into());
            }
        }
        let effect = ["filter", "mixBlendMode", "clipPath"]
            .iter()
            .any(|key| n.styles.contains_key(*key))
            || n.styles.contains_key("transform")
            || n.styles
                .get("opacity")
                .is_some_and(|v| v.as_f64() != Some(1.))
            || n.motion_class.is_some();
        let mut has_slot = n.r#type == "slot";
        if has_slot {
            let id = n.slot_id.as_ref().ok_or("Slot has no identity")?;
            if id.len() > 64 || ancestor_effect || effect {
                return Err(
                    "Animated or transformed video ancestors require a future compositor".into(),
                );
            }
            slots.push(id.clone());
            if slots.len() > 8 {
                return Err("Too many video placements".into());
            }
            if !n.children.is_empty() {
                return Err("Video slots cannot contain children".into());
            }
        }
        for child in &n.children {
            has_slot |= visit(child, allowed, count, ids, slots, ancestor_effect || effect)?;
        }
        Ok(has_slot)
    }
    let mut slots = Vec::new();
    fn check_shaders(n: &Node, root: &Node, depth: usize, count: &mut usize) -> Result<(), String> {
        if n.r#type == "shader" {
            *count += 1;
            let s = n.shader.as_ref().ok_or("Shader configuration is missing")?;
            s.validate()?;
            if depth != 1
                || *count > 4
                || !n.children.is_empty()
                || root.styles.get("position").and_then(Value::as_str) != Some("relative")
                || root.styles.contains_key("transform")
                || root
                    .styles
                    .get("opacity")
                    .is_some_and(|v| v.as_f64() != Some(1.))
                || root.motion_class.is_some()
                || n.styles.get("position").and_then(Value::as_str) != Some("absolute")
                || n.styles
                    .keys()
                    .any(|k| !["position", "left", "top", "width", "height"].contains(&k.as_str()))
            {
                return Err("Shader layers require a plain root and absolute geometry".into());
            }
            let get = |k: &str| {
                n.styles
                    .get(k)
                    .and_then(Value::as_f64)
                    .ok_or("Shader geometry must be numeric")
            };
            let (x, y, w, h) = (get("left")?, get("top")?, get("width")?, get("height")?);
            let rw = root
                .styles
                .get("width")
                .and_then(Value::as_f64)
                .ok_or("Shader root width is missing")?;
            let rh = root
                .styles
                .get("height")
                .and_then(Value::as_f64)
                .ok_or("Shader root height is missing")?;
            if x < 0.
                || y < 0.
                || w < 1.
                || h < 1.
                || w > 1920.
                || h > 1920.
                || x + w > rw
                || y + h > rh
            {
                return Err("Shader layer exceeds canvas bounds".into());
            }
        } else if n.shader.is_some() {
            return Err("Shader configuration requires a shader node".into());
        }
        for c in &n.children {
            check_shaders(c, root, depth + 1, count)?;
        }
        Ok(())
    }
    check_shaders(&p.root, &p.root, 0, &mut 0)?;
    if p.root.children.iter().any(|n| n.shader.is_some())
        && (p.root.styles.get("width").and_then(Value::as_f64) != Some(p.width as f64)
            || p.root.styles.get("height").and_then(Value::as_f64) != Some(p.height as f64)
            || p.root.styles.keys().any(|k| {
                !["position", "width", "height", "background", "overflow"].contains(&k.as_str())
            }))
    {
        return Err("Shader root must match the canvas without CSS offsets".into());
    }
    visit(
        &p.root,
        &allowed,
        &mut 0,
        &mut Default::default(),
        &mut slots,
        false,
    )?;
    for (id, source) in &request.bindings {
        if !slots.contains(id) || source.len() > 128 || source.is_empty() {
            return Err("Binding does not belong to this layout".into());
        }
    }
    if serde_json::to_vec(&p.root)
        .map_err(|e| e.to_string())?
        .len()
        + p.css.len()
        + p.assets
            .values()
            .map(|a| a.data.len() + a.name.len() + a.mime.len() + 128)
            .sum::<usize>()
        + 4096
        > 40 * 1024 * 1024
    {
        return Err("Output projection is too large".into());
    }
    Ok(())
}

pub fn hydrate(request: &mut Request, previous: &Request) {
    if request.lease != previous.lease {
        return;
    }
    let mut assets = previous.projection.assets.clone();
    if let Some(p) = &previous.preload {
        assets.extend(p.assets.clone());
    }
    assets.extend(request.projection.assets.clone());
    if let Some(p) = &request.preload {
        assets.extend(p.assets.clone());
    }
    if let Some(ids) = &request.asset_ids {
        assets.retain(|id, _| ids.contains(id));
    }
    request.projection.assets = assets.clone();
    if let Some(p) = request.preload.as_mut() {
        p.assets = assets;
    }
}
/// Absolute camera boxes cannot reflow when text or graphics change.
fn used_assets(p: &Projection) -> std::collections::HashSet<String> {
    fn collect(n: &Node, ids: &mut std::collections::HashSet<String>) {
        if let Some(id) = &n.asset_id {
            ids.insert(id.clone());
        }
        for c in &n.children {
            collect(c, ids);
        }
    }
    let mut ids = std::collections::HashSet::new();
    collect(&p.root, &mut ids);
    ids
}
fn resolve_local_media(p: &mut Projection) {
    for a in p.assets.values_mut() {
        if a.data.starts_with("producer-media:") {
            if let Ok(url) = crate::set_media::set_media_resolve((*a.data).clone()) {
                a.data = Arc::new(url);
            }
        }
    }
}
fn media_key(p: &Projection) -> Vec<(String, String, Option<Asset>)> {
    fn visit(n: &Node, p: &Projection, result: &mut Vec<(String, String, Option<Asset>)>) {
        if let Some(id) = &n.asset_id {
            result.push((n.id.clone(), id.clone(), p.assets.get(id).cloned()));
        }
        for c in &n.children {
            visit(c, p, result);
        }
    }
    let mut result = vec![];
    visit(&p.root, p, &mut result);
    result
}
fn prepared_graphics(p: &Projection) -> Value {
    let mut root = p.root.clone();
    fn strip(n: &mut Node) {
        n.playback = None;
        n.autoplay = None;
        for c in &mut n.children {
            strip(c);
        }
    }
    strip(&mut root);
    serde_json::json!({"width":p.width,"height":p.height,"root":root,"css":p.css,"animation":animation_key(p)})
}
fn morph_compatible(a: &Projection, b: &Projection) -> bool {
    if a.width != b.width
        || a.height != b.height
        || a.root.id != b.root.id
        || !b
            .timeline
            .as_ref()
            .is_some_and(|t| t.transition.as_ref().is_some_and(|v| v.r#type == "morph"))
    {
        return false;
    }
    fn native(n: &Node) -> bool {
        n.slot_id.is_some() || n.shader.is_some()
    }
    fn signature(p: &Projection) -> Option<Value> {
        if p.root.styles.get("position").and_then(Value::as_str) != Some("relative")
            || ["transform", "padding"]
                .iter()
                .any(|k| p.root.styles.contains_key(*k))
        {
            return None;
        }
        let mut nodes = std::collections::BTreeMap::new();
        fn nested(n: &Node) -> bool {
            n.children.iter().any(|c| native(c) || nested(c))
        }
        for n in &p.root.children {
            if nested(n) {
                return None;
            }
            if native(n) {
                if n.styles.get("position").and_then(Value::as_str) != Some("absolute")
                    || ["left", "top", "width", "height"]
                        .iter()
                        .any(|k| n.styles.get(*k).and_then(Value::as_f64).is_none())
                {
                    return None;
                }
                nodes.insert(n.id.clone(),serde_json::json!({"slot":n.slot_id,"shader":n.shader,"appearance":n.appearance,"framing":n.framing}));
            }
        }
        if nodes.is_empty() {
            None
        } else {
            Some(serde_json::json!(nodes))
        }
    }
    signature(a).is_some_and(|old| Some(old) == signature(b))
}
fn animation_key(p: &Projection) -> Value {
    p.timeline.as_ref().map_or(
        Value::Null,
        |t| serde_json::json!({"tracks":t.tracks,"transition":t.transition}),
    )
}
fn prepared_media_matches(old: &Node, next: &Node, now: f64) -> bool {
    if let Some(t) = &next.playback {
        let Some(previous) = &old.playback else {
            return false;
        };
        let position = |v: &MediaTransport| {
            v.position_ms
                + if v.playing {
                    (now - v.anchor_ms).max(0.)
                } else {
                    0.
                }
        };
        // Only promote a frame already decoded at the intended entry position.
        // Long-running resume/continue clocks take the normal seek-and-paint path.
        if (position(previous) - position(t)).abs() > 200. {
            return false;
        }
    }
    old.children.len() == next.children.len()
        && old
            .children
            .iter()
            .zip(&next.children)
            .all(|(a, b)| prepared_media_matches(a, b, now))
}
fn geometry_key(p: &Projection) -> Option<Value> {
    fn visit(
        n: &Node,
        ancestors: &mut Vec<Value>,
        slots: &mut Vec<Value>,
        root: bool,
    ) -> Option<()> {
        let has_slot =
            n.slot_id.is_some() || n.shader.is_some() || n.children.iter().any(contains_slot);
        if !has_slot {
            return Some(());
        }
        // Font-relative geometry must remeasure if inherited text styles change.
        if n.styles.iter().any(|(k, v)| {
            ![
                "background",
                "color",
                "fontFamily",
                "fontSize",
                "fontWeight",
                "lineHeight",
                "textAlign",
            ]
            .contains(&k.as_str())
                && v.as_str().is_some_and(|s| {
                    s.split(|c: char| !c.is_ascii_alphabetic())
                        .any(|unit| ["em", "rem", "ex", "ch", "lh", "rlh"].contains(&unit))
                })
        }) {
            return None;
        }
        if n.styles.get("position").and_then(Value::as_str)
            != Some(if root { "relative" } else { "absolute" })
            || !n.styles.contains_key("width")
            || !n.styles.contains_key("height")
        {
            return None;
        }
        ancestors.push(serde_json::json!({"id":n.id,"styles":n.styles.iter().filter(|(k,_)|!["background","color","opacity","borderRadius","fontSize","fontWeight","lineHeight","fontFamily","textAlign"].contains(&k.as_str())).collect::<HashMap<_,_>>()}));
        if n.slot_id.is_some() {
            slots.push(serde_json::json!({"ancestry":ancestors,"slot":n.slot_id,"framing":n.framing,"appearance":n.appearance}));
        }
        if n.shader.is_some() {
            slots.push(serde_json::json!({"ancestry":ancestors,"shader":n.shader}));
        }
        for c in &n.children {
            visit(c, ancestors, slots, false)?;
        }
        ancestors.pop();
        Some(())
    }
    fn contains_slot(n: &Node) -> bool {
        n.slot_id.is_some() || n.shader.is_some() || n.children.iter().any(contains_slot)
    }
    let mut slots = vec![];
    visit(&p.root, &mut vec![], &mut slots, true)?;
    Some(serde_json::json!({"width":p.width,"height":p.height,"slots":slots}))
}
struct BridgeState {
    serial: u64,
    transport_only: bool,
    receipt_revision: u64,
    projection: Projection,
    receipts: HashMap<String, Receipt>,
}
pub struct Bridge {
    pub token: String,
    pub origin: String,
    projection: Projection,
    active: AtomicBool,
    painted: AtomicBool,
    streams: AtomicUsize,
    state: Mutex<BridgeState>,
}
impl Bridge {
    pub fn start(projection: Projection) -> Result<Arc<Self>, String> {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let bridge = Arc::new(Self {
            token: uuid::Uuid::new_v4().simple().to_string(),
            origin: format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port()),
            projection: projection.clone(),
            active: AtomicBool::new(true),
            painted: AtomicBool::new(true),
            streams: AtomicUsize::new(0),
            state: Mutex::new(BridgeState {
                serial: 0,
                transport_only: false,
                receipt_revision: projection.revision,
                projection,
                receipts: HashMap::new(),
            }),
        });
        let weak = Arc::downgrade(&bridge);
        std::thread::spawn(move || loop {
            let Some(bridge) = weak.upgrade() else { break };
            if !bridge.active.load(Ordering::SeqCst) {
                break;
            }
            match listener.accept() {
                Ok((stream, _)) => {
                    bridge.serve(stream);
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    drop(bridge);
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(_) => break,
            }
        });
        Ok(bridge)
    }
    pub fn url(&self, surface: &str) -> String {
        format!("{}/{}/{}", self.origin, self.token, surface)
    }
    pub fn revoke(&self) {
        self.active.store(false, Ordering::SeqCst);
    }
    pub fn ready(&self) -> Option<Vec<Placement>> {
        let state = self.state.lock().unwrap();
        let bg = state.receipts.get("background")?;
        let fg = state.receipts.get("foreground")?;
        if bg.revision == state.projection.revision
            && fg.revision == bg.revision
            && bg.serial == state.serial
            && fg.serial == state.serial
            && self.painted.load(Ordering::SeqCst)
        {
            Some(fg.slots.clone())
        } else {
            None
        }
    }
    pub fn wait(&self) -> Result<Vec<Placement>, String> {
        let revision = self.state.lock().unwrap().projection.revision;
        self.wait_revision(revision)
    }
    pub fn wait_revision(&self, revision: u64) -> Result<Vec<Placement>, String> {
        let start = Instant::now();
        loop {
            if !self.active.load(Ordering::SeqCst) {
                return Err("Set preparation was cancelled".into());
            }
            {
                let state = self.state.lock().unwrap();
                if state.projection.revision != revision {
                    return Err("Set update was superseded".into());
                }
                if let (Some(bg), Some(fg)) = (
                    state.receipts.get("background"),
                    state.receipts.get("foreground"),
                ) {
                    if bg.revision == state.projection.revision
                        && fg.revision == bg.revision
                        && self.painted.load(Ordering::SeqCst)
                    {
                        return Ok(fg.slots.clone());
                    }
                }
            }
            if start.elapsed() > Duration::from_secs(30) {
                return Err("Set graphics did not finish preparing; room output was kept".into());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    fn serve(self: &Arc<Self>, mut stream: TcpStream) {
        // macOS can inherit O_NONBLOCK from the listener. Chromium may connect
        // before sending its request; treating WouldBlock as EOF then produces
        // an intermittent ERR_EMPTY_RESPONSE instead of preparing the surface.
        if stream.set_nonblocking(false).is_err() {
            return;
        }
        let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
        let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
        let started = Instant::now();
        let mut bytes = Vec::new();
        let mut buf = [0u8; 4096];
        let header_end;
        loop {
            if started.elapsed() > Duration::from_secs(1) {
                return;
            }
            match stream.read(&mut buf) {
                Ok(0) | Err(_) => return,
                Ok(n) => bytes.extend_from_slice(&buf[..n]),
            };
            if bytes.len() > 8192 {
                return;
            }
            if let Some(i) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                header_end = i + 4;
                break;
            }
        }
        let headers = String::from_utf8_lossy(&bytes[..header_end]);
        let mut lines = headers.lines();
        let Some(first) = lines.next() else { return };
        let parts: Vec<_> = first.split_whitespace().collect();
        if parts.len() != 3 {
            return;
        }
        #[cfg(debug_assertions)]
        eprintln!(
            "[set-bridge] revision={} request={}",
            self.projection.revision, first
        );
        let method = parts[0];
        let path = parts[1];
        let mut host = "";
        let mut origin = None;
        let mut length = 0;
        let mut invalid = false;
        for line in lines {
            if let Some((key, value)) = line.split_once(':') {
                let value = value.trim();
                match key.to_ascii_lowercase().as_str() {
                    "host" => host = value,
                    "origin" => origin = Some(value),
                    "content-length" => length = value.parse().unwrap_or(usize::MAX),
                    "transfer-encoding" => invalid = true,
                    _ => {}
                }
            }
        }
        let prefix = format!("/{}/", self.token);
        let mut status = "404 Not Found";
        let mut body = String::new();
        let mut kind = "text/plain";
        if self.active.load(Ordering::SeqCst)
            && host == self.origin.trim_start_matches("http://")
            && origin.is_none_or(|o| o == self.origin)
            && !invalid
            && path.starts_with(&prefix)
        {
            if method == "GET"
                && length == 0
                && ["events/background", "events/foreground"].contains(&&path[prefix.len()..])
            {
                let surface = path[prefix.len() + 7..].to_string();
                if self.streams.fetch_add(1, Ordering::SeqCst) >= 4 {
                    self.streams.fetch_sub(1, Ordering::SeqCst);
                    return;
                }
                let bridge = self.clone();
                std::thread::spawn(move || {
                    bridge.events(stream, &surface);
                    bridge.streams.fetch_sub(1, Ordering::SeqCst);
                });
                return;
            }
            match (method, &path[prefix.len()..]) {
                ("GET", surface @ ("background" | "foreground")) if length == 0 => {
                    status = "200 OK";
                    kind = "text/html";
                    body = self.page(surface);
                }
                ("POST", "ready") if origin == Some(self.origin.as_str()) && length <= 32768 => {
                    let mut data = bytes[header_end..].to_vec();
                    while data.len() < length {
                        if started.elapsed() > Duration::from_secs(1) {
                            return;
                        }
                        match stream.read(&mut buf) {
                            Ok(0) | Err(_) => return,
                            Ok(n) => data.extend_from_slice(&buf[..n]),
                        }
                    }
                    if let Ok(mut receipt) = serde_json::from_slice::<Receipt>(&data[..length]) {
                        let mut state = self.state.lock().unwrap();
                        if (receipt.revision == state.receipt_revision
                            || receipt.revision == state.projection.revision)
                            && receipt.serial == state.serial
                            && receipt.width == state.projection.width
                            && receipt.height == state.projection.height
                            && ["background", "foreground"].contains(&receipt.surface.as_str())
                            && receipt.slots.len() <= 8
                        {
                            #[cfg(debug_assertions)]
                            eprintln!(
                                "[set-bridge] prepared {} revision={}",
                                receipt.surface, receipt.revision
                            );
                            receipt.revision = state.projection.revision;
                            state.receipts.insert(receipt.surface.clone(), receipt);
                            status = "204 No Content";
                        }
                    }
                }
                _ => {}
            }
        }
        let nonce = &self.token;
        let headers=format!("HTTP/1.1 {status}\r\nContent-Type: {kind}; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nPermissions-Policy: camera=(), microphone=(), display-capture=()\r\nContent-Security-Policy: default-src 'none'; script-src 'nonce-{nonce}'; style-src 'unsafe-inline'; connect-src 'self'; img-src data: http://127.0.0.1:*; media-src data: http://127.0.0.1:*; frame-src 'self' about:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'\r\n\r\n",body.len());
        let _ = stream.write_all(headers.as_bytes());
        let _ = stream.write_all(body.as_bytes());
    }
    pub fn publish(&self, projection: Projection) {
        let mut state = self.state.lock().unwrap();
        state.receipt_revision = projection.revision;
        state.projection = projection;
        state.serial += 1;
        state.transport_only = false;
        state.receipts.clear();
    }
    fn adopt_revision(&self, revision: u64) {
        let mut state = self.state.lock().unwrap();
        state.projection.revision = revision;
        for receipt in state.receipts.values_mut() {
            receipt.revision = revision;
        }
    }
    fn promote_transport(&self, projection: Projection) {
        let mut state = self.state.lock().unwrap();
        state.serial += 1;
        state.transport_only = true;
        let serial = state.serial;
        for receipt in state.receipts.values_mut() {
            receipt.revision = projection.revision;
            receipt.serial = serial;
        }
        state.receipt_revision = projection.revision;
        state.projection = projection;
    }
    fn events(&self, mut stream: TcpStream, surface: &str) {
        let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
        let headers=format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\n\r\n");
        if stream.write_all(headers.as_bytes()).is_err() {
            return;
        }
        let mut serial = None;
        let used = used_assets(&self.projection);
        let mut known = self
            .projection
            .assets
            .iter()
            .filter(|(id, _)| used.contains(*id))
            .map(|(id, a)| (id.clone(), a.clone()))
            .collect::<HashMap<_, _>>();
        let mut heartbeat = Instant::now();
        while self.active.load(Ordering::SeqCst) {
            let update = {
                let state = self.state.lock().unwrap();
                if serial != Some(state.serial) {
                    Some((state.projection.clone(), state.serial, state.transport_only))
                } else {
                    None
                }
            };
            if let Some((mut p, next_serial, transport_only)) = update {
                let asset_ids = p.assets.keys().cloned().collect::<Vec<_>>();
                known.retain(|id, _| asset_ids.contains(id));
                serial = Some(next_serial);
                if surface == "background" || transport_only {
                    p.assets.clear();
                } else {
                    let used = used_assets(&p);
                    p.assets
                        .retain(|id, a| used.contains(id) && known.get(id) != Some(a));
                    known.extend(p.assets.clone());
                }
                resolve_local_media(&mut p);
                let Ok(json) = serde_json::to_string(
                    &serde_json::json!({"projection":p,"serial":next_serial,"assetIds":asset_ids,"transportOnly":transport_only}),
                ) else {
                    return;
                };
                if stream
                    .write_all(format!("data: {json}\n\n").as_bytes())
                    .is_err()
                {
                    return;
                }
            } else if heartbeat.elapsed() > Duration::from_secs(1) {
                if stream.write_all(b": keepalive\n\n").is_err() {
                    return;
                }
                heartbeat = Instant::now();
            }
            std::thread::sleep(Duration::from_millis(8));
        }
    }
    fn page(&self, surface: &str) -> String {
        let nonce = &self.token;
        let serial = self.state.lock().unwrap().serial;
        let frame=format!("<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'nonce-{nonce}'; style-src 'unsafe-inline'; connect-src 'none'; img-src data: http://127.0.0.1:*; media-src data: http://127.0.0.1:*; object-src 'none'; base-uri 'none'; form-action 'none'\"><style>html,body{{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;font-family:system-ui,sans-serif}}*{{box-sizing:border-box}}#canvas{{position:absolute;transform-origin:top left;overflow:hidden}}</style><style id=\"motion\"></style><div id=\"canvas\"></div><script nonce=\"{nonce}\">{}</script>",format!("{}\n{}",include_str!("../../../src/features/presentation/vendor/lottie-light.js"),include_str!("../../../src/features/presentation/frame.js")));
        let frame = serde_json::to_string(&frame)
            .unwrap()
            .replace('<', "\\u003c");
        let asset_ids = serde_json::to_string(
            &self
                .state
                .lock()
                .unwrap()
                .projection
                .assets
                .keys()
                .collect::<Vec<_>>(),
        )
        .unwrap();
        let mut initial = self.state.lock().unwrap().projection.clone();
        if surface == "background" {
            initial.assets.clear();
        } else {
            let used = used_assets(&initial);
            initial.assets.retain(|id, _| used.contains(id));
        }
        resolve_local_media(&mut initial);
        let projection = serde_json::to_string(&initial)
            .unwrap()
            .replace('<', "\\u003c");
        let bg = if surface == "background" {
            "#000"
        } else {
            "transparent"
        };
        format!("<!doctype html><style>html,body{{margin:0;width:100%;height:100%;overflow:hidden;background:{bg}}}iframe{{width:100%;height:100%;border:0}}</style><iframe sandbox=\"allow-scripts\" allow=\"camera 'none'; microphone 'none'; display-capture 'none'\"></iframe><script nonce=\"{nonce}\">const f=document.querySelector('iframe');let port;addEventListener('message',e=>{{if(e.source!==f.contentWindow||e.data!=='presentation.ready'||port)return;const c=new MessageChannel();port=c.port1;port.onmessage=e=>{{if(e.data?.type==='prepared'){{fetch('ready',{{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify({{...e.data,surface:'{surface}',type:undefined}}),credentials:'omit'}});}}}};port.start();f.contentWindow.postMessage('presentation.connect','*',[c.port2]);port.postMessage({{type:'output',surface:'{surface}',projection:{projection},serial:{serial},assetIds:{asset_ids}}});const events=new EventSource('events/{surface}');events.onmessage=e=>{{const update=JSON.parse(e.data);port.postMessage({{type:'output',surface:'{surface}',projection:update.projection,serial:update.serial,assetIds:update.assetIds,transportOnly:update.transportOnly}});}};}});f.srcdoc={frame};</script>")
    }
}

// OBS's browser event loop advances during video_render. A prepared source is
// deliberately off output, so render its graphics into a private target until
// its geometry receipt arrives. Never warm it by adding it to the room scene.
#[cfg(have_engine)]
struct PreparationRender {
    sources: Vec<*mut super::ffi::obs_source_t>,
    bridge: Arc<Bridge>,
    target: *mut std::ffi::c_void,
    stage: *mut std::ffi::c_void,
    width: u32,
    painted: Vec<bool>,
}
#[cfg(have_engine)]
extern "C" fn prepare_render(data: *mut std::ffi::c_void, _: u32, _: u32) {
    unsafe {
        use super::ffi;
        let render = &mut *(data as *mut PreparationRender);
        if render.target.is_null() {
            render.target = ffi::gs_texrender_create(ffi::GS_RGBA, ffi::GS_ZS_NONE);
            render.stage = ffi::gs_stagesurface_create(2, 1, ffi::GS_RGBA);
        }
        if render.target.is_null() || render.stage.is_null() {
            return;
        }
        for (index, source) in render.sources.iter().enumerate() {
            ffi::gs_texrender_reset(render.target);
            if !ffi::gs_texrender_begin(render.target, 2, 1) {
                continue;
            }
            let clear = ffi::vec4 {
                x: 0.,
                y: 0.,
                z: 0.,
                w: 0.,
            };
            ffi::gs_clear(1, &clear, 0., 0);
            // The trusted child paints a serial beacon outside the design, in
            // the same compositor frame as its updated graphics. Read actual GPU pixels
            // for each fresh browser surface; DOM receipts alone are insufficient.
            ffi::gs_ortho(
                render.width as f32 - 2.,
                render.width as f32,
                0.,
                1.,
                -100.,
                100.,
            );
            ffi::gs_blend_state_push();
            ffi::gs_blend_function(ffi::GS_BLEND_ONE, ffi::GS_BLEND_INVSRCALPHA);
            ffi::obs_source_video_render(*source);
            ffi::gs_blend_state_pop();
            ffi::gs_texrender_end(render.target);
            ffi::gs_stage_texture(render.stage, ffi::gs_texrender_get_texture(render.target));
            let mut pixels = std::ptr::null_mut();
            let mut linesize = 0;
            if ffi::gs_stagesurface_map(render.stage, &mut pixels, &mut linesize) {
                if !pixels.is_null() && linesize >= 8 {
                    let p = std::slice::from_raw_parts(pixels, 8);
                    let revision = render.bridge.state.lock().unwrap().serial;
                    let expected = [
                        32 + (revision % 190) as u8,
                        32 + ((revision / 190) % 190) as u8,
                    ];
                    render.painted[index] |= p.chunks_exact(4).zip(expected).all(|(rgba, v)| {
                        rgba[..3].iter().all(|c| c.abs_diff(v) <= 2) && rgba[3] >= 240
                    });
                }
                ffi::gs_stagesurface_unmap(render.stage);
            }
        }
        if render.painted.iter().all(|p| *p) {
            render.bridge.painted.store(true, Ordering::SeqCst);
        }
    }
}
#[cfg(have_engine)]
struct PlacementCache {
    width: u32,
    height: u32,
    slot: String,
    capture: *mut super::ffi::obs_source_t,
    proxy: *mut super::ffi::obs_source_t,
    item: *mut super::ffi::obs_sceneitem_t,
}
#[cfg(have_engine)]
struct ShaderCache {
    key: String,
    source: *mut super::ffi::obs_source_t,
    item: *mut super::ffi::obs_sceneitem_t,
}
#[cfg(have_engine)]
pub struct Composition {
    animator: Option<super::animation::Animator>,
    preparation_render: Option<Box<PreparationRender>>,
    canvas_size: Option<(u32, u32)>,
    pub request: Request,
    pub pending_patch: Option<Request>,
    entry_transport_pending: bool,
    pub bridge: Arc<Bridge>,
    pub scene: *mut super::ffi::obs_scene_t,
    pub item: *mut super::ffi::obs_sceneitem_t,
    sources: Vec<*mut super::ffi::obs_source_t>,
    captures: HashMap<String, *mut super::ffi::obs_source_t>,
    showing: Vec<*mut super::ffi::obs_source_t>,
    placements: Vec<PlacementCache>,
    shaders: Vec<ShaderCache>,
}
#[cfg(have_engine)]
impl Composition {
    pub unsafe fn build(
        request: Request,
        captures: HashMap<String, *mut super::ffi::obs_source_t>,
    ) -> Result<Self, String> {
        Self::build_sized(request, captures, None, None)
    }
    pub unsafe fn build_sized(
        request: Request,
        captures: HashMap<String, *mut super::ffi::obs_source_t>,
        canvas_size: Option<(u32, u32)>,
        canvas: Option<*mut std::ffi::c_void>,
    ) -> Result<Self, String> {
        use super::ffi;
        use std::ffi::CString;
        let bridge = Bridge::start(request.projection.clone())?;
        bridge.painted.store(false, Ordering::SeqCst);
        let name = CString::new(format!("Set {}", bridge.token)).unwrap();
        extern "C" {
            fn obs_canvas_scene_create(
                canvas: *mut std::ffi::c_void,
                name: *const std::ffi::c_char,
            ) -> *mut ffi::obs_scene_t;
        }
        let scene = match canvas {
            Some(canvas) => obs_canvas_scene_create(canvas, name.as_ptr()),
            None => ffi::obs_scene_create_private(name.as_ptr()),
        };
        if scene.is_null() {
            bridge.revoke();
            return Err("Set composition allocation failed".into());
        }
        let mut out = Self {
            animator: None,
            preparation_render: None,
            canvas_size,
            request,
            pending_patch: None,
            entry_transport_pending: false,
            bridge,
            scene,
            item: std::ptr::null_mut(),
            sources: Vec::new(),
            captures: HashMap::new(),
            showing: Vec::new(),
            placements: Vec::new(),
            shaders: Vec::new(),
        };
        ffi::obs_source_set_audio_mixers(ffi::obs_scene_get_source(scene), 0);
        for (id, capture) in captures {
            out.captures.insert(id, ffi::obs_source_get_ref(capture));
        }
        let mut info: std::mem::MaybeUninit<ffi::obs_video_info> = std::mem::MaybeUninit::zeroed();
        if !ffi::obs_get_video_info(info.as_mut_ptr()) {
            return Err("Canvas is not running".into());
        }
        let info = info.assume_init();
        let dimensions = canvas_size.unwrap_or((info.base_width, info.base_height));
        let base = (dimensions.0 as f32, dimensions.1 as f32);
        let settings = ffi::obs_data_create();
        for (key, value) in [
            ("width", dimensions.0 as i64),
            ("height", dimensions.1 as i64),
            ("color", 0xff000000),
        ] {
            ffi::obs_data_set_int(settings, CString::new(key).unwrap().as_ptr(), value);
        }
        let black = ffi::obs_source_create_private(
            CString::new("color_source_v3").unwrap().as_ptr(),
            CString::new("Set canvas").unwrap().as_ptr(),
            settings,
        );
        ffi::obs_data_release(settings);
        if black.is_null() {
            return Err("Set canvas creation failed".into());
        }
        out.sources.push(black);
        if ffi::obs_scene_add(scene, black).is_null() {
            return Err("Set canvas attachment failed".into());
        }
        let scale = (base.0 / out.request.projection.width as f32)
            .min(base.1 / out.request.projection.height as f32);
        let width = out.request.projection.width as f32 * scale;
        let height = out.request.projection.height as f32 * scale;
        for surface in ["background", "foreground"] {
            let settings = ffi::obs_data_create();
            ffi::obs_data_set_string(
                settings,
                CString::new("url").unwrap().as_ptr(),
                CString::new(out.bridge.url(surface)).unwrap().as_ptr(),
            );
            for (key, value) in [
                ("width", out.request.projection.width as i64 + 2),
                ("height", out.request.projection.height as i64),
                ("fps", 30),
                ("webpage_control_level", 0),
            ] {
                ffi::obs_data_set_int(settings, CString::new(key).unwrap().as_ptr(), value);
            }
            for (key, value) in [
                ("fps_custom", true),
                ("shutdown", false),
                ("restart_when_active", false),
                ("reroute_audio", true),
            ] {
                ffi::obs_data_set_bool(settings, CString::new(key).unwrap().as_ptr(), value);
            }
            let src = ffi::obs_source_create_private(
                CString::new("browser_source").unwrap().as_ptr(),
                CString::new(format!("Set {surface}")).unwrap().as_ptr(),
                settings,
            );
            ffi::obs_data_release(settings);
            if src.is_null() {
                return Err("This engine cannot render set graphics".into());
            }
            ffi::obs_source_set_audio_mixers(src, 0);
            ffi::obs_source_set_muted(src, true);
            out.sources.push(src);
            ffi::obs_source_inc_active(src);
            ffi::obs_source_inc_showing(src);
            out.showing.push(src);
            let item = ffi::obs_scene_add(scene, src);
            if item.is_null() {
                return Err("Set graphics attachment failed".into());
            }
            // The readiness beacon is outside the set canvas and is never on air.
            ffi::obs_sceneitem_set_crop(
                item,
                &ffi::obs_sceneitem_crop {
                    left: 0,
                    top: 0,
                    right: 2,
                    bottom: 0,
                },
            );
            ffi::obs_sceneitem_set_pos(
                item,
                &ffi::vec2 {
                    x: (base.0 - width) / 2.,
                    y: (base.1 - height) / 2.,
                },
            );
            ffi::obs_sceneitem_set_bounds_type(item, ffi::OBS_BOUNDS_SCALE_INNER);
            ffi::obs_sceneitem_set_bounds(
                item,
                &ffi::vec2 {
                    x: width,
                    y: height,
                },
            );
        }
        let mut render = Box::new(PreparationRender {
            sources: out.showing.clone(),
            bridge: out.bridge.clone(),
            target: std::ptr::null_mut(),
            stage: std::ptr::null_mut(),
            width: out.request.projection.width + 2,
            painted: vec![false; out.showing.len()],
        });
        ffi::obs_add_main_render_callback(prepare_render, &mut *render as *mut _ as *mut _);
        out.preparation_render = Some(render);
        Ok(out)
    }
    unsafe fn stop_preparing(&mut self) {
        if let Some(mut render) = self.preparation_render.take() {
            super::ffi::obs_remove_main_render_callback(
                prepare_render,
                &mut *render as *mut _ as *mut _,
            );
            if !render.target.is_null() {
                super::ffi::obs_enter_graphics();
                super::ffi::gs_texrender_destroy(render.target);
                if !render.stage.is_null() {
                    super::ffi::gs_stagesurface_destroy(render.stage);
                }
                super::ffi::obs_leave_graphics();
            }
        }
    }
    unsafe fn begin_preparing(&mut self) {
        self.stop_preparing();
        self.bridge.painted.store(false, Ordering::SeqCst);
        let mut render = Box::new(PreparationRender {
            sources: self.showing.clone(),
            bridge: self.bridge.clone(),
            target: std::ptr::null_mut(),
            stage: std::ptr::null_mut(),
            width: self.request.projection.width + 2,
            painted: vec![false; self.showing.len()],
        });
        super::ffi::obs_add_main_render_callback(prepare_render, &mut *render as *mut _ as *mut _);
        self.preparation_render = Some(render);
    }
    pub fn same_size(&self, request: &Request) -> bool {
        self.request.projection.width == request.projection.width
            && self.request.projection.height == request.projection.height
    }
    pub fn can_promote(
        &self,
        request: &Request,
        captures: &HashMap<String, *mut super::ffi::obs_source_t>,
    ) -> bool {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as f64;
        self.request.lease == request.lease
            && self.request.generation == request.generation
            && self.request.bindings == request.bindings
            && self.captures == *captures
            && self.placements.iter().all(|p| unsafe {
                super::ffi::obs_source_get_width(p.capture) == p.width
                    && super::ffi::obs_source_get_height(p.capture) == p.height
            })
            && media_key(&self.request.projection) == media_key(&request.projection)
            && prepared_graphics(&self.request.projection) == prepared_graphics(&request.projection)
            && prepared_media_matches(&self.request.projection.root, &request.projection.root, now)
    }
    pub unsafe fn promote(&mut self, request: Request) -> Result<(), String> {
        if let (Some(animator), Some(timeline)) = (&self.animator, &request.projection.timeline) {
            animator.prepare(timeline.clone());
        }
        self.bridge.adopt_revision(request.projection.revision);
        self.request = request;
        self.pending_patch = None;
        self.entry_transport_pending = true;
        Ok(())
    }
    pub unsafe fn finish_preparation(&mut self, placements: Vec<Placement>) -> Result<(), String> {
        if self.preparation_render.is_some() {
            self.dress(placements)?;
        }
        if self.entry_transport_pending {
            self.bridge
                .promote_transport(self.request.projection.clone());
            self.entry_transport_pending = false;
        }
        Ok(())
    }
    pub unsafe fn reuse(
        &mut self,
        request: Request,
        captures: HashMap<String, *mut super::ffi::obs_source_t>,
    ) {
        self.animator = None;
        self.stop_preparing();
        self.pending_patch = None;
        self.entry_transport_pending = false;
        for source in self.captures.values() {
            super::ffi::obs_source_release(*source);
        }
        self.captures = captures
            .into_iter()
            .map(|(id, src)| (id, super::ffi::obs_source_get_ref(src)))
            .collect();
        self.request = request;
        self.bridge.painted.store(false, Ordering::SeqCst);
        self.bridge.publish(self.request.projection.clone());
        self.begin_preparing();
    }
    pub fn preload_request(&self) -> Option<Request> {
        self.request.preload.as_ref().map(|p| {
            fn slots(n: &Node, ids: &mut std::collections::HashSet<String>) {
                if let Some(id) = &n.slot_id {
                    ids.insert(id.clone());
                }
                for c in &n.children {
                    slots(c, ids);
                }
            }
            let mut ids = std::collections::HashSet::new();
            slots(&p.root, &mut ids);
            let mut projection = p.clone();
            fn pause(n: &mut Node) {
                if let Some(t) = n.playback.as_mut() {
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as f64;
                    if t.playing {
                        t.position_ms += (now - t.anchor_ms).max(0.);
                    }
                    t.playing = false;
                    t.anchor_ms = now;
                }
                if n.r#type == "media" {
                    n.autoplay = Some(false);
                }
                for c in &mut n.children {
                    pause(c);
                }
            }
            pause(&mut projection.root);
            Request {
                asset_ids: self.request.asset_ids.clone(),
                generation: self.request.generation,
                lease: self.request.lease.clone(),
                projection,
                bindings: self
                    .request
                    .bindings
                    .iter()
                    .filter(|(id, _)| ids.contains(*id))
                    .map(|(id, src)| (id.clone(), src.clone()))
                    .collect(),
                preload: None,
            }
        })
    }
    pub unsafe fn warm_proxies(&mut self) {
        if self.preparation_render.is_some() {
            if let Some(placements) = self.bridge.ready() {
                if let Err(e) = self.dress(placements) {
                    eprintln!("[set-preload] {e}");
                }
            }
        }
    }
    pub fn preload_captures(&self) -> HashMap<String, *mut super::ffi::obs_source_t> {
        self.captures.clone()
    }
    pub fn can_patch(
        &self,
        request: &Request,
        captures: &HashMap<String, *mut super::ffi::obs_source_t>,
    ) -> bool {
        (morph_compatible(&self.request.projection, &request.projection)
            || animation_key(&self.request.projection) == animation_key(&request.projection)
                && geometry_key(&self.request.projection)
                    .is_some_and(|old| Some(old) == geometry_key(&request.projection)))
            && self.request.bindings == request.bindings
            && self.captures == *captures
            && self.placements.iter().all(|p| unsafe {
                super::ffi::obs_source_get_width(p.capture) == p.width
                    && super::ffi::obs_source_get_height(p.capture) == p.height
            })
            && media_key(&self.request.projection) == media_key(&request.projection)
    }
    pub fn patch(&mut self, request: Request) -> Arc<Bridge> {
        if let (Some(animator), Some(timeline)) = (&self.animator, &request.projection.timeline) {
            if morph_compatible(&self.request.projection, &request.projection) {
                animator.retarget(&request.projection);
            }
            animator.update(timeline.clone());
        }
        self.bridge.publish(request.projection.clone());
        self.pending_patch = Some(request);
        unsafe {
            self.begin_preparing();
        }
        self.bridge.clone()
    }
    pub fn commit_patch(&mut self, token: &str, generation: u64) -> Result<bool, String> {
        if token != self.bridge.token || self.pending_patch.is_none() {
            return Ok(false);
        }
        if self.pending_patch.as_ref().unwrap().generation != generation {
            return Err("Room changed during graphics update".into());
        }
        unsafe {
            self.stop_preparing();
        }
        self.request = self.pending_patch.take().unwrap();
        Ok(true)
    }
    pub fn abort_patch(&mut self, token: &str, revision: u64) {
        if token == self.bridge.token
            && self
                .pending_patch
                .as_ref()
                .is_some_and(|r| r.projection.revision == revision)
        {
            unsafe {
                self.stop_preparing();
            }
            if let (Some(animator), Some(timeline)) =
                (&self.animator, &self.request.projection.timeline)
            {
                animator.retarget(&self.request.projection);
                animator.update(timeline.clone());
            }
            self.pending_patch = None;
            self.bridge.publish(self.request.projection.clone());
        }
    }
    pub unsafe fn dress(&mut self, placements: Vec<Placement>) -> Result<(), String> {
        self.animator = None;
        self.stop_preparing();
        use super::ffi;
        use std::ffi::CString;
        let p = &self.request.projection;
        let mut seen = std::collections::HashSet::new();
        fn collect(n: &Node, out: &mut HashMap<String, String>) {
            if let Some(id) = &n.slot_id {
                out.insert(n.id.clone(), id.clone());
            }
            for c in &n.children {
                collect(c, out);
            }
        }
        let mut slots = HashMap::new();
        collect(&p.root, &mut slots);
        if placements.len() != slots.len() {
            return Err("Renderer did not prepare every slot".into());
        }
        for slot in &placements {
            if slots.get(&slot.node_id) != Some(&slot.slot_id)
                || !seen.insert(slot.node_id.clone())
                || ![slot.x, slot.y, slot.width, slot.height]
                    .iter()
                    .all(|v| v.is_finite())
                || slot.x < 0.
                || slot.y < 0.
                || slot.width <= 0.
                || slot.height <= 0.
                || slot.x + slot.width > p.width as f32 + 1.
                || slot.y + slot.height > p.height as f32 + 1.
            {
                return Err("Set slot geometry is invalid".into());
            }
            if let Some(f) = &slot.framing {
                f.validate()?;
            }
            if let Some(a) = &slot.appearance {
                super::filters::validate_appearance_patch(
                    a.as_object().ok_or("Invalid slot appearance")?,
                )?;
            }
        }
        let mut info: std::mem::MaybeUninit<ffi::obs_video_info> = std::mem::MaybeUninit::zeroed();
        if !ffi::obs_get_video_info(info.as_mut_ptr()) {
            return Err("Canvas stopped during preparation".into());
        }
        let info = info.assume_init();
        let dimensions = self
            .canvas_size
            .unwrap_or((info.base_width, info.base_height));
        let scale =
            (dimensions.0 as f32 / p.width as f32).min(dimensions.1 as f32 / p.height as f32);
        let offset = (
            (dimensions.0 as f32 - p.width as f32 * scale) / 2.,
            (dimensions.1 as f32 - p.height as f32 * scale) / 2.,
        );
        // Reuse camera proxies and compiled filters across cuts. Only their
        // framing, appearance settings and rectangle change on the off-air scene.
        let mut previous = std::mem::take(&mut self.placements);
        let mut animated_targets = Vec::new();
        let mut previous_shaders = std::mem::take(&mut self.shaders);
        for (index, node) in p
            .root
            .children
            .iter()
            .filter(|n| n.shader.is_some())
            .enumerate()
        {
            let config = node.shader.as_ref().unwrap();
            let get = |k: &str| node.styles[k].as_f64().unwrap() as f32;
            let (x, y, w, h) = (get("left"), get("top"), get("width"), get("height"));
            let key = serde_json::json!({"shader":config,"width":w,"height":h}).to_string();
            let cached = previous_shaders
                .iter()
                .position(|s| s.key == key)
                .map(|i| previous_shaders.remove(i));
            let (source, item) = if let Some(s) = cached {
                (s.source, s.item)
            } else {
                let source = super::shaders::create(config, w, h)?;
                self.sources.push(source);
                let item = ffi::obs_scene_add(self.scene, source);
                if item.is_null() {
                    return Err("Shader attachment failed".into());
                }
                (source, item)
            };
            ffi::obs_sceneitem_set_pos(
                item,
                &ffi::vec2 {
                    x: offset.0 + x * scale,
                    y: offset.1 + y * scale,
                },
            );
            ffi::obs_sceneitem_set_bounds_type(item, ffi::OBS_BOUNDS_STRETCH);
            ffi::obs_sceneitem_set_bounds(
                item,
                &ffi::vec2 {
                    x: w * scale,
                    y: h * scale,
                },
            );
            ffi::obs_sceneitem_set_order_position(item, index as i32 + 2);
            ffi::producer_shader_frame(
                source,
                0.,
                config.intensity as f32,
                config.scale as f32,
                config.opacity as f32,
            );
            self.shaders.push(ShaderCache { key, source, item });
            animated_targets.push(super::animation::Target {
                id: node.id.clone(),
                item,
                source,
                x: offset.0 + x * scale,
                y: offset.1 + y * scale,
                width: w * scale,
                height: h * scale,
                local_x: x,
                local_y: y,
                scale,
                last: None,
                last_opacity: None,
                shader: Some(config.clone()),
                last_shader: None,
                capture: std::ptr::null_mut(),
                framing: None,
                appearance: None,
            });
        }
        for old in previous_shaders {
            ffi::obs_sceneitem_remove(old.item);
            if let Some(i) = self.sources.iter().position(|s| *s == old.source) {
                self.sources.remove(i);
                ffi::obs_source_release(old.source);
            }
        }
        for (index, slot) in placements.iter().enumerate() {
            let Some(capture) = self.captures.get(&slot.slot_id).copied() else {
                continue;
            };
            let cached = previous
                .iter()
                .position(|p| p.slot == slot.slot_id && p.capture == capture)
                .map(|i| previous.remove(i));
            let (proxy, item) = if let Some(cached) = cached {
                (cached.proxy, cached.item)
            } else {
                let proxy = ffi::producer_source_placement_create(capture);
                if proxy.is_null() {
                    return Err("Source cannot be used as a video placement".into());
                }
                self.sources.push(proxy);
                let item = ffi::obs_scene_add(self.scene, proxy);
                if item.is_null() {
                    return Err("Video placement attachment failed".into());
                }
                (proxy, item)
            };
            let mut crop =
                serde_json::json!({"relative":true,"left":0,"right":0,"top":0,"bottom":0});
            if let Some(f) = slot.framing.as_ref().filter(|f| f.mode == "fill") {
                let sw = ffi::obs_source_get_width(capture) as f64;
                let sh = ffi::obs_source_get_height(capture) as f64;
                if sw <= 0.0 || sh <= 0.0 {
                    return Err("Slot source has no dimensions".into());
                }
                let ratio = slot.width as f64 / slot.height as f64;
                let (cw, ch) = if sw / sh > ratio {
                    (sh * ratio, sh)
                } else {
                    (sw, sw / ratio)
                };
                let dx = (sw - cw).max(0.0).floor() as i32;
                let dy = (sh - ch).max(0.0).floor() as i32;
                let left = (dx as f64 * f.x).round() as i32;
                let top = (dy as f64 * f.y).round() as i32;
                crop = serde_json::json!({"relative":true,"left":left,"right":dx-left,"top":top,"bottom":dy-top});
            }
            let crop_name = CString::new("Set framing").unwrap();
            let mut filter = ffi::obs_source_get_filter_by_name(proxy, crop_name.as_ptr());
            if !filter.is_null() || slot.framing.as_ref().is_some_and(|f| f.mode == "fill") {
                let json = CString::new(crop.to_string()).unwrap();
                let data = ffi::obs_data_create_from_json(json.as_ptr());
                if filter.is_null() {
                    filter = ffi::obs_source_create_private(
                        CString::new("crop_filter").unwrap().as_ptr(),
                        crop_name.as_ptr(),
                        data,
                    );
                    if !filter.is_null() {
                        ffi::obs_source_filter_add(proxy, filter);
                    }
                } else {
                    ffi::obs_source_update(filter, data);
                }
                ffi::obs_data_release(data);
                if filter.is_null() {
                    return Err("Set crop filter is unavailable".into());
                }
                ffi::obs_source_release(filter);
            }
            let appearance_name = CString::new("Set slot appearance").unwrap();
            let mut filter = ffi::obs_source_get_filter_by_name(proxy, appearance_name.as_ptr());
            if let Some(appearance) = &slot.appearance {
                if filter.is_null() {
                    filter = ffi::obs_source_create_private(
                        CString::new("producer_source_appearance").unwrap().as_ptr(),
                        appearance_name.as_ptr(),
                        std::ptr::null_mut(),
                    );
                    if !filter.is_null() {
                        ffi::obs_source_filter_add(proxy, filter);
                    }
                }
                if filter.is_null() {
                    return Err("Source appearance is unavailable".into());
                }
                let mut values = appearance.clone();
                let obj = values.as_object_mut().unwrap();
                obj.insert("displayWidth".into(), Value::from(slot.width));
                obj.insert("displayHeight".into(), Value::from(slot.height));
                let json = CString::new(values.to_string()).unwrap();
                let data = ffi::obs_data_create_from_json(json.as_ptr());
                ffi::obs_source_update(filter, data);
                ffi::obs_data_release(data);
                ffi::obs_source_release(filter);
            } else if !filter.is_null() {
                ffi::obs_source_filter_remove(proxy, filter);
                ffi::obs_source_release(filter);
            }
            self.placements.push(PlacementCache {
                width: ffi::obs_source_get_width(capture),
                height: ffi::obs_source_get_height(capture),
                slot: slot.slot_id.clone(),
                capture,
                proxy,
                item,
            });
            fn find_node<'a>(n: &'a Node, id: &str) -> Option<&'a Node> {
                if n.id == id {
                    Some(n)
                } else {
                    n.children.iter().find_map(|c| find_node(c, id))
                }
            }
            let node = find_node(&p.root, &slot.node_id).unwrap();
            animated_targets.push(super::animation::Target {
                id: slot.node_id.clone(),
                item,
                source: proxy,
                x: offset.0 + slot.x * scale,
                y: offset.1 + slot.y * scale,
                width: slot.width * scale,
                height: slot.height * scale,
                local_x: node
                    .styles
                    .get("left")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.) as f32,
                local_y: node.styles.get("top").and_then(Value::as_f64).unwrap_or(0.) as f32,
                scale,
                last: None,
                last_opacity: None,
                shader: None,
                last_shader: None,
                capture,
                framing: slot.framing.clone(),
                appearance: slot.appearance.clone(),
            });
            let opacity_filter = ffi::obs_source_get_filter_by_name(
                proxy,
                CString::new(super::filters::OPACITY_FILTER)
                    .unwrap()
                    .as_ptr(),
            );
            if !opacity_filter.is_null() {
                ffi::obs_source_release(opacity_filter);
                super::filters::set_opacity(proxy, 1.)?;
            }
            ffi::obs_sceneitem_set_pos(
                item,
                &ffi::vec2 {
                    x: offset.0 + slot.x * scale,
                    y: offset.1 + slot.y * scale,
                },
            );
            // Fill crops already match this rectangle. Avoid aspect-fit gaps while
            // integer crop extents change during a morph; fit slots retain letterboxing.
            ffi::obs_sceneitem_set_bounds_type(
                item,
                if slot.framing.as_ref().is_some_and(|f| f.mode == "fill") {
                    ffi::OBS_BOUNDS_STRETCH
                } else {
                    ffi::OBS_BOUNDS_SCALE_INNER
                },
            );
            ffi::obs_sceneitem_set_bounds(
                item,
                &ffi::vec2 {
                    x: slot.width * scale,
                    y: slot.height * scale,
                },
            );
            ffi::obs_sceneitem_set_order_position(
                item,
                index as i32 + 2 + self.shaders.len() as i32,
            );
        }
        for old in previous {
            ffi::obs_sceneitem_remove(old.item);
            if let Some(i) = self.sources.iter().position(|p| *p == old.proxy) {
                self.sources.remove(i);
                ffi::obs_source_release(old.proxy);
            }
        }
        if let Some(timeline) = &p.timeline {
            self.animator = Some(super::animation::Animator::new(
                &self.request.lease,
                timeline.clone(),
                ffi::obs_scene_get_source(self.scene),
                animated_targets,
            )?);
        }
        Ok(())
    }
    pub fn activate_animation(&self, fade: bool) {
        if let Some(a) = &self.animator {
            a.activate(fade);
        }
    }
    pub fn transition_finished(&self) -> bool {
        self.animator.as_ref().is_none_or(|a| a.finished())
    }
    pub fn finish_transition(&self) {
        if let Some(a) = &self.animator {
            a.finish();
        }
    }
    pub fn has_crossfade(&self) -> bool {
        self.request
            .projection
            .timeline
            .as_ref()
            .is_some_and(|timeline| {
                timeline.clock.running
                    && timeline
                        .transition
                        .as_ref()
                        .is_some_and(|t| t.r#type == "crossfade" && t.duration_ms > 0.)
            })
    }
    pub fn synchronize_retired_clock(&mut self, clock: &super::animation::ClockSpec) {
        let Some(timeline) = self.request.projection.timeline.as_mut() else {
            return;
        };
        let origin = timeline.clock.position_ms - timeline.clock.segment_ms;
        let was_running = timeline.clock.running;
        timeline.clock = super::animation::ClockSpec {
            running: clock.running,
            position_ms: clock.position_ms,
            segment_ms: (clock.position_ms - origin).max(0.),
            anchor_ms: clock.anchor_ms,
        };
        if let Some(a) = &self.animator {
            a.update(timeline.clone());
        }
        if was_running != clock.running {
            fn pause(n: &mut Node, running: bool) {
                if let Some(t) = n.playback.as_mut() {
                    let now = super::animation::utc_ms();
                    if !running {
                        let resume = t.playing;
                        if t.playing {
                            t.position_ms += (now - t.anchor_ms).max(0.);
                        }
                        t.playing = false;
                        t.resume_after_pause = Some(resume);
                    } else if t.resume_after_pause == Some(true) {
                        t.playing = true;
                        t.resume_after_pause = None;
                    }
                    t.anchor_ms = now;
                }
                for c in &mut n.children {
                    pause(c, running);
                }
            }
            pause(&mut self.request.projection.root, clock.running);
        }
        self.bridge
            .promote_transport(self.request.projection.clone());
    }
}
#[cfg(have_engine)]
impl Drop for Composition {
    fn drop(&mut self) {
        unsafe {
            self.animator = None;
            self.stop_preparing();
            self.bridge.revoke();
            if !self.item.is_null() {
                super::ffi::obs_sceneitem_remove(self.item);
            }
            for source in &self.showing {
                super::ffi::obs_source_dec_showing(*source);
                super::ffi::obs_source_dec_active(*source);
            }
            super::ffi::obs_scene_release(self.scene);
            for source in &self.sources {
                super::ffi::obs_source_release(*source);
            }
            for source in self.captures.values() {
                super::ffi::obs_source_release(*source);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prepared_entry_matches_transport_but_rejects_changed_graphics_and_seek() {
        let mut prepared = request().projection;
        prepared.root.playback = Some(MediaTransport {
            playing: false,
            position_ms: 0.,
            anchor_ms: 1000.,
            resume_after_pause: None,
        });
        prepared.root.autoplay = Some(false);
        let mut entering = prepared.clone();
        entering.revision = 9;
        entering.root.playback.as_mut().unwrap().playing = true;
        entering.root.autoplay = Some(true);
        assert_eq!(prepared_graphics(&prepared), prepared_graphics(&entering));
        assert!(prepared_media_matches(
            &prepared.root,
            &entering.root,
            1100.
        ));
        entering.root.playback.as_mut().unwrap().position_ms = 900.;
        assert!(!prepared_media_matches(
            &prepared.root,
            &entering.root,
            1100.
        ));
        entering.root.children[0]
            .styles
            .insert("left".into(), serde_json::json!(300));
        assert_ne!(prepared_graphics(&prepared), prepared_graphics(&entering));
    }
    #[test]
    fn promotion_keeps_proven_receipts_and_relabels_revision() {
        let p = request().projection;
        let bridge = Bridge::start(p.clone()).unwrap();
        {
            let mut state = bridge.state.lock().unwrap();
            for surface in ["background", "foreground"] {
                state.receipts.insert(
                    surface.into(),
                    Receipt {
                        revision: p.revision,
                        serial: 0,
                        width: p.width,
                        height: p.height,
                        slots: vec![],
                        surface: surface.into(),
                    },
                );
            }
        }
        assert!(bridge.ready().is_some());
        bridge.adopt_revision(7);
        assert!(bridge.ready().is_some());
        assert_eq!(bridge.state.lock().unwrap().serial, 0);
        assert_eq!(bridge.state.lock().unwrap().receipt_revision, 1);
        let mut next = p;
        next.revision = 7;
        bridge.promote_transport(next);
        assert!(bridge.ready().is_some());
        assert!(bridge.wait_revision(7).is_ok());
        assert!(bridge.wait_revision(1).is_err());
        assert!(bridge.state.lock().unwrap().transport_only);
        bridge.revoke();
    }
    #[test]
    fn adopting_in_progress_preparation_accepts_its_late_receipts() {
        let p = request().projection;
        let bridge = Bridge::start(p.clone()).unwrap();
        bridge.adopt_revision(7);
        let host = bridge.origin.trim_start_matches("http://");
        let route = format!("/{}/ready", bridge.token);
        for surface in ["background", "foreground"] {
            let receipt=serde_json::json!({"revision":1,"serial":0,"width":p.width,"height":p.height,"slots":[],"surface":surface}).to_string();
            assert!(http(
                &bridge,
                "POST",
                &route,
                host,
                Some(&bridge.origin),
                &receipt
            )
            .starts_with("HTTP/1.1 204"));
        }
        assert!(bridge.ready().is_some());
        assert!(bridge.wait_revision(7).is_ok());
        bridge.publish(p.clone());
        let stale=serde_json::json!({"revision":1,"serial":0,"width":p.width,"height":p.height,"slots":[],"surface":"foreground"}).to_string();
        assert!(
            http(&bridge, "POST", &route, host, Some(&bridge.origin), &stale)
                .starts_with("HTTP/1.1 404")
        );
        assert!(bridge.ready().is_none());
        bridge.revoke();
    }
    fn request() -> Request {
        Request {
            asset_ids: None,
            preload: None,
            generation: 1,
            lease: uuid::Uuid::new_v4().to_string(),
            bindings: HashMap::from([("host".into(), "camera".into())]),
            projection: Projection {
                timeline: None,
                width: 1280,
                height: 720,
                revision: 1,
                css: String::new(),
                assets: HashMap::new(),
                root: Node {
                    shader: None,
                    id: "root".into(),
                    r#type: "box".into(),
                    text: None,
                    asset_id: None,
                    fit: None,
                    autoplay: None,
                    r#loop: None,
                    playback: None,
                    slot_id: None,
                    slot_label: None,
                    appearance: None,
                    framing: None,
                    styles: HashMap::new(),
                    motion_class: None,
                    children: vec![Node {
                        shader: None,
                        id: "host".into(),
                        r#type: "slot".into(),
                        slot_id: Some("host".into()),
                        slot_label: Some("Host".into()),
                        text: None,
                        asset_id: None,
                        fit: None,
                        autoplay: None,
                        r#loop: None,
                        playback: None,
                        appearance: None,
                        framing: None,
                        styles: HashMap::new(),
                        children: vec![],
                        motion_class: None,
                    }],
                },
            },
        }
    }
    #[test]
    fn morph_patch_reuses_only_compatible_direct_native_layers() {
        let mut a = request().projection;
        a.root.styles = serde_json::from_value(
            serde_json::json!({"position":"relative","width":1280,"height":720}),
        )
        .unwrap();
        a.root.children[0].styles = serde_json::from_value(
            serde_json::json!({"position":"absolute","left":10,"top":20,"width":300,"height":200}),
        )
        .unwrap();
        let mut b = a.clone();
        b.timeline=Some(serde_json::from_value(serde_json::json!({"clock":{"running":true,"positionMs":0,"segmentMs":0,"anchorMs":1000},"tracks":[],"transition":{"type":"morph","durationMs":1100}})).unwrap());
        b.root.children[0]
            .styles
            .insert("width".into(), serde_json::json!(600));
        assert!(morph_compatible(&a, &b));
        let mut changed = b.clone();
        changed.height = 1280;
        assert!(!morph_compatible(&a, &changed));
        changed = b.clone();
        changed.root.children[0].slot_id = Some("other".into());
        assert!(!morph_compatible(&a, &changed));
        changed = b.clone();
        changed.root.children[0].framing = Some(Framing {
            mode: "fit".into(),
            x: 0.5,
            y: 0.5,
        });
        assert!(!morph_compatible(&a, &changed));
    }
    #[test]
    fn shader_configuration_invalidates_native_geometry_cache() {
        let mut p = request().projection;
        p.root.styles=serde_json::from_value(serde_json::json!({"position":"relative","width":1280,"height":720,"background":"#080d1a"})).unwrap();
        let shader:Node=serde_json::from_value(serde_json::json!({"id":"aurora","type":"shader","styles":{"position":"absolute","left":0,"top":0,"width":1280,"height":720},"children":[],"shader":{"effect":"aurora","colors":["#071023","#236bad","#845ade"],"speed":1,"intensity":1,"scale":1,"opacity":1,"radius":24,"quality":"low","clock":"segment"}})).unwrap();
        p.root.children = vec![shader];
        let before = geometry_key(&p);
        assert!(before.is_some());
        p.root.children[0].shader.as_mut().unwrap().intensity = 0.;
        assert_ne!(before, geometry_key(&p));
        p.root.children[0].shader.as_mut().unwrap().intensity = 1.;
        assert_eq!(before, geometry_key(&p));
        p.root.children[0]
            .styles
            .insert("width".into(), serde_json::json!(1000));
        assert_ne!(before, geometry_key(&p));
    }
    #[test]
    fn graphics_updates_keep_geometry_but_layout_changes_do_not() {
        let mut a = request().projection;
        a.root.styles=serde_json::from_value(serde_json::json!({"position":"relative","width":1280,"height":720,"background":"#000"})).unwrap();
        a.root.children[0].styles = serde_json::from_value(
            serde_json::json!({"position":"absolute","left":10,"top":20,"width":300,"height":200}),
        )
        .unwrap();
        let mut b = a.clone();
        b.root
            .styles
            .insert("background".into(), serde_json::json!("#fff"));
        assert_eq!(geometry_key(&a), geometry_key(&b));
        b.root.children[0]
            .styles
            .insert("left".into(), serde_json::json!(100));
        assert_ne!(geometry_key(&a), geometry_key(&b));
        b.root
            .styles
            .insert("position".into(), serde_json::json!("static"));
        assert!(geometry_key(&b).is_none());
    }
    #[test]
    fn compact_assets_hydrate_only_with_the_same_lease() {
        let mut previous = request();
        previous.projection.assets.insert(
            "picture".into(),
            Asset {
                name: "pixel.png".into(),
                mime: "image/png".into(),
                data: Arc::new("data:image/png;base64,AAAA".into()),
            },
        );
        let mut compact = request();
        compact.lease = previous.lease.clone();
        hydrate(&mut compact, &previous);
        assert_eq!(compact.projection.assets.len(), 1);
        let mut other = request();
        other.lease = uuid::Uuid::new_v4().to_string();
        hydrate(&mut other, &previous);
        assert!(other.projection.assets.is_empty());
    }
    #[test]
    fn publishing_the_same_revision_still_advances_the_render_serial() {
        let bridge = Bridge::start(request().projection).unwrap();
        assert_eq!(bridge.state.lock().unwrap().serial, 0);
        bridge.publish(request().projection);
        assert_eq!(bridge.state.lock().unwrap().serial, 1);
        assert!(bridge.ready().is_none());
        bridge.revoke();
    }
    #[test]
    fn media_transport_roundtrips_and_rejects_invalid_clocks() {
        let t: MediaTransport =
            serde_json::from_str(r#"{"playing":true,"positionMs":1200,"anchorMs":100000}"#)
                .unwrap();
        let value = serde_json::to_value(&t).unwrap();
        assert_eq!(value["positionMs"], 1200.0);
        let mut r = request();
        r.projection.root.playback = Some(t);
        assert!(
            validate(&r).is_err(),
            "transport belongs only to media nodes"
        );
        assert!(serde_json::from_str::<MediaTransport>(
            r#"{"playing":true,"positionMs":0,"anchorMs":1,"script":"bad"}"#
        )
        .is_err());
    }
    #[test]
    fn decorative_compositing_accepts_graphics_but_rejects_video_ancestors() {
        let mut r = request();
        r.projection.root.children.push(serde_json::from_value(serde_json::json!({"id":"material","type":"box","styles":{"filter":"blur(16px)","mixBlendMode":"screen","clipPath":"ellipse(48% 42% at 50% 50%)","fontFamily":"Avenir Next, sans-serif"},"children":[]})).unwrap());
        validate(&r).unwrap();
        for key in ["filter", "mixBlendMode", "clipPath"] {
            let mut invalid = r.clone();
            invalid
                .projection
                .root
                .styles
                .insert(key.into(), serde_json::json!("none"));
            assert!(validate(&invalid).is_err());
        }
    }
    #[test]
    fn bounds_bindings_and_resources_are_checked_before_native_allocation() {
        let base = request();
        validate(&base).unwrap();
        let mut r = base.clone();
        r.projection
            .root
            .children
            .push(r.projection.root.children[0].clone());
        assert!(validate(&r).is_err());
        let mut r = base.clone();
        r.bindings.insert("unknown".into(), "camera".into());
        assert!(validate(&r).is_err());
        let mut r = base.clone();
        r.projection
            .root
            .styles
            .insert("background".into(), Value::from("url(https://example.com)"));
        assert!(validate(&r).is_err());
        let mut r = base.clone();
        r.projection
            .root
            .styles
            .insert("transform".into(), Value::from("rotate(20deg)"));
        assert!(validate(&r).is_err());
        let mut r = base;
        r.projection.css = "@import 'https://example.com';".into();
        assert!(validate(&r).is_err());
    }
    fn http(
        bridge: &Bridge,
        method: &str,
        path: &str,
        host: &str,
        origin: Option<&str>,
        body: &str,
    ) -> String {
        let addr = bridge.origin.trim_start_matches("http://");
        let mut stream = TcpStream::connect(addr).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let origin = origin
            .map(|o| format!("Origin: {o}\r\n"))
            .unwrap_or_default();
        stream.write_all(format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\n{origin}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).unwrap();
        let mut response = String::new();
        let _ = stream.read_to_string(&mut response);
        response
    }
    #[test]
    fn private_bridge_accepts_a_request_after_connect() {
        let bridge = Bridge::start(request().projection).unwrap();
        let host = bridge.origin.trim_start_matches("http://");
        let mut stream = TcpStream::connect(host).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        // Chromium preconnects before writing the navigation request. The
        // nonblocking listener must not make that pause look like EOF.
        std::thread::sleep(Duration::from_millis(100));
        stream
            .write_all(
                format!(
                    "GET /{}/background HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n",
                    bridge.token
                )
                .as_bytes(),
            )
            .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 200"));
        bridge.revoke();
    }
    #[test]
    fn private_bridge_is_scoped_bounded_and_revocable() {
        let bridge = Bridge::start(request().projection).unwrap();
        let host = bridge.origin.trim_start_matches("http://");
        let route = format!("/{}/foreground", bridge.token);
        let page = http(&bridge, "GET", &route, host, None, "");
        assert!(page.starts_with("HTTP/1.1 200"));
        assert!(page.contains("sandbox=\"allow-scripts\""));
        assert!(page.contains("camera 'none'"));
        assert!(!page.contains("__TAURI_INTERNALS__"));
        assert!(http(&bridge, "GET", &route, "evil.example", None, "").starts_with("HTTP/1.1 404"));
        assert!(http(
            &bridge,
            "GET",
            &route,
            host,
            Some("https://evil.example"),
            ""
        )
        .starts_with("HTTP/1.1 404"));
        assert!(http(&bridge, "GET", "/foreground", host, None, "").starts_with("HTTP/1.1 404"));
        assert!(
            http(&bridge, "POST", &route, host, Some(&bridge.origin), "{}")
                .starts_with("HTTP/1.1 404")
        );
        let ready = format!("/{}/ready", bridge.token);
        for surface in ["background", "foreground"] {
            let data=serde_json::json!({"revision":1,"width":1280,"height":720,"surface":surface,"slots":[]}).to_string();
            assert!(
                http(&bridge, "POST", &ready, host, Some(&bridge.origin), &data)
                    .starts_with("HTTP/1.1 204")
            );
        }
        assert!(bridge.wait().unwrap().is_empty());
        bridge.revoke();
        assert!(bridge.wait().is_err());
    }
}
