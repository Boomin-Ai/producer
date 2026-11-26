//! Shared laboratory shapes; not shipped templates or a public authoring API.
use producer_production_core::{compile, contract::*, retention};
use std::collections::BTreeMap;
fn node(id: &str, content: Content) -> Node {
    Node {
        style: None,
        id: id.into(),
        frame: Some(Rect {
            x: 0.0,
            y: 0.0,
            width: 10.0,
            height: 10.0,
        }),
        placement: None,
        flow: Flow::Overlay,
        content,
        children: vec![],
        bindings: vec![],
    }
}
fn range(seconds: i64) -> Range {
    Range {
        start: Time::ZERO,
        duration: Time::seconds(seconds),
    }
}
fn instance(id: &str, sequence: &str, start: i64) -> SequenceInstance {
    SequenceInstance {
        id: id.into(),
        sequence: sequence.into(),
        range: Range {
            start: Time::seconds(start),
            duration: Time::seconds(4),
        },
        source_in: Time::ZERO,
        speed: Speed::default(),
        looping: false,
        target_bindings: vec![],
        source_bindings: vec![],
    }
}
pub fn document(id: &str, nested: bool) -> Document {
    let mut d = fixture::analytic_reconstruction();
    d.id = id.into();
    d.title = "Pressure 000000".into();
    d.sequences.clear();
    d.shows.clear();
    d.components.clear();
    d.sets.clear();
    // 128 component placements plus ordinary nodes reach 4,096 expanded nodes.
    // Thousands of component/reader scopes are separately rejected by ownership.
    let component = Component {
        version: 1,
        authority: Authority::Local,
        props: BTreeMap::new(),
        root: node(
            "surface",
            Content::Source {
                source: "stage".into(),
                fit: Fit::Contain,
            },
        ),
    };
    let pin = digest(&component).unwrap();
    d.components.insert("surface".into(), component);
    let mut layouts = BTreeMap::new();
    for (layout, orientation, width, height) in [
        ("wide", Orientation::Landscape, 1920, 1080),
        ("tall", Orientation::Vertical, 1080, 1920),
    ] {
        let mut root = node("root", Content::Group);
        root.frame = Some(Rect {
            x: 0.0,
            y: 0.0,
            width: width as f64,
            height: height as f64,
        });
        root.children = (0..1983)
            .map(|n| {
                node(
                    &format!("slot-{n:04}"),
                    if n < 64 {
                        Content::Component {
                            definition: "surface".into(),
                            pin: pin.clone(),
                            props: BTreeMap::new(),
                        }
                    } else {
                        Content::Group
                    },
                )
            })
            .collect();
        layouts.insert(
            layout.into(),
            Layout {
                orientation,
                width,
                height,
                root,
            },
        );
    }
    d.sets.insert(
        "pressure".into(),
        Set {
            canvas_fit: Default::default(),
            graphs: Default::default(),
            output_graphs: Default::default(),
            layout_transition_ms: None,
            reversible_layout_transitions: BTreeMap::new(),
            layouts,
            theme: BTreeMap::new(),
            actions: BTreeMap::new(),
            controls: vec![],
        },
    );
    let inv = validate_document(&d).unwrap();
    assert_eq!(inv.expanded_nodes, NODES);
    let track_count = if nested { 128 } else { TRACKS };
    let keys = if nested { KEYS } else { 64 };
    let targets = inv
        .targets
        .into_iter()
        .filter(|t| t.property == Property::Opacity)
        .take(track_count);
    let duration = if nested { 4 } else { 8 };
    let leaf = Sequence {
        duration: Time::seconds(duration),
        instances: vec![],
        tracks: targets
            .enumerate()
            .map(|(i, target)| Track {
                id: format!("track-{i}"),
                target,
                range: range(duration),
                interpolation: Interpolation::Linear,
                keys: (0..keys)
                    .map(|k| Key {
                        at: Time::new(k as i64 * duration, (keys - 1) as u32).unwrap(),
                        value: Value::Number((k % 2) as f64),
                    })
                    .collect(),
            })
            .collect(),
        placements: (0..if nested { 128 } else { 768 })
            .map(|i| Placement {
                id: format!("fx-{i}"),
                source: "stage".into(),
                range: range(duration),
                source_in: Time::ZERO,
                speed: Speed::default(),
                looping: false,
            })
            .collect(),
        cues: vec![],
        audio_routes: vec![],
    };
    if nested {
        d.sequences.insert("leaf".into(), leaf);
        d.sequences.insert(
            "middle".into(),
            Sequence {
                duration: Time::seconds(4),
                instances: vec![instance("inner", "leaf", 0)],
                placements: vec![],
                tracks: vec![],
                cues: vec![],
                audio_routes: vec![],
            },
        );
        d.sequences.insert(
            "timeline".into(),
            Sequence {
                duration: Time::seconds(8),
                instances: vec![
                    instance("first", "middle", 0),
                    instance("second", "middle", 4),
                ],
                placements: vec![],
                tracks: vec![],
                cues: vec![],
                audio_routes: vec![],
            },
        );
    } else {
        d.sequences.insert("timeline".into(), leaf);
    }
    // Near the unchanged byte cap, with room for a request envelope and title edits.
    let target = DOCUMENT_BYTES - 4096;
    let mut left = target
        .checked_sub(retention::measure(&d).unwrap().encoded_bytes)
        .unwrap();
    let mut n = 0;
    while left > 64 {
        let key = format!("padding-{n:04}");
        let overhead = key.len() + 6;
        let len = (left - overhead).min(STRING_BYTES);
        d.metadata
            .insert(key, serde_json::Value::String("x".repeat(len)));
        left -= len + overhead;
        n += 1;
    }
    let p = compile::compile(&d).unwrap();
    assert_eq!(p.nodes.len(), NODES);
    assert_eq!(p.inventory.expanded_tracks, TRACKS);
    assert_eq!(
        p.sequences["timeline"].effects.len(),
        if nested { 256 } else { 768 }
    );
    d
}
