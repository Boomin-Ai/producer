//! Strict development transport for compiled v2 graphs, independent of Tauri.
//! Definitions/data are compiled upstream; native code independently validates
//! geometry, paint and resource identities before resolving any room source.
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Bounds {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}
#[derive(Clone, Debug, Deserialize)]
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
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Mask {
    pub kind: String,
    pub radius: f32,
}
#[derive(Clone, Debug, Deserialize)]
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
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub id: String,
    pub orientation: String,
    pub width: u32,
    pub height: u32,
    pub scaling: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Viewport {
    pub scale_x: f32,
    pub scale_y: f32,
    pub offset_x: f32,
    pub offset_y: f32,
    pub clip: Bounds,
}
#[derive(Clone, Debug, Deserialize)]
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
        revision: u64,
        plan: Plan,
    },
    Take {
        generation: u64,
        revision: u64,
        duration_ms: f64,
        mode: String,
    },
    Cancel {
        generation: u64,
        revision: u64,
    },
    Status {
        generation: u64,
    },
    Pause {
        generation: u64,
        paused: bool,
    },
    Return {
        generation: u64,
    },
}
impl Action {
    pub fn generation(&self) -> u64 {
        match self {
            Self::Prepare { generation, .. }
            | Self::Take { generation, .. }
            | Self::Cancel { generation, .. }
            | Self::Status { generation }
            | Self::Pause { generation, .. }
            | Self::Return { generation } => *generation,
        }
    }
}
#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
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
            || p.rotation.is_some_and(|v| v != 0.)
            || p.scale.is_some_and(|v| v != 1.)
        {
            return Err("Invalid or unsupported native v2 style/transform".into());
        }
        if let Some(m) = &n.mask {
            if m.kind != "rounded" || !number(m.radius, 0., 8192.) {
                return Err("Invalid v2 mask".into());
            }
        }
        let _ = n.isolate;
        match n.kind.as_str(){
            "group"=>{
                if n.resource.is_some() || n.fit.is_some() || n.children.len()>128{return Err("Invalid v2 group".into());}
                for child in &n.children{walk(child,depth+1,ids,resources)?;}
            },
            "source"|"graphic"|"text"=>{
                if !n.children.is_empty() || n.mask.is_some(){return Err("Invalid v2 leaf".into());}
                if n.kind=="source" {
                    let resource=n.resource.as_ref().ok_or("Missing source identity")?;
                    if !identity(resource) || !n.fit.as_ref().is_some_and(|v|["contain","cover"].contains(&v.as_str())) {return Err("Invalid room source binding".into());}
                    resources.insert(resource.clone());
                }else if n.kind=="graphic" {
                    if n.fit.is_some(){return Err("Graphic fit is unsupported".into());}
                    let resource=n.resource.as_ref().ok_or("Missing graphic identity")?;
                    if !resource.strip_prefix("graphic:").is_some_and(identity){return Err("Invalid graphic identity".into());}
                    resources.insert(resource.clone());
                }else if n.resource.is_some() || n.fit.is_some(){return Err("Unexpected text resource".into());}
            },
            _=>return Err("This dev adapter supports groups, room sources and graphics; assets/shaders await the resource service".into()),
        }
        Ok(())
    }
    walk(&plan.root, 0, &mut ids, &mut resources)?;
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
    let mut html=format!("<!doctype html><meta charset=utf-8><meta http-equiv=Content-Security-Policy content=\"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\"><style>html,body{{margin:0;width:{width}px;height:{}px;overflow:hidden;background:transparent;font-family:Arial,sans-serif}}*{{box-sizing:border-box}}</style>",height+1);
    for n in nodes {
        if !["text", "graphic"].contains(&n.kind.as_str()) {
            return Err("Invalid graphics batch".into());
        }
        let b = &n.bounds;
        let p = &n.properties;
        let mut style=format!("position:absolute;overflow:hidden;left:{}px;top:{}px;width:{}px;height:{}px;opacity:{};",b.x-origin.0,b.y-origin.1,b.width,b.height,p.opacity.unwrap_or(1.));
        if p.visible == Some(false) {
            style.push_str("display:none;");
        }
        let text = if n.kind == "graphic" {
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
        html.push_str(&format!("<div style=\"{style}\">{text}</div>"));
    }
    // Reserved extra row is cropped by a native placement wrapper. The marker
    // is painted with the document but is never part of outgoing set pixels.
    html.push_str(&format!("<div style=\"position:absolute;left:0;top:{height}px;width:1px;height:1px;background:#01fe03\"></div>"));
    Ok(html)
}
