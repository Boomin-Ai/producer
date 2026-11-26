//! Install the authored Native Dev set library once per studio, under its room lock.
use crate::model::RoomProject;
use anyhow::{ensure, Context, Result};
use producer_production_contract::{Asset, AssetKind, Role, Set, Show, Source};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, io::Write, path::Path};

#[derive(Deserialize)]
struct Catalog {
    sets: BTreeMap<String, Set>,
    shows: BTreeMap<String, Show>,
    assets: BTreeMap<String, Asset>,
    sources: BTreeMap<String, Source>,
}
macro_rules! image {
    ($name:literal) => {
        (
            $name,
            include_bytes!(concat!("../starter-sets/", $name, ".png")).as_slice(),
        )
    };
}
const IMAGES: &[(&str, &[u8])] = &[
    image!("observatory"),
    image!("aerie-relief"),
    image!("aerie-sky"),
    image!("meridian-rooftop"),
    image!("meridian-shopfront"),
];
const LEGACY_RECEIPT: &str = "starter-sets-v1.installed";
const SPEAKER_RECEIPT: &str = "starter-sets-v2.installed";
const CLASSIC_RECEIPT: &str = "starter-sets-v4.installed";
const MFM_RECEIPT: &str = "starter-sets-v5.installed";
const RECEIPT: &str = "starter-sets-v6.installed";
const RETIRED: [&str; 4] = ["studio", "waves", "podcast", "podcast-studio"];
const CLASSIC_SKYLINE_HASH: &str = "ab06936944a63d57755ab8f1cc3ee96abaa2ee7a7902efc4d64ae8bc329f4c46";
const CLASSIC_SKYLINE: &[u8] = include_bytes!("../starter-sets/classic-skyline.png");

pub(crate) fn aerie(room: &mut RoomProject) -> Result<crate::studio_presets::AuthoredStudio> {
    let mut catalog: Catalog = serde_json::from_slice(include_bytes!("../starter-sets/catalog.json"))?;
    for (id, asset) in catalog.assets {
        room.production.assets.entry(id).or_insert(asset);
    }
    for (id, source) in catalog.sources {
        room.production.sources.entry(id).or_insert(source);
    }
    let id = "atmosphere-aerie";
    Ok(crate::studio_presets::AuthoredStudio {
        set: catalog.sets.remove(id).context("Atmosphere Aerie set is missing")?,
        show: catalog.shows.remove(id).context("Atmosphere Aerie show is missing")?,
    })
}

pub(crate) fn register_classic_skyline(room: &mut RoomProject) {
    room.production.assets.entry("classic-skyline".into()).or_insert(Asset {
        hash: CLASSIC_SKYLINE_HASH.into(),
        kind: AssetKind::Image,
        available: None,
    });
}

fn digest(value: &impl Serialize) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}
const WAVES_DIGEST: &str = "179f711389ad00b2b92aa41b45176a599f444a65ed243b45004fc7990281caa3";

fn retire_stock_sets(room: &mut RoomProject) -> Result<()> {
    let original = RoomProject::demo();
    for id in RETIRED {
        let Some(set) = room.production.sets.get(id) else { continue };
        let stock = match id {
            "studio" => set == &original.production.sets["studio"],
            "waves" => digest(set)? == WAVES_DIGEST,
            "podcast" => digest(set)? == "1f46dab961c532ca297a4595dfc9ba30fff7045d60d4f8bc62e6872943d35063",
            "podcast-studio" => digest(set)? == "5d92a0120f95c82a9593503519ad62faca5fbd85d8d1031a633089db34a926e7",
            _ => unreachable!(),
        };
        if !stock { continue; }

        // Keep a studio's authored shows and automation if they rely on this Set.
        let prefix = format!("sets/{id}/");
        let uses_set = |path: &str| path.starts_with(&prefix);
        let mut stock_shows = Vec::new();
        for (key, show) in room.production.shows.iter().filter(|(_, show)| show.set == id) {
            let stock = match (id, key.as_str()) {
                ("studio", _) => original.production.shows.get(key) == Some(show),
                ("podcast", "podcast-show") => digest(show)? == "fdab46317e6679b82b2e0c4b02e1a2688bd852d7a4c6b9bdfaa98a2408c78be9",
                ("podcast-studio", "podcast-studio") => digest(show)? == "56b3fd32d0775a4b2162d584dffe4d8af28ca17fc2e5a0fa53b068eeeadd7934",
                _ => false,
            };
            if stock { stock_shows.push(key.clone()); }
        }
        let custom_show = room.production.shows.values().filter(|show| show.set == id).count() != stock_shows.len();
        let custom_motion = room.production.sequences.iter().any(|(key, seq)| {
            seq.tracks.iter().any(|track| uses_set(&track.target.path)
                && !(key == "main" && original.production.sequences["main"].tracks.contains(track)))
                || seq.instances.iter().flat_map(|instance| &instance.target_bindings)
                    .any(|binding| uses_set(&binding.from.path) || uses_set(&binding.to.path))
        });
        let custom_action = room.production.sets.values().flat_map(|set| set.actions.values().flatten())
            .any(|action| matches!(action, producer_production_contract::Action::SetParameter { target, .. } if uses_set(&target.path)));
        if custom_show || custom_motion || custom_action { continue; }

        let replacement = ["classic", "atmosphere-aerie", crate::speaker_split::ID].into_iter()
            .chain(room.production.sets.keys().map(String::as_str))
            .find(|key| !RETIRED.contains(key) && room.production.sets.get(*key)
                .is_some_and(|set| set.layouts.contains_key("landscape") && set.layouts.contains_key("vertical")))
            .map(str::to_owned);
        let Some(replacement) = replacement else { continue };
        room.production.sets.remove(id);
        if room.scene == id { room.scene.clone_from(&replacement); }
        if room.mounted_set.as_deref() == Some(id) {
            room.mounted_set = Some(replacement.clone());
            room.mounted_layout = None;
        }
        for scene in room.room_scenes.values_mut() {
            if scene.mounted_set.as_deref() == Some(id) {
                scene.mounted_set = Some(replacement.clone());
                scene.mounted_layout = None;
            }
        }
        for key in stock_shows {
            if key == "native-show" {
                room.production.shows.get_mut(&key).unwrap().set.clone_from(&replacement);
            } else {
                room.production.shows.remove(&key);
            }
        }
        for seq in room.production.sequences.values_mut() {
            seq.tracks.retain(|track| !uses_set(&track.target.path));
        }
    }
    Ok(())
}

fn write_missing(path: &Path, bytes: &[u8]) -> Result<()> {
    if path.exists() {
        return Ok(());
    }
    let mut temp = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
    temp.write_all(bytes)?;
    temp.as_file().sync_all()?;
    temp.persist_noclobber(path)?;
    Ok(())
}

fn install_my_first_million(room: &mut RoomProject, assets: &Path) -> Result<()> {
    const ID: &str = "my-first-million";
    let doc = &mut room.production;
    if doc.sets.contains_key(ID) || doc.shows.contains_key(ID) {
        return Ok(());
    }
    let studio: crate::studio_presets::AuthoredStudio =
        serde_json::from_slice(include_bytes!("../starter-sets/my-first-million.json"))?;
    for (name, bytes) in [
        image!("my-first-million-logo"),
        image!("my-first-million-sam"),
        image!("my-first-million-shaan"),
    ] {
        let hash = format!("{:x}", Sha256::digest(bytes));
        write_missing(&assets.join(format!("{hash}.png")), bytes)?;
        doc.assets.insert(name.into(), Asset { hash, kind: AssetKind::Image, available: None });
    }
    write_missing(&assets.join("my-first-million-credits.txt"), include_bytes!("../starter-sets/my-first-million-credits.txt"))?;
    for (source, role) in [
        ("camera", Role::HostCamera), ("camera-2", Role::HostCamera),
        ("rtc-guest", Role::Guest), ("screen", Role::Screen),
    ] {
        doc.sources.entry(source.into()).or_insert(Source::Live { role });
    }
    doc.sets.insert(ID.into(), studio.set);
    doc.shows.insert(ID.into(), studio.show);
    Ok(())
}

fn add_mfm_focus_shots(room: &mut RoomProject) -> Result<()> {
    let id = "my-first-million";
    let doc = &mut *room.production;
    let (Some(set), Some(show)) = (doc.sets.get_mut(id), doc.shows.get_mut(id)) else {
        return Ok(());
    };
    if show.set != id {
        return Ok(());
    }
    let stock: crate::studio_presets::AuthoredStudio =
        serde_json::from_slice(include_bytes!("../starter-sets/my-first-million.json"))?;
    let mut position = show.segments.iter().position(|s| s.id == "conversation")
        .map_or(show.segments.len(), |i| i + 1);
    for shot in stock.show.segments.into_iter().filter(|s| matches!(s.id.as_str(), "focus-shaan" | "focus-sam")) {
        if show.segments.iter().any(|s| s.id == shot.id)
            || set.layouts.contains_key(&shot.landscape) || set.layouts.contains_key(&shot.vertical) {
            continue;
        }
        for key in [&shot.landscape, &shot.vertical] {
            set.layouts.insert(key.clone(), stock.set.layouts[key].clone());
        }
        show.segments.insert(position, shot);
        position += 1;
    }
    Ok(())
}

pub(crate) fn install(root: &Path) -> Result<()> {
    if root.join(RECEIPT).is_file() {
        return Ok(());
    }
    let catalog = (!root.join(LEGACY_RECEIPT).is_file())
        .then(|| serde_json::from_slice::<Catalog>(include_bytes!("../starter-sets/catalog.json")))
        .transpose()?;
    let mut room = match fs::read(root.join("room.json")) {
        Ok(doc) => serde_json::from_slice(&doc)?,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            let mut room = RoomProject::demo();
            crate::studio_presets::Starter::Classic.apply(&mut room)?;
            room
        }
        Err(err) => return Err(err.into()),
    };
    let install_classic = !root.join(CLASSIC_RECEIPT).is_file();
    if install_classic {
        register_classic_skyline(&mut room);
        let doc = &mut room.production;
        if let Some(catalog) = &catalog {
            for (key, value) in &catalog.sources {
                doc.sources.entry(key.clone()).or_insert_with(|| value.clone());
            }
            for (key, value) in &catalog.assets {
                doc.assets.entry(key.clone()).or_insert_with(|| value.clone());
            }
            for (key, value) in &catalog.sets {
                doc.sets.entry(key.clone()).or_insert_with(|| value.clone());
            }
            for (key, value) in &catalog.shows {
                if doc.sets.get(&value.set).is_some_and(|set| {
                    value.segments.iter().all(|s| {
                        set.layouts.contains_key(&s.landscape) && set.layouts.contains_key(&s.vertical)
                    })
                }) {
                    doc.shows.entry(key.clone()).or_insert_with(|| value.clone());
                }
            }
        }
        let classic = crate::studio_presets::classic()?;
        doc.sets.entry("classic".into()).or_insert(classic.set);
        doc.shows.entry("classic".into()).or_insert(classic.show);

        doc.sources.entry("rtc-guest".into()).or_insert(Source::Live { role: Role::Guest });
        if !doc.sets.contains_key(crate::speaker_split::ID) && !root.join(SPEAKER_RECEIPT).is_file() {
            doc.sources.entry("camera".into()).or_insert(Source::Live { role: Role::HostCamera });
            doc.sources.entry("rtc-guest".into()).or_insert(Source::Live { role: Role::Guest });
            let set = serde_json::from_slice(include_bytes!("../starter-sets/speaker-split.json"))?;
            doc.sets.insert(crate::speaker_split::ID.into(), set);
        }
        retire_stock_sets(&mut room)?;
    }
    let assets = root.join("assets");
    fs::create_dir_all(&assets)?;
    if root.join(MFM_RECEIPT).is_file() {
        add_mfm_focus_shots(&mut room)?;
    } else {
        install_my_first_million(&mut room, &assets)?;
    }
    room.compile()?;
    ensure!(format!("{:x}", Sha256::digest(CLASSIC_SKYLINE)) == CLASSIC_SKYLINE_HASH, "Invalid Classic skyline");
    write_missing(&assets.join(format!("{CLASSIC_SKYLINE_HASH}.png")), CLASSIC_SKYLINE)?;
    write_missing(&assets.join("classic-skyline-credits.txt"), include_bytes!("../starter-sets/classic-skyline-credits.txt"))?;
    if let Some(catalog) = &catalog {
        for (key, bytes) in IMAGES {
            let digest = &catalog.assets[*key].hash;
            ensure!(
                format!("{:x}", Sha256::digest(bytes)) == *digest,
                "Invalid starter image {key}"
            );
            write_missing(&root.join("assets").join(format!("{digest}.png")), bytes)?;
        }
        write_missing(
            &root.join("weather.json"),
            br#"{"city":"Tokyo","latitude":35.6895,"longitude":139.69171,"timezone":"Asia/Tokyo"}"#,
        )?;
        write_missing(
            &root.join("weather-comparison.json"),
            br#"{"city":"Paris","latitude":48.85341,"longitude":2.3488,"timezone":"Europe/Paris"}"#,
        )?;
    }
    crate::engine::persist(root, &room)?;
    write_missing(&root.join(LEGACY_RECEIPT), b"1\n")?;
    write_missing(&root.join(SPEAKER_RECEIPT), b"2\n")?;
    write_missing(&root.join(CLASSIC_RECEIPT), b"4\n")?;
    write_missing(&root.join(MFM_RECEIPT), b"5\n")?;
    write_missing(&root.join(RECEIPT), b"6\n")
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn focus_upgrade_preserves_studio_edits_and_host_routing() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        install(root).unwrap();
        let mut room: RoomProject = serde_json::from_slice(&fs::read(root.join("room.json")).unwrap()).unwrap();
        let id = "my-first-million";
        let show = room.production.shows.get_mut(id).unwrap();
        show.segments.retain(|s| !s.id.starts_with("focus-"));
        show.segments[0].title = "Custom conversation".into();
        room.production.sets.get_mut(id).unwrap().layouts.retain(|k, _| !k.starts_with("focus-"));
        crate::engine::persist(root, &room).unwrap();
        fs::remove_file(root.join(RECEIPT)).unwrap();
        install(root).unwrap();
        let updated: RoomProject = serde_json::from_slice(&fs::read(root.join("room.json")).unwrap()).unwrap();
        assert_eq!(updated.mounted_set, room.mounted_set);
        assert_eq!(updated.production.shows[id].segments[0].title, "Custom conversation");
        for (i, host, expected) in [(1, "focus-shaan", "camera"), (2, "focus-sam", "camera-2")] {
            let segment = &updated.production.shows[id].segments[i];
            assert_eq!(segment.id, host);
            for key in [&segment.landscape, &segment.vertical] {
                let layout = serde_json::to_value(&updated.production.sets[id].layouts[key]).unwrap();
                let sources: Vec<_> = layout["root"]["children"].as_array().unwrap().iter()
                    .filter_map(|n| n["content"]["source"].as_str()).collect();
                assert_eq!(sources, [expected]);
            }
        }
    }

    #[test]
    fn v4_migration_adds_mfm_without_changing_the_program_or_restoring_removed_sets() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        install(root).unwrap();
        let mut room: RoomProject = serde_json::from_slice(&fs::read(root.join("room.json")).unwrap()).unwrap();
        room.mount_set(Some("atmosphere-aerie".into()), None).unwrap();
        room.production.sets.remove("my-first-million");
        room.production.shows.remove("my-first-million");
        room.production.sets.remove(crate::speaker_split::ID);
        let expected_layout = room.mounted_layout.clone();
        crate::engine::persist(root, &room).unwrap();
        fs::remove_file(root.join(RECEIPT)).unwrap();
        fs::remove_file(root.join(MFM_RECEIPT)).unwrap();
        install(root).unwrap();
        let updated: RoomProject = serde_json::from_slice(&fs::read(root.join("room.json")).unwrap()).unwrap();
        assert_eq!(updated.mounted_set, room.mounted_set);
        assert_eq!(updated.mounted_layout, expected_layout);
        assert!(!updated.production.sets.contains_key(crate::speaker_split::ID));
        assert!(updated.production.shows.contains_key("my-first-million"));
        for key in ["my-first-million-logo", "my-first-million-sam", "my-first-million-shaan"] {
            let asset = &updated.production.assets[key];
            let data = fs::read(root.join("assets").join(format!("{}.png", asset.hash))).unwrap();
            assert_eq!(format!("{:x}", Sha256::digest(data)), asset.hash);
        }
    }

    #[test]
    fn old_rooms_gain_the_library_once_and_keep_their_edits() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let mut room = RoomProject::demo();
        room.production.title = "Keep my room".into();
        crate::engine::persist(root, &room).unwrap();
        install(root).unwrap();
        let mut saved: RoomProject =
            serde_json::from_slice(&fs::read(root.join("room.json")).unwrap()).unwrap();
        assert_eq!(saved.production.title, room.production.title);
        assert!(!saved.production.sets.contains_key("studio"));
        assert!(!saved.production.sets.contains_key("waves"));
        assert_eq!(saved.mounted_set.as_deref(), Some("classic"));
        assert_eq!(saved.production.sets.len(), 8);
        assert!(saved.set_layout_choices("my-first-million").len() == 6);
        assert_eq!(saved.set_layout_choices(crate::speaker_split::ID).len(), 1);
        assert!(saved.set_layout_choices("the-producer").len() >= 3);
        for (id, set) in &saved.production.sets {
            let mut candidate = saved.clone();
            candidate.mount_set(Some(id.clone()), None).unwrap();
            assert!(!set.layouts.is_empty());
            candidate.live_set().unwrap().compile().unwrap();
        }
        // Simulate a studio already using the previous catalog, with a Set removed.
        fs::remove_file(root.join(RECEIPT)).unwrap();
        fs::remove_file(root.join(CLASSIC_RECEIPT)).unwrap();
        fs::remove_file(root.join(SPEAKER_RECEIPT)).unwrap();
        saved.production.sets.remove(crate::speaker_split::ID);
        crate::engine::persist(root, &saved).unwrap();
        install(root).unwrap();
        let mut saved: RoomProject =
            serde_json::from_slice(&fs::read(root.join("room.json")).unwrap()).unwrap();
        assert!(!saved.production.sets.contains_key("waves"));
        assert!(saved.production.sets.contains_key(crate::speaker_split::ID));

        saved.production.sets.remove(crate::speaker_split::ID);
        crate::engine::persist(root, &saved).unwrap();
        let before = fs::read(root.join("room.json")).unwrap();
        install(root).unwrap();
        assert_eq!(before, fs::read(root.join("room.json")).unwrap());
    }
}
