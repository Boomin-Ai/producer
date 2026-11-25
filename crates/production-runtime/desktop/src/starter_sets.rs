//! Install the authored Native Dev set library once per studio, under its room lock.
use crate::model::RoomProject;
use anyhow::{ensure, Result};
use producer_production_contract::{Asset, Set, Show, Source};
use serde::Deserialize;
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
const RECEIPT: &str = "starter-sets-v1.installed";

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

pub(crate) fn install(root: &Path) -> Result<()> {
    if root.join(RECEIPT).is_file() {
        return Ok(());
    }
    let catalog: Catalog = serde_json::from_slice(include_bytes!("../starter-sets/catalog.json"))?;
    let mut room = match fs::read(root.join("room.json")) {
        Ok(doc) => serde_json::from_slice(&doc)?,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => RoomProject::demo(),
        Err(err) => return Err(err.into()),
    };
    let doc = &mut room.production;
    for (key, value) in catalog.sources {
        doc.sources.entry(key).or_insert(value);
    }
    for (key, value) in &catalog.assets {
        doc.assets
            .entry(key.clone())
            .or_insert_with(|| value.clone());
    }
    for (key, value) in catalog.sets {
        doc.sets.entry(key).or_insert(value);
    }
    for (key, value) in catalog.shows {
        if doc.sets.get(&value.set).is_some_and(|set| {
            value.segments.iter().all(|s| {
                set.layouts.contains_key(&s.landscape) && set.layouts.contains_key(&s.vertical)
            })
        }) {
            doc.shows.entry(key).or_insert(value);
        }
    }
    room.compile()?;
    fs::create_dir_all(root.join("assets"))?;
    for (key, bytes) in IMAGES {
        use sha2::{Digest, Sha256};
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
    crate::engine::persist(root, &room)?;
    write_missing(&root.join(RECEIPT), b"1\n")
}
#[cfg(test)]
mod tests {
    use super::*;
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
        assert_eq!(
            saved.production.sets["studio"],
            room.production.sets["studio"]
        );
        assert_eq!(saved.production.sets.len(), 8);
        assert!(saved.set_layout_choices("the-producer").len() >= 3);
        for (id, set) in &saved.production.sets {
            let mut candidate = saved.clone();
            candidate.mount_set(Some(id.clone()), None).unwrap();
            assert!(!set.layouts.is_empty());
            candidate.live_set().unwrap().compile().unwrap();
        }
        saved.production.sets.remove("waves");
        crate::engine::persist(root, &saved).unwrap();
        let before = fs::read(root.join("room.json")).unwrap();
        install(root).unwrap();
        assert_eq!(before, fs::read(root.join("room.json")).unwrap());
    }
}
