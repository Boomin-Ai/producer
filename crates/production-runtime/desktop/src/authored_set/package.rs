//! Portable native authoring folder. Playback protocol and signed production bundles remain independent.
use super::{prepare, SavedDesign};
use crate::{engine, model::RoomProject};
use anyhow::{ensure, Context, Result};
use producer_production_contract::{
    geometry::Mesh, validate::valid_id, AspectRatio, Asset, AssetKind, Component, Content,
    Document, GraphInput, GraphPass, Node, Paint, Set, Source,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Read, Write},
    os::unix::fs::OpenOptionsExt,
    path::Path,
};

#[derive(Default, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Dependencies {
    sources: BTreeMap<String, Source>,
    components: BTreeMap<String, Component>,
    assets: BTreeMap<String, Asset>,
    files: BTreeSet<String>,
}

fn checked_file(name: &str) -> Result<&str> {
    let (digest, ext) = name
        .split_once('.')
        .context("Expected a digest-named asset")?;
    ensure!(
        digest.len() == 64
            && digest
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            && matches!(
                ext,
                "png" | "glb" | "vclip" | "mov" | "wav" | "ttf" | "otf" | "bin" | "json"
            ),
        "Invalid asset filename"
    );
    Ok(digest)
}

impl Dependencies {
    fn asset(&mut self, doc: &Document, id: &str, dir: &Path) -> Result<()> {
        let a = doc
            .assets
            .get(id)
            .with_context(|| format!("Unknown asset {id}"))?;
        if self.assets.insert(id.into(), a.clone()).is_some() {
            return Ok(());
        }
        // Both are qualified native system-font descriptors. No font binary is loaded.
        if a.kind == AssetKind::Font && crate::visuals::is_system_font(&a.hash) {
            return Ok(());
        }
        let ext = &match a.kind {
            AssetKind::Image => vec!["png"],
            AssetKind::Video => vec!["mov"],
            AssetKind::Audio => vec!["wav", "mov"],
            AssetKind::Font => vec!["ttf", "otf"],
            AssetKind::Geometry => vec!["glb", "vclip", "bin"],
            AssetKind::Material => vec!["json", "bin"],
        };
        let files = ext
            .iter()
            .map(|ext| format!("{}.{ext}", a.hash))
            .filter(|name| checked_file(name).is_ok() && dir.join(name).is_file())
            .collect::<Vec<_>>();
        ensure!(
            !files.is_empty(),
            "Missing native bytes for asset {id} ({})",
            a.hash
        );
        self.files.extend(files);
        Ok(())
    }

    fn source(&mut self, doc: &Document, id: &str, dir: &Path) -> Result<()> {
        let source = doc
            .sources
            .get(id)
            .with_context(|| format!("Unknown source {id}"))?;
        if self.sources.insert(id.into(), source.clone()).is_some() {
            return Ok(());
        }
        match source {
            Source::Player { asset } => self.asset(doc, asset, dir)?,
            Source::Graphics { scene } => {
                for batch in &scene.batches {
                    self.asset(doc, &batch.geometry, dir)?;
                    self.asset(doc, &batch.material, dir)?;
                }
            }
            Source::Live { .. } => {}
        }
        Ok(())
    }

    fn node(&mut self, doc: &Document, n: &Node, dir: &Path) -> Result<()> {
        if let Some(Paint::Image { asset, .. }) =
            n.style.as_ref().and_then(|style| style.fill.as_ref())
        {
            self.asset(doc, asset, dir)?;
        }
        if let Some(AspectRatio::Source { source, .. }) = n
            .placement
            .as_ref()
            .and_then(|p| p.aspect.as_ref())
            .map(|a| &a.ratio)
        {
            self.source(doc, source, dir)?;
        }
        match &n.content {
            Content::Source { source, .. } => self.source(doc, source, dir)?,
            Content::Text { font, .. } => {
                let matching = |asset: &Asset| asset.kind == AssetKind::Font && &asset.hash == font;
                let registered = doc.assets.get_key_value("system-font").filter(|(_, a)| matching(a))
                    .or_else(|| doc.assets.iter().find(|(_, a)| matching(a)));
                if let Some((id, _)) = registered {
                    self.asset(doc, id, dir)?;
                } else {
                    ensure!(crate::visuals::is_system_font(font), "Missing font descriptor");
                }
            }
            Content::Component { definition, .. } => {
                let c = doc
                    .components
                    .get(definition)
                    .context("Missing component")?;
                if self
                    .components
                    .insert(definition.clone(), c.clone())
                    .is_none()
                {
                    self.node(doc, &c.root, dir)?;
                }
            }
            Content::Group => {}
        }
        for child in &n.children {
            self.node(doc, child, dir)?;
        }
        Ok(())
    }

    fn collect(doc: &Document, set: &Set, dir: &Path) -> Result<Self> {
        let mut deps = Self::default();
        for l in set.layouts.values() {
            deps.node(doc, &l.root, dir)?;
        }
        for graph in set.graphs.values() {
            for pass in &graph.passes {
                for input in pass.inputs() {
                    match input {
                        GraphInput::Source { id } => deps.source(doc, id, dir)?,
                        GraphInput::Image { asset } => deps.asset(doc, asset, dir)?,
                        _ => {}
                    }
                }
                if let GraphPass::Geometry { scene, .. } = pass {
                    if let Some(hash) = &scene.environment {
                        deps.files.insert(format!("{hash}.png"));
                    }
                    for object in &scene.objects {
                        let name = match &object.mesh {
                            Mesh::Glb { digest } => format!("{digest}.glb"),
                            Mesh::VertexClip { digest, .. } => format!("{digest}.vclip"),
                            _ => continue,
                        };
                        deps.files.insert(name);
                    }
                }
            }
        }
        for name in &deps.files {
            checked_file(name)?;
        }
        Ok(deps)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Package {
    version: u32,
    id: String,
    design: SavedDesign,
    set: Set,
    dependencies: Dependencies,
}

fn read_bytes(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .with_context(|| format!("Open {}", path.display()))?;
    ensure!(file.metadata()?.is_file(), "Expected regular file");
    let mut data = Vec::new();
    file.take(limit + 1).read_to_end(&mut data)?;
    ensure!(data.len() as u64 <= limit, "File exceeds native budget");
    Ok(data)
}

fn copy_assets(src: &Path, dst: &Path, files: &BTreeSet<String>) -> Result<()> {
    if files.is_empty() {
        return Ok(());
    }
    ensure!(src.symlink_metadata()?.is_dir(), "Expected asset directory");
    fs::create_dir_all(dst)?;
    ensure!(
        dst.symlink_metadata()?.is_dir(),
        "Expected destination asset directory"
    );
    for name in files {
        let hash = checked_file(name)?;
        let data = read_bytes(&src.join(name), 128 * 1024 * 1024)?;
        ensure!(
            format!("{:x}", Sha256::digest(&data)) == hash,
            "Asset digest mismatch: {name}"
        );
        let target = dst.join(name);
        if target.try_exists()? {
            ensure!(
                read_bytes(&target, 128 * 1024 * 1024)? == data,
                "Existing asset conflicts: {name}"
            );
        } else {
            let mut tmp = tempfile::NamedTempFile::new_in(dst)?;
            tmp.write_all(&data)?;
            tmp.as_file().sync_all()?;
            tmp.persist_noclobber(target)?;
        }
    }
    Ok(())
}

fn load_room(root: &Path) -> Result<RoomProject> {
    Ok(serde_json::from_slice(&fs::read(root.join("room.json"))?)?)
}

pub(crate) fn export(root: &Path, id: &str, dst: &Path) -> Result<()> {
    ensure!(!dst.try_exists()?, "Choose an unused export destination");
    let room = load_room(root)?;
    let set = room.production.sets.get(id).context("Missing set")?;
    let design = room
        .authored_designs
        .get(id)
        .context("Set has no saved authoring source")?;
    design.verify(id, set)?;
    let deps = Dependencies::collect(&room.production, set, &root.join("assets"))?;
    let parent = dst
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let stage = tempfile::tempdir_in(parent)?;
    copy_assets(
        &root.join("assets"),
        &stage.path().join("assets"),
        &deps.files,
    )?;
    let package = Package {
        version: 1,
        id: id.into(),
        design: (**design).clone(),
        set: set.clone(),
        dependencies: deps,
    };
    fs::write(
        stage.path().join("set.json"),
        serde_json::to_vec_pretty(&package)?,
    )?;
    // Publish exclusively. A simultaneous export or user-created folder always survives.
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let from = CString::new(stage.path().as_os_str().as_bytes())?;
    let to = CString::new(dst.as_os_str().as_bytes())?;
    if unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

pub(crate) fn import(root: &Path, src: &Path, new_id: Option<&str>) -> Result<()> {
    let _exclusive = crate::ipc::reserve(root)?;
    let mut room = load_room(root)?;
    let p: Package = serde_json::from_slice(&read_bytes(&src.join("set.json"), 8 * 1024 * 1024)?)?;
    ensure!(
        p.version == 1,
        "Unsupported native set package version {}",
        p.version
    );
    p.design.verify(&p.id, &p.set)?;
    let id = new_id.unwrap_or(&p.id);
    ensure!(
        valid_id(id) && !room.production.sets.contains_key(id),
        "Choose an unused set ID"
    );
    // Validate the dependency closure against an isolated document before adding anything to the room.
    let mut doc = Document::empty("package", "Native set");
    for (k, v) in &p.dependencies.assets {
        doc.assets.insert(k.clone(), v.clone());
    }
    for (k, v) in &p.dependencies.components {
        doc.components.insert(k.clone(), v.clone());
    }
    for (k, v) in &p.dependencies.sources {
        doc.sources.insert(k.clone(), v.clone());
    }
    let input_dir = src.join("assets");
    ensure!(
        Dependencies::collect(&doc, &p.set, &input_dir)? == p.dependencies,
        "Package has unrelated or missing resources"
    );
    macro_rules! merge {
        ($collection:ident) => {
            for (key, value) in &p.dependencies.$collection {
                ensure!(
                    room.production
                        .$collection
                        .get(key)
                        .is_none_or(|old| old == value),
                    "{} identifier '{key}' conflicts with this room",
                    stringify!($collection)
                );
                room.production
                    .$collection
                    .insert(key.clone(), value.clone());
            }
        };
    }
    merge!(assets);
    merge!(components);
    merge!(sources);
    let saved = p.design.renamed(id)?;
    let mut authored_canvas = room.clone();
    for l in p.set.layouts.values() {
        let size = producer_native_media::boundary::OutputSize {
            width: l.width,
            height: l.height,
        }
        .validate()?;
        match l.orientation {
            producer_production_contract::Orientation::Landscape => {
                authored_canvas.canvas.landscape = size
            }
            producer_production_contract::Orientation::Vertical => {
                authored_canvas.canvas.vertical = size
            }
        }
    }
    let candidate = prepare(&authored_canvas, saved.source.clone())?;
    candidate.install(&mut room)?;
    ensure!(
        room.production.sets.get(id) == Some(&p.set),
        "Playable set differs from its authored source"
    );
    crate::render_graph::inspect(&p.set)?;
    copy_assets(&input_dir, &root.join("assets"), &p.dependencies.files)?;
    engine::persist(root, &room)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn explicit_native_font_round_trips_a_descriptorless_studio() {
        let source = tempfile::tempdir().unwrap();
        let destination = tempfile::tempdir().unwrap();
        let package = source.path().join("line-desk.package");
        let mut room = RoomProject::demo();
        room.production.assets.retain(|_, a| a.kind != AssetKind::Font);
        engine::persist(destination.path(), &room).unwrap();
        let layer = json!({"id":"title","landscape":[0,0,1,1],"vertical":[0,0,1,1],"content":{
            "kind":"text","value":"Line Desk","font":crate::visuals::DEFAULT_SYSTEM_FONT}});
        let design = json!({"op":"authorSet","id":"line-desk","looks":[{"id":"opening","layers":[layer]}]});
        prepare(&room, design).unwrap().install(&mut room).unwrap();
        assert_eq!(room.production.assets.remove("system-font").unwrap().hash, crate::visuals::DEFAULT_SYSTEM_FONT);
        engine::persist(source.path(), &room).unwrap();
        export(source.path(), "line-desk", &package).unwrap();
        import(destination.path(), &package, None).unwrap();
        let reopened = load_room(destination.path()).unwrap();
        assert_eq!(reopened.production.sets["line-desk"], room.production.sets["line-desk"]);
        assert_eq!(reopened.production.assets["system-font"].hash, crate::visuals::DEFAULT_SYSTEM_FONT);
    }

    #[test]
    fn round_trip_image_asset_and_edit_portable_set() {
        let source = tempfile::tempdir().unwrap();
        let output = tempfile::tempdir().unwrap();
        let dest = tempfile::tempdir().unwrap();
        let folder = output.path().join("designed-set");
        let dir = source.path().join("assets");
        fs::create_dir(&dir).unwrap();
        let image = image::RgbaImage::from_pixel(2, 2, image::Rgba([36, 12, 168, 255]));
        let mut bytes = std::io::Cursor::new(Vec::new());
        image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
        let bytes = bytes.into_inner();
        let hash = format!("{:x}", Sha256::digest(&bytes));
        let filename = format!("{hash}.png");
        fs::write(dir.join(&filename), &bytes).unwrap();
        let mut room = RoomProject::demo();
        room.production.assets.insert(
            "backdrop".into(),
            Asset {
                hash,
                kind: AssetKind::Image,
                available: None,
            },
        );
        let layer = json!({"id":"ground","content":{"kind":"group"},"style":{"fill":{"kind":"image","asset":"backdrop","fit":"cover"}},"landscape":[0.,0.,1.,1.],"vertical":[0.,0.,1.,1.]});
        let design =
            json!({"op":"authorSet","id":"artwork","looks":[{"id":"opening","layers":[layer]}]});
        prepare(&room, design).unwrap().install(&mut room).unwrap();
        engine::persist(source.path(), &room).unwrap();
        engine::persist(dest.path(), &RoomProject::demo()).unwrap();
        export(source.path(), "artwork", &folder).unwrap();
        assert!(export(source.path(), "artwork", &folder).is_err());
        import(dest.path(), &folder, Some("reopened")).unwrap();
        assert_eq!(
            fs::read(dest.path().join("assets").join(&filename)).unwrap(),
            bytes
        );
        let mut reopened = load_room(dest.path()).unwrap();
        assert_eq!(
            reopened.production.sets["reopened"],
            room.production.sets["artwork"]
        );
        let edit = json!({"op":"editAuthoredSet","id":"reopened","changes":[{"op":"frame","look":"opening","layer":"ground","landscape":[0,0,0.8,1]}]});
        prepare(&reopened, edit)
            .unwrap()
            .install(&mut reopened)
            .unwrap();
        let before = fs::read(dest.path().join("room.json")).unwrap();
        fs::write(folder.join("assets").join(filename), b"corrupt").unwrap();
        assert!(format!(
            "{:#}",
            import(dest.path(), &folder, Some("corrupted")).unwrap_err()
        )
        .contains("digest mismatch"));
        assert_eq!(fs::read(dest.path().join("room.json")).unwrap(), before);
    }
}
