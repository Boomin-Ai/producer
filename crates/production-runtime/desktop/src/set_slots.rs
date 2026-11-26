//! Stable addresses for source bindings in authored layouts and GPU pass inputs.
use crate::model::{RoomProject, SetLayoutPair};
use producer_production_contract::{
    Content, GraphInput, GraphPass, Node, Paint, Role, Set, Source,
};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Slot {
    pub key: String,
    pub name: String,
    pub source: String,
    pub component: bool,
}

pub fn for_pair(room: &RoomProject, set: &Set, pair: &SetLayoutPair) -> Vec<Slot> {
    let mut entries = Vec::new();
    let mut graphs = BTreeSet::new();
    fn visit(
        room: &RoomProject,
        node: &Node,
        path: String,
        component: bool,
        graphs: &mut BTreeSet<String>,
        entries: &mut Vec<Slot>,
    ) {
        if let Some(Paint::Graph { graph }) = node.style.as_ref().and_then(|s| s.fill.as_ref()) {
            graphs.insert(graph.clone());
        }
        match &node.content {
            Content::Source { source, .. } => {
                let slot = Slot {
                    key: path.clone(),
                    name: node.id.clone(),
                    source: source.clone(),
                    component,
                };
                if !entries.contains(&slot) {
                    entries.push(slot);
                }
            }
            Content::Component { definition, .. } => {
                if let Some(c) = room.production.components.get(definition) {
                    visit(
                        room,
                        &c.root,
                        format!("{path}/{}", c.root.id),
                        true,
                        graphs,
                        entries,
                    );
                }
            }
            _ => {}
        }
        for child in &node.children {
            visit(
                room,
                child,
                format!("{path}/{}", child.id),
                component,
                graphs,
                entries,
            );
        }
    }
    for id in pair.ids() {
        if let Some(layout) = set.layouts.get(id) {
            visit(
                room,
                &layout.root,
                format!("node/{}", layout.root.id),
                false,
                &mut graphs,
                &mut entries,
            );
            graphs.extend(set.output_graphs.get(id).cloned());
        }
    }
    for graph in graphs {
        if let Some(g) = set.graphs.get(&graph) {
            for pass in &g.passes {
                let (GraphPass::Fragment { id, .. } | GraphPass::Geometry { id, .. }) = pass else {
                    continue;
                };
                for (index, input) in pass.inputs().iter().enumerate() {
                    if let GraphInput::Source { id: source } = input {
                        entries.push(Slot {
                            key: format!("graph/{graph}/{id}/{index}"),
                            name: if id == "exchange-live-screen" {
                                "Billboard".into()
                            } else {
                                format!("{id} · {source}")
                            },
                            source: source.clone(),
                            component: false,
                        });
                    }
                }
            }
        }
    }
    entries
}

pub fn bindings(set: &Set) -> BTreeMap<String, String> {
    fn visit(node: &Node, path: String, result: &mut BTreeMap<String, String>) {
        if let Content::Source { source, .. } = &node.content {
            result.entry(path.clone()).or_insert_with(|| source.clone());
        }
        for child in &node.children {
            visit(child, format!("{path}/{}", child.id), result);
        }
    }
    let mut result = BTreeMap::new();
    for layout in set.layouts.values() {
        visit(
            &layout.root,
            format!("node/{}", layout.root.id),
            &mut result,
        );
    }
    for (key, graph) in &set.graphs {
        for pass in &graph.passes {
            let (GraphPass::Fragment { id, .. } | GraphPass::Geometry { id, .. }) = pass else {
                continue;
            };
            for (i, input) in pass.inputs().iter().enumerate() {
                if let GraphInput::Source { id: src } = input {
                    result.insert(format!("graph/{key}/{id}/{i}"), src.clone());
                }
            }
        }
    }
    result
}

pub fn assign(set: &mut Set, key: &str, source: &str) {
    let parts: Vec<_> = key.split('/').collect();
    match parts.as_slice() {
        ["node", path @ ..] => {
            for layout in set.layouts.values_mut() {
                let Some((first, children)) = path.split_first() else {
                    continue;
                };
                if layout.root.id != *first {
                    continue;
                }
                let node = children.iter().try_fold(&mut layout.root, |node, id| {
                    node.children.iter_mut().find(|child| child.id == *id)
                });
                if let Some(Node {
                    content:
                        Content::Source {
                            source: binding, ..
                        },
                    ..
                }) = node
                {
                    source.clone_into(binding);
                }
            }
        }
        ["graph", graph, pass, index] => {
            let Some(graph) = set.graphs.get_mut(*graph) else {
                return;
            };
            for item in &mut graph.passes {
                let (GraphPass::Fragment { id, inputs, .. }
                | GraphPass::Geometry { id, inputs, .. }) = item
                else {
                    continue;
                };
                if id.as_str() != *pass {
                    continue;
                }
                if let Some(GraphInput::Source { id }) =
                    index.parse::<usize>().ok().and_then(|i| inputs.get_mut(i))
                {
                    source.clone_into(id);
                }
            }
        }
        _ => {}
    }
}

pub(crate) fn visual_source(room: &RoomProject, id: &str) -> bool {
    matches!(
        room.production.sources.get(id),
        Some(Source::Live {
            role: Role::HostCamera | Role::Screen | Role::Guest
        })
    ) || (matches!(id, "movie" | "take")
        && matches!(room.production.sources.get(id), Some(Source::Player { .. })))
}
