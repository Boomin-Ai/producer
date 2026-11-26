//! Producer Protocol v1. A production is an editable, offline package with verified bytes.
mod creative;
mod session;
pub mod model;
use contract::{Document, Error, Result, DOCUMENT_BYTES};
use model::*;
use producer_production_contract as contract;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs::File, io::Read, path::Path};

fn bad(path: &str, reason: &str) -> Error {
    Error::new("PROTOCOL_INVALID", path, reason)
}
fn check(pass: bool, path: &str, reason: &str) -> Result<()> {
    if pass {
        Ok(())
    } else {
        Err(bad(path, reason))
    }
}
fn lookup<'a, T>(map: &'a Map<T>, id: &str, path: &str) -> Result<&'a T> {
    map.get(id)
        .ok_or_else(|| bad(path, "referenced object does not exist"))
}
fn hash_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn read_file(path: &Path) -> Result<File> {
    let error =
        |e: std::io::Error| Error::new("BUNDLE_FILE", path.display().to_string(), e.to_string());
    let metadata = path.symlink_metadata().map_err(error)?;
    check(
        metadata.is_file(),
        &path.display().to_string(),
        "bundle entry must be a regular file",
    )?;
    File::open(path).map_err(error)
}
fn read_json(path: &Path) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    read_file(path)?
        .take(DOCUMENT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| Error::new("BUNDLE_FILE", "metadata", e.to_string()))?;
    check(
        bytes.len() <= DOCUMENT_BYTES,
        "metadata",
        "input exceeds document byte limit",
    )?;
    Ok(bytes)
}
fn production_id(value: &str) -> bool {
    value
        .strip_prefix("urn:uuid:")
        .and_then(|s| uuid::Uuid::parse_str(s).ok())
        .is_some_and(|u| !u.is_nil() && u.urn().to_string() == value)
}
fn valid_hash(hash: &str) -> bool {
    contract::validate::hash(hash)
}

fn work_digest(raw: Value) -> Result<String> {
    let mut body = raw
        .as_object()
        .cloned()
        .ok_or_else(|| bad("manifest", "expected an object"))?;
    // Exclude revision authorship and workflow so review approvals can survive
    // workflow-only updates while any creative change invalidates the approval.
    for k in ["authoredAt", "author", "workflow", "parent"] {
        body.remove(k);
    }
    let canonical = contract::ingress::canonical(&Value::Object(body))?;
    Ok(hash_bytes(&canonical))
}

fn workflow(m: &Manifest, work: &str) -> Result<()> {
    let f = &m.workflow;
    let author = lookup(&m.actors, &m.author, "author")?;
    label_identity(author)?;
    if let Some(r) = &f.review {
        lookup(&m.actors, &r.actor, "workflow.review.actor")?;
        check(
            valid_hash(&r.work_sha256),
            "review.workSha256",
            "invalid review digest",
        )?;
    }
    if let Some(start) = f.started_at {
        check(
            start <= m.authored_at,
            "workflow.startedAt",
            "start date is after revision date",
        )?;
    }
    if let Some(end) = f.ended_at {
        check(
            end <= m.authored_at && f.started_at.is_none_or(|s| s <= end),
            "workflow.endedAt",
            "end date outside production interval",
        )?;
    }
    check(
        match f.state {
            Lifecycle::Planned => f.started_at.is_none() && f.ended_at.is_none(),
            Lifecycle::Active => f.started_at.is_some() && f.ended_at.is_none(),
            Lifecycle::Completed => f.started_at.is_some() && f.ended_at.is_some(),
            Lifecycle::Cancelled => f.ended_at.is_some(),
        },
        "workflow.state",
        "invalid start or end timestamps",
    )?;
    for task in f.tasks.values() {
        if let Some(id) = &task.owner {
            lookup(&m.actors, id, "workflow.tasks.owner")?;
        }
        if let Some(id) = &task.shot {
            lookup(&m.shots, id, "workflow.tasks.shot")?;
        }
        if task.state == TaskState::Blocked {
            check(
                task.note.as_ref().is_some_and(|n| !n.trim().is_empty()),
                "workflow.tasks",
                "blocked task requires a reason",
            )?;
        }
        check(
            !task.title.trim().is_empty(),
            "workflow.tasks.title",
            "task needs a title",
        )?;
    }
    if f.state == Lifecycle::Completed {
        check(
            f.review.as_ref().is_some_and(|r| r.actor == m.author),
            "workflow.review",
            "reviewer must attest the completed snapshot",
        )?;
        check(
            f.tasks
                .values()
                .all(|t| !t.required || t.state == TaskState::Done),
            "workflow.tasks",
            "required work remains unfinished",
        )?;
        check(
            f.review
                .as_ref()
                .is_some_and(|r| r.decision == Decision::Approved && r.work_sha256 == work),
            "workflow.review",
            "completion requires approval of this work revision",
        )?;
    }
    Ok(())
}

fn label_identity(actor: &Actor) -> Result<()> {
    check(
        actor.identity.as_ref().is_some_and(|v| !v.is_empty()),
        "author",
        "signing actor identity required",
    )
}

pub fn schema() -> Value {
    serde_json::to_value(schemars::schema_for!(Manifest)).unwrap()
}

pub struct OpenBundle {
    pub manifest: Manifest,
    pub revision: String,
    pub work_sha256: String,
    pub document: Document,
}

impl OpenBundle {
    pub fn open(root: &Path) -> Result<Self> {
        let raw_manifest = read_json(&root.join("manifest.json"))?;
        let raw_value = contract::ingress::parse(&raw_manifest, DOCUMENT_BYTES)?;
        let manifest: Manifest = serde_json::from_value(raw_value.clone())
            .map_err(|e| bad("manifest", &e.to_string()))?;
        let work_sha256 = work_digest(raw_value)?;
        let doc = read_json(&root.join("production.json"))?;
        check(
            hash_bytes(&doc) == manifest.document_sha256,
            "production.json",
            "document bytes failed integrity check",
        )?;
        let work = Self {
            manifest,
            revision: hash_bytes(&raw_manifest),
            work_sha256,
            document: contract::parse_document(&doc)?,
        };
        work.validate(root)?;
        Ok(work)
    }
    fn validate(&self, root: &Path) -> Result<()> {
        let m = &self.manifest;
        let d = &self.document;
        check(
            production_id(&m.production),
            "production",
            "canonical non-nil UUID URN required",
        )?;
        check(
            m.parent.as_deref().is_none_or(valid_hash),
            "parent",
            "invalid parent revision",
        )?;
        workflow(m, &self.work_sha256)?;
        if let Some(entry) = &m.entry {
            let show = lookup(&d.shows, &entry.show, "entry.show")?;
            check(
                show.segments.iter().any(|s| s.id == entry.segment),
                "entry",
                "unknown segment",
            )?;
        } else {
            check(
                m.workflow.state != Lifecycle::Completed,
                "entry",
                "completed work requires a playable entry",
            )?;
        }
        for id in m
            .actors
            .keys()
            .chain(m.entities.keys())
            .chain(m.shots.keys())
            .chain(m.universes.keys())
            .chain(m.contributions.keys())
            .chain(m.workflow.tasks.keys())
        {
            check(contract::validate::valid_id(id), id, "invalid local id")?;
        }
        for (id, ext) in &m.extensions {
            check(
                id.contains('.') && id.split('.').all(contract::validate::valid_id),
                id,
                "reverse-domain extension name required",
            )?;
            if ext.required {
                return Err(bad(id, "unknown required extension"));
            }
        }
        check(
            m.assets.len() == d.assets.len(),
            "assets",
            "asset count differs",
        )?;
        let mut hashes = std::collections::BTreeSet::new();
        for (id, a) in &d.assets {
            let r = lookup(&m.assets, id, id)?;
            check(r.original.sha256 == a.hash, id, "asset hash mismatch")?;
            check(
                a.kind == contract::AssetKind::Video || r.proxies.is_empty(),
                id,
                "v1 proxies supported for video only",
            )?;
            for repr in std::iter::once(&r.original).chain(&r.proxies) {
                check(
                    valid_hash(&repr.sha256) && !repr.format.trim().is_empty(),
                    id,
                    "invalid representation",
                )?;
                if a.kind == contract::AssetKind::Video {
                    let (w, h) = (repr.width.unwrap_or(0), repr.height.unwrap_or(0));
                    check(
                        w > 0
                            && h > 0
                            && u64::from(w) * u64::from(r.original.height.unwrap_or(0))
                                == u64::from(h) * u64::from(r.original.width.unwrap_or(0)),
                        id,
                        "video dimensions or proxy aspect differ",
                    )?;
                }
                hashes.insert(&repr.sha256);
            }
        }
        for score in m.music_sessions.values() {
            check(valid_hash(&score.arrangement_sha256), "musicSessions", "invalid score digest")?;
            hashes.insert(&score.arrangement_sha256);
        }
        if !hashes.is_empty() {
            check(
                root.join("blobs")
                    .symlink_metadata()
                    .is_ok_and(|t| t.is_dir()),
                "blobs",
                "regular directory required",
            )?;
        }
        for hash in hashes {
            let mut f = read_file(&root.join("blobs").join(hash))?;
            let mut digest = Sha256::new();
            std::io::copy(&mut f, &mut digest).map_err(|e| bad(hash, &e.to_string()))?;
            check(
                format!("{:x}", digest.finalize()) == *hash,
                hash,
                "media bytes failed integrity check",
            )?;
        }
        // Text nodes pin fonts by byte hash directly in the native contract.
        let fonts: std::collections::BTreeSet<_> = d
            .assets
            .values()
            .filter(|a| a.kind == contract::AssetKind::Font)
            .map(|a| &a.hash)
            .collect();
        fn fonts_present(
            n: &contract::Node,
            fonts: &std::collections::BTreeSet<&String>,
        ) -> Result<()> {
            if let contract::Content::Text { font, .. } = &n.content {
                check(
                    fonts.contains(font),
                    font,
                    "font bytes missing from portable assets",
                )?;
            }
            for child in &n.children {
                fonts_present(child, fonts)?;
            }
            Ok(())
        }
        for node in d
            .sets
            .values()
            .flat_map(|s| s.layouts.values().map(|l| &l.root))
            .chain(d.components.values().map(|c| &c.root))
        {
            fonts_present(node, &fonts)?;
        }
        creative::validate(m, d)?;
        session::validate_sessions(m, d, root)?;
        Ok(())
    }
    pub fn plan(&self, device: &Device) -> Result<Value> {
        check(
            device.max_video_width > 0 && device.max_video_height > 0,
            "device",
            "positive video budget required",
        )?;
        let mut selected = BTreeMap::new();
        for (id, media) in &self.manifest.assets {
            let fits = |r: &&Representation| {
                device.formats.contains(&r.format)
                    && (self.document.assets[id].kind != contract::AssetKind::Video
                        || (r.width.unwrap_or(0) <= device.max_video_width
                            && r.height.unwrap_or(0) <= device.max_video_height))
            };
            let chosen = std::iter::once(&media.original)
                .filter(fits)
                .next()
                .or_else(|| media.proxies.iter().filter(fits).max_by_key(|r| r.width))
                .ok_or_else(|| {
                    Error::new(
                        "NO_REPRESENTATION",
                        id,
                        "device cannot decode any representation within budget",
                    )
                })?;
            selected.insert(id, chosen);
        }
        let slots: BTreeMap<_, _> = self
            .document
            .sources
            .iter()
            .filter_map(|(id, s)| match s {
                contract::Source::Live { role } => Some((id, role)),
                _ => None,
            })
            .collect();
        Ok(
            json!({"production":self.manifest.production,"revision":self.revision,"workSha256":self.work_sha256,
            "entry":self.manifest.entry,"selected":selected,"liveSlots":slots,"mix":self.manifest.mix,
            "workflow":self.manifest.workflow,"reviewCurrent":self.manifest.workflow.review.as_ref().is_some_and(|r|r.work_sha256==self.work_sha256)}),
        )
    }
}

impl OpenBundle {
    /// One resolved reference sheet for an agent or generation provider.
    pub fn sheet(&self, id: &str) -> Result<Value> {
        let m = &self.manifest;
        let shot = lookup(&m.shots, id, "shot")?;
        let (placement, duration) = creative::shot_timing(&self.document, shot)?;
        let mut cast = Map::new();
        let mut worlds = Map::new();
        let credits: BTreeMap<_, _> = m
            .contributions
            .iter()
            .filter(|(_, c)| {
                shot.cut.as_ref().is_some_and(|cut| {
                    c.cut.sequence == cut.sequence && c.cut.placement == cut.placement
                })
            })
            .collect();
        let dir = &shot.direction;
        for e in dir
            .cast
            .iter()
            .chain(&dir.location)
            .chain(credits.values().filter_map(|c| c.featured_entity.as_ref()))
            .chain(dir.mentions.iter().map(|m| &m.entity))
            .chain(
                dir.beats
                    .iter()
                    .filter_map(|b| b.narration.as_ref().map(|n| &n.speaker)),
            )
        {
            let entity = &m.entities[e];
            cast.insert(e.clone(), entity);
            if let Some(u) = &entity.universe {
                worlds.insert(u.clone(), &m.universes[u]);
            }
        }
        if let Some(id) = &shot.universe {
            worlds.insert(id.clone(), &m.universes[id]);
        }
        let mut setup = serde_json::Map::new();
        let mut camera = serde_json::Map::new();
        let mut environment = serde_json::Map::new();
        fn overlay(map: &mut serde_json::Map<String, Value>, value: Value) {
            if let Value::Object(fields) = value {
                map.extend(fields.into_iter().filter(|(_, v)| !v.is_null()));
            }
        }
        for defaults in m
            .setup
            .iter()
            .chain(
                shot.universe
                    .iter()
                    .filter_map(|id| m.universes[id].setup.as_ref()),
            )
            .chain(
                shot.cut
                    .as_ref()
                    .and_then(|c| m.sequence_setups.get(&c.sequence)),
            )
        {
            overlay(&mut setup, json!(defaults));
            if let Some(env) = &defaults.environment { overlay(&mut environment, json!(env)); }
            if let Some(c) = &defaults.camera {
                overlay(&mut camera, json!(c));
            }
        }
        if let Some(c) = &dir.camera {
            overlay(&mut camera, json!(c));
        }
        if let Some(light) = &dir.lighting {
            setup.insert("lighting".into(), json!(light));
        }
        if let Some(id) = &dir.location { environment.insert("location".into(), json!(id)); }
        if let Some(env) = &dir.environment { overlay(&mut environment,json!(env)); }
        setup.insert("environment".into(), json!(environment));
        setup.insert("camera".into(), json!(camera));
        let resolved_beats: Vec<_> = dir.beats.iter().map(|b| {
            let mut beat_env = environment.clone();
            if let Some(env) = &b.environment { overlay(&mut beat_env,json!(env)); }
            let mut effective = camera.clone();
            if let Some(c) = &b.camera { overlay(&mut effective,json!(c)); }
            json!({"range":b.range,"environment":beat_env,"camera":effective,"action":b.action,"narration":b.narration})
        }).collect();
        let actors: BTreeMap<_, _> = credits
            .values()
            .map(|c| &c.actor)
            .chain(cast.values().filter_map(|e| e.played_by.as_ref()))
            .map(|id| (id, &m.actors[id]))
            .collect();
        let mut inputs = Map::new();
        let mut counters = BTreeMap::new();
        let mut slots = Vec::new();
        for id in dir
            .references
            .iter()
            .chain(cast.values().flat_map(|e| e.references.iter()))
            .map(|r| &r.asset)
            .chain(
                dir.beats
                    .iter()
                    .filter_map(|b| b.narration.as_ref()?.audio_asset.as_ref()),
            )
        {
            if inputs.insert(id.clone(), &m.assets[id].original).is_none() {
                let kind = match self.document.assets[id].kind {
                    contract::AssetKind::Image => "Image",
                    contract::AssetKind::Video => "Video",
                    contract::AssetKind::Audio => "Audio",
                    _ => return Err(bad(id, "unsupported reference kind")),
                };
                let n = counters.entry(kind).or_insert(0);
                *n += 1;
                slots.push(json!({"slot":format!("@{kind}{n}"),"asset":id,"sha256":m.assets[id].original.sha256}));
            }
        }
        Ok(
            json!({"production":m.production,"revision":self.revision,"shot":id,"title":shot.title,
            "resolvedSetup":setup,"resolvedBeats":resolved_beats,"cut":shot.cut,"range":placement.map(|p|p.range),"duration":duration,"sourceIn":placement.map(|p|p.source_in),"direction":dir,
            "intendedModel":shot.intended_model,"universes":worlds,"entities":cast,"inputs":inputs,"referenceSlots":slots,
            "contributions":credits,"actors":actors,"takes":shot.takes,"selectedTake":shot.selected_take}),
        )
    }
}
