//! Bounded temporal expansion and exact time maps. No loop occurrences or keys
//! are unrolled into the evaluation plan. Interval projection is preflight only.
use crate::*;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TimeMap {
    pub range: Range,
    pub source_range: Range,
    pub source_in: Time,
    pub speed: Speed,
    pub looping: bool,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MapError {
    Unrepresentable,
    Depth,
}
pub fn add(a: Time, b: Time) -> Option<Time> {
    if b == Time::ZERO {
        return Some(a);
    }
    if a == Time::ZERO {
        return Some(b);
    }
    Time::try_ratio(
        a.ticks() as i128 * b.rate() as i128 + b.ticks() as i128 * a.rate() as i128,
        a.rate() as i128 * b.rate() as i128,
    )
}
pub fn sub(a: Time, b: Time) -> Option<Time> {
    if b == Time::ZERO {
        return Some(a);
    }
    if a == b {
        return Some(Time::ZERO);
    }
    Time::try_ratio(
        a.ticks() as i128 * b.rate() as i128 - b.ticks() as i128 * a.rate() as i128,
        a.rate() as i128 * b.rate() as i128,
    )
}
pub fn scale(a: Time, s: Speed) -> Option<Time> {
    if s.numerator == 0 || s.denominator == 0 {
        return None;
    }
    if s.numerator == s.denominator {
        return Some(a);
    }
    Time::try_ratio(
        a.ticks() as i128 * s.numerator as i128,
        a.rate() as i128 * s.denominator as i128,
    )
}
// Internal exact intermediates are wider than the serialized Time profile. A
// slow parent and fast child may cancel; narrowing between them would reject a
// perfectly representable final sample. Every operation is checked, with no
// heap allocation or floating-point rounding.
#[derive(Clone, Copy)]
struct Rational {
    n: i128,
    d: i128,
}
fn gcd(mut a: u128, mut b: u128) -> u128 {
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a
}
impl From<Time> for Rational {
    fn from(t: Time) -> Self {
        Self {
            n: t.ticks() as i128,
            d: t.rate() as i128,
        }
    }
}
impl Rational {
    fn new(n: i128, d: i128) -> Option<Self> {
        if d <= 0 {
            return None;
        }
        let g = gcd(n.unsigned_abs(), d as u128) as i128;
        Some(Self { n: n / g, d: d / g })
    }
    fn time(self) -> Option<Time> {
        Time::try_ratio(self.n, self.d)
    }
    fn add(self, b: Self) -> Option<Self> {
        let g = gcd(self.d as u128, b.d as u128) as i128;
        Self::new(
            self.n
                .checked_mul(b.d / g)?
                .checked_add(b.n.checked_mul(self.d / g)?)?,
            self.d.checked_mul(b.d / g)?,
        )
    }
    fn sub(self, b: Self) -> Option<Self> {
        self.add(Self {
            n: b.n.checked_neg()?,
            d: b.d,
        })
    }
    fn mul(self, b: Self) -> Option<Self> {
        let g = gcd(self.n.unsigned_abs(), b.d as u128) as i128;
        let h = gcd(b.n.unsigned_abs(), self.d as u128) as i128;
        Self::new(
            (self.n / g).checked_mul(b.n / h)?,
            (self.d / h).checked_mul(b.d / g)?,
        )
    }
    fn scale(self, speed: Speed) -> Option<Self> {
        if speed.numerator == 0 || speed.denominator == 0 {
            return None;
        }
        self.mul(Self {
            n: speed.numerator as i128,
            d: speed.denominator as i128,
        })
    }
    fn cmp(self, b: Self) -> Option<std::cmp::Ordering> {
        // Ordinary profile values take the short path. Continued fractions are
        // the exact overflow fallback; comparison never rounds or multiplies
        // two near-i128-limit intermediates.
        if let (Some(a), Some(b)) = (self.n.checked_mul(b.d), b.n.checked_mul(self.d)) {
            return Some(a.cmp(&b));
        }
        if self.n.signum() != b.n.signum() {
            return Some(self.n.cmp(&b.n));
        }
        let (mut a, mut ad, mut b, mut bd) = (
            self.n.unsigned_abs(),
            self.d as u128,
            b.n.unsigned_abs(),
            b.d as u128,
        );
        let mut reverse = self.n < 0;
        loop {
            let order = (a / ad).cmp(&(b / bd));
            if !order.is_eq() {
                return Some(if reverse { order.reverse() } else { order });
            }
            let (ar, br) = (a % ad, b % bd);
            if ar == 0 || br == 0 {
                let order = ar.cmp(&br);
                return Some(if reverse { order.reverse() } else { order });
            }
            (a, ad, b, bd) = (ad, ar, bd, br);
            reverse = !reverse;
        }
    }
    fn modulo(self, length: Self) -> Option<(Self, u64)> {
        if self.n < 0 || length.n <= 0 {
            return None;
        }
        let quotient = self.mul(Self {
            n: length.d,
            d: length.n,
        })?;
        let count = u64::try_from(quotient.n / quotient.d).ok()?;
        Some((
            self.sub(length.mul(Self {
                n: count as i128,
                d: 1,
            })?)?,
            count,
        ))
    }
}
fn fail(path: &str, message: &str) -> Error {
    Error::new("TEMPORAL", path, message)
}
pub fn spend(work: &mut usize) -> Result<()> {
    *work = work.checked_sub(1).ok_or_else(|| {
        Error::new(
            "TEMPORAL_WORK_LIMIT",
            "sequences",
            "bounded temporal preflight work exhausted",
        )
    })?;
    Ok(())
}
impl TimeMap {
    pub fn validate(self) -> Result<()> {
        self.speed.validate()?;
        self.range.end()?;
        self.source_range.end()?;
        if !self.source_range.contains(self.source_in)?
            || (!self.looping
                && self
                    .source_in
                    .checked_add(self.range.duration.scale(self.speed)?)?
                    > self.source_range.end()?)
        {
            return Err(fail("timeMap", "trim exceeds available child/source range"));
        }
        Ok(())
    }
    /// Numeric-only fast path; failures are Copy enums, not allocated diagnostics.
    pub fn map(self, parent: Time) -> std::result::Result<Option<(Time, u64)>, MapError> {
        match self.map_fast(parent) {
            Ok(value) => Ok(value),
            Err(_) => self
                .map_wide(parent.into())?
                .map(|(time, count)| Ok((time.time().ok_or(MapError::Unrepresentable)?, count)))
                .transpose(),
        }
    }
    fn map_fast(self, parent: Time) -> std::result::Result<Option<(Time, u64)>, MapError> {
        let result = || -> Option<Option<(Time, u64)>> {
            let end = add(self.range.start, self.range.duration)?;
            if parent < self.range.start || parent >= end {
                return Some(None);
            }
            let elapsed = scale(sub(parent, self.range.start)?, self.speed)?;
            let unwrapped = add(sub(self.source_in, self.source_range.start)?, elapsed)?;
            let (offset, count) = if self.looping && unwrapped >= self.source_range.duration {
                if unwrapped < Time::ZERO || self.source_range.duration <= Time::ZERO {
                    return None;
                }
                let n = unwrapped.ticks() as i128 * self.source_range.duration.rate() as i128;
                let d = unwrapped.rate() as i128 * self.source_range.duration.ticks() as i128;
                (
                    Time::try_ratio(
                        n % d,
                        unwrapped.rate() as i128 * self.source_range.duration.rate() as i128,
                    )?,
                    u64::try_from(n / d).ok()?,
                )
            } else {
                (unwrapped, 0)
            };
            let time = add(self.source_range.start, offset)?;
            if time < self.source_range.start
                || time >= add(self.source_range.start, self.source_range.duration)?
            {
                return None;
            }
            Some(Some((time, count)))
        };
        result().ok_or(MapError::Unrepresentable)
    }
    fn map_wide(self, parent: Rational) -> std::result::Result<Option<(Rational, u64)>, MapError> {
        let result = || -> Option<Option<(Rational, u64)>> {
            let start = Rational::from(self.range.start);
            let end = start.add(self.range.duration.into())?;
            if parent.cmp(start)?.is_lt() || !parent.cmp(end)?.is_lt() {
                return Some(None);
            }
            let source_start = Rational::from(self.source_range.start);
            let elapsed = parent.sub(start)?.scale(self.speed)?;
            let unwrapped = Rational::from(self.source_in)
                .sub(source_start)?
                .add(elapsed)?;
            let (offset, occurrence) = if self.looping {
                unwrapped.modulo(self.source_range.duration.into())?
            } else {
                (unwrapped, 0)
            };
            let time = source_start.add(offset)?;
            let source_end = source_start.add(self.source_range.duration.into())?;
            if time.cmp(source_start)?.is_lt() || !time.cmp(source_end)?.is_lt() {
                return None;
            }
            Some(Some((time, occurrence)))
        };
        result().ok_or(MapError::Unrepresentable)
    }
    /// Inverse for a known occurrence. Endpoints are permitted for interval math.
    pub fn inverse(self, child: Time, occurrence: u64) -> Result<Time> {
        if !self.looping && occurrence != 0 {
            return Err(fail("timeMap", "nonlooping occurrence must be zero"));
        }
        let offset = self.source_range.duration.times(occurrence)?;
        self.range.start.checked_add(
            child
                .checked_add(offset)?
                .checked_sub(self.source_in)?
                .scale(Speed {
                    numerator: self.speed.denominator,
                    denominator: self.speed.numerator,
                })?,
        )
    }
}
/// Returns the final local time; callers needing occurrence identity use map().
pub fn map_chain(maps: &[TimeMap], time: Time) -> std::result::Result<Option<Time>, MapError> {
    if maps.len() > TEMPORAL_DEPTH + 1 {
        return Err(MapError::Depth);
    }
    let mut narrow = time;
    let mut complete = true;
    for map in maps {
        match map.map_fast(narrow) {
            Ok(Some((mapped, _))) => narrow = mapped,
            Ok(None) => return Ok(None),
            Err(_) => {
                complete = false;
                break;
            }
        }
    }
    if complete {
        return Ok(Some(narrow));
    }
    let mut wide = Rational::from(time);
    for map in maps {
        match map.map_wide(wide)? {
            Some((mapped, _)) => wide = mapped,
            None => return Ok(None),
        }
    }
    Ok(Some(wide.time().ok_or(MapError::Unrepresentable)?))
}
/// Decoder boundary only: perform every visibility/loop/speed operation exactly,
/// then convert the final wide rational to the decoder's seconds interface.
/// Do not narrow it back to serialized Time: subtracting e.g. 3833/600 from a
/// nanosecond clock can legitimately require a rate above the document profile.
/// Document edits, animation evaluation and exact sample() keep their contract.
pub fn map_chain_media_seconds(
    maps: &[TimeMap],
    time: Time,
) -> std::result::Result<Option<f64>, MapError> {
    match map_chain(maps, time) {
        Ok(value) => Ok(value.map(|t| t.as_f64())),
        Err(MapError::Depth) => Err(MapError::Depth),
        Err(MapError::Unrepresentable) => {
            let mut wide = Rational::from(time);
            for map in maps {
                match map.map_wide(wide)? {
                    Some((mapped, _)) => wide = mapped,
                    None => return Ok(None),
                }
            }
            Ok(Some(wide.n as f64 / wide.d as f64))
        }
    }
}
/// Exact active intervals in root time, with loop seams preserved. This is
/// bounded control-lane work, used only where competing drivers need proof.
pub fn project_ranges(maps: &[TimeMap], leaf: Range, work: &mut usize) -> Result<Vec<Range>> {
    let mut ranges = vec![leaf];
    for map in maps.iter().rev() {
        let mut projected = Vec::new();
        let source_end = map.source_range.end()?;
        let unwrapped_end = map
            .source_in
            .checked_sub(map.source_range.start)?
            .checked_add(map.range.duration.scale(map.speed)?)?;
        let last = if map.looping {
            unwrapped_end.loop_offset(map.source_range.duration)?.1
        } else {
            0
        };
        for r in ranges {
            let start = r.start.max(map.source_range.start);
            let end = r.end()?.min(source_end);
            if start >= end {
                continue;
            }
            for occurrence in 0..=last {
                spend(work)?;
                let a = map.inverse(start, occurrence)?.max(map.range.start);
                let b = map.inverse(end, occurrence)?.min(map.range.end()?);
                if a < b {
                    projected.push(Range {
                        start: a,
                        duration: b.checked_sub(a)?,
                    });
                }
            }
        }
        ranges = projected;
    }
    Ok(ranges)
}

#[derive(Debug)]
pub struct ExpandedTrack<'a> {
    pub path: String,
    pub target: Target,
    pub template: &'a Track,
    pub maps: Vec<TimeMap>,
}
#[derive(Debug)]
pub struct ExpandedPlayer<'a> {
    pub path: String,
    pub source: String,
    pub template: &'a Placement,
    pub maps: Vec<TimeMap>,
}
#[derive(Debug)]
pub struct ExpandedCue<'a> {
    pub path: String,
    pub template: &'a Cue,
    pub maps: Vec<TimeMap>,
}
#[derive(Debug, Default)]
pub struct ExpandedSequence<'a> {
    pub tracks: Vec<ExpandedTrack<'a>>,
    pub players: Vec<ExpandedPlayer<'a>>,
    pub cues: Vec<ExpandedCue<'a>>,
    pub routes: Vec<AudioRoute>,
    pub instances: usize,
}
/// Spatial addresses are rebound explicitly; definitions remain shared. A
/// binding consumes a child's exported address after its inner bindings.
pub fn expand<'a>(d: &'a Document, root: &str, work: &mut usize) -> Result<ExpandedSequence<'a>> {
    fn walk<'a>(
        d: &'a Document,
        id: &str,
        path: &str,
        stack: &mut Vec<String>,
        work: &mut usize,
    ) -> Result<ExpandedSequence<'a>> {
        spend(work)?;
        if stack.len() > TEMPORAL_DEPTH || stack.iter().any(|s| s == id) {
            return Err(fail(path, "temporal cycle or composition depth exceeded"));
        }
        let seq = d
            .sequences
            .get(id)
            .ok_or_else(|| fail(path, "sequence reference missing"))?;
        if seq.instances.len() > TEMPORAL_INSTANCES
            || seq.tracks.len() > TRACKS
            || seq.placements.len() > NODES
            || seq.cues.len() > NODES
            || seq.audio_routes.len() > NODES
        {
            return Err(fail(path, "temporal declaration profile exceeded"));
        }
        let declarations =
            seq.tracks.len() + seq.placements.len() + seq.cues.len() + seq.audio_routes.len();
        for _ in 0..declarations {
            spend(work)?;
        }
        stack.push(id.into());
        let mut out = ExpandedSequence {
            tracks: seq
                .tracks
                .iter()
                .map(|t| ExpandedTrack {
                    path: format!("{path}/tracks/{}", t.id),
                    target: t.target.clone(),
                    template: t,
                    maps: vec![],
                })
                .collect(),
            players: seq
                .placements
                .iter()
                .map(|p| ExpandedPlayer {
                    path: format!("{path}/placements/{}", p.id),
                    source: p.source.clone(),
                    template: p,
                    maps: vec![],
                })
                .collect(),
            cues: seq
                .cues
                .iter()
                .map(|c| ExpandedCue {
                    path: format!("{path}/cues/{}", c.id),
                    template: c,
                    maps: vec![],
                })
                .collect(),
            routes: seq.audio_routes.clone(),
            instances: 1,
        };
        for instance in &seq.instances {
            let child = d
                .sequences
                .get(&instance.sequence)
                .ok_or_else(|| fail(&instance.id, "sequence reference missing"))?;
            let map = TimeMap {
                range: instance.range,
                source_range: Range {
                    start: Time::ZERO,
                    duration: child.duration,
                },
                source_in: instance.source_in,
                speed: instance.speed,
                looping: instance.looping,
            };
            map.validate()?;
            if map.range.start < Time::ZERO || map.range.end()? > seq.duration {
                return Err(fail(&instance.id, "instance range exceeds parent"));
            }
            let mut branch = walk(
                d,
                &instance.sequence,
                &format!("{path}/instances/{}", instance.id),
                stack,
                work,
            )?;
            if instance.target_bindings.len() > 256 || instance.source_bindings.len() > 256 {
                return Err(fail(&instance.id, "binding profile exceeded"));
            }
            let exports = branch
                .tracks
                .iter()
                .map(|t| &t.target)
                .collect::<BTreeSet<_>>();
            let mut targets = BTreeMap::new();
            for b in &instance.target_bindings {
                spend(work)?;
                if b.from.property != b.to.property
                    || targets.insert(&b.from, &b.to).is_some()
                    || !exports.contains(&b.from)
                {
                    return Err(fail(
                        &instance.id,
                        "duplicate, unused or incompatible target binding",
                    ));
                }
            }
            let exported_sources = branch
                .players
                .iter()
                .map(|p| &p.source)
                .chain(branch.routes.iter().map(|r| &r.source))
                .collect::<BTreeSet<_>>();
            let mut sources = BTreeMap::new();
            for b in &instance.source_bindings {
                spend(work)?;
                let from = d
                    .sources
                    .get(&b.from)
                    .ok_or_else(|| fail(&b.from, "source binding missing"))?;
                let to = d
                    .sources
                    .get(&b.to)
                    .ok_or_else(|| fail(&b.to, "source binding missing"))?;
                if std::mem::discriminant(from) != std::mem::discriminant(to)
                    || sources.insert(&b.from, &b.to).is_some()
                    || !exported_sources.contains(&b.from)
                {
                    return Err(fail(
                        &instance.id,
                        "duplicate, unused or incompatible source binding",
                    ));
                }
            }
            for t in &mut branch.tracks {
                spend(work)?;
                if let Some(target) = targets.get(&t.target) {
                    t.target = (*target).clone();
                }
                t.maps.insert(0, map);
            }
            for p in &mut branch.players {
                spend(work)?;
                if let Some(source) = sources.get(&p.source) {
                    p.source = (*source).clone();
                }
                p.maps.insert(0, map);
            }
            for c in &mut branch.cues {
                spend(work)?;
                c.maps.insert(0, map);
            }
            for r in &mut branch.routes {
                spend(work)?;
                if let Some(source) = sources.get(&r.source) {
                    r.source = (*source).clone();
                }
                r.id = format!("{path}/instances/{}/routes/{}", instance.id, r.id);
            }
            out.instances += branch.instances;
            if out.instances > TEMPORAL_INSTANCES
                || out.tracks.len() + branch.tracks.len() > TRACKS
                || out.players.len() + branch.players.len() > NODES
                || out.cues.len() + branch.cues.len() > NODES
                || out.routes.len() + branch.routes.len() > NODES
            {
                return Err(fail(path, "expanded temporal profile exceeded"));
            }
            out.tracks.extend(branch.tracks);
            out.players.extend(branch.players);
            out.cues.extend(branch.cues);
            out.routes.extend(branch.routes);
        }
        stack.pop();
        Ok(out)
    }
    walk(d, root, &format!("sequences/{root}"), &mut vec![], work)
}

pub fn validate_expanded(
    d: &Document,
    inventory: &Inventory,
    e: &ExpandedSequence<'_>,
    work: &mut usize,
) -> Result<()> {
    let mut targets: BTreeMap<&Target, Vec<&ExpandedTrack<'_>>> = BTreeMap::new();
    for t in &e.tracks {
        spend(work)?;
        if !inventory.targets.contains(&t.target)
            || inventory
                .nodes
                .get(&t.target.path)
                .is_some_and(|n| n.authority == Authority::Hosted)
        {
            return Err(fail(&t.path, "invalid or hosted rebound track target"));
        }
        targets.entry(&t.target).or_default().push(t);
    }
    for tracks in targets.values().filter(|v| v.len() > 1) {
        let mut intervals = Vec::new();
        for t in tracks {
            for range in project_ranges(&t.maps, t.template.range, work)? {
                intervals.push((range, &t.path));
            }
        }
        intervals.sort_by(|a, b| a.0.start.cmp(&b.0.start).then(a.1.cmp(b.1)));
        let mut end = Time::ZERO;
        for (range, path) in intervals {
            spend(work)?;
            if range.start < end {
                return Err(Error::new(
                    "DRIVER_CONFLICT",
                    path,
                    "expanded replace drivers overlap in root time",
                ));
            }
            end = range.end()?;
        }
    }
    let mut players: BTreeMap<&str, Vec<(Vec<TimeMap>, &str)>> = BTreeMap::new();
    for p in &e.players {
        spend(work)?;
        if let Some(Source::Player { asset }) = d.sources.get(&p.source) {
            let available = d.assets[asset]
                .available
                .ok_or_else(|| fail(&p.path, "file metadata missing"))?;
            let map = TimeMap {
                range: p.template.range,
                source_range: available,
                source_in: p.template.source_in,
                speed: p.template.speed,
                looping: p.template.looping,
            };
            map.validate()?;
            let mut maps = p.maps.clone();
            maps.push(map);
            players.entry(&p.source).or_default().push((maps, &p.path));
        }
    }
    for group in players.values().filter(|v| v.len() > 1) {
        let mut ranges = Vec::new();
        for (i, (maps, _)) in group.iter().enumerate() {
            let last = maps.last().unwrap();
            for r in project_ranges(maps, last.source_range, work)? {
                ranges.push((r, i));
            }
        }
        ranges.sort_by(|a, b| a.0.start.cmp(&b.0.start).then(a.1.cmp(&b.1)));
        for (i, (a, ai)) in ranges.iter().enumerate() {
            for (b, bi) in ranges.iter().skip(i + 1) {
                spend(work)?;
                if b.start >= a.end()? {
                    break;
                }
                if ai == bi {
                    continue;
                }
                let start = a.start.max(b.start);
                let end = a.end()?.min(b.end()?);
                let mid = start.checked_add(end.checked_sub(start)?.scale(Speed {
                    numerator: 1,
                    denominator: 2,
                })?)?;
                for time in [start, mid] {
                    let sample = |maps: &[TimeMap]| {
                        map_chain(maps, time)
                            .map_err(|_| fail("players", "mapped time unrepresentable"))
                    };
                    if sample(&group[*ai].0)? != sample(&group[*bi].0)? {
                        return Err(Error::new(
                            "DRIVER_CONFLICT",
                            group[*bi].1,
                            "one player has incompatible nested playheads; bind a separate player",
                        ));
                    }
                }
            }
        }
    }
    // The compiler coalesces matching inherited routes. Charge traversal work
    // here without constructing a second unused route set.
    for _ in &e.routes {
        spend(work)?;
    }
    Ok(())
}
