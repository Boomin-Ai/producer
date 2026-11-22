//! Off-callback compilation; frame evaluation consumes only numeric handles/keys.
use crate::{
    contract::*,
    layout::{self, Geometry, ResolvedAspect},
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::Arc};

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
    pub style: Option<SurfaceStyle>,
    pub frame: Rect,
    pub pivot: UnitPoint,
    pub aspect: Option<ResolvedAspect>,
    pub kind: String,
    pub source: Option<String>,
    pub fit: Option<Fit>,
    pub font: Option<Digest>,
    pub text: Option<String>,
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
    pub effects: Vec<crate::analytic::EffectPlan>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Plan {
    pub analytic_sources: BTreeMap<String, crate::analytic::AnalyticSourcePlan>,
    pub geometry_digest: Digest,
    pub layout_inputs: Arc<LayoutInputs>,
    pub digest: String,
    pub nodes: Vec<Arc<NodePlan>>,
    pub targets: Vec<Target>,
    pub sequences: BTreeMap<String, Arc<SequencePlan>>,
    pub inventory: Inventory,
    pub dependencies: Arc<crate::dependencies::DependencyPlan>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvalError {
    ScratchTooSmall,
    TimeRange,
}
impl SequencePlan {
    /// Slots follow compiled placement order. A failed frame must be discarded
    /// as a whole, just like numeric evaluation. No cue/action is dispatched.
    pub fn evaluate_effects_into(
        &self,
        t: Time,
        out: &mut [Option<crate::analytic::EffectInputs>],
    ) -> std::result::Result<(), EvalError> {
        if out.len() < self.effects.len() {
            return Err(EvalError::ScratchTooSmall);
        }
        if t < Time::ZERO || t > self.duration {
            return Err(EvalError::TimeRange);
        }
        out.fill(None);
        for (slot, effect) in out.iter_mut().zip(&self.effects) {
            *slot = effect.sample(t)?;
        }
        Ok(())
    }
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
                let phase = (n as f64 / d as f64).clamp(0.0, 1.0);
                let weight = if track.interpolation == Interpolation::EaseInOut { phase * phase * (3.0 - 2.0 * phase) } else { phase };
                CompactValue::interpolate(av, bv, weight)
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
    /// Floating-point conversion happens only at the external decoder boundary;
    /// all mapping and source visibility decisions are evaluated exactly first.
    pub fn media_seconds(&self, root: Time) -> std::result::Result<Option<f64>, EvalError> {
        if self.available.is_none() {
            return self.sample(root).map(|v| v.map(|t| t.as_f64()));
        }
        temporal::map_chain_media_seconds(&self.maps, root).map_err(|_| EvalError::TimeRange)
    }

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
pub(crate) fn allocation(sizes: &[Size], available: f64) -> Result<Vec<f64>> {
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
            Size::Aspect => {
                return Err(bad(
                    "allocation",
                    "aspect sizes must resolve before allocation",
                ))
            }
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
fn expand(
    d: &Document,
    n: &Node,
    path: &str,
    geometry: Geometry,
    props: &BTreeMap<String, Value>,
    inputs: &LayoutInputs,
    out: &mut Vec<Arc<NodePlan>>,
) -> Result<()> {
    let path = format!("{path}/{}", n.id);
    let kind = match &n.content {
        Content::Group => "group",
        Content::Text { .. } => "text",
        Content::Source { .. } => "source",
        Content::Component { .. } => "component",
    };
    let r = geometry.frame;
    let snapped = layout::raster(r);
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
    out.push(Arc::new(NodePlan {
        path: path.clone(),
        style: n.style.clone(),
        frame: snapped,
        pivot: geometry.pivot,
        aspect: geometry.aspect,
        kind: kind.into(),
        source: if let Content::Source { source, .. } = &n.content {
            Some(source.clone())
        } else {
            None
        },
        fit: if let Content::Source { fit, .. } = &n.content {
            Some(*fit)
        } else {
            None
        },
        font: if let Content::Text { font, .. } = &n.content {
            Some(font.clone())
        } else {
            None
        },
        text: if let Content::Text { value, .. } = &n.content {
            Some(value.clone())
        } else {
            None
        },
        bound,
    }));
    if let Content::Component {
        definition,
        props: overrides,
        ..
    } = &n.content
    {
        let component = &d.components[definition];
        let mut p = component.props.clone();
        p.extend(overrides.clone());
        let child = layout::fill(&component.root, r, inputs)?;
        expand(d, &component.root, &path, child, &p, inputs, out)?;
    }
    for (child, rect) in n.children.iter().zip(layout::children(n, r, inputs)?) {
        expand(d, child, &path, rect, props, inputs, out)?;
    }
    Ok(())
}
pub fn compile(d: &Document) -> Result<Plan> {
    compile_with_layout_inputs(d, &LayoutInputs::empty(&d.id))
}
pub fn compile_with_layout_inputs(d: &Document, inputs: &LayoutInputs) -> Result<Plan> {
    compile_with_inputs_and_scratch(d, inputs, &mut wire::Scratch::default())
}
pub fn compile_with_scratch(d: &Document, scratch: &mut wire::Scratch) -> Result<Plan> {
    compile_with_inputs_and_scratch(d, &LayoutInputs::empty(&d.id), scratch)
}
fn compile_with_inputs_and_scratch(
    d: &Document,
    inputs: &LayoutInputs,
    scratch: &mut wire::Scratch,
) -> Result<Plan> {
    let inventory = validate::validate_with_scratch(d, scratch)?;
    crate::contract::layout::validate_inputs(d, inputs)?;
    let targets: Vec<_> = inventory.targets.iter().cloned().collect();
    let handles: BTreeMap<_, _> = targets
        .iter()
        .cloned()
        .enumerate()
        .map(|(i, t)| (t, i))
        .collect();
    let mut nodes = Vec::with_capacity(inventory.expanded_nodes);
    for (sid, set) in &d.sets {
        for lid in set.layouts.keys() {
            nodes.extend(layout(d, sid, lid, inputs)?);
        }
    }
    let mut sequences = BTreeMap::new();
    let mut temporal_work = TEMPORAL_WORK;
    for id in d.sequences.keys() {
        sequences.insert(
            id.clone(),
            Arc::new(sequence(d, id, &handles, &mut temporal_work)?),
        );
    }
    let dependencies = Arc::new(crate::dependencies::compile(
        d, &nodes, &sequences, &targets,
    )?);
    let document_digest = scratch.digest(d)?;
    Ok(Plan {
        analytic_sources: crate::analytic::sources(d),
        geometry_digest: geometry_digest(&document_digest, inputs)?,
        layout_inputs: Arc::new(inputs.clone()),
        digest: document_digest,
        nodes,
        targets,
        sequences,
        inventory,
        dependencies,
    })
}

pub(crate) fn geometry_digest(document_digest: &str, inputs: &LayoutInputs) -> Result<Digest> {
    digest(&(document_digest, inputs))
}
pub(crate) fn layout(
    d: &Document,
    sid: &str,
    lid: &str,
    inputs: &LayoutInputs,
) -> Result<Vec<Arc<NodePlan>>> {
    let l = &d.sets[sid].layouts[lid];
    let mut nodes = vec![];
    expand(
        d,
        &l.root,
        &format!("sets/{sid}/layouts/{lid}"),
        layout::place(
            &l.root,
            Rect {
                x: 0.0,
                y: 0.0,
                width: f64::from(l.width),
                height: f64::from(l.height),
            },
            l.root.frame.unwrap(),
            inputs,
        )?,
        &BTreeMap::new(),
        inputs,
        &mut nodes,
    )?;
    Ok(nodes)
}
pub(crate) fn sequence(
    d: &Document,
    id: &str,
    handles: &BTreeMap<Target, usize>,
    temporal_work: &mut usize,
) -> Result<SequencePlan> {
    let expanded = temporal::expand(d, id, temporal_work)?;
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
    let mut effects = Vec::new();
    let analytic_sources = crate::analytic::sources(d);
    for p in expanded.players {
        if let Some(source) = analytic_sources.get(&p.source) {
            let mut maps = p.maps.clone();
            // Graphics have no file playhead. Their content clock starts at the
            // placement's entry, after exact ancestor trim/speed/loop mapping.
            maps.push(temporal::TimeMap {
                range: p.template.range,
                source_range: Range {
                    start: Time::ZERO,
                    duration: p.template.range.duration,
                },
                source_in: Time::ZERO,
                speed: Speed::default(),
                looping: false,
            });
            effects.push(crate::analytic::EffectPlan {
                path: p.path.clone(),
                source: p.source.clone(),
                clock: source.bind(&p.path)?,
                maps,
            });
        }
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
    Ok(SequencePlan {
        effects,
        duration: d.sequences[id].duration,
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
    })
}
