use crate::model::{CanvasView, RoomProject};
use crate::workspace::{Edge, PanelId, Workspace};
use anyhow::{Context, Result};
use producer_production_contract::{Role, Set, Show, Source};
use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Starter {
    Clips,
    Classic,
    AtmosphereAerie,
    Pilot,
    GameShow,
}

#[derive(Deserialize)]
pub(crate) struct AuthoredStudio {
    pub set: Set,
    pub show: Show,
}

pub(crate) fn classic() -> Result<AuthoredStudio> {
    Ok(serde_json::from_slice(include_bytes!("../starter-sets/classic.json"))?)
}

impl Starter {
    pub(crate) const ALL: [Self; 5] = [
        Self::Classic, Self::AtmosphereAerie, Self::Clips, Self::Pilot, Self::GameShow,
    ];

    pub(crate) fn key(self) -> &'static str {
        match self {
            Self::Clips => "clips",
            Self::Classic => "classic",
            Self::AtmosphereAerie => "atmosphere-aerie",
            Self::Pilot => "pilot",
            Self::GameShow => "game-show",
        }
    }

    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Clips => "Clips Studio",
            Self::Classic => "Classic",
            Self::AtmosphereAerie => "Atmosphere Aerie",
            Self::Pilot => "Pilot Studio",
            Self::GameShow => "Game Show Studio",
        }
    }

    pub(crate) fn description(self) -> &'static str {
        match self {
            Self::Clips => "Turn a shared window into portrait clips.",
            Self::Classic => "Start with your camera, guests and screen share.",
            Self::AtmosphereAerie => "Present from a mountain observatory.",
            Self::Pilot => "Demo a project and shape a Set as you go.",
            Self::GameShow => "Ask a Yes or No question and reveal the answer.",
        }
    }

    pub(crate) fn art(self) -> &'static [u8] {
        match self {
            Self::Clips => include_bytes!("../starter-studios/clips.jpg"),
            Self::Classic => include_bytes!("../starter-sets/previews/classic.jpg"),
            Self::AtmosphereAerie => include_bytes!("../starter-sets/previews/atmosphere-aerie.jpg"),
            Self::Pilot => include_bytes!("../starter-studios/pilot.jpg"),
            Self::GameShow => include_bytes!("../starter-studios/game-show.jpg"),
        }
    }

    pub(crate) fn workspace(self) -> Workspace {
        use Edge::{Bottom, Left, Right};
        use PanelId::{Assistant, Clips, Controls, Mixer, People, Scenes, Sources};

        let mut workspace = Workspace::default();
        for panel in workspace.panels.values_mut() {
            panel.visible = false;
        }
        for dock in workspace.docks.values_mut() {
            dock.active = None;
        }
        let sides = match self {
            Self::Clips => [(Left, [Some(Sources), Some(Controls)]), (Right, [Some(Clips), None])],
            Self::Classic | Self::AtmosphereAerie | Self::GameShow => {
                [(Left, [Some(People), Some(Sources)]), (Right, [Some(Controls), None])]
            }
            Self::Pilot => [(Left, [Some(Sources), Some(Controls)]), (Right, [Some(Assistant), None])],
        };
        let bottom = if matches!(self, Self::Classic | Self::AtmosphereAerie) {
            [None, None]
        } else {
            [Some(Scenes), Some(Mixer)]
        };
        let layout = sides.into_iter().chain([(Bottom, bottom)]);
        let mut order = Vec::new();
        for (edge, panels) in layout {
            let dock = workspace.docks.get_mut(&edge).unwrap();
            dock.active = panels[0];
            dock.size = match edge {
                Left => 248.,
                Right => 300.,
                Bottom => 162.,
                _ => dock.size,
            };
            for id in panels.into_iter().flatten() {
                let panel = workspace.panels.get_mut(&id).unwrap();
                panel.edge = edge;
                panel.visible = true;
                order.push(id);
            }
        }
        order.extend(PanelId::ALL.into_iter().filter(|id| !workspace.panels[id].visible));
        workspace.order = order;
        workspace
    }

    pub(crate) fn apply(self, project: &mut RoomProject) -> Result<()> {
        let studio = match self {
            Self::Classic => {
                crate::starter_sets::register_classic_skyline(project);
                classic()?
            },
            Self::AtmosphereAerie => crate::starter_sets::aerie(project)?,
            _ => {
                let mut catalog: BTreeMap<String, AuthoredStudio> =
                    serde_json::from_slice(include_bytes!("../starter-studios/catalog.json"))?;
                catalog.remove(self.key()).context("Starter studio is missing")?
            }
        };
        let id = studio.show.set.clone();
        if matches!(self, Self::Classic | Self::GameShow) {
            project.production.sources.entry("rtc-guest".into()).or_insert(Source::Live { role: Role::Guest });
        }
        project.production.sets.insert(id.clone(), studio.set);
        project.production.shows.insert(id.clone(), studio.show);
        project.workspace = self.workspace();
        if self == Self::Clips {
            project.canvas.view = CanvasView::Vertical;
        }
        project.scene = id.clone();
        project.mount_set(Some(id), None)?;
        if let Some(scene) = project.room_scenes.get_mut(&project.active_scene) {
            scene.name = "Main".into();
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_starter_opens_with_a_valid_set_and_its_workflow_panels() {
        use PanelId::{Assistant, Clips, Controls, Mixer, People, Scenes, Sources, Timeline};
        for (starter, focus) in [
            (Starter::Clips, Clips), (Starter::Classic, People), (Starter::AtmosphereAerie, People),
            (Starter::Pilot, Assistant), (Starter::GameShow, Controls),
        ] {
            let mut room = RoomProject::demo();
            starter.apply(&mut room).unwrap();
            assert_eq!(room.mounted_set.as_deref(), Some(room.scene.as_str()));
            assert_eq!(room.canvas.view == CanvasView::Vertical, starter == Starter::Clips);
            for panel in [focus, Controls, Sources] {
                assert!(room.workspace.visible(panel), "{starter:?} missing {panel:?}");
            }
            let simple = matches!(starter, Starter::Classic | Starter::AtmosphereAerie);
            for panel in [Mixer, Scenes] {
                assert_eq!(room.workspace.visible(panel), !simple);
            }
            assert!(!room.workspace.visible(Timeline));
            room.workspace.validate().unwrap();
            room.compile().unwrap();
            let set = &room.production.sets[&room.scene];
            crate::render_graph::inspect(set).unwrap();
            for choice in room.set_layout_choices(&room.scene) {
                room.mount_set(Some(room.scene.clone()), Some(choice.pair)).unwrap();
                room.live_set().unwrap().compile().unwrap();
            }
        }
    }
}
