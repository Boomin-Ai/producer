//! Portable participant bindings, authored environment and editable DAW attachments.
use super::{bad, check, lookup, model::*, read_file, valid_hash, OpenBundle};
use producer_production_contract::{
    validate::valid_id, AssetKind, Document, ParticipantTrack, Result, Source,
};
use serde_json::{json, Value};
use std::{io::Read, path::Path};

pub(crate) fn environment(env: &Environment, m: &Manifest) -> Result<()> {
    if let Some(id) = &env.location {
        check(
            lookup(&m.entities, id, "environment.location")?.kind == EntityKind::Location,
            id,
            "expected location entity",
        )?;
    }
    if let Some(c) = &env.coordinates {
        check(
            (-90.0..=90.0).contains(&c.latitude) && (-180.0..=180.0).contains(&c.longitude),
            "environment.coordinates",
            "invalid WGS84 coordinates",
        )?;
    }
    check(
        env.utc_offset_minutes
            .is_none_or(|v| (-840..=840).contains(&v))
            && env.time_zone.as_ref().is_none_or(|s| !s.trim().is_empty()),
        "environment",
        "invalid civil time metadata",
    )
}

pub(crate) fn validate_sessions(m: &Manifest, d: &Document, root: &Path) -> Result<()> {
    for set in d.sets.values() {
        for slot in set.participant_inputs.values() {
            lookup(&m.actors, &slot.actor, "participantInputs.actor")?;
        }
    }
    for (id, session) in &m.music_sessions {
        check(
            valid_id(id)
                && valid_hash(&session.arrangement_sha256)
                && session.rendered_from == session.arrangement_sha256,
            id,
            "stem must identify the score revision it renders",
        )?;
        let seq = lookup(&d.sequences, &session.cut.sequence, id)?;
        let clip = seq
            .placements
            .iter()
            .find(|p| p.id == session.cut.placement)
            .ok_or_else(|| bad(id, "missing stem placement"))?;
        let Source::Player { asset } = &d.sources[&clip.source] else {
            return Err(bad(id, "stem requires an audio player"));
        };
        let repr = &m.assets[asset].original;
        check(
            d.assets[asset].kind == AssetKind::Audio
                && repr.format == "pcm-wav"
                && (8000..=192000).contains(&session.sample_rate_hz)
                && seq.cues.iter().any(|c| c.id == session.picture_cue)
                && seq.audio_routes.iter().any(|r| {
                    r.source == clip.source && r.bus == producer_production_contract::Bus::Program
                }),
            id,
            "invalid stem, picture cue, or program route",
        )?;
        let wav = hound::WavReader::new(read_file(&root.join("blobs").join(&repr.sha256))?)
            .map_err(|e| bad(id, &e.to_string()))?;
        let span = d.assets[asset]
            .available
            .ok_or_else(|| bad(id, "stem availability missing"))?;
        check(
            wav.spec().sample_rate == session.sample_rate_hz
                && wav.spec().sample_format == hound::SampleFormat::Int
                && span.start == producer_production_contract::Time::ZERO
                && producer_production_contract::Time::new(
                    wav.duration().into(),
                    session.sample_rate_hz,
                )? >= span.duration,
            id,
            "stem PCM rate or coverage differs",
        )?;
        let f = read_file(&root.join("blobs").join(&session.arrangement_sha256))?;
        let mut zip = zip::ZipArchive::new(f).map_err(|e| bad(id, &e.to_string()))?;
        check(zip.len() <= 8192, id, "score member budget exceeded")?;
        let mut names = std::collections::BTreeSet::new();
        for i in 0..zip.len() {
            let entry = zip.by_index(i).map_err(|e| bad(id, &e.to_string()))?;
            check(
                entry.enclosed_name().is_some() && names.insert(entry.name().to_owned()),
                id,
                "invalid or duplicate score member",
            )?;
        }
        let xml = zip
            .by_name("project.xml")
            .map_err(|_| bad(id, "missing DAWproject score"))?;
        let mut bytes = String::new();
        xml.take(8 * 1024 * 1024 + 1)
            .read_to_string(&mut bytes)
            .map_err(|e| bad(id, &e.to_string()))?;
        check(
            bytes.len() <= 8 * 1024 * 1024,
            id,
            "score XML exceeds budget",
        )?;
        let doc = roxmltree::Document::parse_with_options(
            &bytes,
            roxmltree::ParsingOptions {
                nodes_limit: 131072,
                ..Default::default()
            },
        )
        .map_err(|e| bad(id, &e.to_string()))?;
        check(
            doc.root_element().has_tag_name("Project")
                && doc.root_element().attribute("version") == Some("1.0"),
            id,
            "expected DAWproject version 1.0",
        )?;
    }
    Ok(())
}

impl OpenBundle {
    pub fn readiness(
        &self,
        set_id: &str,
        layout: &str,
        observations: &Map<GuestObservation>,
    ) -> Result<Value> {
        let set = lookup(&self.document.sets, set_id, "set")?;
        lookup(&set.layouts, layout, "layout")?;
        let mut inputs = Vec::new();
        let mut ready = true;
        for (id, input) in &set.participant_inputs {
            if !input.layouts.is_empty() && !input.layouts.iter().any(|v| v == layout) {
                continue;
            }
            let present = observations.get(&input.source).is_some_and(|obs| {
                obs.actor == input.actor
                    && match input.track {
                        ParticipantTrack::Audio => obs.audio,
                        ParticipantTrack::Video => obs.video,
                    }
            });
            ready &= !input.required || present;
            inputs.push(json!({"id":id,"actor":input.actor,"source":input.source,"track":input.track,"required":input.required,"present":present}));
        }
        Ok(json!({"set":set_id,"layout":layout,"ready":ready,"inputs":inputs}))
    }
}
