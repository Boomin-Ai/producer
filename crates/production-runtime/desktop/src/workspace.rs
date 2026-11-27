//! Room workspace state. This document never enters the production render plan.
use anyhow::{bail, Result};
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PanelId {
    Sources,
    Scenes,
    Mixer,
    #[serde(rename = "guests")]
    People,
    Controls,
    Assistant,
    Timeline,
    Clips,
    Dj,
    Sound,
    Network,
    Publish,
}
impl PanelId {
    pub const ALL: [Self; 12] = [
        Self::Sources,
        Self::Scenes,
        Self::Mixer,
        Self::People,
        Self::Controls,
        Self::Timeline,
        Self::Clips,
        Self::Assistant,
        Self::Dj,
        Self::Sound,
        Self::Network,
        Self::Publish,
    ];
    pub fn launch_panels() -> impl Iterator<Item = Self> {
        let boomin = crate::boomin_account::STUDIO_PANELS;
        Self::ALL.into_iter()
            .filter(move |panel| *panel != Self::Timeline && !boomin.contains(panel))
            .chain(boomin.iter().copied())
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Sources => "Sources",
            Self::Scenes => "Scenes",
            Self::Mixer => "Audio mixer",
            Self::People => "People",
            Self::Controls => "Set Controls",
            Self::Timeline => "Timeline",
            Self::Assistant => "Assistant",
            Self::Clips => "Clips",
            Self::Dj => "DJ",
            Self::Sound => "Sound",
            Self::Network => "Network",
            Self::Publish => "Publish",
        }
    }
    pub fn key(self) -> &'static str {
        match self {
            Self::Sources => "sources",
            Self::Scenes => "scenes",
            Self::Mixer => "mixer",
            Self::People => "guests",
            Self::Controls => "controls",
            Self::Timeline => "timeline",
            Self::Assistant => "assistant",
            Self::Clips => "clips",
            Self::Dj => "dj",
            Self::Sound => "sound",
            Self::Network => "network",
            Self::Publish => "publish",
        }
    }
    pub fn parse(s: &str) -> Result<Self> {
        Self::ALL
            .into_iter()
            .find(|p| p.key() == s)
            .ok_or_else(|| anyhow::anyhow!("Unknown panel"))
    }
    pub fn accepts(self, edge: Edge) -> bool {
        self != Self::Timeline || !edge.side()
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Edge {
    Left,
    Right,
    Top,
    Bottom,
}
impl Edge {
    pub const ALL: [Self; 4] = [Self::Left, Self::Right, Self::Top, Self::Bottom];
    pub fn key(self) -> &'static str {
        match self {
            Self::Left => "left",
            Self::Right => "right",
            Self::Top => "top",
            Self::Bottom => "bottom",
        }
    }
    pub fn side(self) -> bool {
        matches!(self, Self::Left | Self::Right)
    }
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HeaderMode {
    #[default]
    Standard,
    Compact,
    Hidden,
}
impl HeaderMode {
    pub const ALL: [Self; 3] = [Self::Standard, Self::Compact, Self::Hidden];
    fn is_default(&self) -> bool { *self == Self::Standard }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Panel {
    #[serde(default, skip_serializing_if = "HeaderMode::is_default")]
    pub header: HeaderMode,
    pub edge: Edge,
    pub visible: bool,
    #[serde(default = "default_panel_weight")]
    pub weight: f32,
}
fn default_panel_weight() -> f32 {
    1.
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Dock {
    pub size: f32,
    pub collapsed: bool,
    #[serde(default)]
    pub hidden: bool,
    pub active: Option<PanelId>,
}
#[derive(Debug, Default, Copy, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeskTheme {
    #[default]
    Classic,
    OrbitalGreen,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub theme: DeskTheme,
    pub panels: BTreeMap<PanelId, Panel>,
    pub docks: BTreeMap<Edge, Dock>,
    pub order: Vec<PanelId>,
    pub selected: Option<String>,
}
// The first native prototype wrote visibility flags. Upgrade in memory; do not
// rewrite a user's project just because it was opened.
impl<'de> Deserialize<'de> for Workspace {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields, rename_all = "camelCase")]
        struct Wire {
            #[serde(default)]
            theme: DeskTheme,
            panels: Option<BTreeMap<PanelId, Panel>>,
            docks: Option<BTreeMap<Edge, Dock>>,
            order: Option<Vec<PanelId>>,
            selected: Option<String>,
            sources: Option<bool>,
            controls: Option<bool>,
            timeline: Option<bool>,
            timeline_top: Option<bool>,
        }
        let w = Wire::deserialize(d)?;
        let mut out = Self::default();
        out.theme = w.theme;
        match (w.panels, w.docks, w.order) {
            (Some(p), Some(d), Some(o))
                if [w.sources, w.controls, w.timeline, w.timeline_top]
                    .iter()
                    .all(Option::is_none) =>
            {
                let mut panels = p;
                let mut order = o;
                for id in [PanelId::Clips, PanelId::People, PanelId::Assistant, PanelId::Dj, PanelId::Sound, PanelId::Network, PanelId::Publish] {
                    if !panels.contains_key(&id) && !order.contains(&id) {
                        panels.insert(id, out.panels[&id].clone());
                        order.push(id);
                    }
                }
                out.panels = panels;
                out.docks = d;
                out.order = order;
                out.validate_registry().map_err(serde::de::Error::custom)?;
                out.reconcile();
            }
            (None, None, None) => {
                for (p, v) in [
                    (PanelId::Sources, w.sources),
                    (PanelId::Controls, w.controls),
                    (PanelId::Timeline, w.timeline),
                ] {
                    if let Some(v) = v {
                        out.panels.get_mut(&p).unwrap().visible = v;
                    }
                }
                if w.timeline_top == Some(true) {
                    out.panels.get_mut(&PanelId::Timeline).unwrap().edge = Edge::Top;
                }
                out.reconcile();
            }
            _ => {
                return Err(serde::de::Error::custom(
                    "Incomplete or conflicting workspace layout",
                ))
            }
        }
        out.selected = w.selected;
        out.validate().map_err(serde::de::Error::custom)?;
        Ok(out)
    }
}
impl Default for Workspace {
    fn default() -> Self {
        Self {
            theme: DeskTheme::Classic,
            panels: [
                (PanelId::Sources, Edge::Left, true),
                (PanelId::Scenes, Edge::Left, false),
                (PanelId::Mixer, Edge::Right, false),
                (PanelId::People, Edge::Left, false),
                (PanelId::Assistant, Edge::Right, false),
                (PanelId::Clips, Edge::Right, false),
                (PanelId::Dj, Edge::Bottom, false),
                (PanelId::Sound, Edge::Left, false),
                (PanelId::Network, Edge::Right, false),
                (PanelId::Publish, Edge::Right, false),
                (PanelId::Controls, Edge::Right, true),
                (PanelId::Timeline, Edge::Bottom, true),
            ]
            .into_iter()
            .map(|(p, edge, visible)| {
                (
                    p,
                    Panel {
                        header: HeaderMode::default(),
                        edge,
                        visible,
                        weight: 1.,
                    },
                )
            })
            .collect(),
            docks: [
                (Edge::Left, 240., Some(PanelId::Sources)),
                (Edge::Right, 288., Some(PanelId::Controls)),
                (Edge::Top, 240., None),
                (Edge::Bottom, 266., Some(PanelId::Timeline)),
            ]
            .into_iter()
            .map(|(e, size, active)| {
                (
                    e,
                    Dock {
                        size,
                        collapsed: false,
                        hidden: false,
                        active,
                    },
                )
            })
            .collect(),
            order: PanelId::ALL.to_vec(),
            selected: None,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum WorkspaceCommand {
    SetTheme { theme: DeskTheme },
    SetHeader { panel: PanelId, mode: HeaderMode },
    Place {
        panel: PanelId,
        edge: Edge,
        before: Option<PanelId>,
    },
    Move {
        panel: PanelId,
        edge: Edge,
    },
    Activate {
        panel: PanelId,
    },
    Visibility {
        panel: PanelId,
        visible: bool,
    },
    Collapse {
        edge: Edge,
        collapsed: bool,
    },
    HideDock {
        edge: Edge,
        hidden: bool,
    },
    Resize {
        edge: Edge,
        size: f32,
    },
    /// Commit a resize and compact/expanded state together after a dock drag.
    ResizeDock {
        edge: Edge,
        size: f32,
        collapsed: bool,
    },
    ResizeSplit {
        first: PanelId,
        second: PanelId,
        ratio: f32,
    },
    Reset,
}
impl Workspace {
    /// Resolve a divider drag from its original geometry, never from the moving
    /// preview. Horizontal docks snap across the otherwise unusable 40–160px gap.
    pub fn dock_drag(
        edge: Edge,
        start: f32,
        collapsed: bool,
        opening_delta: f32,
    ) -> WorkspaceCommand {
        if edge.side() {
            return WorkspaceCommand::Resize {
                edge,
                size: (start + opening_delta).clamp(160., 520.),
            };
        }
        if collapsed {
            if opening_delta < 12. {
                return WorkspaceCommand::Collapse {
                    edge,
                    collapsed: true,
                };
            }
            return WorkspaceCommand::ResizeDock {
                edge,
                size: (160. + opening_delta - 12.).clamp(160., 440.),
                collapsed: false,
            };
        }
        let size = start + opening_delta;
        if size < 100. {
            // Keep the expanded size for a subsequent click-to-restore.
            WorkspaceCommand::Collapse {
                edge,
                collapsed: true,
            }
        } else {
            WorkspaceCommand::ResizeDock {
                edge,
                size: size.clamp(160., 440.),
                collapsed: false,
            }
        }
    }
    pub fn descriptors(&self) -> BTreeMap<&'static str, serde_json::Value> {
        PanelId::ALL.into_iter().filter(|id| *id != PanelId::Timeline).map(|id| {
            let panel = &self.panels[&id];
            let edges: Vec<_> = Edge::ALL.into_iter().filter(|edge| id.accepts(*edge)).collect();
            (id.key(), serde_json::json!({
                "id": id.key(), "label": id.label(), "allowedEdges": edges,
                "headerMode": panel.header, "headerModes": HeaderMode::ALL,
                "placement": panel, "dockCollapsed": self.docks[&panel.edge].collapsed,
                "dockHidden": self.docks[&panel.edge].hidden, "scope": "workspace"
            }))
        }).collect()
    }

    fn validate_registry(&self) -> Result<()> {
        if self.panels.len() != PanelId::ALL.len()
            || self.docks.len() != 4
            || self.order.len() != PanelId::ALL.len()
            || PanelId::ALL.iter().any(|p| {
                !self.panels.contains_key(p) || self.order.iter().filter(|v| *v == p).count() != 1
            })
        {
            bail!("Invalid workspace registry");
        }
        Ok(())
    }
    pub fn validate(&self) -> Result<()> {
        self.validate_registry()?;
        for (p, s) in &self.panels {
            if !s.weight.is_finite() || !(0.0001..=16.).contains(&s.weight) {
                bail!("Invalid panel size weight");
            }
            if !p.accepts(s.edge) {
                bail!("Timeline supports top/bottom docks");
            }
        }
        for (edge, d) in &self.docks {
            let max = if edge.side() { 520. } else { 440. };
            if !d.size.is_finite() || !(160. ..=max).contains(&d.size) {
                bail!("Dock size outside supported range");
            }
            let visible = self.at(*edge);
            if d.active.is_some_and(|p| !visible.contains(&p))
                || (d.active.is_none() && !visible.is_empty())
            {
                bail!("Dock selection must reference a visible panel");
            }
        }
        Ok(())
    }
    pub fn at(&self, edge: Edge) -> Vec<PanelId> {
        self.order
            .iter()
            .copied()
            .filter(|p| self.panels[p].visible && self.panels[p].edge == edge)
            .collect()
    }
    /// Same geometry drives painting, hit targets and timeline pointer mapping.
    pub fn panel_spans(&self, edge: Edge, length: f32, editing: bool) -> Vec<(PanelId, f32, f32)> {
        let ids = self.at(edge);
        if ids.is_empty() {
            return vec![];
        }
        let add = if editing {
            if edge.side() {
                32.
            } else {
                80.
            }
        } else {
            0.
        };
        let usable = (length - add - 4. * (ids.len() - 1) as f32).max(0.);
        let total: f32 = ids.iter().map(|p| self.panels[p].weight).sum();
        let mut offset = 0.;
        ids.into_iter()
            .map(|p| {
                let size = usable * self.panels[&p].weight / total;
                let result = (p, offset, size);
                offset += size + 4.;
                result
            })
            .collect()
    }
    /// Resolve insertion against the drag-start layout; moving a placeholder must
    /// never move the hit boundaries beneath the pointer.
    pub fn insertion_before(
        &self,
        panel: PanelId,
        edge: Edge,
        coordinate: f32,
        length: f32,
    ) -> Option<PanelId> {
        self.panel_spans(edge, length, true)
            .into_iter()
            .filter(|(p, _, _)| *p != panel)
            .find(|(_, offset, size)| coordinate < offset + size * 0.5)
            .map(|(p, _, _)| p)
    }
    /// Popovers open inward from the actual inline add tile, never across it.
    pub fn panel_picker(
        &self,
        edge: Edge,
        width: f32,
        height: f32,
        extents: [f32; 4],
        count: usize,
    ) -> ([f32; 4], [f32; 4]) {
        let populated = !self.at(edge).is_empty();
        let anchor = if edge.side() {
            let extent = extents[if edge == Edge::Left { 0 } else { 1 }];
            let body_top = 48. + extents[2];
            let body_height = height - 74. - extents[2] - extents[3];
            [
                if edge == Edge::Left {
                    2.
                } else {
                    width - extent + 2.
                },
                if populated {
                    body_top + body_height - 30.
                } else {
                    body_top + (body_height - 28.) / 2.
                },
                (extent - 4.).max(0.),
                28.,
            ]
        } else {
            let extent = extents[if edge == Edge::Top { 2 } else { 3 }];
            [
                if populated {
                    width - 78.
                } else {
                    (width - 76.) / 2.
                },
                if edge == Edge::Top {
                    50.
                } else {
                    height - 26. - extent + 2.
                },
                76.,
                (extent - 4.).max(0.),
            ]
        };
        let w = 228_f32.min((width - 16.).max(1.));
        let h = (66. + count.max(1) as f32 * 44.).min((height - 90.).max(1.));
        let (x, y) = match edge {
            Edge::Left => (anchor[0] + anchor[2] + 8., anchor[1] + anchor[3] - h),
            Edge::Right => (anchor[0] - w - 8., anchor[1] + anchor[3] - h),
            Edge::Top => (anchor[0] + anchor[2] - w, anchor[1] + anchor[3] + 8.),
            Edge::Bottom => (anchor[0] + anchor[2] - w, anchor[1] - h - 8.),
        };
        (
            anchor,
            [
                x.clamp(8., (width - w - 8.).max(8.)),
                y.clamp(56., (height - h - 34.).max(56.)),
                w,
                h,
            ],
        )
    }
    pub fn visible(&self, p: PanelId) -> bool {
        self.panels[&p].visible
    }
    pub fn apply_studio(&mut self, command: WorkspaceCommand) -> Result<()> {
        use WorkspaceCommand::*;
        if matches!(command,
            Place { panel: PanelId::Timeline, .. } | Move { panel: PanelId::Timeline, .. }
            | Activate { panel: PanelId::Timeline } | Visibility { panel: PanelId::Timeline, visible: true }) {
            bail!("Timeline is unavailable in this version of Studio");
        }
        self.apply(command)?;
        self.apply_launch_visibility();
        Ok(())
    }
    pub fn apply_launch_visibility(&mut self) {
        if self.visible(PanelId::Timeline) {
            self.panels.get_mut(&PanelId::Timeline).unwrap().visible = false;
            self.reconcile();
        }
    }
    fn reconcile(&mut self) {
        for e in Edge::ALL {
            let ids = self.at(e);
            let d = self.docks.get_mut(&e).unwrap();
            if !d.active.is_some_and(|p| ids.contains(&p)) {
                d.active = ids.first().copied();
            }
        }
    }
    pub fn apply(&mut self, c: WorkspaceCommand) -> Result<()> {
        let mut next = self.clone();
        match c {
            WorkspaceCommand::SetTheme { theme } => next.theme = theme,
            WorkspaceCommand::SetHeader { panel, mode } => {
                next.panels.get_mut(&panel).unwrap().header = mode;
            }
            WorkspaceCommand::Place {
                panel,
                edge,
                before,
            } => {
                if !panel.accepts(edge) {
                    bail!("Timeline supports top/bottom docks");
                }
                if let Some(anchor) = before {
                    if anchor == panel || !next.at(edge).contains(&anchor) {
                        bail!("Insertion must reference another visible panel in the target dock");
                    }
                }
                next.order.retain(|p| *p != panel);
                let index = before
                    .and_then(|p| next.order.iter().position(|v| *v == p))
                    .unwrap_or_else(|| {
                        next.order
                            .iter()
                            .rposition(|p| next.panels[p].edge == edge)
                            .map_or(next.order.len(), |i| i + 1)
                    });
                next.order.insert(index, panel);
                let p = next.panels.get_mut(&panel).unwrap();
                p.edge = edge;
                p.visible = true;
                let d = next.docks.get_mut(&edge).unwrap();
                d.active = Some(panel);
                d.collapsed = false;
                d.hidden = false;
            }
            WorkspaceCommand::Move { panel, edge } => {
                if !panel.accepts(edge) {
                    bail!("Timeline supports top/bottom docks");
                }
                let p = next.panels.get_mut(&panel).unwrap();
                p.edge = edge;
                p.visible = true;
                let d = next.docks.get_mut(&edge).unwrap();
                d.active = Some(panel);
                d.collapsed = false;
                d.hidden = false;
            }
            WorkspaceCommand::Activate { panel } => {
                let p = next.panels.get_mut(&panel).unwrap();
                p.visible = true;
                let d = next.docks.get_mut(&p.edge).unwrap();
                d.active = Some(panel);
                d.collapsed = false;
                d.hidden = false;
            }
            WorkspaceCommand::Visibility { panel, visible } => {
                next.panels.get_mut(&panel).unwrap().visible = visible;
                if visible {
                    let e = next.panels[&panel].edge;
                    let dock = next.docks.get_mut(&e).unwrap();
                    dock.active = Some(panel);
                    dock.hidden = false;
                }
            }
            WorkspaceCommand::Collapse { edge, collapsed } => {
                let dock = next.docks.get_mut(&edge).unwrap();
                dock.collapsed = collapsed;
                if !collapsed {
                    dock.hidden = false;
                }
            }
            WorkspaceCommand::HideDock { edge, hidden } => {
                next.docks.get_mut(&edge).unwrap().hidden = hidden
            }
            WorkspaceCommand::Resize { edge, size } => {
                next.docks.get_mut(&edge).unwrap().size = size
            }
            WorkspaceCommand::ResizeDock {
                edge,
                size,
                collapsed,
            } => {
                let dock = next.docks.get_mut(&edge).unwrap();
                dock.size = size;
                dock.collapsed = collapsed;
                dock.hidden = false;
            }
            WorkspaceCommand::ResizeSplit {
                first,
                second,
                ratio,
            } => {
                if !ratio.is_finite() || !(0.05..=0.95).contains(&ratio) {
                    bail!("Invalid panel split");
                }
                let edge = next.panels[&first].edge;
                let ids = next.at(edge);
                let adjacent=ids.windows(2).any(|pair| pair == [first, second]);
                let across_hidden_timeline=next.docks[&edge].collapsed && ids.windows(3).any(|trio|trio==[first,PanelId::Timeline,second]);
                if !adjacent && !across_hidden_timeline {
                    bail!("Panel split must join adjacent visible panels");
                }
                let total = next.panels[&first].weight + next.panels[&second].weight;
                next.panels.get_mut(&first).unwrap().weight = total * ratio;
                next.panels.get_mut(&second).unwrap().weight = total * (1. - ratio);
            }
            WorkspaceCommand::Reset => {
                let selected = next.selected.clone();
                let theme = next.theme;
                next = Self::default();
                next.theme = theme;
                next.selected = selected;
            }
        }
        next.reconcile();
        for edge in Edge::ALL {
            let ids = next.at(edge);
            let sum: f32 = ids.iter().map(|p| next.panels[p].weight).sum();
            if sum > 0. {
                for panel in &ids {
                    next.panels.get_mut(panel).unwrap().weight *= ids.len() as f32 / sum;
                }
            }
        }
        next.validate()?;
        *self = next;
        Ok(())
    }
    /// Fit the workspace while reserving a useful canvas. Stored sizes are never
    /// overwritten when a small window temporarily constrains a dock.
    pub fn extents(&self, width: f32, height: f32) -> [f32; 4] {
        self.layout_extents(width, height, false)
    }
    pub fn layout_extents(&self, width: f32, height: f32, editing: bool) -> [f32; 4] {
        let mut out = [0.; 4];
        for (i, e) in Edge::ALL.into_iter().enumerate() {
            if editing {
                out[i] = if self.at(e).is_empty() {
                    if e.side() {
                        84.
                    } else {
                        56.
                    }
                } else {
                    // Edit placeholders expose membership without consuming the saved live-room footprint.
                    self.docks[&e].size.min(if e.side() { 200. } else { 112. })
                };
            } else if !self.at(e).is_empty() && !self.docks[&e].hidden {
                let d = &self.docks[&e];
                out[i] = if d.collapsed {
                    if e.side() {
                        0.
                    } else {
                        40.
                    }
                } else {
                    d.size
                };
            }
        }
        for (a, b, budget) in [
            (0, 1, (width - 320.).max(0.)),
            (2, 3, (height - 330.).max(0.)),
        ] {
            let total = out[a] + out[b];
            if total > budget && total > 0. {
                let scale = budget / total;
                out[a] *= scale;
                out[b] *= scale;
            }
        }
        out
    }
    /// Small edge hit targets restore fully hidden docks without reserving a rail.
    pub fn restore_bounds(edge: Edge, width: f32, height: f32, extents: [f32; 4]) -> [f32; 4] {
        let body_top = 48. + extents[2];
        let body_bottom = (height - 26. - extents[3]).max(body_top);
        if edge.side() {
            [
                if edge == Edge::Left {
                    0.
                } else {
                    (width - 10.).max(0.)
                },
                ((body_top + body_bottom - 56.) / 2.).max(body_top),
                10.,
                56.,
            ]
        } else {
            [
                ((width - 56.) / 2.).max(0.),
                if edge == Edge::Top {
                    48.
                } else {
                    (height - 36.).max(48.)
                },
                56.,
                10.,
            ]
        }
    }
    /// Only actual dock regions are destinations. Dropping over the canvas or
    /// outside the room cancels instead of guessing a dock from half the window.
    pub fn drop_target(x: f32, y: f32, width: f32, height: f32, extents: [f32; 4]) -> Option<Edge> {
        let [left, right, top, bottom] = extents;
        if x < 0. || x > width || y < 48. || y > height - 26. {
            return None;
        }
        if top > 0. && y < 48. + top {
            return Some(Edge::Top);
        }
        if bottom > 0. && y > height - 26. - bottom {
            return Some(Edge::Bottom);
        }
        if left > 0. && x < left {
            return Some(Edge::Left);
        }
        if right > 0. && x > width - right {
            return Some(Edge::Right);
        }
        None
    }
}
#[cfg(test)]
mod tests {

    #[test]
    fn launch_layout_hides_restored_timeline_and_reclaims_its_dock() {
        let mut layout = Workspace::default();
        layout.apply(WorkspaceCommand::Activate { panel: PanelId::Timeline }).unwrap();
        layout.apply_launch_visibility();
        assert!(!layout.visible(PanelId::Timeline));
        assert!(!PanelId::launch_panels().any(|panel| panel == PanelId::Timeline));
        assert_eq!(layout.extents(1440., 900.)[3], 0.);
        layout.validate().unwrap();
    }

    #[test]
    fn header_mode_survives_moves_and_round_trips() {
        let mut ws = Workspace::default();
        let legacy = serde_json::to_value(&ws).unwrap();
        assert!(legacy["panels"]["guests"].get("header").is_none());
        for mode in HeaderMode::ALL {
            ws.apply(WorkspaceCommand::SetHeader { panel: PanelId::People, mode }).unwrap();
            ws.apply(WorkspaceCommand::Move { panel: PanelId::People, edge: Edge::Right }).unwrap();
            ws = serde_json::from_value(serde_json::to_value(&ws).unwrap()).unwrap();
            assert_eq!(ws.panels[&PanelId::People].header, mode);
        }
        for panel in PanelId::ALL {
            ws.apply(WorkspaceCommand::SetHeader { panel, mode: HeaderMode::Hidden }).unwrap();
        }
        ws.apply(WorkspaceCommand::SetTheme { theme: DeskTheme::OrbitalGreen }).unwrap();
        let restored: Workspace = serde_json::from_value(serde_json::to_value(&ws).unwrap()).unwrap();
        assert_eq!(restored, ws);
    }

    #[test]
    fn earlier_five_panel_layout_keeps_its_docks_and_adds_people_to_the_picker() {
        let original = Workspace::default();
        let mut old = serde_json::to_value(&original).unwrap();
        old["panels"].as_object_mut().unwrap().remove("guests");
        old["order"].as_array_mut().unwrap().retain(|p| p != "guests");
        let restored: Workspace = serde_json::from_value(old).unwrap();
        assert_eq!(restored.docks, original.docks);
        assert_eq!(restored.panels, original.panels);
        assert_eq!(restored.order[..5], [PanelId::Sources, PanelId::Scenes, PanelId::Mixer, PanelId::Controls, PanelId::Timeline]);
        assert_eq!(restored.order.last(), Some(&PanelId::People));
        assert!(!restored.visible(PanelId::People));
    }
    #[test]
    fn old_workspace_gains_the_optional_boomin_panel_once() {
        let mut old = serde_json::to_value(Workspace::default()).unwrap();
        old["panels"].as_object_mut().unwrap().remove("network");
        old["order"].as_array_mut().unwrap().retain(|id| id != "network");
        let mut workspace: Workspace = serde_json::from_value(old).unwrap();
        assert!(!workspace.visible(PanelId::Network));
        assert_eq!(PanelId::launch_panels().filter(|id| *id == PanelId::Network).count(), 1);
        for edge in Edge::ALL {
            workspace.apply(WorkspaceCommand::Place { panel: PanelId::Network, edge, before: None }).unwrap();
            assert_eq!(workspace.panels[&PanelId::Network].edge, edge);
        }
    }
    #[test]
    fn insertion_reorders_and_persists_in_every_dock_without_changing_sizes() {
        for edge in Edge::ALL {
            let mut w = Workspace::default();
            for panel in [PanelId::Sources, PanelId::Scenes, PanelId::Mixer] {
                w.apply(WorkspaceCommand::Move { panel, edge }).unwrap();
            }
            let sizes = w.docks.clone();
            w.apply(WorkspaceCommand::Place {
                panel: PanelId::Mixer,
                edge,
                before: Some(PanelId::Scenes),
            })
            .unwrap();
            assert_eq!(
                w.at(edge)
                    .into_iter()
                    .filter(|p| [PanelId::Sources, PanelId::Scenes, PanelId::Mixer].contains(p))
                    .collect::<Vec<_>>(),
                vec![PanelId::Sources, PanelId::Mixer, PanelId::Scenes]
            );
            w.apply(WorkspaceCommand::Place {
                panel: PanelId::Scenes,
                edge,
                before: Some(PanelId::Sources),
            })
            .unwrap();
            w.apply(WorkspaceCommand::Place {
                panel: PanelId::Scenes,
                edge,
                before: None,
            })
            .unwrap();
            assert_eq!(w.at(edge).last(), Some(&PanelId::Scenes));
            for e in Edge::ALL {
                assert_eq!(sizes[&e].size, w.docks[&e].size);
            }
            let restored: Workspace =
                serde_json::from_str(&serde_json::to_string(&w).unwrap()).unwrap();
            assert_eq!(w, restored);
        }
    }
    #[test]
    fn insertion_preview_is_local_and_invalid_drops_are_atomic() {
        let original = Workspace::default();
        let mut preview = original.clone();
        preview
            .apply(WorkspaceCommand::Place {
                panel: PanelId::Mixer,
                edge: Edge::Top,
                before: None,
            })
            .unwrap();
        assert!(!original.visible(PanelId::Mixer));
        assert!(preview.visible(PanelId::Mixer));
        for c in [
            WorkspaceCommand::Place {
                panel: PanelId::Sources,
                edge: Edge::Right,
                before: Some(PanelId::Sources),
            },
            WorkspaceCommand::Place {
                panel: PanelId::Timeline,
                edge: Edge::Left,
                before: None,
            },
            WorkspaceCommand::Place {
                panel: PanelId::Sources,
                edge: Edge::Top,
                before: Some(PanelId::Controls),
            },
        ] {
            let before = preview.clone();
            assert!(preview.apply(c).is_err());
            assert_eq!(before, preview);
        }
    }
    #[test]
    fn insertion_hit_tests_find_before_between_and_after_for_both_axes() {
        for edge in Edge::ALL {
            let mut w = Workspace::default();
            for panel in [PanelId::Sources, PanelId::Scenes, PanelId::Mixer] {
                w.apply(WorkspaceCommand::Move { panel, edge }).unwrap();
            }
            let spans = w.panel_spans(edge, 1000., true);
            let target = spans
                .iter()
                .find(|(p, _, _)| *p == PanelId::Scenes)
                .unwrap();
            assert_eq!(
                w.insertion_before(PanelId::Mixer, edge, 0., 1000.),
                Some(PanelId::Sources)
            );
            assert_eq!(
                w.insertion_before(PanelId::Mixer, edge, target.1 + 1., 1000.),
                Some(PanelId::Scenes)
            );
            assert_eq!(w.insertion_before(PanelId::Mixer, edge, 1000., 1000.), None);
        }
    }
    use super::*;
    #[test]
    fn hiding_each_dock_preserves_panels_and_geometry_on_reopen() {
        for edge in Edge::ALL {
            let mut w = Workspace::default();
            w.apply(WorkspaceCommand::Move {
                panel: PanelId::Sources,
                edge,
            })
            .unwrap();
            w.apply(WorkspaceCommand::Move {
                panel: PanelId::Mixer,
                edge,
            })
            .unwrap();
            let panels = w.at(edge);
            let size = w.docks[&edge].size;
            w.apply(WorkspaceCommand::HideDock { edge, hidden: true })
                .unwrap();
            assert_eq!(
                w.extents(1800., 1400.)[Edge::ALL.iter().position(|e| *e == edge).unwrap()],
                0.
            );
            let mut restored: Workspace =
                serde_json::from_str(&serde_json::to_string(&w).unwrap()).unwrap();
            restored
                .apply(WorkspaceCommand::Activate {
                    panel: PanelId::Sources,
                })
                .unwrap();
            assert!(!restored.docks[&edge].hidden);
            assert_eq!(restored.docks[&edge].size, size);
            assert_eq!(restored.at(edge), panels);
        }
        // Documents saved before hidden docks existed still load normally.
        let mut json = serde_json::to_value(Workspace::default()).unwrap();
        for dock in json["docks"].as_object_mut().unwrap().values_mut() {
            dock.as_object_mut().unwrap().remove("hidden");
        }
        let legacy: Workspace = serde_json::from_value(json).unwrap();
        assert!(legacy.docks.values().all(|d| !d.hidden));
    }
    #[test]
    fn panel_picker_opens_inward_for_every_dock_and_stays_on_screen() {
        for (width, height) in [(1440., 900.), (480., 360.)] {
            for edge in Edge::ALL {
                let mut w = Workspace::default();
                w.apply(WorkspaceCommand::Move {
                    panel: PanelId::Sources,
                    edge,
                })
                .unwrap();
                let extents = w.layout_extents(width, height, true);
                let (a, b) = w.panel_picker(edge, width, height, extents, 4);
                assert!(b[0] >= 8. && b[0] + b[2] <= width - 8.);
                assert!(b[1] >= 56. && b[1] + b[3] <= height - 34.);
                if width == 1440. {
                    match edge {
                        Edge::Left => assert!(b[0] > a[0] + a[2]),
                        Edge::Right => assert!(b[0] + b[2] < a[0]),
                        Edge::Top => assert!(b[1] > a[1] + a[3]),
                        Edge::Bottom => assert!(b[1] + b[3] < a[1]),
                    }
                }
            }
        }
    }
    #[test]
    fn split_resize_is_persistent_bounded_and_only_affects_adjacent_panels() {
        let mut w = Workspace::default();
        w.apply(WorkspaceCommand::Move {
            panel: PanelId::Scenes,
            edge: Edge::Bottom,
        })
        .unwrap();
        w.apply(WorkspaceCommand::ResizeSplit {
            first: PanelId::Scenes,
            second: PanelId::Timeline,
            ratio: 0.25,
        })
        .unwrap();
        let spans = w.panel_spans(Edge::Bottom, 1000., false);
        assert_eq!(
            spans,
            vec![(PanelId::Scenes, 0., 249.), (PanelId::Timeline, 253., 747.)]
        );
        let edit = w.panel_spans(Edge::Bottom, 1000., true);
        assert_eq!(edit[1].1 + edit[1].2, 920.);
        let saved: Workspace = serde_json::from_str(&serde_json::to_string(&w).unwrap()).unwrap();
        assert_eq!(w, saved);
        for (first, second, ratio) in [
            (PanelId::Sources, PanelId::Timeline, 0.5),
            (PanelId::Scenes, PanelId::Timeline, 0.),
            (PanelId::Scenes, PanelId::Timeline, f32::NAN),
        ] {
            assert!(w
                .apply(WorkspaceCommand::ResizeSplit {
                    first,
                    second,
                    ratio
                })
                .is_err());
            assert_eq!(w, saved);
        }
        let mut old = serde_json::to_value(Workspace::default()).unwrap();
        for panel in old["panels"].as_object_mut().unwrap().values_mut() {
            panel.as_object_mut().unwrap().remove("weight");
        }
        assert_eq!(
            serde_json::from_value::<Workspace>(old).unwrap(),
            Workspace::default()
        );
    }
    #[test]
    fn editing_exposes_all_members_without_changing_room_dock_state() {
        let mut w = Workspace::default();
        for panel in [PanelId::Sources, PanelId::Mixer, PanelId::Controls] {
            w.apply(WorkspaceCommand::Move {
                panel,
                edge: Edge::Right,
            })
            .unwrap();
        }
        w.apply(WorkspaceCommand::Collapse {
            edge: Edge::Right,
            collapsed: true,
        })
        .unwrap();
        w.apply(WorkspaceCommand::HideDock {
            edge: Edge::Bottom,
            hidden: true,
        })
        .unwrap();
        let saved = w.clone();
        let edit = w.layout_extents(1440., 900., true);
        assert_eq!(edit[1], 200.);
        assert_eq!(edit[3], 112.);
        assert_eq!(
            w.at(Edge::Right),
            vec![PanelId::Sources, PanelId::Mixer, PanelId::Controls]
        );
        assert_eq!(w, saved);
        assert_eq!(w.extents(1440., 900.)[1], 0.);
        assert_eq!(w.extents(1440., 900.)[3], 0.);
    }
    #[test]
    fn edit_mode_exposes_empty_docks_and_hit_tests_real_regions() {
        let w = Workspace::default();
        let extents = w.layout_extents(1440., 900., true);
        assert_eq!(extents[2], 56.);
        assert_eq!(w.extents(1440., 900.)[2], 0.);
        for (x, y, expected) in [
            (700., 70., Some(Edge::Top)),
            (700., 820., Some(Edge::Bottom)),
            (30., 300., Some(Edge::Left)),
            (1400., 300., Some(Edge::Right)),
            (700., 300., None),
            (700., 20., None),
            (-1., 300., None),
            (700., 890., None),
        ] {
            assert_eq!(Workspace::drop_target(x, y, 1440., 900., extents), expected);
        }
        let mut empty = w.clone();
        for panel in PanelId::ALL {
            empty
                .apply(WorkspaceCommand::Visibility {
                    panel,
                    visible: false,
                })
                .unwrap();
        }
        assert_eq!(
            empty.layout_extents(1440., 900., true),
            [84., 84., 56., 56.]
        );
        assert_eq!(empty.extents(1440., 900.), [0.; 4]);
    }
    #[test]
    fn loading_repairs_stale_dock_selection() {
        let mut saved = Workspace::default();
        saved.docks.get_mut(&Edge::Left).unwrap().active = Some(PanelId::Mixer);
        saved.docks.get_mut(&Edge::Top).unwrap().active = Some(PanelId::Timeline);
        saved.docks.get_mut(&Edge::Right).unwrap().active = None;
        let restored: Workspace = serde_json::from_value(serde_json::to_value(saved).unwrap()).unwrap();
        assert_eq!(restored, Workspace::default());
    }
    #[test]
    fn horizontal_drag_snaps_and_expands_symmetrically() {
        for edge in [Edge::Top, Edge::Bottom] {
            let mut base = Workspace::default();
            base.apply(WorkspaceCommand::Move {
                panel: PanelId::Timeline,
                edge,
            })
            .unwrap();
            base.apply(WorkspaceCommand::Resize { edge, size: 266. })
                .unwrap();
            // No unusable intermediate height on the way down; collapse only
            // after crossing the midpoint between compact and expanded.
            for (delta, extent) in [(-50., 216.), (-130., 160.), (-165., 160.), (-167., 40.)] {
                let mut w = base.clone();
                w.apply(Workspace::dock_drag(edge, 266., false, delta))
                    .unwrap();
                assert_eq!(
                    w.extents(1600., 1200.)[if edge == Edge::Top { 2 } else { 3 }],
                    extent
                );
                if extent == 40. {
                    assert_eq!(w.docks[&edge].size, 266.);
                }
            }
            base.apply(WorkspaceCommand::Collapse {
                edge,
                collapsed: true,
            })
            .unwrap();
            for (delta, collapsed, size) in [
                (4., true, 266.),
                (12., false, 160.),
                (62., false, 210.),
                (500., false, 440.),
                (0., true, 266.),
            ] {
                let mut w = base.clone();
                let command = Workspace::dock_drag(edge, 40., true, delta);
                let wire = serde_json::to_string(&command).unwrap();
                w.apply(serde_json::from_str(&wire).unwrap()).unwrap();
                assert_eq!(w.docks[&edge].collapsed, collapsed);
                assert_eq!(w.docks[&edge].size, size);
            }
        }
    }
    #[test]
    fn adding_panels_keeps_existing_dock_contents() {
        let mut w = Workspace::default();
        for panel in [PanelId::Scenes, PanelId::Mixer, PanelId::Controls] {
            w.apply(WorkspaceCommand::Move {
                panel,
                edge: Edge::Left,
            })
            .unwrap();
        }
        assert_eq!(w.at(Edge::Left).len(), 4);
        assert!(w.at(Edge::Left).contains(&PanelId::Sources));
        assert_eq!(w.docks[&Edge::Left].active, Some(PanelId::Controls));
        let before = w.clone();
        assert!(w
            .apply(WorkspaceCommand::Move {
                panel: PanelId::Timeline,
                edge: Edge::Left
            })
            .is_err());
        assert_eq!(w, before);
        w.apply(WorkspaceCommand::Activate {
            panel: PanelId::Sources,
        })
        .unwrap();
        assert_eq!(w.at(Edge::Left).len(), 4);
    }
    #[test]
    fn legacy_visibility_upgrades_and_roundtrips() {
        let w:Workspace=serde_json::from_str(r#"{"sources":false,"controls":true,"timeline":true,"timelineTop":true,"selected":"clip"}"#).unwrap();
        assert!(!w.visible(PanelId::Sources));
        assert_eq!(w.panels[&PanelId::Timeline].edge, Edge::Top);
        let json = serde_json::to_string(&w).unwrap();
        assert!(!json.contains("timelineTop"));
        assert_eq!(w, serde_json::from_str(&json).unwrap());
    }
    #[test]
    fn move_close_reopen_and_collapse_preserve_position() {
        let mut w = Workspace::default();
        w.apply(WorkspaceCommand::Move {
            panel: PanelId::Controls,
            edge: Edge::Top,
        })
        .unwrap();
        w.apply(WorkspaceCommand::Visibility {
            panel: PanelId::Controls,
            visible: false,
        })
        .unwrap();
        w.apply(WorkspaceCommand::Activate {
            panel: PanelId::Controls,
        })
        .unwrap();
        assert_eq!(w.docks[&Edge::Top].active, Some(PanelId::Controls));
        w.apply(WorkspaceCommand::Collapse {
            edge: Edge::Top,
            collapsed: true,
        })
        .unwrap();
        assert!(w.visible(PanelId::Controls));
        w.validate().unwrap();
    }
    #[test]
    fn invalid_workspace_edit_is_atomic() {
        let mut w = Workspace::default();
        let original = w.clone();
        for c in [
            WorkspaceCommand::Move {
                panel: PanelId::Timeline,
                edge: Edge::Left,
            },
            WorkspaceCommand::Resize {
                edge: Edge::Left,
                size: f32::NAN,
            },
            WorkspaceCommand::Resize {
                edge: Edge::Top,
                size: 10000.,
            },
        ] {
            assert!(w.apply(c).is_err());
            assert_eq!(w, original);
        }
    }
    #[test]
    fn selected_tab_recovers_when_closed_or_moved() {
        let mut w = Workspace::default();
        w.apply(WorkspaceCommand::Move {
            panel: PanelId::Mixer,
            edge: Edge::Left,
        })
        .unwrap();
        w.apply(WorkspaceCommand::Visibility {
            panel: PanelId::Mixer,
            visible: false,
        })
        .unwrap();
        assert_eq!(w.docks[&Edge::Left].active, Some(PanelId::Sources));
        w.apply(WorkspaceCommand::Move {
            panel: PanelId::Sources,
            edge: Edge::Right,
        })
        .unwrap();
        assert_eq!(w.docks[&Edge::Left].active, None);
        w.validate().unwrap();
    }
    #[test]
    fn collapsed_sides_leave_no_rail_and_reopen_at_saved_size() {
        let mut w = Workspace::default();
        for edge in Edge::ALL {
            w.apply(WorkspaceCommand::Collapse {
                edge,
                collapsed: true,
            })
            .unwrap();
        }
        let saved: Workspace = serde_json::from_str(&serde_json::to_string(&w).unwrap()).unwrap();
        assert_eq!(saved.extents(1440., 900.), [0., 0., 0., 40.]);
        assert_eq!(
            saved.layout_extents(1440., 900., true),
            [200., 200., 56., 112.]
        );
        let size = w.docks[&Edge::Left].size;
        w.apply(WorkspaceCommand::Activate {
            panel: PanelId::Sources,
        })
        .unwrap();
        assert_eq!(w.extents(1440., 900.)[0], size);
        w.apply(WorkspaceCommand::Move {
            panel: PanelId::Controls,
            edge: Edge::Top,
        })
        .unwrap();
        w.apply(WorkspaceCommand::Collapse {
            edge: Edge::Top,
            collapsed: true,
        })
        .unwrap();
        assert_eq!(w.extents(1440., 900.)[2], 40.);
    }
    #[test]
    fn hidden_docks_have_in_bounds_restore_targets_and_editing_preserves_sizes() {
        for (width, height) in [(1440., 900.), (480., 360.)] {
            let mut w = Workspace::default();
            for edge in Edge::ALL {
                w.apply(WorkspaceCommand::HideDock { edge, hidden: true })
                    .unwrap();
            }
            let saved = w.clone();
            let extents = w.extents(width, height);
            for edge in Edge::ALL {
                let b = Workspace::restore_bounds(edge, width, height, extents);
                assert!(b[0] >= 0. && b[0] + b[2] <= width);
                assert!(b[1] >= 48. && b[1] + b[3] <= height - 26.);
                let mut restored = w.clone();
                restored
                    .apply(WorkspaceCommand::Collapse {
                        edge,
                        collapsed: false,
                    })
                    .unwrap();
                assert!(!restored.docks[&edge].hidden && !restored.docks[&edge].collapsed);
                assert_eq!(restored.docks[&edge].size, saved.docks[&edge].size);
            }
            let edit = w.layout_extents(width, height, true);
            assert!(edit[0] <= 200. && edit[1] <= 200. && edit[2] <= 112. && edit[3] <= 112.);
            assert_eq!(w, saved);
        }
    }
    #[test]
    fn small_window_preserves_canvas_and_saved_sizes() {
        let w = Workspace::default();
        let e = w.extents(800., 600.);
        assert!(e[0] + e[1] <= 480.01);
        assert!(e[2] + e[3] <= 270.01);
        assert_eq!(w.docks[&Edge::Left].size, 240.);
    }
}
