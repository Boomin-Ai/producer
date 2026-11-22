//! Compiled lifetime/use dependencies, built on the control lane. No native
//! allocations, implicit decoder sharing or frame-callback graph traversal.
use crate::{
    compile::{NodePlan, SequencePlan},
    contract::*,
    ownership::{self, Lane, Ownership, ResourceId, ScopeId, ScopeKind},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ResourceKind {
    Asset,
    Font,
    Capture,
    Player,
    Graphics,
    GraphicsBatch,
    Set,
    Layout,
    Component,
    Sequence,
    PlayerReader,
    AudioRoute,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSpec {
    pub owner: String,
    pub kind: ResourceKind,
    pub lane: Lane,
    pub identity: Option<Digest>,
    pub dependencies: BTreeSet<String>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DependencyPlan {
    /// Scope path -> parent path. The document root is implicit.
    pub scopes: BTreeMap<String, String>,
    pub resources: BTreeMap<String, ResourceSpec>,
}
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResourceBinding {
    pub path: String,
    pub resource: ResourceId,
    pub kind: ResourceKind,
    pub lane: Lane,
    pub dependencies: Vec<ResourceId>,
}
pub(crate) struct InstalledDependencies {
    pub ownership: Ownership,
    pub scopes: BTreeMap<String, ScopeId>,
    pub resources: Arc<BTreeMap<String, ResourceBinding>>,
}
fn fail(message: &str) -> Error {
    Error::new("RESOURCE_LIMIT", "dependencies", message)
}
impl DependencyPlan {
    fn scope(&mut self, path: &str, parent: &str) -> Result<()> {
        // Leave room for one run and one segment. Definition expansion cannot
        // consume the independent stop/navigation path's scope allowance.
        if !self.scopes.contains_key(path) && self.scopes.len() + 3 >= ownership::SCOPES {
            return Err(fail("compiled scopes must leave run/segment capacity"));
        }
        self.scopes.insert(path.into(), parent.into());
        Ok(())
    }
    fn resource(&mut self, path: &str, owner: &str, kind: ResourceKind, lane: Lane) -> Result<()> {
        if self.resources.contains_key(path) {
            return Err(fail("duplicate compiled resource path"));
        }
        if self.resources.len() >= ownership::RESOURCES {
            return Err(fail("compiled resource capacity"));
        }
        self.resources.insert(
            path.into(),
            ResourceSpec {
                owner: owner.into(),
                kind,
                lane,
                identity: None,
                dependencies: BTreeSet::new(),
            },
        );
        Ok(())
    }
    fn depend(&mut self, user: &str, dependency: &str) -> Result<()> {
        if !self.resources.contains_key(dependency) {
            return Err(fail("compiled dependency is missing"));
        }
        // Also reserve a run borrower and a segment's contribution per resource.
        let edge_count: usize = self.resources.values().map(|r| r.dependencies.len()).sum();
        let resources = self.resources.len();
        let r = self
            .resources
            .get_mut(user)
            .ok_or_else(|| fail("compiled user is missing"))?;
        if !r.dependencies.contains(dependency)
            && edge_count + 2 * resources >= ownership::RELATIONS
        {
            return Err(fail(
                "compiled dependencies must leave logical user capacity",
            ));
        }
        r.dependencies.insert(dependency.into());
        Ok(())
    }
    pub fn work(&self) -> usize {
        self.scopes.len()
            + self.resources.len()
            + self
                .resources
                .values()
                .map(|r| r.dependencies.len())
                .sum::<usize>()
    }
    pub(crate) fn install(&self) -> Result<InstalledDependencies> {
        let mut ownership = Ownership::new();
        let mut scopes = BTreeMap::from([("document".into(), ownership.root())]);
        for (path, parent) in &self.scopes {
            let parent = scopes
                .get(parent)
                .copied()
                .ok_or_else(|| fail("scope parent is missing"))?;
            scopes.insert(path.clone(), ownership.enter(parent, ScopeKind::Component)?);
        }
        let mut resources = BTreeMap::new();
        for (path, r) in &self.resources {
            let owner = scopes
                .get(&r.owner)
                .copied()
                .ok_or_else(|| fail("resource owner is missing"))?;
            resources.insert(
                path.clone(),
                ResourceBinding {
                    path: path.clone(),
                    resource: ownership.own(owner, r.lane)?,
                    kind: r.kind,
                    lane: r.lane,
                    dependencies: vec![],
                },
            );
        }
        for (path, r) in &self.resources {
            let resource = resources[path].resource;
            let mut dependencies = vec![];
            for key in &r.dependencies {
                let dependency = resources
                    .get(key)
                    .ok_or_else(|| fail("resource dependency is missing"))?
                    .resource;
                ownership.depend(resource, dependency)?;
                dependencies.push(dependency);
            }
            resources.get_mut(path).unwrap().dependencies = dependencies;
        }
        Ok(InstalledDependencies {
            ownership,
            scopes,
            resources: Arc::new(resources),
        })
    }
}

fn containing_scope<'a>(scopes: &'a BTreeMap<String, String>, path: &str) -> Option<&'a str> {
    let mut candidate = path;
    loop {
        if let Some((key, _)) = scopes.get_key_value(candidate) {
            return Some(key);
        }
        candidate = candidate.rsplit_once('/')?.0;
    }
}

pub(crate) fn compile(
    d: &Document,
    nodes: &[Arc<NodePlan>],
    sequences: &BTreeMap<String, Arc<SequencePlan>>,
    targets: &[Target],
) -> Result<DependencyPlan> {
    let mut p = DependencyPlan::default();
    for (id, a) in &d.assets {
        let path = format!("assets/{id}");
        let lane = match a.kind {
            AssetKind::Image | AssetKind::Geometry | AssetKind::Material | AssetKind::Font => {
                Lane::Renderer
            }
            AssetKind::Video | AssetKind::Audio => Lane::Control,
        };
        p.resource(&path, "document", ResourceKind::Asset, lane)?;
        p.resources.get_mut(&path).unwrap().identity = Some(a.hash.clone());
    }
    for (id, source) in &d.sources {
        let path = format!("sources/{id}");
        let (kind, lane) = match source {
            Source::Live { .. } => (ResourceKind::Capture, Lane::Video),
            Source::Player { .. } => (ResourceKind::Player, Lane::Video),
            Source::Graphics { .. } => (ResourceKind::Graphics, Lane::Renderer),
        };
        p.resource(&path, "document", kind, lane)?;
        match source {
            Source::Player { asset } => p.depend(&path, &format!("assets/{asset}"))?,
            Source::Graphics { scene } => {
                for batch in &scene.batches {
                    let batch_path = format!("{path}/batches/{}", batch.id);
                    p.resource(
                        &batch_path,
                        "document",
                        ResourceKind::GraphicsBatch,
                        Lane::Renderer,
                    )?;
                    p.depend(&batch_path, &format!("assets/{}", batch.geometry))?;
                    p.depend(&batch_path, &format!("assets/{}", batch.material))?;
                    p.depend(&path, &batch_path)?;
                }
            }
            Source::Live { .. } => {}
        }
    }
    for (id, set) in &d.sets {
        let path = format!("sets/{id}");
        p.scope(&path, "document")?;
        p.resource(&path, &path, ResourceKind::Set, Lane::Video)?;
        for layout in set.layouts.keys() {
            let child = format!("{path}/layouts/{layout}");
            p.scope(&child, &path)?;
            p.resource(&child, &child, ResourceKind::Layout, Lane::Video)?;
            p.depend(&child, &path)?;
        }
    }
    // Expanded node order is preorder. Component instances receive different
    // scopes even when they refer to the same pinned component definition.
    for node in nodes {
        if node.kind == "component" {
            let parent = containing_scope(&p.scopes, &node.path)
                .ok_or_else(|| fail("component owner missing"))?
                .to_string();
            p.scope(&node.path, &parent)?;
            p.resource(
                &node.path,
                &node.path,
                ResourceKind::Component,
                Lane::Renderer,
            )?;
            p.depend(&parent, &node.path)?;
        }
        let owner = containing_scope(&p.scopes, &node.path)
            .ok_or_else(|| fail("node owner missing"))?
            .to_string();
        if let Some(source) = &node.source {
            p.depend(&owner, &format!("sources/{source}"))?;
        }
        if let Some(source) = node.aspect.as_ref().and_then(|a| a.source.as_ref()) {
            p.depend(&owner, &format!("sources/{source}"))?;
        }
        if let Some(font) = &node.font {
            let path = format!("fonts/{font}");
            if !p.resources.contains_key(&path) {
                p.resource(&path, "document", ResourceKind::Font, Lane::Renderer)?;
                p.resources.get_mut(&path).unwrap().identity = Some(font.clone());
            }
            p.depend(&owner, &path)?;
        }
    }
    for (id, sequence) in sequences {
        let path = format!("sequences/{id}");
        p.scope(&path, "document")?;
        p.resource(&path, &path, ResourceKind::Sequence, Lane::Control)?;
        for player in &sequence.players {
            let reader = format!("{path}/readers/{}", player.path);
            p.resource(&reader, &path, ResourceKind::PlayerReader, Lane::Video)?;
            p.depend(&reader, &format!("sources/{}", player.source))?;
            p.depend(&path, &reader)?;
        }
        for route in &sequence.routes {
            let bus = match route.bus {
                Bus::Program => "program",
                Bus::Monitor => "monitor",
            };
            let route_path = format!("{path}/audio/{}/{bus}", route.source);
            p.resource(&route_path, &path, ResourceKind::AudioRoute, Lane::Audio)?;
            p.depend(&route_path, &format!("sources/{}", route.source))?;
            p.depend(&path, &route_path)?;
        }
        for track in &sequence.tracks {
            let target = &targets[track.target].path;
            let dependency = if target.starts_with("sources/") {
                // Graphics targets include a parameter name beneath the source.
                let source = target
                    .split('/')
                    .nth(1)
                    .ok_or_else(|| fail("source target missing"))?;
                format!("sources/{source}")
            } else {
                containing_scope(&p.scopes, target)
                    .ok_or_else(|| fail("track owner missing"))?
                    .to_string()
            };
            p.depend(&path, &dependency)?;
        }
    }
    if p.resources
        .values()
        .map(|r| r.dependencies.len())
        .sum::<usize>()
        + 2 * p.resources.len()
        > ownership::RELATIONS
    {
        return Err(fail(
            "compiled graph leaves insufficient logical user capacity",
        ));
    }
    Ok(p)
}
