//! Off-callback compilation; frame evaluation consumes only numeric handles/keys.
use crate::contract::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum CompactValue {
    Number(f64),
    Vec3([f64; 3]),
    Bool(bool),
    Color([u8; 4]),
}
impl CompactValue {
    pub fn from_value(v: &Value) -> Result<Self> {
        Ok(match v {
            Value::Number(n) => Self::Number(*n),
            Value::Vec3(n) => Self::Vec3(*n),
            Value::Bool(b) => Self::Bool(*b),
            Value::Color(s) if validate::color(s) => {
                let n = u32::from_str_radix(&s[1..], 16).unwrap();
                Self::Color([(n >> 16) as u8, (n >> 8) as u8, n as u8, 255])
            }
            _ => {
                return Err(Error::new(
                    "UNSUPPORTED",
                    "value",
                    "text interpolation is not a first-profile target",
                ))
            }
        })
    }
    fn interpolate(a: Self, b: Self, t: f64) -> Self {
        match (a, b) {
            (Self::Number(a), Self::Number(b)) => Self::Number(a * (1.0 - t) + b * t),
            (Self::Vec3(a), Self::Vec3(b)) => {
                Self::Vec3(std::array::from_fn(|i| a[i] * (1.0 - t) + b[i] * t))
            }
            _ => a,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodePlan {
    pub path: String,
    pub frame: Rect,
    pub kind: String,
    pub source: Option<String>,
    pub bound: Vec<(Property, CompactValue)>,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct Sample {
    pub target: usize,
    pub value: CompactValue,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackPlan {
    pub id: String,
    pub target: usize,
    pub range: Range,
    pub keys: Vec<(Time, CompactValue)>,
    pub interpolation: Interpolation,
    pub maps: Vec<temporal::TimeMap>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayerPlan {
    pub path: String,
    pub source: String,
    pub range: Range,
    pub maps: Vec<temporal::TimeMap>,
    pub available: Option<Range>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CuePlan {
    pub path: String,
    pub cue: Cue,
    pub maps: Vec<temporal::TimeMap>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SequencePlan {
    pub duration: Time,
    pub tracks: Vec<TrackPlan>,
    pub players: Vec<PlayerPlan>,
    pub cues: Vec<CuePlan>,
    pub routes: Vec<AudioRoute>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Plan {
    pub digest: String,
    pub nodes: Vec<NodePlan>,
    pub targets: Vec<Target>,
    pub sequences: BTreeMap<String, SequencePlan>,
    pub inventory: Inventory,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvalError {
    ScratchTooSmall,
    TimeRange,
}
impl SequencePlan {
    /// Caller allocates scratch off-callback. No strings, JSON, IO, locks or allocations here.
    pub fn evaluate_into(
        &self,
        t: Time,
        out: &mut [Option<Sample>],
    ) -> std::result::Result<(), EvalError> {
        if out.len() < self.tracks.len() {
            return Err(EvalError::ScratchTooSmall);
        }
        if t < Time::ZERO || t > self.duration {
            return Err(EvalError::TimeRange);
        }
        out.fill(None);
        for (slot, track) in out.iter_mut().zip(&self.tracks) {
            *slot = None;
            let Some(t) = temporal::map_chain(&track.maps, t).map_err(|_| EvalError::TimeRange)?
            else {
                continue;
            };
            // Half-open track; its endpoint remains a key, not an extra active frame.
            if t < track.range.start || t >= track.range.end().map_err(|_| EvalError::TimeRange)? {
                continue;
            }
            let next = track.keys.partition_point(|(at, _)| *at <= t);
            let (a, av) = track.keys[next.saturating_sub(1)];
            let value = if track.interpolation == Interpolation::Step || next == track.keys.len() {
                av
            } else {
                let (b, bv) = track.keys[next];
                // All products fit i128 under the validated i64/u32 time profile.
                let n = (t.ticks() as i128 * a.rate() as i128
                    - a.ticks() as i128 * t.rate() as i128)
                    * b.rate() as i128;
                let d = (b.ticks() as i128 * a.rate() as i128
                    - a.ticks() as i128 * b.rate() as i128)
                    * t.rate() as i128;
                CompactValue::interpolate(av, bv, (n as f64 / d as f64).clamp(0.0, 1.0))
            };
            *slot = Some(Sample {
                target: track.target,
                value,
            });
        }
        Ok(())
    }
}
impl PlayerPlan {
    /// Live capture remains live; None available means this is only a visibility
    /// gate. A file's returned time is source PTS, not the parent's content clock.
    pub fn sample(&self, root: Time) -> std::result::Result<Option<Time>, EvalError> {
        let Some(local) =
            temporal::map_chain(&self.maps, root).map_err(|_| EvalError::TimeRange)?
        else {
            return Ok(None);
        };
        if self.available.is_some() {
            Ok(Some(local))
        } else {
            let end =
                temporal::add(self.range.start, self.range.duration).ok_or(EvalError::TimeRange)?;
            Ok((local >= self.range.start && local < end).then_some(Time::ZERO))
        }
    }
}
fn bad(p: &str, m: &str) -> Error {
    Error::new("LAYOUT", p, m)
}
fn allocation(sizes: &[Size], available: f64) -> Result<Vec<f64>> {
    if !available.is_finite() || available < 0.0 {
        return Err(bad("allocation", "negative/nonfinite available space"));
    }
    let mut out = vec![0.0; sizes.len()];
    let mut pending = Vec::new();
    let mut remaining = available;
    for (i, s) in sizes.iter().enumerate() {
        match s {
            Size::Fixed { pixels } => {
                out[i] = *pixels;
                remaining -= pixels;
            }
            Size::Weight { .. } => pending.push(i),
        }
    }
    if remaining < 0.0 {
        return Err(bad("allocation", "fixed children exceed parent"));
    }
    // Each pass fixes at least one clamped child or completes. Bounded by children+1.
    for _ in 0..=sizes.len() {
        if pending.is_empty() {
            if remaining.abs() > 0.000001 {
                return Err(bad("allocation", "constraints cannot fill available space"));
            }
            return Ok(out);
        }
        let sum: f64 = pending
            .iter()
            .map(|i| match sizes[*i] {
                Size::Weight { weight, .. } => weight,
                _ => 0.0,
            })
            .sum();
        let bounded_total: f64 = pending
            .iter()
            .map(|i| match sizes[*i] {
                Size::Weight { weight, min, max } => (remaining * weight / sum).clamp(min, max),
                _ => 0.0,
            })
            .sum();
        let freeze_min = bounded_total > remaining;
        let mut fixed = Vec::new();
        for i in &pending {
            if let Size::Weight { weight, min, max } = sizes[*i] {
                let value = remaining * weight / sum;
                let bounded = value.clamp(min, max);
                if (freeze_min && value < min) || (!freeze_min && value > max) {
                    out[*i] = bounded;
                    fixed.push(*i);
                }
            }
        }
        if fixed.is_empty() {
            for i in pending {
                if let Size::Weight { weight, .. } = sizes[i] {
                    out[i] = remaining * weight / sum;
                }
            }
            return Ok(out);
        }
        for i in &fixed {
            remaining -= out[*i];
        }
        if remaining < -0.000001 {
            return Err(bad("allocation", "minimum sizes exceed parent"));
        }
        pending.retain(|i| !fixed.contains(i));
    }
    Err(bad("allocation", "bounded redistribution exhausted"))
}
fn children(n: &Node, r: Rect) -> Result<Vec<Rect>> {
    let count = n.children.len();
    if count == 0 {
        return Ok(vec![]);
    }
    match &n.flow {
        Flow::Overlay => n
            .children
            .iter()
            .map(|c| {
                let f = c.frame.ok_or_else(|| bad(&n.id, "child frame missing"))?;
                Ok(Rect {
                    x: r.x + f.x,
                    y: r.y + f.y,
                    ..f
                })
            })
            .collect(),
        Flow::Row { gap, sizes } | Flow::Column { gap, sizes } => {
            let row = matches!(n.flow, Flow::Row { .. });
            let available = (if row { r.width } else { r.height }) - gap * (count - 1) as f64;
            let lengths = allocation(sizes, available)?;
            let mut offset = 0.0;
            let mut out = Vec::with_capacity(count);
            for size in lengths {
                if size <= 0.0 {
                    return Err(bad(&n.id, "empty allocated child"));
                }
                out.push(if row {
                    Rect {
                        x: r.x + offset,
                        y: r.y,
                        width: size,
                        height: r.height,
                    }
                } else {
                    Rect {
                        x: r.x,
                        y: r.y + offset,
                        width: r.width,
                        height: size,
                    }
                });
                offset += size + gap;
            }
            Ok(out)
        }
        Flow::Grid { gap, columns } => {
            let cols = *columns as usize;
            let rows = count.div_ceil(cols);
            let width = (r.width - gap * (cols - 1) as f64) / cols as f64;
            let height = (r.height - gap * (rows - 1) as f64) / rows as f64;
            if width <= 0.0 || height <= 0.0 {
                return Err(bad(&n.id, "grid gaps exceed parent"));
            }
            Ok((0..count)
                .map(|i| Rect {
                    x: r.x + (i % cols) as f64 * (width + gap),
                    y: r.y + (i / cols) as f64 * (height + gap),
                    width,
                    height,
                })
                .collect())
        }
    }
}
fn raster(r: Rect) -> Rect {
    let x = r.x.round_ties_even();
    let y = r.y.round_ties_even();
    Rect {
        x,
        y,
        width: (r.x + r.width).round_ties_even() - x,
        height: (r.y + r.height).round_ties_even() - y,
    }
}
fn expand(
    d: &Document,
    n: &Node,
    path: &str,
    r: Rect,
    props: &BTreeMap<String, Value>,
    out: &mut Vec<NodePlan>,
) -> Result<()> {
    let path = format!("{path}/{}", n.id);
    let kind = match &n.content {
        Content::Group => "group",
        Content::Text { .. } => "text",
        Content::Source { .. } => "source",
        Content::Component { .. } => "component",
    };
    let snapped = raster(r);
    if snapped.width <= 0.0 || snapped.height <= 0.0 {
        return Err(bad(&path, "subpixel box has no raster footprint"));
    }
    let bound = n
        .bindings
        .iter()
        .map(|b| {
            Ok((
                b.property,
                CompactValue::from_value(&validate::evaluate(&b.expression, props, &mut 256)?)?,
            ))
        })
        .collect::<Result<_>>()?;
    out.push(NodePlan {
        path: path.clone(),
        frame: snapped,
        kind: kind.into(),
        source: if let Content::Source { source, .. } = &n.content {
            Some(source.clone())
        } else {
            None
        },
        bound,
    });
    if let Content::Component {
        definition,
        props: overrides,
        ..
    } = &n.content
    {
        let component = &d.components[definition];
        let mut p = component.props.clone();
        p.extend(overrides.clone());
        expand(d, &component.root, &path, r, &p, out)?;
    }
    for (child, rect) in n.children.iter().zip(children(n, r)?) {
        expand(d, child, &path, rect, props, out)?;
    }
    Ok(())
}
pub fn compile(d: &Document) -> Result<Plan> {
    let inventory = validate_document(d)?;
    let targets: Vec<_> = inventory.targets.iter().cloned().collect();
    let handles: BTreeMap<_, _> = targets
        .iter()
        .cloned()
        .enumerate()
        .map(|(i, t)| (t, i))
        .collect();
    let mut nodes = Vec::with_capacity(inventory.expanded_nodes);
    for (sid, set) in &d.sets {
        for (lid, l) in &set.layouts {
            expand(
                d,
                &l.root,
                &format!("sets/{sid}/layouts/{lid}"),
                l.root.frame.unwrap(),
                &BTreeMap::new(),
                &mut nodes,
            )?;
        }
    }
    let mut sequences = BTreeMap::new();
    let mut temporal_work = TEMPORAL_WORK;
    for (id, s) in &d.sequences {
        let expanded = temporal::expand(d, id, &mut temporal_work)?;
        let mut tracks = Vec::new();
        for resolved in expanded.tracks {
            let t = resolved.template;
            tracks.push(TrackPlan {
                id: resolved.path,
                target: handles[&resolved.target],
                range: t.range,
                interpolation: t.interpolation,
                maps: resolved.maps,
                keys: t
                    .keys
                    .iter()
                    .map(|k| Ok((k.at, CompactValue::from_value(&k.value)?)))
                    .collect::<Result<_>>()?,
            });
        }
        let mut players = Vec::new();
        for p in expanded.players {
            let mut maps = p.maps;
            let available = if let Source::Player { asset } = &d.sources[&p.source] {
                d.assets[asset].available
            } else {
                None
            };
            if let Some(source_range) = available {
                maps.push(temporal::TimeMap {
                    range: p.template.range,
                    source_range,
                    source_in: p.template.source_in,
                    speed: p.template.speed,
                    looping: p.template.looping,
                });
            }
            players.push(PlayerPlan {
                path: p.path,
                source: p.source,
                range: p.template.range,
                maps,
                available,
            });
        }
        let mut routes = Vec::new();
        let mut routed = std::collections::BTreeSet::new();
        for route in expanded.routes {
            if routed.insert((route.source.clone(), route.bus)) {
                routes.push(route);
            }
        }
        sequences.insert(
            id.clone(),
            SequencePlan {
                duration: s.duration,
                tracks,
                players,
                cues: expanded
                    .cues
                    .into_iter()
                    .map(|c| CuePlan {
                        path: c.path,
                        cue: c.template.clone(),
                        maps: c.maps,
                    })
                    .collect(),
                routes,
            },
        );
    }
    Ok(Plan {
        digest: digest(d)?,
        nodes,
        targets,
        sequences,
        inventory,
    })
}
