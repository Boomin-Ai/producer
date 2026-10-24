//! Strict development transport for compiled v2 graphs, independent of Tauri.
//! Definitions/data are compiled upstream; native code independently validates
//! geometry, paint and resource identities before resolving any room source.
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Bounds {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Properties {
    pub text: Option<String>,
    pub color: Option<String>,
    pub background: Option<String>,
    pub opacity: Option<f32>,
    pub visible: Option<bool>,
    pub rotation: Option<f32>,
    pub scale: Option<f32>,
    pub font_size: Option<f32>,
    pub font_weight: Option<f32>,
    pub align: Option<String>,
    pub scale_x: Option<f32>,
    pub scale_y: Option<f32>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Mask {
    pub kind: String,
    pub radius: f32,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Appearance {
    pub shape: String,
    pub corner_radius: f32,
    pub outline_width: f32,
    pub outline_color: String,
    pub grayscale: f32,
    pub opacity: f32,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Framing {
    pub mode: String,
    pub x: f32,
    pub y: f32,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Node {
    pub id: String,
    pub kind: String,
    pub bounds: Bounds,
    pub properties: Properties,
    pub resource: Option<String>,
    pub fit: Option<String>,
    pub mask: Option<Mask>,
    pub isolate: Option<bool>,
    pub children: Vec<Node>,
    pub paint: Option<HashMap<String, serde_json::Value>>,
    pub appearance: Option<Appearance>,
    pub framing: Option<Framing>,
    pub playback: Option<Playback>,
    pub looping: Option<bool>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub id: String,
    pub orientation: String,
    pub width: u32,
    pub height: u32,
    pub scaling: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Viewport {
    pub scale_x: f32,
    pub scale_y: f32,
    pub offset_x: f32,
    pub offset_y: f32,
    pub clip: Bounds,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Clock {
    pub running: bool,
    pub position_ms: f64,
    pub segment_ms: f64,
    pub anchor_ms: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Asset {
    pub name: String,
    pub mime: String,
    pub data: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Shader {
    pub effect: String,
    pub colors: Vec<String>,
    pub speed: f32,
    pub intensity: f32,
    pub scale: f32,
    pub opacity: f32,
    pub radius: f32,
    pub quality: String,
    pub clock: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Playback {
    pub playing: bool,
    pub position_ms: f64,
    pub anchor_ms: f64,
    pub resume_after_pause: Option<bool>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Keyframe {
    pub at_ms: f64,
    pub value: f32,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Track {
    pub target: String,
    pub property: String,
    pub keyframes: Vec<Keyframe>,
    pub easing: Option<String>,
    pub clock: Option<String>,
    pub delay_ms: Option<f64>,
    pub r#loop: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Plan {
    pub definition_id: String,
    pub definition_revision: u64,
    pub instance_id: String,
    pub canvas_id: String,
    pub target: Target,
    pub viewport: Viewport,
    pub root: Node,
    pub resources: Vec<String>,
    #[serde(default)]
    pub assets: HashMap<String, Asset>,
    #[serde(default)]
    pub shaders: HashMap<String, Shader>,
    pub clock: Option<Clock>,
    #[serde(default)]
    pub motion: Vec<Track>,
    #[serde(default)]
    pub retained_targets:Vec<String>,
}
#[derive(Debug, Deserialize)]
#[serde(
    tag = "op",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Action {
    Prepare {
        generation: u64,
        output_id: Option<String>,
        revision: u64,
        plan: Plan,
    },
    Preload {
        generation:u64, output_id:Option<String>, revision:u64, key:String, plan:Plan,
    },
    Activate {
        generation:u64, output_id:Option<String>, revision:u64, key:String, plan:Plan,
    },
    Retain {
        generation:u64, output_id:Option<String>, keys:Vec<String>,
    },
    Take {
        generation: u64,
        output_id: Option<String>,
        revision: u64,
        duration_ms: f64,
        mode: String,
    },
    Cancel {
        generation: u64,
        output_id: Option<String>,
        revision: u64,
    },
    Status {
        generation: u64,
        output_id: Option<String>,
    },
    Pause {
        generation: u64,
        output_id: Option<String>,
        paused: bool,
    },
    Return {
        generation: u64,
        output_id: Option<String>,
    },
}
impl Action {
    pub fn output(&self) -> &str {
        match self {
            Self::Prepare { output_id, .. }
            | Self::Preload { output_id, .. } | Self::Activate { output_id, .. } | Self::Retain { output_id, .. }
            | Self::Take { output_id, .. }
            | Self::Cancel { output_id, .. }
            | Self::Status { output_id, .. }
            | Self::Pause { output_id, .. }
            | Self::Return { output_id, .. } => output_id.as_deref().unwrap_or("program"),
        }
    }
    pub fn generation(&self) -> u64 {
        match self {
            Self::Prepare { generation, .. }
            | Self::Preload { generation, .. } | Self::Activate { generation, .. } | Self::Retain { generation, .. }
            | Self::Take { generation, .. }
            | Self::Cancel { generation, .. }
            | Self::Status { generation, .. }
            | Self::Pause { generation, .. }
            | Self::Return { generation, .. } => *generation,
        }
    }
}
#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub cached_keys:Vec<String>,
    pub cached_bytes:usize,
    pub generation: u64,
    pub prepared_revision: u64,
    pub rendered_revision: u64,
    pub render_serial: u64,
    pub clock_ms: f64,
    pub transition_progress: f64,
    pub warmed: bool,
    pub ready: bool,
    pub queued: bool,
    pub transitioning: bool,
    pub paused: bool,
}
pub fn identity(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.as_bytes()[0].is_ascii_alphabetic()
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        && !["constructor", "prototype", "__proto__"].contains(&s)
}
pub fn hex(s: &str) -> bool {
    (s.len() == 7 || s.len() == 9)
        && s.starts_with('#')
        && s[1..].bytes().all(|c| c.is_ascii_hexdigit())
}
fn number(n: f32, min: f32, max: f32) -> bool {
    n.is_finite() && n >= min && n <= max
}
fn bounds(b: &Bounds) -> bool {
    number(b.x, -16384., 16384.)
        && number(b.y, -16384., 16384.)
        && number(b.width, 0., 8192.)
        && number(b.height, 0., 8192.)
}
pub fn validate(plan: &Plan) -> Result<(), String> {
    if plan.retained_targets.len()>128||plan.retained_targets.iter().any(|id|!identity(id)){return Err("Invalid retained motion targets".into());}

    if ![
        &plan.definition_id,
        &plan.instance_id,
        &plan.canvas_id,
        &plan.target.id,
    ]
    .iter()
    .all(|id| identity(id))
        || plan.definition_revision == 0
        || plan.definition_revision > 9_007_199_254_740_991
        || !["portrait", "landscape"].contains(&plan.target.orientation.as_str())
        || !["contain", "cover", "stretch"].contains(&plan.target.scaling.as_str())
        || plan.target.width == 0
        || plan.target.height == 0
        || plan.target.width > 8192
        || plan.target.height > 8192
        || plan.root.kind != "group"
        || plan.root.bounds.x != 0.
        || plan.root.bounds.y != 0.
        || plan.root.bounds.width < 1.
        || plan.root.bounds.height < 1.
    {
        return Err("Invalid native v2 canvas request".into());
    }
    if plan.assets.len() > 24 || plan.shaders.len() > 32 {
        return Err("Set resource budget exceeded".into());
    }
    if let Some(c) = &plan.clock {
        if ![c.position_ms, c.segment_ms, c.anchor_ms]
            .iter()
            .all(|v| v.is_finite() && *v >= 0.)
            || c.position_ms > 86400000.
            || c.segment_ms > 86400000.
        {
            return Err("Invalid set clock".into());
        }
    }
    for (key, a) in &plan.assets {
        if !identity(key)
            || a.name.len() > 160
            || a.data.len() > 24 * 1024 * 1024
            || ![
                "image/png",
                "image/jpeg",
                "image/webp",
                "image/gif",
                "video/mp4",
                "video/webm",
                "video/quicktime",
            ]
            .contains(&a.mime.as_str())
        {
            return Err("Invalid embedded media resource".into());
        }
    }
    for (key, s) in &plan.shaders {
        if !identity(key)
            || ![
                "aurora",
                "edgeGlow",
                "lightSweep",
                "plasma",
                "silk",
                "rings",
                "grid",
                "stars",
                "petals",
                "contours",
                "prism",
                "borderFlare",
            ]
            .contains(&s.effect.as_str())
            || s.colors.len() != 3
            || s.colors.iter().any(|c| c.len() != 7 || !hex(c))
            || !number(s.speed, 0., 4.)
            || !number(s.intensity, 0., 2.)
            || !number(s.scale, 0.25, 4.)
            || !number(s.opacity, 0., 1.)
            || !number(s.radius, 0., 960.)
            || !["low", "medium"].contains(&s.quality.as_str())
            || !["show", "segment"].contains(&s.clock.as_str())
        {
            return Err("Invalid native material".into());
        }
    }
    let mut ids = HashSet::new();
    let mut resources = HashSet::new();
    fn walk(
        n: &Node,
        depth: usize,
        ids: &mut HashSet<String>,
        resources: &mut HashSet<String>,
    ) -> Result<(), String> {
        if depth > 12
            || ids.len() >= 128
            || !identity(&n.id)
            || !ids.insert(n.id.clone())
            || !bounds(&n.bounds)
        {
            return Err("Invalid native v2 node identity/geometry/budget".into());
        }
        let p = &n.properties;
        if p.opacity.is_some_and(|v| !number(v, 0., 1.))
            || p.font_size.is_some_and(|v| !number(v, 1., 1024.))
            || p.font_weight.is_some_and(|v| !number(v, 100., 1000.))
            || p.text.as_ref().is_some_and(|v| v.len() > 16384)
            || [&p.color, &p.background]
                .iter()
                .any(|v| v.as_ref().is_some_and(|v| !hex(v)))
            || p.align
                .as_ref()
                .is_some_and(|v| !["left", "center", "right"].contains(&v.as_str()))
            || p.rotation.is_some_and(|v| !number(v, -36000., 36000.))
            || p.scale.is_some_and(|v| !number(v, 0.01, 32.))
            || p.scale_x.is_some_and(|v| !number(v, 0.01, 32.))
            || p.scale_y.is_some_and(|v| !number(v, 0.01, 32.))
        {
            return Err("Invalid or unsupported native v2 style/transform".into());
        }
        if let Some(a) = &n.appearance {
            if n.kind != "source"
                || !["rectangle", "circle"].contains(&a.shape.as_str())
                || !number(a.corner_radius, 0., 960.)
                || !number(a.outline_width, 0., 64.)
                || a.outline_color.len() != 7
                || !hex(&a.outline_color)
                || !number(a.grayscale, 0., 1.)
                || !number(a.opacity, 0., 1.)
            {
                return Err("Invalid source placement appearance".into());
            }
        }
        if let Some(f) = &n.framing {
            if n.kind != "source"
                || !["fill", "fit"].contains(&f.mode.as_str())
                || !number(f.x, 0., 1.)
                || !number(f.y, 0., 1.)
            {
                return Err("Invalid source framing".into());
            }
        }
        if let Some(paint) = &n.paint {
            if !["text", "graphic"].contains(&n.kind.as_str()) {
                return Err("Native media cannot accept graphics paint styles".into());
            }
            validate_paint(paint)?;
        }
        if let Some(m) = &n.mask {
            if m.kind != "rounded" || !number(m.radius, 0., 8192.) {
                return Err("Invalid v2 mask".into());
            }
        }
        let _ = n.isolate;
        match n.kind.as_str() {
            "group" => {
                if n.resource.is_some() || n.fit.is_some() || n.children.len() > 128 {
                    return Err("Invalid v2 group".into());
                }
                for child in &n.children {
                    walk(child, depth + 1, ids, resources)?;
                }
            }
            "source" | "graphic" | "text" | "asset" | "shader" => {
                if !n.children.is_empty() || n.mask.is_some() {
                    return Err("Invalid v2 leaf".into());
                }
                if n.kind == "source" {
                    let resource = n.resource.as_ref().ok_or("Missing source identity")?;
                    if !identity(resource)
                        || !n
                            .fit
                            .as_ref()
                            .is_some_and(|v| ["contain", "cover"].contains(&v.as_str()))
                    {
                        return Err("Invalid room source binding".into());
                    }
                    resources.insert(resource.clone());
                } else if n.kind == "graphic" {
                    if n.fit.is_some() {
                        return Err("Graphic fit is unsupported".into());
                    }
                    let resource = n.resource.as_ref().ok_or("Missing graphic identity")?;
                    if !resource.strip_prefix("graphic:").is_some_and(identity) {
                        return Err("Invalid graphic identity".into());
                    }
                    resources.insert(resource.clone());
                } else if n.kind == "asset" || n.kind == "shader" {
                    let r = n.resource.as_ref().ok_or("Missing set resource")?;
                    let prefix = if n.kind == "asset" {
                        "asset:"
                    } else {
                        "shader:"
                    };
                    if !r.strip_prefix(prefix).is_some_and(identity) {
                        return Err("Invalid set resource identity".into());
                    }
                    if n.kind == "asset"
                        && !n
                            .fit
                            .as_ref()
                            .is_some_and(|v| ["contain", "cover"].contains(&v.as_str()))
                    {
                        return Err("Invalid embedded media fit".into());
                    }
                    resources.insert(r.clone());
                } else if n.resource.is_some() || n.fit.is_some() {
                    return Err("Unexpected text resource".into());
                }
                if let Some(p) = &n.playback {
                    if n.kind != "asset"
                        || ![p.position_ms, p.anchor_ms]
                            .iter()
                            .all(|v| v.is_finite() && *v >= 0.)
                        || p.position_ms > 86400000.
                    {
                        return Err("Invalid native media transport".into());
                    }
                }
            }
            _ => return Err("Unsupported native set node".into()),
        }
        Ok(())
    }
    walk(&plan.root, 0, &mut ids, &mut resources)?;
    if plan.motion.len() > 128 {
        return Err("Native animation track budget exceeded".into());
    }
    let mut tracks = HashSet::new();
    for t in &plan.motion {
        if !ids.contains(&t.target)
            || !tracks.insert((&t.target, &t.property))
            || t.keyframes.len() < 2
            || t.keyframes.len() > 64
            || ![
                "x",
                "y",
                "width",
                "height",
                "opacity",
                "rotation",
                "scale",
                "shader.intensity",
                "shader.scale",
            ]
            .contains(&t.property.as_str())
            || t.clock
                .as_ref()
                .is_some_and(|s| !["show", "segment"].contains(&s.as_str()))
            || t.easing.as_ref().is_some_and(|s| {
                !["linear", "easeIn", "easeOut", "easeInOut"].contains(&s.as_str())
            })
            || t.r#loop
                .as_ref()
                .is_some_and(|s| !["none", "repeat", "pingpong"].contains(&s.as_str()))
            || t.delay_ms
                .is_some_and(|d| !d.is_finite() || d < 0. || d > 60000.)
        {
            return Err("Invalid native animation track".into());
        }
        let mut last = -1.;
        for frame in &t.keyframes {
            let bounds = match t.property.as_str() {
                "opacity" => (0., 1.),
                "scale" => (0.01, 32.),
                "shader.intensity" => (0., 2.),
                "shader.scale" => (0.25, 4.),
                "width" | "height" => (0., 8192.),
                _ => (-16384., 16384.),
            };
            if !frame.at_ms.is_finite()
                || frame.at_ms < 0.
                || frame.at_ms > 60000.
                || frame.at_ms <= last
                || (last < 0. && frame.at_ms != 0.)
                || !number(frame.value, bounds.0, bounds.1)
            {
                return Err("Invalid native animation keyframe".into());
            }
            last = frame.at_ms;
        }
    }
    let declared: HashSet<_> = plan.resources.iter().cloned().collect();
    if declared.len() != plan.resources.len() || declared != resources {
        return Err("V2 resource manifest mismatch".into());
    }
    // Recompute the viewport rather than trusting client-provided transforms.
    let sx = plan.target.width as f32 / plan.root.bounds.width;
    let sy = plan.target.height as f32 / plan.root.bounds.height;
    let ratio = if plan.target.scaling == "cover" {
        sx.max(sy)
    } else {
        sx.min(sy)
    };
    let (sx, sy) = if plan.target.scaling == "stretch" {
        (sx, sy)
    } else {
        (ratio, ratio)
    };
    let v = &plan.viewport;
    let expected = [
        sx,
        sy,
        (plan.target.width as f32 - plan.root.bounds.width * sx) * 0.5,
        (plan.target.height as f32 - plan.root.bounds.height * sy) * 0.5,
        0.,
        0.,
        plan.target.width as f32,
        plan.target.height as f32,
    ];
    let actual = [
        v.scale_x,
        v.scale_y,
        v.offset_x,
        v.offset_y,
        v.clip.x,
        v.clip.y,
        v.clip.width,
        v.clip.height,
    ];
    if expected
        .iter()
        .zip(actual)
        .any(|(a, b)| !b.is_finite() || (*a - b).abs() > 0.01)
    {
        return Err("V2 viewport does not match its canvas".into());
    }
    Ok(())
}
pub fn validate_paint(paint: &HashMap<String, serde_json::Value>) -> Result<(), String> {
    const KEYS: &[&str] = &[
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
        "padding",
        "display",
        "alignItems",
        "justifyContent",
    ];
    if paint.len() > KEYS.len() {
        return Err("Graphics paint budget exceeded".into());
    }
    for (key, value) in paint {
        if !KEYS.contains(&key.as_str()) {
            return Err("Unsupported graphics paint property".into());
        }
        let text = match value {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Number(v) => v.to_string(),
            _ => return Err("Invalid graphics paint value".into()),
        };
        let lower = text.to_ascii_lowercase();
        if text.len() > 512
            || text
                .chars()
                .any(|c| c.is_control() || ";{}<>\\@&".contains(c))
            || [
                "url(",
                "var(",
                "expression(",
                "javascript:",
                "data:",
                "import",
                "!important",
            ]
            .iter()
            .any(|bad| lower.contains(bad))
        {
            return Err("Unsafe graphics paint value".into());
        }
    }
    Ok(())
}
fn paint_css(paint: &HashMap<String, serde_json::Value>) -> Result<String, String> {
    validate_paint(paint)?;
    let mut result = String::new();
    for (key, value) in paint {
        let css_key = key
            .chars()
            .map(|c| {
                if c.is_ascii_uppercase() {
                    format!("-{}", c.to_ascii_lowercase())
                } else {
                    c.to_string()
                }
            })
            .collect::<String>();
        let text = if let Some(s) = value.as_str() {
            s.to_string()
        } else {
            format!(
                "{}{}",
                value,
                if ["fontWeight", "lineHeight"].contains(&key.as_str()) {
                    ""
                } else {
                    "px"
                }
            )
        };
        result.push_str(&format!("{css_key}:{};", escaped(&text)));
    }
    Ok(result)
}
pub fn escaped(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
pub fn graphics_document(
    nodes: &[&Node],
    width: u32,
    height: u32,
    origin: (f32, f32),
    palette: &HashMap<String, String>,
) -> Result<String, String> {
    graphics_document_scaled(nodes,width,height,origin,palette,1.)
}
pub fn graphics_document_scaled(
    nodes:&[&Node],width:u32,height:u32,origin:(f32,f32),
    palette:&HashMap<String,String>,density:f32,
)->Result<String,String>{
    if !density.is_finite() || density<1. || density>8. {return Err("Invalid graphics density".into());}
    let physical_width=(width as f32*density).ceil() as u32;
    let physical_height=(height as f32*density).ceil() as u32;
    let mut html=format!("<!doctype html><meta charset=utf-8><meta http-equiv=Content-Security-Policy content=\"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\"><style>html,body{{margin:0;width:{physical_width}px;height:{}px;overflow:hidden;background:transparent;font-family:Arial,sans-serif}}*{{box-sizing:border-box}}</style><div style=\"position:absolute;left:0;top:0;width:{width}px;height:{height}px;zoom:{density}\">",physical_height+1);
    fn append(n: &Node, origin: (f32,f32), palette: &HashMap<String,String>, html: &mut String) -> Result<(),String> {
        if !["text", "graphic", "group"].contains(&n.kind.as_str()) {
            return Err("Invalid graphics batch".into());
        }
        let b = &n.bounds;
        let p = &n.properties;
        let mut style=format!("position:absolute;overflow:hidden;left:{}px;top:{}px;width:{}px;height:{}px;opacity:{};",b.x-origin.0,b.y-origin.1,b.width,b.height,p.opacity.unwrap_or(1.));
        if p.visible == Some(false) {
            style.push_str("display:none;");
        }
        let text = if n.kind == "group" {
            String::new()
        } else if n.kind == "graphic" {
            let paint = p
                .background
                .as_ref()
                .or_else(|| n.resource.as_ref().and_then(|r| palette.get(r)))
                .ok_or("Unresolved graphic paint")?;
            if !hex(paint) {
                return Err("Invalid graphics paint".into());
            }
            style.push_str(&format!("background:{paint};"));
            String::new()
        } else {
            style.push_str(&format!("color:{};background:{};font-size:{}px;font-weight:{};text-align:{};white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.15;",p.color.as_deref().unwrap_or("#ffffff"),p.background.as_deref().unwrap_or("#00000000"),p.font_size.unwrap_or(32.),p.font_weight.unwrap_or(400.),p.align.as_deref().unwrap_or("left")));
            escaped(p.text.as_deref().unwrap_or(""))
        };
        if let Some(paint) = &n.paint {
            style.push_str(&paint_css(paint)?);
        }
        if let Some(mask) = &n.mask { style.push_str(&format!("border-radius:{}px;",mask.radius)); }
        style.push_str(&format!("transform:rotate({}deg) scale({},{});transform-origin:center;",p.rotation.unwrap_or(0.),p.scale_x.or(p.scale).unwrap_or(1.),p.scale_y.or(p.scale).unwrap_or(1.)));
        html.push_str(&format!("<div style=\"{style}\">{text}"));
        for child in &n.children { append(child,(0.,0.),palette,html)?; }
        html.push_str("</div>");
        Ok(())
    }
    for n in nodes { append(n,origin,palette,&mut html)?; }
    html.push_str("</div>");
    // Reserved extra row is cropped by a native placement wrapper. The marker
    // is painted with the document but is never part of outgoing set pixels.
    html.push_str(&format!("<div style=\"position:absolute;left:0;top:{physical_height}px;width:1px;height:1px;background:#01fe03\"></div>"));
    Ok(html)
}

pub fn clock_positions(clock: Option<&Clock>) -> (f64, f64, bool) {
    clock.map_or((0., 0., true), |c| {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64()
            * 1000.;
        let delta = if c.running {
            (now - c.anchor_ms).max(0.).min(86400000.)
        } else {
            0.
        };
        (
            (c.position_ms + delta).min(86400000.),
            (c.segment_ms + delta).min(86400000.),
            c.running,
        )
    })
}
