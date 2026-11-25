//! Off-callback immutable fragment reuse. Admission remains a full-document check.
//! Only the latest accepted document is cached; failed/cancelled builds are atomic.
use crate::{compile::*, contract::*};
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

#[derive(Debug, Default, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileStats {
    pub layouts_built: usize,
    pub layouts_reused: usize,
    pub sequences_built: usize,
    pub sequences_reused: usize,
}
type LayoutFragments = BTreeMap<(String, String), Arc<Vec<Arc<NodePlan>>>>;
#[derive(Default, Clone)]
pub struct Compiler {
    document: Option<Arc<Document>>,
    inputs: Option<Arc<LayoutInputs>>,
    targets: Arc<Vec<Target>>,
    layouts: LayoutFragments,
    sequences: BTreeMap<String, Arc<SequencePlan>>,
}
fn cancelled(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Acquire) {
        Err(Error::new(
            "COMPILE_CANCELLED",
            "compile",
            "intent was superseded or stopped",
        ))
    } else {
        Ok(())
    }
}
fn layout_dependencies(
    d: &Document,
    node: &Node,
    ids: &mut BTreeSet<String>,
    sources: &mut BTreeSet<String>,
) {
    if let Some(AspectConstraint {
        ratio: AspectRatio::Source { source, .. },
        ..
    }) = node.placement.as_ref().and_then(|p| p.aspect.as_ref())
    {
        sources.insert(source.clone());
    }
    if let Content::Component { definition, .. } = &node.content {
        if ids.insert(definition.clone()) {
            layout_dependencies(d, &d.components[definition].root, ids, sources);
        }
    }
    for child in &node.children {
        layout_dependencies(d, child, ids, sources);
    }
}
fn sequence_dependencies(
    d: &Document,
    id: &str,
    ids: &mut BTreeSet<String>,
    sources: &mut BTreeSet<String>,
) {
    if !ids.insert(id.into()) {
        return;
    }
    let sequence = &d.sequences[id];
    for p in &sequence.placements {
        sources.insert(p.source.clone());
    }
    for route in &sequence.audio_routes {
        sources.insert(route.source.clone());
    }
    for child in &sequence.instances {
        for b in &child.source_bindings {
            sources.insert(b.from.clone());
            sources.insert(b.to.clone());
        }
        sequence_dependencies(d, &child.sequence, ids, sources);
    }
}
impl Compiler {
    /// Clear immutable cache references; active/retiring plans retain their own Arcs.
    pub fn clear(&mut self) {
        *self = Self::default();
    }
    pub fn fragment_count(&self) -> usize {
        self.layouts.len() + self.sequences.len()
    }
    pub fn compile(&mut self, d: &Document) -> Result<(Plan, CompileStats)> {
        self.compile_cancellable(d, &AtomicBool::new(false))
    }
    pub fn compile_with_layout_inputs(
        &mut self,
        d: &Document,
        inputs: &LayoutInputs,
    ) -> Result<(Plan, CompileStats)> {
        self.compile_cancellable_with_layout_inputs(d, inputs, &AtomicBool::new(false))
    }
    pub fn compile_cancellable(
        &mut self,
        d: &Document,
        cancel: &AtomicBool,
    ) -> Result<(Plan, CompileStats)> {
        self.compile_cancellable_with_layout_inputs(d, &LayoutInputs::empty(&d.id), cancel)
    }
    pub fn compile_cancellable_with_layout_inputs(
        &mut self,
        d: &Document,
        inputs: &LayoutInputs,
        cancel: &AtomicBool,
    ) -> Result<(Plan, CompileStats)> {
        cancelled(cancel)?;
        // Never reuse admission: pins, conflicts, bounds and permissions may change
        // even if the layout or numeric fragment itself is byte-identical.
        let inventory = validate_document(d)?;
        crate::contract::layout::validate_inputs(d, inputs)?;
        cancelled(cancel)?;
        let targets: Vec<_> = inventory.targets.iter().cloned().collect();
        let handles = targets
            .iter()
            .cloned()
            .enumerate()
            .map(|(i, t)| (t, i))
            .collect();
        let previous = self.document.as_ref().filter(|old| old.id == d.id);
        let same_targets = *self.targets == targets;
        let mut next = Self {
            document: Some(Arc::new(d.clone())),
            inputs: Some(Arc::new(inputs.clone())),
            targets: Arc::new(targets.clone()),
            ..Self::default()
        };
        let mut stats = CompileStats::default();
        let mut nodes = Vec::with_capacity(inventory.expanded_nodes);
        for (sid, set) in &d.sets {
            for (lid, layout) in &set.layouts {
                cancelled(cancel)?;
                let id = (sid.clone(), lid.clone());
                let mut ids = BTreeSet::new();
                let mut sources = BTreeSet::new();
                layout_dependencies(d, &layout.root, &mut ids, &mut sources);
                let same = previous.is_some_and(|old| {
                    old.sets.get(sid).and_then(|s| s.layouts.get(lid)) == Some(layout)
                        && ids
                            .iter()
                            .all(|id| old.components.get(id) == d.components.get(id))
                        && self.inputs.as_ref().is_some_and(|old| {
                            sources
                                .iter()
                                .all(|id| old.sources.get(id) == inputs.sources.get(id))
                        })
                });
                let value = if let Some(old) = self.layouts.get(&id).filter(|_| same) {
                    stats.layouts_reused += 1;
                    old.clone()
                } else {
                    stats.layouts_built += 1;
                    Arc::new(crate::compile::layout(d, sid, lid, inputs)?)
                };
                nodes.extend(value.iter().cloned());
                next.layouts.insert(id, value);
            }
        }
        let mut sequences = BTreeMap::new();
        let mut work = TEMPORAL_WORK;
        for id in d.sequences.keys() {
            cancelled(cancel)?;
            let mut ids = BTreeSet::new();
            let mut sources = BTreeSet::new();
            sequence_dependencies(d, id, &mut ids, &mut sources);
            // Compare typed, validated dependencies rather than serializing each
            // subgraph a second time. Canonical whole-document digest is still
            // calculated below for external identity and admission receipts.
            let same = same_targets
                && previous.is_some_and(|old| {
                    ids.iter()
                        .all(|id| old.sequences.get(id) == d.sequences.get(id))
                        && sources.iter().all(|id| {
                            old.sources.get(id) == d.sources.get(id)
                                && match &d.sources[id] {
                                    Source::Player { asset } => {
                                        old.assets.get(asset) == d.assets.get(asset)
                                    }
                                    _ => true,
                                }
                        })
                });
            let value = if let Some(old) = self.sequences.get(id).filter(|_| same) {
                stats.sequences_reused += 1;
                old.clone()
            } else {
                stats.sequences_built += 1;
                Arc::new(crate::compile::sequence(d, id, &handles, &mut work)?)
            };
            sequences.insert(id.clone(), value.clone());
            next.sequences.insert(id.clone(), value);
        }
        let dependencies = Arc::new(crate::dependencies::compile(
            d, &nodes, &sequences, &targets,
        )?);
        let document_digest = digest(d)?;
        let plan = Plan {
            analytic_sources: crate::analytic::sources(d),
            geometry_digest: geometry_digest(&document_digest, inputs)?,
            layout_inputs: next.inputs.as_ref().unwrap().clone(),
            digest: document_digest,
            nodes,
            targets,
            sequences,
            inventory,
            dependencies,
        };
        cancelled(cancel)?;
        *self = next;
        Ok((plan, stats))
    }
}
