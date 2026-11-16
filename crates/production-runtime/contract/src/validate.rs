use crate::*;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Inventory {
    pub nodes: BTreeMap<String, NodeIdentity>,
    pub targets: BTreeSet<Target>,
    pub expanded_nodes: usize,
    pub instances: u32,
    pub tracks: usize,
    pub temporal_instances: usize,
    pub expanded_tracks: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NodeIdentity {
    pub kind: String,
    pub definition: Option<String>,
    pub authority: Authority,
}
fn err(path: &str, message: &str) -> Error {
    Error::new("SEMANTIC", path, message)
}
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.as_bytes()[0].is_ascii_lowercase()
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !["constructor", "prototype"].contains(&id)
}
pub fn hash(h: &str) -> bool {
    h.len() == 64
        && h.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn color(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit())
}
fn finite(v: f64) -> bool {
    v.is_finite() && v.abs() <= 1_000_000.0
}
pub fn value_valid(v: &Value) -> bool {
    match v {
        Value::Number(n) => finite(*n),
        Value::Text(s) => s.len() <= STRING_BYTES,
        Value::Color(s) => color(s),
        Value::Vec3(v) => v.iter().all(|x| finite(*x)),
        Value::Bool(_) => true,
    }
}
pub fn property_valid(p: Property, v: &Value) -> bool {
    if !value_valid(v) {
        return false;
    }
    match (p, v) {
        (Property::Opacity | Property::MaterialRoughness, Value::Number(n)) => {
            (0.0..=1.0).contains(n)
        }
        (Property::Scale, Value::Number(n)) => (0.001..=100.0).contains(n),
        (Property::CameraFov, Value::Number(n)) => (20.0..=90.0).contains(n),
        (Property::LightIntensity, Value::Number(n)) => (0.0..=10_000.0).contains(n),
        (
            Property::TranslateX | Property::TranslateY | Property::Rotation | Property::Uniform,
            Value::Number(_),
        ) => true,
        (Property::Visibility, Value::Bool(_)) => true,
        (
            Property::CameraPosition | Property::CameraTarget | Property::InstanceOffset,
            Value::Vec3(_),
        ) => true,
        (Property::MaterialColor, Value::Color(_)) => true,
        _ => false,
    }
}
fn rect(r: Rect) -> bool {
    [r.x, r.y, r.width, r.height].iter().all(|v| finite(*v)) && r.width > 0.0 && r.height > 0.0
}
fn keys<T>(m: &BTreeMap<String, T>, p: &str) -> Result<()> {
    if m.len() > NODES {
        return Err(err(p, "map exceeds profile"));
    }
    if m.keys().any(|k| !valid_id(k)) {
        return Err(err(p, "invalid ASCII identifier"));
    }
    Ok(())
}
fn idset<'a>(ids: impl Iterator<Item = &'a str>, p: &str) -> Result<()> {
    let mut seen = BTreeSet::new();
    for id in ids {
        if !valid_id(id) || !seen.insert(id) {
            return Err(err(p, "invalid or duplicate identifier"));
        }
    }
    Ok(())
}
/// Evaluated only on the control/compile lane. Inputs are scoped declared props.
pub fn evaluate(e: &Expr, inputs: &BTreeMap<String, Value>, fuel: &mut usize) -> Result<Value> {
    fn go(e: &Expr, i: &BTreeMap<String, Value>, f: &mut usize, depth: usize) -> Result<Value> {
        if *f == 0 || depth > 16 {
            return Err(err("expression", "expression work/depth budget exceeded"));
        }
        *f -= 1;
        let number = |v: Value| match v {
            Value::Number(x) => Ok(x),
            _ => Err(err("expression", "number required")),
        };
        let eval = |e: &Expr, f: &mut usize| go(e, i, f, depth + 1);
        let v = match e {
            Expr::Literal { value } => value.clone(),
            Expr::Input { name } => i
                .get(name)
                .cloned()
                .ok_or_else(|| err("expression", "undeclared input"))?,
            Expr::Select { condition, yes, no } => {
                let c = match eval(condition, f)? {
                    Value::Bool(b) => b,
                    _ => return Err(err("expression", "boolean condition required")),
                };
                // Validate both possible branches, so a hidden invalid branch is not latent work.
                let a = eval(yes, f)?;
                let b = eval(no, f)?;
                if std::mem::discriminant(&a) != std::mem::discriminant(&b) {
                    return Err(err("expression", "branch type mismatch"));
                }
                if c {
                    a
                } else {
                    b
                }
            }
            Expr::Clamp { value, min, max } => {
                let v = number(eval(value, f)?)?;
                let a = number(eval(min, f)?)?;
                let b = number(eval(max, f)?)?;
                if a > b {
                    return Err(err("expression", "invalid clamp"));
                }
                Value::Number(v.clamp(a, b))
            }
            Expr::Equal { a, b } => Value::Bool(eval(a, f)? == eval(b, f)?),
            Expr::Add { a, b }
            | Expr::Subtract { a, b }
            | Expr::Multiply { a, b }
            | Expr::Divide { a, b }
            | Expr::Less { a, b } => {
                let a = number(eval(a, f)?)?;
                let b = number(eval(b, f)?)?;
                match e {
                    Expr::Add { .. } => Value::Number(a + b),
                    Expr::Subtract { .. } => Value::Number(a - b),
                    Expr::Multiply { .. } => Value::Number(a * b),
                    Expr::Divide { .. } => {
                        if b == 0.0 {
                            return Err(err("expression", "division by zero"));
                        }
                        Value::Number(a / b)
                    }
                    _ => Value::Bool(a < b),
                }
            }
        };
        if !value_valid(&v) {
            return Err(err("expression", "value outside finite profile"));
        }
        Ok(v)
    }
    go(e, inputs, fuel, 0)
}

struct Walker<'a> {
    d: &'a Document,
    out: Inventory,
    pins: BTreeMap<String, String>,
    fuel: usize,
}
impl Walker<'_> {
    fn walk(
        &mut self,
        n: &Node,
        parent: &str,
        depth: usize,
        stack: &mut Vec<String>,
        props: &BTreeMap<String, Value>,
        authority: Authority,
    ) -> Result<()> {
        if depth > SPATIAL_DEPTH || self.out.expanded_nodes >= NODES {
            return Err(err(parent, "expanded node/depth budget exceeded"));
        }
        if !valid_id(&n.id) {
            return Err(err(parent, "invalid node identifier"));
        }
        let path = format!("{parent}/{}", n.id);
        let definition = match &n.content {
            Content::Component { pin, .. } => Some(pin.clone()),
            _ => None,
        };
        let kind = match &n.content {
            Content::Group => "group",
            Content::Text { .. } => "text",
            Content::Source { .. } => "source",
            Content::Component { .. } => "component",
        }
        .into();
        if self
            .out
            .nodes
            .insert(
                path.clone(),
                NodeIdentity {
                    kind,
                    definition,
                    authority,
                },
            )
            .is_some()
        {
            return Err(err(&path, "duplicate scoped identity"));
        }
        self.out.expanded_nodes += 1;
        for property in [
            Property::Opacity,
            Property::TranslateX,
            Property::TranslateY,
            Property::Scale,
            Property::Rotation,
            Property::Visibility,
        ] {
            self.out.targets.insert(Target {
                path: path.clone(),
                property,
            });
        }
        if let Some(r) = n.frame {
            if !rect(r) {
                return Err(err(&path, "invalid box"));
            }
        }
        match &n.flow {
            Flow::Overlay => {
                if n.children.iter().any(|c| c.frame.is_none()) {
                    return Err(err(&path, "overlay children require explicit frames"));
                }
            }
            Flow::Grid { gap, columns } => {
                if !finite(*gap) || *gap < 0.0 || *columns == 0 || *columns > 64 {
                    return Err(err(&path, "invalid grid"));
                }
            }
            Flow::Row { gap, sizes } | Flow::Column { gap, sizes } => {
                if !finite(*gap) || *gap < 0.0 || sizes.len() != n.children.len() {
                    return Err(err(&path, "invalid weighted allocation"));
                }
                for size in sizes {
                    match size {
                        Size::Fixed { pixels } => {
                            if !finite(*pixels) || *pixels <= 0.0 {
                                return Err(err(&path, "invalid fixed size"));
                            }
                        }
                        Size::Weight { weight, min, max } => {
                            if !finite(*weight)
                                || *weight <= 0.0
                                || !finite(*min)
                                || !finite(*max)
                                || *min < 0.0
                                || *max < *min
                            {
                                return Err(err(&path, "invalid weight/min/max"));
                            }
                        }
                    }
                }
            }
        }
        idset(n.children.iter().map(|c| c.id.as_str()), &path)?;
        let mut bound = BTreeSet::new();
        for b in &n.bindings {
            if !bound.insert(b.property) {
                return Err(err(&path, "duplicate binding writer"));
            }
            let mut local = 256;
            let value = evaluate(&b.expression, props, &mut local)?;
            self.fuel = self
                .fuel
                .checked_sub(256 - local)
                .ok_or_else(|| err(&path, "document binding fuel exceeded"))?;
            if !property_valid(b.property, &value) {
                return Err(err(&path, "binding type/range mismatch"));
            }
        }
        match &n.content {
            Content::Group => {}
            Content::Text { value, font } => {
                if value.len() > STRING_BYTES || !hash(font) {
                    return Err(err(&path, "text/font invalid"));
                }
            }
            Content::Source { source, .. } => {
                if !self.d.sources.contains_key(source) {
                    return Err(err(&path, "source unavailable"));
                }
            }
            Content::Component {
                definition,
                pin,
                props: overrides,
            } => {
                if !n.children.is_empty() {
                    return Err(err(&path, "component instance cannot inject children"));
                }
                let c = self
                    .d
                    .components
                    .get(definition)
                    .ok_or_else(|| err(&path, "definition missing"))?;
                if self.pins.get(definition) != Some(pin) {
                    return Err(err(&path, "pinned definition hash mismatch"));
                }
                if stack.contains(definition) {
                    return Err(err(&path, "component expansion cycle"));
                }
                let mut values = c.props.clone();
                for (k, v) in overrides {
                    let old = values
                        .get(k)
                        .ok_or_else(|| err(&path, "unknown component prop"))?;
                    if std::mem::discriminant(old) != std::mem::discriminant(v) || !value_valid(v) {
                        return Err(err(&path, "component prop type/range mismatch"));
                    }
                    values.insert(k.clone(), v.clone());
                }
                let authority = if authority == Authority::Hosted {
                    Authority::Hosted
                } else {
                    c.authority
                };
                stack.push(definition.clone());
                self.walk(&c.root, &path, depth + 1, stack, &values, authority)?;
                stack.pop();
            }
        }
        for c in &n.children {
            self.walk(c, &path, depth + 1, stack, props, authority)?;
        }
        Ok(())
    }
}
pub fn validate_document(d: &Document) -> Result<Inventory> {
    let bytes = serde_json::to_vec(d).map_err(|e| err("$", &e.to_string()))?;
    crate::ingress::parse(&bytes, DOCUMENT_BYTES)?;
    if !valid_id(&d.id) || d.title.trim().is_empty() {
        return Err(err("$", "document id/title required"));
    }
    keys(&d.assets, "assets")?;
    keys(&d.sources, "sources")?;
    keys(&d.components, "components")?;
    keys(&d.sets, "sets")?;
    keys(&d.sequences, "sequences")?;
    keys(&d.shows, "shows")?;
    for (id, a) in &d.assets {
        if !hash(&a.hash) {
            return Err(err(id, "asset SHA-256 required"));
        }
        if let Some(r) = a.available {
            r.end()?;
        }
        if matches!(a.kind, AssetKind::Audio | AssetKind::Video) && a.available.is_none() {
            return Err(err(id, "file media requires a finite probed range"));
        }
    }
    let mut w = Walker {
        d,
        out: Inventory::default(),
        pins: BTreeMap::new(),
        fuel: 16_384,
    };
    for (id, c) in &d.components {
        if c.version == 0 {
            return Err(err(id, "component version required"));
        }
        keys(&c.props, id)?;
        if c.props.values().any(|v| !value_valid(v)) {
            return Err(err(id, "invalid component props"));
        }
        w.pins.insert(id.clone(), digest(c)?);
    }
    // Validate unused definitions too; cycles cannot hide until first use.
    let mut definition_work = 0usize;
    for (id, c) in &d.components {
        let mut check = Walker {
            d,
            out: Inventory::default(),
            pins: w.pins.clone(),
            fuel: 16_384,
        };
        check.walk(
            &c.root,
            &format!("components/{id}"),
            0,
            &mut vec![id.clone()],
            &c.props,
            c.authority,
        )?;
        definition_work += check.out.expanded_nodes;
        if definition_work > 16_384 {
            return Err(err(
                "components",
                "aggregate definition validation work exceeds profile",
            ));
        }
    }
    for (id, s) in &d.sources {
        match s {
            Source::Live { .. } => {}
            Source::Player { asset } => {
                let a = d
                    .assets
                    .get(asset)
                    .ok_or_else(|| err(id, "player asset missing"))?;
                if !matches!(a.kind, AssetKind::Video | AssetKind::Audio) {
                    return Err(err(id, "unsupported player asset kind"));
                }
            }
            Source::Graphics { scene } => {
                if !scene.analytic {
                    return Err(Error::new(
                        "UNSUPPORTED",
                        id,
                        "stateful 3D simulation requires a qualified adapter",
                    ));
                }
                keys(&scene.parameters, id)?;
                if scene.parameters.len() > 256 || scene.batches.len() > 8 {
                    return Err(err(id, "3D manifest budget exceeded"));
                }
                for (name, p) in &scene.parameters {
                    if !matches!(
                        p.property,
                        Property::CameraPosition
                            | Property::CameraTarget
                            | Property::CameraFov
                            | Property::MaterialColor
                            | Property::MaterialRoughness
                            | Property::LightIntensity
                            | Property::Uniform
                            | Property::InstanceOffset
                    ) || !property_valid(p.property, &p.initial)
                    {
                        return Err(err(id, "3D parameter type/range invalid"));
                    }
                    w.out.targets.insert(Target {
                        path: format!("sources/{id}/parameters/{name}"),
                        property: p.property,
                    });
                }
                idset(scene.batches.iter().map(|b| b.id.as_str()), id)?;
                for b in &scene.batches {
                    if b.instances == 0 {
                        return Err(err(id, "empty instanced batch"));
                    }
                    w.out.instances = w
                        .out
                        .instances
                        .checked_add(b.instances)
                        .ok_or_else(|| err(id, "instance overflow"))?;
                    if w.out.instances > 4096 {
                        return Err(err(id, "aggregate instance budget exceeded"));
                    }
                    for (a, kind) in [
                        (&b.geometry, AssetKind::Geometry),
                        (&b.material, AssetKind::Material),
                    ] {
                        if d.assets.get(a).map(|v| v.kind) != Some(kind) {
                            return Err(err(id, "batch resource kind/missing reference"));
                        }
                    }
                }
            }
        }
    }
    for (id, set) in &d.sets {
        keys(&set.layouts, id)?;
        keys(&set.theme, id)?;
        keys(&set.actions, id)?;
        if set.layouts.is_empty() {
            return Err(err(id, "Set needs at least one layout"));
        }
        if set.theme.values().any(|c| !color(c)) {
            return Err(err(id, "theme token must be a hex color"));
        }
        for (lid, l) in &set.layouts {
            if l.width == 0
                || l.height == 0
                || l.width > 7680
                || l.height > 7680
                || (l.orientation == Orientation::Vertical && l.width >= l.height)
                || (l.orientation == Orientation::Landscape && l.width <= l.height)
            {
                return Err(err(lid, "canvas dimensions/orientation invalid"));
            }
            if l.root.frame.is_none() {
                return Err(err(lid, "root frame required"));
            }
            w.walk(
                &l.root,
                &format!("sets/{id}/layouts/{lid}"),
                0,
                &mut Vec::new(),
                &BTreeMap::new(),
                Authority::Local,
            )?;
        }
        idset(set.controls.iter().map(|c| c.id.as_str()), id)?;
        if set.controls.len() > 256 {
            return Err(err(id, "control budget exceeded"));
        }
        for c in &set.controls {
            if !set.actions.contains_key(&c.action) {
                return Err(err(&c.id, "control action missing"));
            }
            if let ControlScope::Layout { layout } = &c.scope {
                if !set.layouts.contains_key(layout) {
                    return Err(err(&c.id, "control layout scope missing"));
                }
            }
        }
    }
    for (id, set) in &d.sets {
        for steps in set.actions.values() {
            if steps.len() > 64 {
                return Err(err(id, "action step budget exceeded"));
            }
            for a in steps {
                match a {
                    Action::SetParameter { target, value } => {
                        if !w.out.targets.contains(target)
                            || !property_valid(target.property, value)
                            || w.out
                                .nodes
                                .get(&target.path)
                                .is_some_and(|n| n.authority == Authority::Hosted)
                        {
                            return Err(err(id, "invalid or hosted action target/value"));
                        }
                    }
                    Action::EmitCue { cue } => {
                        if !valid_id(cue) {
                            return Err(err(id, "invalid cue id"));
                        }
                    }
                }
            }
        }
    }
    for (id, seq) in &d.sequences {
        if seq.duration <= Time::ZERO {
            return Err(err(id, "sequence duration must be positive"));
        }
        idset(seq.tracks.iter().map(|t| t.id.as_str()), id)?;
        idset(seq.instances.iter().map(|t| t.id.as_str()), id)?;
        idset(seq.placements.iter().map(|p| p.id.as_str()), id)?;
        idset(seq.cues.iter().map(|c| c.id.as_str()), id)?;
        idset(seq.audio_routes.iter().map(|r| r.id.as_str()), id)?;
        if seq.instances.len() > TEMPORAL_INSTANCES
            || seq.placements.len() > NODES
            || seq.cues.len() > NODES
            || seq.audio_routes.len() > NODES
        {
            return Err(err(id, "temporal declaration budget exceeded"));
        }
        for instance in &seq.instances {
            if instance.target_bindings.len() > 256 || instance.source_bindings.len() > 256 {
                return Err(err(&instance.id, "instance binding budget exceeded"));
            }
        }
        w.out.tracks += seq.tracks.len();
        if w.out.tracks > TRACKS {
            return Err(err(id, "active track budget exceeded"));
        }
        let mut used: Vec<&Track> = Vec::new();
        for t in &seq.tracks {
            let end = t.range.end()?;
            if t.range.start < Time::ZERO
                || end > seq.duration
                || !w.out.targets.contains(&t.target)
                || t.keys.is_empty()
                || t.keys.len() > KEYS
                || w.out
                    .nodes
                    .get(&t.target.path)
                    .is_some_and(|n| n.authority == Authority::Hosted)
            {
                return Err(err(&t.id, "invalid/hosted track range/target/keys"));
            }
            if t.keys[0].at != t.range.start {
                return Err(err(&t.id, "first key must match track start"));
            }
            let mut prev = None;
            for k in &t.keys {
                if k.at < t.range.start
                    || k.at > end
                    || prev.is_some_and(|p| k.at <= p)
                    || !property_valid(t.target.property, &k.value)
                {
                    return Err(err(&t.id, "unordered key or value/range mismatch"));
                }
                prev = Some(k.at);
                if t.interpolation == Interpolation::Linear
                    && !matches!(k.value, Value::Number(_) | Value::Vec3(_))
                {
                    return Err(err(&t.id, "linear supports numbers/vectors only"));
                }
                if std::mem::discriminant(&k.value) != std::mem::discriminant(&t.keys[0].value) {
                    return Err(err(&t.id, "track key type mismatch"));
                }
            }
            for old in &used {
                if old.target == t.target && old.range.overlaps(t.range)? {
                    return Err(Error::new(
                        "DRIVER_CONFLICT",
                        &t.id,
                        "replace drivers overlap",
                    ));
                }
            }
            used.push(t);
        }
        for c in &seq.cues {
            if c.at < Time::ZERO || c.at >= seq.duration {
                return Err(err(&c.id, "cue outside half-open sequence"));
            }
        }
        let mut player_maps: BTreeMap<&str, Vec<&Placement>> = BTreeMap::new();
        for p in &seq.placements {
            let end = p.range.end()?;
            p.speed.validate()?;
            if p.range.start < Time::ZERO || end > seq.duration {
                return Err(err(&p.id, "placement outside sequence"));
            }
            match d
                .sources
                .get(&p.source)
                .ok_or_else(|| err(&p.id, "placement source missing"))?
            {
                Source::Player { asset } => {
                    let available = d.assets[asset].available.unwrap();
                    if !available.contains(p.source_in)?
                        || (!p.looping
                            && p.source_in.checked_add(p.range.duration.scale(p.speed)?)?
                                > available.end()?)
                    {
                        return Err(err(&p.id, "trim exceeds available source range"));
                    }
                    for old in player_maps.entry(&p.source).or_default().iter() {
                        if old.range.overlaps(p.range)?
                            && (old.range != p.range
                                || old.source_in != p.source_in
                                || old.speed != p.speed
                                || old.looping != p.looping)
                        {
                            return Err(err(&p.id,"one player cannot have two independent controllers; declare a second player"));
                        }
                    }
                    player_maps.get_mut(p.source.as_str()).unwrap().push(p);
                }
                _ => {
                    if p.source_in != Time::ZERO || p.speed != Speed::default() || p.looping {
                        return Err(err(&p.id, "live source cannot acquire a file playhead"));
                    }
                }
            }
        }
        let mut routes = BTreeSet::new();
        for r in &seq.audio_routes {
            if !d.sources.contains_key(&r.source) || !routes.insert((&r.source, r.bus)) {
                return Err(err(
                    &r.id,
                    "missing source or duplicate source-to-bus contribution",
                ));
            }
        }
    }
    let mut temporal_work = TEMPORAL_WORK;
    for id in d.sequences.keys() {
        let expanded = temporal::expand(d, id, &mut temporal_work)?;
        w.out.temporal_instances += expanded.instances;
        w.out.expanded_tracks += expanded.tracks.len();
        if w.out.temporal_instances > TEMPORAL_INSTANCES || w.out.expanded_tracks > TRACKS {
            return Err(err(id, "aggregate expanded temporal budget exceeded"));
        }
        temporal::validate_expanded(d, &w.out, &expanded, &mut temporal_work)?;
    }
    for (id, show) in &d.shows {
        let set = d
            .sets
            .get(&show.set)
            .ok_or_else(|| err(id, "Show Set missing"))?;
        idset(show.segments.iter().map(|s| s.id.as_str()), id)?;
        if show.segments.is_empty() {
            return Err(err(id, "Show segments required"));
        }
        for s in &show.segments {
            if set.layouts.get(&s.landscape).map(|l| l.orientation) != Some(Orientation::Landscape)
                || set.layouts.get(&s.vertical).map(|l| l.orientation)
                    != Some(Orientation::Vertical)
                || s.sequence
                    .as_ref()
                    .is_some_and(|q| !d.sequences.contains_key(q))
            {
                return Err(err(&s.id, "Show layout/sequence reference invalid"));
            }
        }
    }
    Ok(w.out)
}
