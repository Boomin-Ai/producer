//! Native authoring source saved alongside the independently playable set.
use super::lower;
use crate::model::RoomProject;
use anyhow::{bail, ensure, Context, Result};
use producer_production_contract::Set;
use producer_production_core::commands::{Command, Operation};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;

pub const EDIT_GUIDE: &str = r#"For a selected authoredDesign, edit its stable IDs using submit_set with candidate {op:"editAuthoredSet",id,changes:[...]}. To shift a layer use {op:"translate",look,layer,vertical:[dx,dy]} or landscape, in fractions of the output. Native preserves the size, the other view and attached path endpoints. For exact new bounds use {op:"frame",look,layer,vertical:[x,y,width,height]}. For an unambiguous numeric request whose targets are in the manifest, submit the scoped edit directly. Producer renders every look for operator review. Use private image inspection when judging a visual choice. Coordinates are normalized. To constrain a slot to a pixel ratio use {op:"aspect",look,layer,value:{width:1,height:1}} or value:null to release it. For text/image/source replace content with {op:"content",look,layer,value}; for one local style use {op:"style",look,layer,value}; to change all uses of a named style use {op:"sharedStyle",style:"headline",value:<SurfaceStyle>}. To edit a named attachment use {op:"anchor",look,layer,anchor,vertical:[u,v]} or landscape. For one typed material control use {op:"materialParam",material,param:"motion.periodSeconds",value:5}; for a custom WGSL replacement use {op:"material",material,value}. Inspect authoredLook, authoredStyle or authoredMaterial by id for details. If compiled and authored revisions diverged, offer to continue with the compiled set or recover the saved source in a separate set. For requested recovery use {op:"recoverAuthoredSet",from:"old-id",id:"unused-id"} and review the rebuilt copy."#;

fn hash<T: Serialize>(value: &T) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedDesign {
    version: u32,
    pub(super) source: Value,
    source_hash: String,
    set_hash: String,
}

impl SavedDesign {
    fn new(source: Value, set: &Set) -> Result<Self> {
        Ok(Self {
            version: 1,
            source_hash: hash(&source)?,
            set_hash: hash(set)?,
            source,
        })
    }

    pub(super) fn verify(&self, id: &str, set: &Set) -> Result<()> {
        ensure!(
            self.version == 1,
            "Unsupported authored design version {}",
            self.version
        );
        ensure!(
            self.source["id"] == id && self.source_hash == hash(&self.source)?,
            "Saved design {id} differs from its recorded revision"
        );
        ensure!(self.set_hash == hash(set)?,
            "Compiled set {id} changed independently of the saved design. Restore its matching revision or continue editing the compiled set.");
        Ok(())
    }

    pub(crate) fn verified_revision(&self, id: &str, set: &Set) -> Result<&str> {
        self.verify(id, set)?;
        Ok(&self.source_hash)
    }

    pub(crate) fn renamed(&self, id: &str) -> Result<Self> {
        ensure!(self.version == 1, "Unsupported authored design version {}", self.version);
        ensure!(
            self.source_hash == hash(&self.source)?,
            "Saved design differs from its recorded revision"
        );
        let mut copy = self.clone();
        copy.source["id"] = json!(id);
        copy.source_hash = hash(&copy.source)?;
        Ok(copy)
    }

    // A studio binding changes the source on every layout node with this stable path.
    // Mirror that native operation in the authored source so a later edit keeps the device.
    pub(crate) fn rebound(
        &self,
        id: &str,
        before: &Set,
        after: &Set,
        key: &str,
        src: &str,
    ) -> Result<Option<Self>> {
        if self.verify(id, before).is_err() {
            return Ok(None);
        }
        let mut source = self.source.clone();
        let parts: Vec<_> = key.split('/').collect();
        match parts.as_slice() {
            ["node", "stage", layer_id] => {
                for look in source["looks"]
                    .as_array_mut()
                    .context("Missing design looks")?
                {
                    for layer in look["layers"]
                        .as_array_mut()
                        .context("Missing design layers")?
                    {
                        if layer["id"] == *layer_id && layer["content"]["kind"] == "source" {
                            layer["content"]["source"] = json!(src);
                        }
                    }
                }
            }
            ["graph", graph, "display", index] => {
                let looks = source["looks"].as_array().context("Missing design looks")?;
                // A single dimensional display consumes the same source list in both orientations.
                let Some((index_of_look, look)) = looks.iter().enumerate().find(|(_, l)| {
                    l["id"].as_str().is_some_and(|name| {
                        ["landscape", "vertical"].iter().all(|suffix| {
                            before
                                .output_graphs
                                .get(&format!("{name}-{suffix}"))
                                .is_some_and(|key| key == graph)
                        })
                    })
                }) else {
                    return Ok(None);
                };
                let name = look["material"]
                    .as_str()
                    .context("Missing display material")?
                    .to_owned();
                let shared = looks.iter().filter(|l| l["material"] == name).count() > 1;
                let mut material = source["materials"][&name].clone();
                if material["kind"] != "dimensionalDisplay" {
                    return Ok(None);
                }
                let slot = index.parse::<usize>()?;
                *material["sources"]
                    .get_mut(slot)
                    .context("Missing display input")? = json!(src);
                if shared {
                    let key = (1..)
                        .map(|n| format!("display-binding-{n}"))
                        .find(|k| source["materials"].get(k).is_none())
                        .unwrap();
                    source["materials"][&key] = material;
                    source["looks"][index_of_look]["material"] = json!(key);
                } else {
                    source["materials"][&name] = material;
                }
            }
            _ => return Ok(None),
        }
        Ok(Some(Self::new(source, after)?))
    }

    pub(crate) fn manifest(&self, id: &str, set: &Set) -> Value {
        if let Err(error) = self.verify(id, set) {
            return json!({"id":id,"error":error.to_string(),"recovery":"recoverAuthoredSet rebuilds a separate copy with an unused set ID"});
        }
        let looks = self.source["looks"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|look| {
                let layers = look["layers"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|l| {
                        let mut entry = json!({"id":l["id"],"kind":l["content"]["kind"]});
                        if let Some(role) = l["content"].get("source") {
                            entry["source"] = role.clone();
                        }
                        if let Some(name) = l.get("styleRef") { entry["styleRef"] = name.clone(); }
                        entry
                    })
                    .collect::<Vec<_>>();
                json!({"id":look["id"],"layers":layers,"material":look["material"]})
            })
            .collect::<Vec<_>>();
        let materials = self.source["materials"].as_object().into_iter().flatten().map(|(name,v)| {
            let properties = v.as_object().map(|m| m.keys().collect::<Vec<_>>());
            let mut entry = json!({"id":name,"kind":v.get("kind").and_then(Value::as_str).unwrap_or("wgsl"),"fields":properties});
            // A small dependency list lets a director move a window while seeing
            // which light paths will automatically follow it.
            for key in ["from", "to", "layer", "motion"] {
                if let Some(binding) = v.get(key) {
                    entry[key] = binding.clone();
                }
            }
            entry
        }).collect::<Vec<_>>();
        let mut manifest = json!({"id":id,"version":self.version,"revision":self.source_hash,"looks":looks,"materials":materials});
        if self.source.get("styles").is_some() { manifest["styles"] = self.inspect("authoredStyle", ""); }
        manifest
    }

    pub(crate) fn inspect(&self, section: &str, id: &str) -> Value {
        if section == "authoredLook" {
            let mut looks = self.source["looks"].as_array().into_iter().flatten();
            if id.is_empty() { return json!(looks.map(|look| &look["id"]).collect::<Vec<_>>()); }
            return looks.find(|look| look["id"] == id).cloned().unwrap_or(Value::Null);
        }
        let entries = match section {
            "authoredMaterial" => &self.source["materials"],
            "authoredStyle" => &self.source["styles"],
            _ => return Value::Null,
        };
        if id.is_empty() { json!(entries.as_object().into_iter().flat_map(|o| o.keys()).collect::<Vec<_>>()) }
        else { entries[id].clone() }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Edit {
    op: String,
    id: String,
    changes: Vec<Change>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum Change {
    Translate {
        look: String,
        layer: String,
        landscape: Option<[f64; 2]>,
        vertical: Option<[f64; 2]>,
    },
    Frame {
        look: String,
        layer: String,
        landscape: Option<[f64; 4]>,
        vertical: Option<[f64; 4]>,
    },
    Aspect {
        look: String,
        layer: String,
        value: Value,
    },
    Anchor {
        look: String,
        layer: String,
        anchor: String,
        landscape: Option<[f64; 2]>,
        vertical: Option<[f64; 2]>,
    },
    Content {
        look: String,
        layer: String,
        value: Value,
    },
    Style {
        look: String,
        layer: String,
        value: Value,
    },
    SharedStyle {
        style: String,
        value: Value,
    },
    MaterialParam {
        material: String,
        param: String,
        value: Value,
    },
    Material {
        material: String,
        value: Value,
    },
}

fn layer_mut<'a>(source: &'a mut Value, look_id: &str, layer_id: &str) -> Result<&'a mut Value> {
    let look = source["looks"]
        .as_array_mut()
        .context("Missing looks")?
        .iter_mut()
        .find(|look| look["id"] == look_id)
        .with_context(|| format!("Unknown look '{look_id}'"))?;
    look["layers"]
        .as_array_mut()
        .context("Missing layers")?
        .iter_mut()
        .find(|l| l["id"] == layer_id)
        .with_context(|| format!("Unknown layer '{look_id}/{layer_id}'"))
}

fn apply_change(source: &mut Value, change: Change) -> Result<()> {
    match change {
        Change::Translate { look, layer, landscape, vertical } => {
            ensure!(landscape.is_some() || vertical.is_some(), "Supply a landscape or vertical displacement");
            let target = layer_mut(source, &look, &layer)?;
            for (view, delta) in [("landscape", landscape), ("vertical", vertical)] {
                if let Some(delta) = delta {
                    for (axis, offset) in delta.into_iter().enumerate() {
                        if offset != 0.0 {
                            let origin = target[view][axis].as_f64().context("Missing frame origin")?;
                            let shifted = serde_json::Number::from_f64(origin + offset)
                                .context("Frame displacement must be finite")?;
                            target[view][axis] = Value::Number(shifted);
                        }
                    }
                }
            }
        }
        Change::Frame {
            look,
            layer,
            landscape,
            vertical,
        } => {
            ensure!(
                landscape.is_some() || vertical.is_some(),
                "Supply landscape or vertical bounds"
            );
            let target = layer_mut(source, &look, &layer)?;
            if let Some(frame) = landscape {
                target["landscape"] = json!(frame);
            }
            if let Some(frame) = vertical {
                target["vertical"] = json!(frame);
            }
        }
        Change::Aspect { look, layer, value } => {
            let layer = layer_mut(source, &look, &layer)?;
            if value.is_null() {
                layer.as_object_mut().context("Expected design layer")?.remove("aspect");
            } else {
                let ratio: producer_production_contract::Ratio = serde_json::from_value(value)?;
                ensure!(producer_production_contract::layout::ratio_valid(ratio), "Aspect dimensions must be in 1..=65536");
                layer["aspect"] = serde_json::to_value(ratio)?;
            }
        }
        Change::Anchor {
            look,
            layer,
            anchor,
            landscape,
            vertical,
        } => {
            ensure!(
                landscape.is_some() || vertical.is_some(),
                "Supply landscape or vertical anchor coordinates"
            );
            let target = layer_mut(source, &look, &layer)?["attachments"]
                .get_mut(&anchor)
                .with_context(|| format!("Unknown attachment '{look}/{layer}.{anchor}'"))?;
            if let Some(value) = landscape {
                target["landscape"] = json!(value);
            }
            if let Some(value) = vertical {
                target["vertical"] = json!(value);
            }
        }
        Change::Content { look, layer, value } => {
            layer_mut(source, &look, &layer)?["content"] = value
        }
        Change::Style { look, layer, value } => {
            let target = layer_mut(source, &look, &layer)?.as_object_mut().context("Expected design layer")?;
            let detached = target.remove("styleRef");
            target.insert("style".to_owned(), value);
            if let Some(name) = detached.and_then(|v| v.as_str().map(str::to_owned)) {
                let in_use = source["looks"].as_array().into_iter().flatten()
                    .flat_map(|look| look["layers"].as_array().into_iter().flatten())
                    .any(|layer| layer["styleRef"] == name);
                if !in_use {
                    source["styles"].as_object_mut().context("Missing shared styles")?.remove(&name);
                }
            }
        }
        Change::SharedStyle { style, value } => {
            *source["styles"].get_mut(&style)
                .with_context(|| format!("Unknown shared style '{style}'"))? = value;
        }
        Change::Material { material, value } => {
            *source["materials"]
                .get_mut(&material)
                .with_context(|| format!("Unknown material '{material}'"))? = value;
        }
        Change::MaterialParam {
            material,
            param,
            value,
        } => {
            let mut object = source["materials"]
                .get_mut(&material)
                .and_then(Value::as_object_mut)
                .with_context(|| format!("'{material}' must be a typed material"))?;
            ensure!(param != "kind", "Replace the material to change its kind");
            // Lowering deserializes the complete material and checks names, types and domains.
            let mut parts = param.split('.').peekable();
            while let Some(field) = parts.next() {
                ensure!(!field.is_empty(), "Material parameter has an empty field");
                if parts.peek().is_none() {
                    object.insert(field.to_owned(), value);
                    break;
                }
                object = object
                    .get_mut(field)
                    .and_then(Value::as_object_mut)
                    .with_context(|| format!("Unknown parameter '{material}.{param}'"))?;
            }
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct Prepared {
    id: String,
    expected_source: Option<String>,
    source: Arc<SavedDesign>,
    transaction: Command,
}

impl Prepared {
    pub(crate) fn id(&self) -> &str {
        &self.id
    }

    pub(crate) fn install(&self, project: &mut RoomProject) -> Result<()> {
        if let Some(expected) = &self.expected_source {
            let current = project
                .authored_designs
                .get(&self.id)
                .context("Authored set was removed")?;
            current.verify(
                &self.id,
                project
                    .production
                    .sets
                    .get(&self.id)
                    .context("Set was removed")?,
            )?;
            ensure!(
                &current.source_hash == expected,
                "Design changed after review"
            );
        } else {
            ensure!(
                !project.production.sets.contains_key(&self.id),
                "Set already exists"
            );
        }
        project.command(self.transaction.clone())?;
        project
            .authored_designs
            .insert(self.id.clone(), self.source.clone());
        Ok(())
    }
}

pub(crate) fn prepare(project: &RoomProject, payload: Value) -> Result<Prepared> {
    let (source, expected_source) = match payload["op"].as_str() {
        Some("authorSet") => (payload, None),
        Some("recoverAuthoredSet") => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Recovery { from: String, id: String }
            let mut fields = payload;
            fields.as_object_mut().context("Expected recovery command")?.remove("op");
            let recovery: Recovery = serde_json::from_value(fields)?;
            ensure!(recovery.id != recovery.from && !project.production.sets.contains_key(&recovery.id),
                    "Choose an unused ID for the recovered set");
            let saved = project.authored_designs.get(&recovery.from).context("Set has no saved design")?;
            ensure!(saved.source["id"] == recovery.from, "Stored source belongs to a different set");
            (saved.renamed(&recovery.id)?.source, None)
        }
        Some("editAuthoredSet") => {
            let edit: Edit = serde_json::from_value(payload).context("Invalid editAuthoredSet")?;
            ensure!(
                edit.op == "editAuthoredSet" && (1..=128).contains(&edit.changes.len()),
                "Supply 1 to 128 design changes"
            );
            let old = project
                .authored_designs
                .get(&edit.id)
                .context("Set has no editable native design")?;
            old.verify(
                &edit.id,
                project
                    .production
                    .sets
                    .get(&edit.id)
                    .context("Missing compiled set")?,
            )?;
            let mut source = old.source.clone();
            for (index, change) in edit.changes.into_iter().enumerate() {
                apply_change(&mut source, change)
                    .with_context(|| format!("Design edit {}", index + 1))?;
            }
            (source, Some(old.source_hash.clone()))
        }
        _ => bail!("Unknown authored set operation"),
    };
    let id = source["id"]
        .as_str()
        .context("Missing design id")?
        .to_owned();
    let transaction = lower(project, source.clone(), expected_source.is_some())?;
    let Command::Transaction { operations } = &transaction else {
        unreachable!("lowering returns a set transaction")
    };
    let compiled = match operations.last() {
        Some(Operation::AddSet { value, .. } | Operation::ReplaceSet { value, .. }) => value,
        _ => unreachable!("set transaction ends with its compiled set"),
    };
    let record = Arc::new(SavedDesign::new(source, compiled)?);
    Ok(Prepared {
        id,
        expected_source,
        source: record,
        transaction,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn room_with_design() -> RoomProject {
        let mut room = RoomProject::demo();
        let create = json!({"op":"authorSet","id":"native-edit","materials":{"ink":"return textureSampleLevel(input0, linear_sampler, uv, 0.);"},"looks":[
            {"id":"opening","layers":[{"id":"ground","content":{"kind":"group"},"vertical":[0,0,1,1],"landscape":[0,0,1,1]}]},
            {"id":"duo","material":"ink","layers":[{"id":"speaker","content":{"kind":"source","source":"camera","fit":"cover"},"vertical":[0.076543219876543,0.1,0.8,0.4],"landscape":[0.1,0.2,0.8,0.6]}]}
        ]});
        prepare(&room, create).unwrap().install(&mut room).unwrap();
        room
    }

    fn movement(id: &str, y: f64) -> Value {
        json!({"op":"editAuthoredSet","id":id,"changes":[{"op":"frame","look":"duo","layer":"speaker","vertical":[0.1,y,0.8,0.4]}]})
    }

    #[test]
    fn relative_edits_preserve_framing_and_reject_out_of_bounds_or_repeated_approval() {
        let mut room = room_with_design();
        let id = "native-edit";
        let before = room.authored_designs[id].source.clone();
        let manifest = room.authored_designs[id].manifest(id, &room.production.sets[id]);
        assert_eq!(manifest["looks"][1]["layers"][0]["source"], "camera");
        let translate = |dy: f64| json!({"op":"editAuthoredSet","id":id,"changes":[
            {"op":"translate","look":"duo","layer":"speaker","vertical":[0,dy]}]});
        assert!(prepare(&room, translate(1.0)).is_err());
        let edit = prepare(&room, translate(-0.02)).unwrap();
        edit.install(&mut room).unwrap();
        assert!(edit.install(&mut room).is_err());
        let mut expected = before;
        expected["looks"][1]["layers"][0]["vertical"][1] = json!(0.1_f64 - 0.02);
        assert_eq!(room.authored_designs[id].source, expected);
    }

    #[test]
    fn authored_revision_survives_disk_and_only_changes_the_requested_orientation() {
        let room = room_with_design();
        let tmp = tempfile::tempdir().unwrap();
        crate::engine::persist(tmp.path(), &room).unwrap();
        let mut restored: RoomProject =
            serde_json::from_slice(&std::fs::read(tmp.path().join("room.json")).unwrap()).unwrap();
        let before = restored.production.sets["native-edit"].clone();
        let candidate = prepare(&restored, movement("native-edit", 0.36)).unwrap();
        let stale = prepare(&restored, movement("native-edit", 0.37)).unwrap();
        candidate.install(&mut restored).unwrap();
        let after = &restored.production.sets["native-edit"];
        assert_eq!(before.graphs, after.graphs);
        for layout in ["opening-landscape", "opening-vertical", "duo-landscape"] {
            assert_eq!(before.layouts[layout], after.layouts[layout]);
        }
        assert_ne!(
            before.layouts["duo-vertical"],
            after.layouts["duo-vertical"]
        );
        assert!(stale.install(&mut restored).is_err());
        assert!(prepare(&restored, movement("native-edit", 1.)).is_err());
        let mut bad = movement("native-edit", 0.32);
        bad["changes"][0]["layer"] = json!("missing");
        assert!(format!("{:#}", prepare(&restored, bad).unwrap_err()).contains("duo/missing"));
        let saved = &restored.authored_designs["native-edit"];
        saved
            .verify("native-edit", &restored.production.sets["native-edit"])
            .unwrap();
        let mut diverged = restored.clone();
        diverged
            .production
            .sets
            .get_mut("native-edit")
            .unwrap()
            .theme
            .insert("ink".into(), "#FFFFFF".into());
        assert!(prepare(&diverged, movement("native-edit", 0.2)).is_err());
        let raw = diverged.production.sets["native-edit"].clone();
        let recover = json!({"op":"recoverAuthoredSet","from":"native-edit","id":"restored"});
        let draft = prepare(&diverged, recover.clone()).unwrap();
        draft.install(&mut diverged).unwrap();
        assert_eq!(diverged.production.sets["native-edit"], raw);
        assert_eq!(diverged.production.sets["restored"], restored.production.sets["native-edit"]);
        assert!(prepare(&diverged, recover).is_err());
        assert!(prepare(&diverged, movement("restored", 0.2)).is_ok());
    }

    #[test]
    fn compact_styles_and_implicit_fonts_round_trip_and_edit_by_scope() {
        use producer_production_contract::{Asset, AssetKind};
        let mut room = RoomProject::demo();
        let explicit_hash = "d".repeat(64);
        room.production.assets.insert("explicit-font".into(),
            Asset { hash: explicit_hash.clone(), kind: AssetKind::Font, available: None });
        let id = "style-proof";
        let style = json!({"text":{"fontSize":40,"weight":600,"align":"left",
                                  "ink":{"color":"#123456","opacity":1}}});
        let headline = json!({"id":"headline","landscape":[0,0,1,0.5],"vertical":[0,0,1,0.5],
                              "content":{"kind":"text","value":"Story"},"styleRef":"heading"});
        let second = json!({"id":"credit","landscape":[0,0.5,1,0.2],"vertical":[0,0.5,1,0.2],
                            "content":{"kind":"text","value":"Independent","font":explicit_hash}});
        let design = json!({"op":"authorSet","id":id,"styles":{"heading":style},"looks":[
            {"id":"opening","layers":[headline,second]},{"id":"host","layers":[headline,second]}]});
        let mut inline = design.clone();
        inline.as_object_mut().unwrap().remove("styles");
        for look in inline["looks"].as_array_mut().unwrap() {
            let l = &mut look["layers"][0];
            l.as_object_mut().unwrap().remove("styleRef");
            l["style"] = style.clone();
            l["content"]["font"] = json!(room.production.assets["system-font"].hash);
        }
        let mut original = room.clone();
        prepare(&original, inline).unwrap().install(&mut original).unwrap();
        prepare(&room, design.clone()).unwrap().install(&mut room).unwrap();
        let mut room: RoomProject = serde_json::from_slice(&serde_json::to_vec(&room).unwrap()).unwrap();
        let before = &original.production.sets[id];
        assert_eq!(&room.production.sets[id], before);
        let saved = &room.authored_designs[id];
        saved.verify(id, before).unwrap();
        assert_eq!(saved.source, design);
        assert_eq!(saved.inspect("authoredStyle", ""), json!(["heading"]));
        assert_eq!(saved.inspect("authoredStyle", "heading"), style);
        assert_eq!(saved.inspect("authoredStyle", "missing"), Value::Null);
        let manifest = saved.manifest(id, before);
        assert_eq!(manifest["looks"][1]["layers"][0]["styleRef"], "heading");
        assert_eq!(manifest["styles"], json!(["heading"]));
        assert!(!manifest.to_string().contains("#123456"));

        let mut updated = style.clone();
        updated["text"]["ink"]["color"] = json!("#654321");
        let edit = |change| json!({"op":"editAuthoredSet","id":id,"changes":[change]});
        assert!(prepare(&room, edit(json!({"op":"sharedStyle","style":"typo","value":style}))).is_err());
        prepare(&room, edit(json!({"op":"sharedStyle","style":"heading","value":updated})))
            .unwrap().install(&mut room).unwrap();
        for (name, layout) in &room.production.sets[id].layouts {
            let old = &before.layouts[name].root.children;
            assert_eq!(layout.root.children[0].content, old[0].content);
            assert_eq!(layout.root.children[1], old[1]);
            assert_eq!(serde_json::to_value(&layout.root.children[0].style).unwrap()["text"]["ink"]["color"], "#654321");
        }
        for extra in [json!({"styleRef":"unknown"}), json!({"style":style})] {
            let mut bad = design.clone();
            bad["looks"][0]["layers"][0].as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            assert!(prepare(&RoomProject::demo(), bad).is_err());
        }
        prepare(&room, edit(json!({"op":"style","look":"opening","layer":"headline","value":style})))
            .unwrap().install(&mut room).unwrap();
        assert!(room.authored_designs[id].source["looks"][0]["layers"][0].get("styleRef").is_none());
        assert_eq!(room.authored_designs[id].source["looks"][1]["layers"][0]["styleRef"], "heading");
    }

    #[test]
    fn binding_and_cloning_keep_independently_editable_sources() {
        let mut room = room_with_design();
        let id = "native-edit";
        let before = room.production.sets[id].clone();
        let mut bound = before.clone();
        crate::set_slots::assign(&mut bound, "node/stage/speaker", "screen");
        let changed = room.authored_designs[id]
            .rebound(id, &before, &bound, "node/stage/speaker", "screen")
            .unwrap()
            .unwrap();
        room.production.sets.insert(id.into(), bound.clone());
        room.authored_designs.insert(id.into(), Arc::new(changed));
        let copy = "native-edit-copy";
        room.production.sets.insert(copy.into(), bound);
        room.authored_designs.insert(
            copy.into(),
            Arc::new(room.authored_designs[id].renamed(copy).unwrap()),
        );
        prepare(&room, movement(copy, 0.3))
            .unwrap()
            .install(&mut room)
            .unwrap();
        assert_ne!(
            room.authored_designs[id].source_hash,
            room.authored_designs[copy].source_hash
        );
        for set in [id, copy] {
            assert_eq!(
                crate::set_slots::bindings(&room.production.sets[set])["node/stage/speaker"],
                "screen"
            );
        }
    }
}
