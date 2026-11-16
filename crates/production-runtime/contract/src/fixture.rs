//! Synthetic, file-free proof document. Not the shipped Classic Set.
use crate::*;
use std::collections::BTreeMap;
fn node(id: &str, frame: Option<Rect>, content: Content) -> Node {
    Node {
        id: id.into(),
        frame,
        flow: Flow::Overlay,
        content,
        children: vec![],
        bindings: vec![],
    }
}
fn box_at(x: f64, y: f64, width: f64, height: f64) -> Option<Rect> {
    Some(Rect {
        x,
        y,
        width,
        height,
    })
}
pub fn classic_like() -> Document {
    let mut d = Document::empty("classic-lab", "Classic · production core proof");
    for (id, kind, c) in [
        ("movie", AssetKind::Video, 'a'),
        ("geometry", AssetKind::Geometry, 'b'),
        ("material", AssetKind::Material, 'c'),
    ] {
        d.assets.insert(
            id.into(),
            Asset {
                hash: c.to_string().repeat(64),
                kind,
                available: if kind == AssetKind::Video {
                    Some(Range {
                        start: Time::seconds(-1),
                        duration: Time::seconds(21),
                    })
                } else {
                    None
                },
            },
        );
    }
    d.sources.insert(
        "host".into(),
        Source::Live {
            role: Role::HostCamera,
        },
    );
    d.sources
        .insert("screen".into(), Source::Live { role: Role::Screen });
    for id in ["player-a", "player-b"] {
        d.sources.insert(
            id.into(),
            Source::Player {
                asset: "movie".into(),
            },
        );
    }
    d.sources.insert(
        "stage".into(),
        Source::Graphics {
            scene: Scene3d {
                analytic: true,
                parameters: BTreeMap::from([
                    (
                        "camera".into(),
                        SceneParameter {
                            property: Property::CameraPosition,
                            initial: Value::Vec3([0.0, 0.0, 5.0]),
                        },
                    ),
                    (
                        "key-light".into(),
                        SceneParameter {
                            property: Property::LightIntensity,
                            initial: Value::Number(1.0),
                        },
                    ),
                    (
                        "accent".into(),
                        SceneParameter {
                            property: Property::MaterialColor,
                            initial: Value::Color("#83d9ba".into()),
                        },
                    ),
                ]),
                batches: vec![Batch {
                    id: "lights".into(),
                    geometry: "geometry".into(),
                    material: "material".into(),
                    instances: 1000,
                }],
            },
        },
    );
    let mut badge = node("badge", None, Content::Group);
    let mut text = node(
        "label",
        box_at(0.0, 0.0, 280.0, 60.0),
        Content::Text {
            value: "Your next chapter".into(),
            font: "d".repeat(64),
        },
    );
    text.bindings.push(Binding {
        property: Property::Opacity,
        expression: Expr::Input {
            name: "level".into(),
        },
    });
    badge.children.push(text);
    let component = Component {
        version: 1,
        authority: Authority::Local,
        props: BTreeMap::from([("level".into(), Value::Number(0.8))]),
        root: badge,
    };
    let pin = digest(&component).unwrap();
    d.components.insert("badge".into(), component);
    let mut layouts = BTreeMap::new();
    for (id, orientation, width, height) in [
        ("wide", Orientation::Landscape, 1920, 1080),
        ("tall", Orientation::Vertical, 1080, 1920),
    ] {
        let mut root = node(
            "root",
            box_at(0.0, 0.0, width as f64, height as f64),
            Content::Group,
        );
        root.children.push(node(
            "host",
            box_at(32.0, 80.0, 600.0, 640.0),
            Content::Source {
                source: "host".into(),
                fit: Fit::Cover,
            },
        ));
        root.children.push(node(
            "screen",
            box_at(32.0, 760.0, 1000.0, 280.0),
            Content::Source {
                source: "screen".into(),
                fit: Fit::Contain,
            },
        ));
        for (i, name) in ["first-badge", "second-badge"].into_iter().enumerate() {
            root.children.push(node(
                name,
                box_at(680.0, 80.0 + i as f64 * 100.0, 280.0, 60.0),
                Content::Component {
                    definition: "badge".into(),
                    pin: pin.clone(),
                    props: BTreeMap::from([(
                        "level".into(),
                        Value::Number(if i == 0 { 0.8 } else { 0.4 }),
                    )]),
                },
            ));
        }
        layouts.insert(
            id.into(),
            Layout {
                orientation,
                width,
                height,
                root,
            },
        );
    }
    let host_target = Target {
        path: "sets/classic/layouts/wide/root/host".into(),
        property: Property::Opacity,
    };
    let mut set = Set {
        layouts,
        theme: BTreeMap::from([
            ("accent".into(), "#83d9ba".into()),
            ("surface".into(), "#10141c".into()),
        ]),
        actions: BTreeMap::new(),
        controls: vec![],
    };
    set.actions.insert(
        "hide-host".into(),
        vec![Action::SetParameter {
            target: host_target.clone(),
            value: Value::Number(0.0),
        }],
    );
    set.controls.push(Control {
        id: "host-visibility".into(),
        label: "Hide host".into(),
        action: "hide-host".into(),
        scope: ControlScope::Layout {
            layout: "wide".into(),
        },
        compact: true,
        equal_width: true,
        primary: true,
    });
    d.sets.insert("classic".into(), set);
    let range = Range {
        start: Time::ZERO,
        duration: Time::seconds(8),
    };
    let sequence = Sequence {
        instances: vec![],
        duration: range.duration,
        placements: vec![
            Placement {
                id: "clip-a".into(),
                source: "player-a".into(),
                range,
                source_in: Time::ZERO,
                speed: Speed::default(),
                looping: false,
            },
            Placement {
                id: "clip-b".into(),
                source: "player-b".into(),
                range,
                source_in: Time::seconds(4),
                speed: Speed::default(),
                looping: false,
            },
        ],
        tracks: vec![
            Track {
                id: "host-fade".into(),
                target: host_target,
                range,
                interpolation: Interpolation::Linear,
                keys: vec![
                    Key {
                        at: Time::ZERO,
                        value: Value::Number(0.0),
                    },
                    Key {
                        at: Time::seconds(8),
                        value: Value::Number(1.0),
                    },
                ],
            },
            Track {
                id: "camera-move".into(),
                target: Target {
                    path: "sources/stage/parameters/camera".into(),
                    property: Property::CameraPosition,
                },
                range,
                interpolation: Interpolation::Linear,
                keys: vec![
                    Key {
                        at: Time::ZERO,
                        value: Value::Vec3([0.0, 0.0, 5.0]),
                    },
                    Key {
                        at: Time::seconds(8),
                        value: Value::Vec3([2.0, 1.0, 3.0]),
                    },
                ],
            },
        ],
        cues: vec![Cue {
            id: "whoosh".into(),
            at: Time::seconds(2),
            at_start: false,
            each_loop: false,
        }],
        audio_routes: vec![AudioRoute {
            id: "movie-program".into(),
            source: "player-a".into(),
            bus: Bus::Program,
        }],
    };
    d.sequences.insert("opener".into(), sequence);
    d.shows.insert(
        "pilot".into(),
        Show {
            set: "classic".into(),
            authority: Authority::Local,
            segments: vec![Segment {
                id: "opening".into(),
                title: "Your first signal".into(),
                landscape: "wide".into(),
                vertical: "tall".into(),
                sequence: Some("opener".into()),
            }],
        },
    );
    d
}

/// Agent-shaped nested authoring fixture. The definition is shared, while two
/// placements bind different component properties and independent file players.
pub fn nested_timeline() -> Document {
    let mut d = classic_like();
    d.id = "nested-lab".into();
    d.title = "Nested production timeline".into();
    let target = |path: &str| Target {
        path: path.into(),
        property: Property::Opacity,
    };
    let template_target = target("sets/classic/layouts/wide/root/first-badge/badge/label");
    let blank = |seconds| Sequence {
        duration: Time::seconds(seconds),
        instances: vec![],
        placements: vec![],
        tracks: vec![],
        cues: vec![],
        audio_routes: vec![],
    };
    let mut pulse = blank(2);
    let range = Range {
        start: Time::ZERO,
        duration: Time::seconds(2),
    };
    pulse.tracks.push(Track {
        id: "fade".into(),
        target: template_target.clone(),
        range,
        keys: vec![
            Key {
                at: Time::ZERO,
                value: Value::Number(0.0),
            },
            Key {
                at: Time::seconds(2),
                value: Value::Number(1.0),
            },
        ],
        interpolation: Interpolation::Linear,
    });
    pulse.placements.push(Placement {
        id: "movie".into(),
        source: "player-a".into(),
        range,
        source_in: Time::seconds(1),
        speed: Speed::default(),
        looping: false,
    });
    pulse.cues = vec![
        Cue {
            id: "entry".into(),
            at: Time::ZERO,
            at_start: true,
            each_loop: true,
        },
        Cue {
            id: "beat".into(),
            at: Time::new(1, 2).unwrap(),
            at_start: false,
            each_loop: true,
        },
        Cue {
            id: "once".into(),
            at: Time::seconds(1),
            at_start: false,
            each_loop: false,
        },
    ];
    pulse.audio_routes.push(AudioRoute {
        id: "program".into(),
        source: "player-a".into(),
        bus: Bus::Program,
    });
    d.sequences.insert("pulse".into(), pulse);
    let mut motif = blank(4);
    motif.instances.push(SequenceInstance {
        id: "beat".into(),
        sequence: "pulse".into(),
        range: Range {
            start: Time::ZERO,
            duration: Time::seconds(4),
        },
        source_in: Time::ZERO,
        speed: Speed::default(),
        looping: true,
        target_bindings: vec![],
        source_bindings: vec![],
    });
    d.sequences.insert("motif".into(), motif);
    let mut timeline = blank(8);
    for (id, source_in, binding, player) in [
        (
            "left",
            Time::ZERO,
            "sets/classic/layouts/wide/root/first-badge/badge/label",
            "player-a",
        ),
        (
            "right",
            Time::seconds(1),
            "sets/classic/layouts/wide/root/second-badge/badge/label",
            "player-b",
        ),
    ] {
        timeline.instances.push(SequenceInstance {
            id: id.into(),
            sequence: "motif".into(),
            range: Range {
                start: Time::ZERO,
                duration: Time::seconds(8),
            },
            source_in,
            speed: Speed::default(),
            looping: true,
            target_bindings: vec![TargetBinding {
                from: template_target.clone(),
                to: target(binding),
            }],
            source_bindings: vec![SourceBinding {
                from: "player-a".into(),
                to: player.into(),
            }],
        });
    }
    d.sequences.insert("timeline".into(), timeline);
    d.shows.get_mut("pilot").unwrap().segments[0].sequence = Some("timeline".into());
    d
}
