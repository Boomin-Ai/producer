use super::{check, lookup, model::*};
use producer_production_contract::{AssetKind, Document, Placement, Result, Source, Time};
use std::collections::BTreeSet;

fn label(value: &str, path: &str) -> Result<()> {
    check(!value.trim().is_empty(), path, "nonempty text required")
}
fn camera(c: &Camera, path: &str) -> Result<()> {
    let positive = [c.focal_length_mm, c.aperture_f, c.focus_distance_m]
        .into_iter()
        .flatten()
        .all(|v| v > 0.0);
    check(
        positive
            && c.iso != Some(0)
            && c.white_balance_k != Some(0)
            && c.shutter_angle_deg.is_none_or(|x| x > 0.0 && x <= 360.0)
            && c.pitch_deg.is_none_or(|x| x.abs() <= 90.0)
            && [c.yaw_deg, c.roll_deg]
                .into_iter()
                .flatten()
                .all(|x| x.abs() <= 180.0),
        path,
        "camera parameter outside its unit range",
    )
}
fn references(refs: &[Reference], d: &Document) -> Result<()> {
    for r in refs {
        let asset = lookup(&d.assets, &r.asset, "reference.asset")?;
        let compatible = match r.role {
            RefRole::Voice | RefRole::Sound => asset.kind == AssetKind::Audio,
            RefRole::CameraMotion => asset.kind == AssetKind::Video,
            RefRole::FirstFrame | RefRole::LastFrame => asset.kind == AssetKind::Image,
            _ => matches!(asset.kind, AssetKind::Image | AssetKind::Video),
        };
        check(
            compatible,
            &r.asset,
            "reference role incompatible with media kind",
        )?;
        if let Some(range) = r.range {
            let end = range.end()?;
            check(
                asset
                    .available
                    .is_some_and(|a| a.start <= range.start && a.end().is_ok_and(|e| e >= end)),
                &r.asset,
                "reference exceeds source range",
            )?;
        }
    }
    Ok(())
}
fn placement<'a>(d: &'a Document, cut: &Cut) -> Result<&'a Placement> {
    lookup(&d.sequences, &cut.sequence, "cut.sequence")?
        .placements
        .iter()
        .find(|p| p.id == cut.placement)
        .ok_or_else(|| super::bad(&cut.placement, "unknown placement in sequence"))
}
pub fn shot_timing<'a>(d: &'a Document, s: &Shot) -> Result<(Option<&'a Placement>, Time)> {
    match (&s.cut, s.planned_duration) {
        (Some(cut), None) => {
            let p = placement(d, cut)?;
            Ok((Some(p), p.range.duration))
        }
        (None, Some(duration)) if duration > Time::ZERO => Ok((None, duration)),
        _ => Err(super::bad(
            "shot",
            "supply a placed cut or a positive planned duration",
        )),
    }
}
fn generation_model(m: &Model) -> Result<()> {
    label(&m.provider, "model.provider")?;
    label(&m.name, "model.name")
}
fn direction(s: &Direction, m: &Manifest, d: &Document, duration: Time) -> Result<()> {
    if let Some(c) = &s.camera {
        camera(c, "shot.camera")?;
    }
    if let Some(id) = &s.location {
        check(
            lookup(&m.entities, id, "location")?.kind == EntityKind::Location,
            id,
            "location entity required",
        )?;
    }
    for id in &s.cast {
        lookup(&m.entities, id, "cast")?;
    }
    references(&s.references, d)?;
    let utf16: BTreeSet<usize> = std::iter::once(0)
        .chain(s.prompt.chars().scan(0, |end, ch| {
            *end += ch.len_utf16();
            Some(*end)
        }))
        .collect();
    let mut previous = 0;
    for mention in &s.mentions {
        lookup(&m.entities, &mention.entity, "mention.entity")?;
        check(
            mention.start >= previous
                && mention.start < mention.end
                && utf16.contains(&mention.start)
                && utf16.contains(&mention.end),
            "mention",
            "invalid or overlapping UTF-16 span",
        )?;
        previous = mention.end;
    }
    for beat in &s.beats {
        check(
            beat.range.start >= Time::ZERO && beat.range.end()? <= duration,
            "beat.range",
            "beat outside shot",
        )?;
        if let Some(c) = &beat.camera {
            camera(c, "beat.camera")?;
        }
        if let Some(n) = &beat.narration {
            check(
                lookup(&m.entities, &n.speaker, "narration.speaker")?.kind == EntityKind::Character,
                &n.speaker,
                "character required",
            )?;
            label(&n.language, "narration.language")?;
            label(&n.text, "narration.text")?;
            if let Some(id) = &n.audio_asset {
                check(
                    lookup(&d.assets, id, "narration.audio")?.kind == AssetKind::Audio,
                    id,
                    "audio required",
                )?;
            }
        }
    }
    Ok(())
}
pub fn validate(m: &Manifest, d: &Document) -> Result<()> {
    for key in m.sequence_setups.keys() {
        lookup(&d.sequences, key, "sequenceSetups")?;
    }
    for setup in m
        .setup
        .iter()
        .chain(m.sequence_setups.values())
        .chain(m.universes.values().filter_map(|u| u.setup.as_ref()))
    {
        if let Some(c) = &setup.camera {
            camera(c, "setup.camera")?;
        }
    }
    for origin in m
        .universes
        .values()
        .filter_map(|u| u.origin.as_ref())
        .chain(m.entities.values().filter_map(|e| e.origin.as_ref()))
    {
        check(
            super::production_id(&origin.production)
                && super::valid_hash(&origin.revision)
                && producer_production_contract::validate::valid_id(&origin.id),
            "origin",
            "invalid pinned resource origin",
        )?;
    }
    for u in m.universes.values() {
        label(&u.name, "universe.name")?;
    }
    for a in m.actors.values() {
        label(&a.name, "actor.name")?;
    }
    for e in m.entities.values() {
        label(&e.name, "entity.name")?;
        if let Some(v) = &e.voice {
            check(
                e.kind == EntityKind::Character
                    && !v.provider.trim().is_empty()
                    && !v.id.trim().is_empty(),
                "entity.voice",
                "voice requires character and provider identity",
            )?;
        }
        if let Some(id) = &e.universe {
            lookup(&m.universes, id, "entity.universe")?;
        }
        if let Some(id) = &e.played_by {
            lookup(&m.actors, id, "entity.playedBy")?;
        }
        references(&e.references, d)?;
    }
    for s in m.shots.values() {
        if let Some(u) = &s.universe {
            lookup(&m.universes, u, "shot.universe")?;
        }
        let (p, duration) = shot_timing(d, s)?;
        label(&s.title, "shot.title")?;
        direction(&s.direction, m, d, duration)?;
        if let Some(model) = &s.intended_model {
            generation_model(model)?;
        }
        for (id, t) in &s.takes {
            check(
                producer_production_contract::validate::valid_id(id),
                id,
                "invalid take id",
            )?;
            let a = lookup(&d.assets, &t.asset, id)?;
            if let Some(mic) = &t.microphone {
                check(
                    mic.sample_rate_hz.is_none_or(|r| r > 0)
                        && mic.distance_m.is_none_or(|d| d >= 0.0)
                        && !mic.channels.is_empty()
                        && mic.channels.iter().all(|s| !s.trim().is_empty()),
                    id,
                    "invalid microphone capture",
                )?;
            }
            if let Some(c) = &t.camera {
                camera(c, id)?;
            }
            if let Some(model) = &t.model {
                generation_model(model)?;
            }
            if t.origin == Origin::Generated {
                check(
                    t.model.is_some()
                        && t.prompt_snapshot
                            .as_ref()
                            .is_some_and(|p| !p.trim().is_empty())
                        && t.direction_snapshot.is_some()
                        && t.recipe_revision.as_deref().is_some_and(super::valid_hash),
                    id,
                    "generated take requires model, prompt and direction receipt",
                )?;
            }
            if let Some(dir) = &t.direction_snapshot {
                direction(dir, m, d, a.available.map_or(duration, |r| r.duration))?;
            }
        }
        if let Some(id) = &s.selected_take {
            let t = lookup(&s.takes, id, "selectedTake")?;
            check(
                p.is_none_or(|placement|matches!(d.sources.get(&placement.source),Some(Source::Player{asset}) if asset == &t.asset)),
                id,
                "selected take differs from placed asset",
            )?;
        }
    }
    for c in m.contributions.values() {
        let actor = lookup(&m.actors, &c.actor, "contribution.actor")?;
        placement(d, &c.cut)?;
        if let Some(id) = &c.featured_entity {
            lookup(&m.entities, id, "contribution.featuredEntity")?;
        }
        if c.kind == CreditKind::BrandPlacement {
            check(
                actor.kind == ActorKind::Brand
                    && c.featured_entity.is_some()
                    && c.disclosure.as_ref().is_some_and(|s| !s.trim().is_empty()),
                "contribution",
                "brand, featured entity and disclosure required",
            )?;
        }
    }
    let mut routes = BTreeSet::new();
    for x in &m.mix {
        let seq = lookup(&d.sequences, &x.sequence, "mix.sequence")?;
        check(
            seq.audio_routes.iter().any(|r| r.id == x.route)
                && routes.insert((&x.sequence, &x.route))
                && (-96000..=24000).contains(&x.gain_millidb)
                && (-1000..=1000).contains(&x.balance_permille),
            &x.route,
            "invalid mix target, gain or stereo balance",
        )?;
    }
    Ok(())
}
