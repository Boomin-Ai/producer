use producer_production_core::{compile::*, contract::*, incremental::Compiler};
use std::{collections::BTreeMap, sync::Arc};

fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
    Rect {
        x,
        y,
        width,
        height,
    }
}
fn node(id: &str, frame: Option<Rect>) -> Node {
    Node {
        style: None,
        id: id.into(),
        frame,
        placement: None,
        flow: Flow::Overlay,
        content: Content::Group,
        children: vec![],
        bindings: vec![],
    }
}
fn single(root: Node, width: u32, height: u32) -> Document {
    let mut d = fixture::responsive_layout();
    d.sets.get_mut("teaching").unwrap().layouts = BTreeMap::from([(
        "test".into(),
        Layout {
            orientation: Orientation::Landscape,
            width,
            height,
            root,
        },
    )]);
    d
}
fn input(d: &Document, source: &str, width: u32, height: u32) -> LayoutInputs {
    LayoutInputs {
        document: d.id.clone(),
        sources: BTreeMap::from([(
            source.into(),
            SourceDimensions {
                identity: layout::source_layout_identity(d, source).unwrap(),
                display: Ratio { width, height },
            },
        )]),
    }
}
fn aspect(mode: AspectMode, width: u32, height: u32) -> NodePlacement {
    NodePlacement {
        aspect: Some(AspectConstraint {
            mode,
            ratio: AspectRatio::Fixed {
                ratio: Ratio { width, height },
            },
        }),
        ..NodePlacement::default()
    }
}
fn planned<'a>(p: &'a Plan, suffix: &str) -> &'a NodePlan {
    p.nodes.iter().find(|n| n.path.ends_with(suffix)).unwrap()
}
fn root_mut(d: &mut Document) -> &mut Node {
    &mut d
        .sets
        .get_mut("teaching")
        .unwrap()
        .layouts
        .get_mut("test")
        .unwrap()
        .root
}

#[test]
fn anchor_offsets_and_pivots_use_continuous_parent_geometry() {
    let mut root = node("root", Some(rect(10.25, 20.5, 201.5, 100.5)));
    let mut child = node("child", Some(rect(-5.0, -10.0, 40.0, 20.0)));
    child.placement = Some(NodePlacement {
        anchor: UnitPoint { x: 1.0, y: 1.0 },
        pivot: UnitPoint { x: 0.5, y: 0.5 },
        aspect: None,
    });
    root.children.push(child);
    let d = single(root, 400, 300);
    let p = compile(&d).unwrap();
    assert_eq!(planned(&p, "/child").frame, rect(187.0, 101.0, 40.0, 20.0));
    assert_eq!(planned(&p, "/child").pivot, UnitPoint { x: 0.5, y: 0.5 });
}
#[test]
fn screen_height_reflows_host_without_mutating_authored_document() {
    let d = fixture::responsive_layout();
    let original = digest(&d).unwrap();
    let a = compile(&d).unwrap();
    let b = compile_with_layout_inputs(&d, &input(&d, "screen", 4, 3)).unwrap();
    assert_eq!(
        planned(&a, "tall/root/screen").frame,
        rect(0.0, 0.0, 1080.0, 608.0)
    );
    assert_eq!(
        planned(&a, "tall/root/host").frame,
        rect(0.0, 624.0, 1080.0, 1296.0)
    );
    assert_eq!(
        planned(&b, "tall/root/screen").frame,
        rect(0.0, 0.0, 1080.0, 810.0)
    );
    assert_eq!(
        planned(&b, "tall/root/host").frame,
        rect(0.0, 826.0, 1080.0, 1094.0)
    );
    assert!(
        planned(&a, "tall/root/screen")
            .aspect
            .as_ref()
            .unwrap()
            .used_fallback
    );
    assert!(
        !planned(&b, "tall/root/screen")
            .aspect
            .as_ref()
            .unwrap()
            .used_fallback
    );
    assert_eq!(planned(&b, "tall/root/screen").fit, Some(Fit::Contain));
    assert_eq!(planned(&b, "tall/root/host").fit, Some(Fit::Cover));
    assert_eq!(a.digest, original);
    assert_eq!(b.digest, original);
    assert_eq!(digest(&d).unwrap(), original);
    assert_ne!(a.geometry_digest, b.geometry_digest);
}
#[test]
fn row_aspect_item_uses_cross_axis_before_weighted_allocation() {
    let mut root = node("root", Some(rect(0.0, 0.0, 1000.0, 200.0)));
    root.flow = Flow::Row {
        gap: 10.0,
        sizes: vec![
            Size::Aspect,
            Size::Weight {
                weight: 1.0,
                min: 100.0,
                max: 1000.0,
            },
        ],
    };
    let mut first = node("first", None);
    first.placement = Some(aspect(AspectMode::Height, 16, 9));
    root.children = vec![first, node("second", None)];
    let p = compile(&single(root, 1000, 200)).unwrap();
    assert_eq!(planned(&p, "/first").frame, rect(0.0, 0.0, 356.0, 200.0));
    assert_eq!(planned(&p, "/second").frame, rect(366.0, 0.0, 634.0, 200.0));
}
#[test]
fn contain_centers_in_grid_and_shared_edges_snap_once() {
    let mut root = node("root", Some(rect(0.0, 0.0, 101.0, 100.0)));
    root.flow = Flow::Grid {
        gap: 1.0,
        columns: 3,
    };
    for id in ["a", "b", "c"] {
        let mut child = node(id, None);
        let mut placement = aspect(AspectMode::Contain, 1, 1);
        placement.anchor = UnitPoint { x: 0.5, y: 0.5 };
        placement.pivot = placement.anchor;
        child.placement = Some(placement);
        root.children.push(child);
    }
    let p = compile(&single(root, 101, 100)).unwrap();
    for (id, x) in [("a", 0.0), ("b", 34.0), ("c", 68.0)] {
        // Continuous 33 x 33 centered at y=50. Endpoint ties snap to even.
        assert_eq!(
            planned(&p, &format!("/{id}")).frame,
            rect(x, 34.0, 33.0, 32.0)
        );
    }
}
#[test]
fn changed_inputs_only_rebuild_consuming_layouts_and_preserve_sequences() {
    let mut d = fixture::classic_like();
    let wide = &mut d
        .sets
        .get_mut("classic")
        .unwrap()
        .layouts
        .get_mut("wide")
        .unwrap()
        .root
        .children[0];
    wide.placement = Some(NodePlacement {
        aspect: Some(AspectConstraint {
            mode: AspectMode::Contain,
            ratio: AspectRatio::Source {
                source: "screen".into(),
                fallback: Ratio {
                    width: 16,
                    height: 9,
                },
            },
        }),
        ..NodePlacement::default()
    });
    let mut c = Compiler::default();
    let (a, _) = c.compile(&d).unwrap();
    let inputs = input(&d, "screen", 4, 3);
    let (b, stats) = c.compile_with_layout_inputs(&d, &inputs).unwrap();
    assert_eq!((stats.layouts_built, stats.layouts_reused), (1, 1));
    for (a, b) in a.nodes.iter().zip(&b.nodes) {
        assert_eq!(Arc::ptr_eq(a, b), a.path.contains("/tall/"));
    }
    assert!(Arc::ptr_eq(&a.sequences["opener"], &b.sequences["opener"]));
    assert_eq!(
        serde_json::to_value(&b).unwrap(),
        serde_json::to_value(compile_with_layout_inputs(&d, &inputs).unwrap()).unwrap()
    );
    let mut unrelated = inputs.clone();
    unrelated.sources.extend(input(&d, "host", 1, 1).sources);
    let (next, stats) = c.compile_with_layout_inputs(&d, &unrelated).unwrap();
    assert_eq!(stats.layouts_built, 0);
    assert!(Arc::ptr_eq(&b.nodes[0], &next.nodes[0]));
    assert_ne!(b.geometry_digest, next.geometry_digest);
}
#[test]
fn aspect_inside_reusable_component_tracks_inputs_and_ownership() {
    let mut d = fixture::classic_like();
    let component = d.components.get_mut("badge").unwrap();
    component.root.placement = Some(NodePlacement {
        aspect: Some(AspectConstraint {
            mode: AspectMode::Contain,
            ratio: AspectRatio::Source {
                source: "screen".into(),
                fallback: Ratio {
                    width: 16,
                    height: 9,
                },
            },
        }),
        ..NodePlacement::default()
    });
    let pin = digest(component).unwrap();
    for set in d.sets.values_mut() {
        for layout in set.layouts.values_mut() {
            for child in &mut layout.root.children {
                if let Content::Component { pin: p, .. } = &mut child.content {
                    *p = pin.clone();
                }
            }
        }
    }
    let mut c = Compiler::default();
    let (a, _) = c.compile(&d).unwrap();
    let (b, stats) = c
        .compile_with_layout_inputs(&d, &input(&d, "screen", 1, 1))
        .unwrap();
    assert_eq!(stats.layouts_built, 2);
    for name in ["first-badge", "second-badge"] {
        let suffix = format!("wide/root/{name}/badge");
        assert_eq!(planned(&a, &suffix).frame.width, 107.0);
        assert_eq!(planned(&b, &suffix).frame.width, 60.0);
        let resource = format!("sets/classic/layouts/wide/root/{name}");
        assert!(b.dependencies.resources[&resource]
            .dependencies
            .contains("sources/screen"));
    }
}
#[test]
fn infeasible_geometry_and_stale_inputs_do_not_poison_incremental_cache() {
    let d = fixture::responsive_layout();
    let mut c = Compiler::default();
    let (a, _) = c.compile(&d).unwrap();
    let err = c
        .compile_with_layout_inputs(&d, &input(&d, "screen", 1, 2))
        .unwrap_err();
    assert_eq!(err.code, "LAYOUT");
    let mut stale = input(&d, "screen", 4, 3);
    stale.sources.get_mut("screen").unwrap().identity = "0".repeat(64);
    assert_eq!(
        c.compile_with_layout_inputs(&d, &stale).unwrap_err().code,
        "LAYOUT_INPUT"
    );
    let (b, stats) = c.compile(&d).unwrap();
    assert_eq!(stats.layouts_built, 0);
    assert_eq!(stats.layouts_reused, 2);
    assert!(Arc::ptr_eq(&a.nodes[0], &b.nodes[0]));
    assert_eq!(a.geometry_digest, b.geometry_digest);
}
#[test]
fn source_inputs_require_matching_document_visual_definition_and_dimensions() {
    let mut d = fixture::classic_like();
    let valid = input(&d, "player-a", 640, 480);
    compile_with_layout_inputs(&d, &valid).unwrap();
    d.assets.get_mut("movie").unwrap().hash = "e".repeat(64);
    assert_eq!(
        compile_with_layout_inputs(&d, &valid).unwrap_err().code,
        "LAYOUT_INPUT"
    );
    let mut wrong_doc = input(&d, "host", 1, 1);
    wrong_doc.document = "other".into();
    assert_eq!(
        compile_with_layout_inputs(&d, &wrong_doc).unwrap_err().code,
        "LAYOUT_INPUT"
    );
    for ratio in [
        Ratio {
            width: 0,
            height: 1,
        },
        Ratio {
            width: 1,
            height: 65537,
        },
    ] {
        let mut invalid = input(&d, "host", 1, 1);
        invalid.sources.get_mut("host").unwrap().display = ratio;
        assert_eq!(
            compile_with_layout_inputs(&d, &invalid).unwrap_err().code,
            "LAYOUT_INPUT"
        );
    }
    d.assets.get_mut("movie").unwrap().kind = AssetKind::Audio;
    assert_eq!(
        layout::validate_inputs(&d, &input(&d, "player-a", 1, 1))
            .unwrap_err()
            .code,
        "LAYOUT_INPUT"
    );
    let mut huge = LayoutInputs::empty(&d.id);
    for i in 0..257 {
        huge.sources.insert(
            format!("s{i}"),
            SourceDimensions {
                identity: "0".repeat(64),
                display: Ratio {
                    width: 1,
                    height: 1,
                },
            },
        );
    }
    assert_eq!(
        layout::validate_inputs(&d, &huge).unwrap_err().code,
        "LAYOUT_INPUT"
    );
}
#[test]
fn ignored_flow_frames_and_invalid_constraint_combinations_are_rejected() {
    let original = fixture::responsive_layout();
    type InvalidConstraint = Box<dyn Fn(&mut Node)>;
    let cases: Vec<InvalidConstraint> = vec![
        Box::new(|n| n.children[0].frame = Some(rect(0.0, 0.0, 10.0, 10.0))),
        Box::new(|n| n.children[0].placement = None),
        Box::new(|n| {
            n.children[0]
                .placement
                .as_mut()
                .unwrap()
                .aspect
                .as_mut()
                .unwrap()
                .mode = AspectMode::Height
        }),
        Box::new(|n| n.children[0].placement.as_mut().unwrap().anchor.x = 1.01),
        Box::new(|n| n.children[0].placement.as_mut().unwrap().pivot.y = f64::NAN),
        Box::new(|n| {
            n.children[0]
                .placement
                .as_mut()
                .unwrap()
                .aspect
                .as_mut()
                .unwrap()
                .ratio = AspectRatio::Fixed {
                ratio: Ratio {
                    width: 0,
                    height: 1,
                },
            }
        }),
        Box::new(|n| {
            n.children[0]
                .placement
                .as_mut()
                .unwrap()
                .aspect
                .as_mut()
                .unwrap()
                .ratio = AspectRatio::Source {
                source: "missing".into(),
                fallback: Ratio {
                    width: 1,
                    height: 1,
                },
            }
        }),
        Box::new(|n| {
            n.flow = Flow::Grid {
                gap: 0.0,
                columns: 2,
            }
        }),
    ];
    for edit in cases {
        let mut d = original.clone();
        edit(
            &mut d
                .sets
                .get_mut("teaching")
                .unwrap()
                .layouts
                .get_mut("tall")
                .unwrap()
                .root,
        );
        assert_eq!(compile(&d).unwrap_err().code, "SEMANTIC");
    }
}
#[test]
fn derived_overflow_and_zero_raster_footprint_fail_explicitly() {
    let mut root = node("root", Some(rect(0.0, 0.0, 1000.0, 1000.0)));
    let mut child = node("child", Some(rect(0.0, 0.0, 1_000_000.0, 1.0)));
    child.placement = Some(aspect(AspectMode::Width, 1, 65536));
    root.children.push(child);
    let mut d = single(root, 1001, 1000);
    assert_eq!(compile(&d).unwrap_err().code, "LAYOUT");
    let child = &mut root_mut(&mut d).children[0];
    child.frame = Some(rect(0.0, 0.0, 1.0, 1.0));
    child.placement = Some(aspect(AspectMode::Contain, 1, 65536));
    assert_eq!(compile(&d).unwrap_err().code, "LAYOUT");
}
#[test]
fn seeded_anchor_geometry_matches_independent_integer_quarter_oracle() {
    fn even(q: i64) -> f64 {
        let n = q.div_euclid(4);
        let r = q.rem_euclid(4);
        (n + i64::from(r > 2 || (r == 2 && n % 2 != 0))) as f64
    }
    let mut root = node("root", Some(rect(3.25, -2.5, 333.0, 207.0)));
    let mut expected = vec![];
    let mut seed = 293_u64;
    for i in 0..512 {
        let mut next = |bound: u64| {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            (seed >> 32) % bound
        };
        let (ax, ay, px, py) = (
            next(5) as i64,
            next(5) as i64,
            next(5) as i64,
            next(5) as i64,
        );
        let (ox, oy, w, h) = (
            next(201) as i64 - 100,
            next(201) as i64 - 100,
            next(80) as i64 + 2,
            next(80) as i64 + 2,
        );
        let x = 13 + 333 * ax + ox - w * px;
        let y = -10 + 207 * ay + oy - h * py;
        expected.push(rect(
            even(x),
            even(y),
            even(x + 4 * w) - even(x),
            even(y + 4 * h) - even(y),
        ));
        let mut child = node(
            &format!("n{i}"),
            Some(rect(ox as f64 / 4.0, oy as f64 / 4.0, w as f64, h as f64)),
        );
        child.placement = Some(NodePlacement {
            anchor: UnitPoint {
                x: ax as f64 / 4.0,
                y: ay as f64 / 4.0,
            },
            pivot: UnitPoint {
                x: px as f64 / 4.0,
                y: py as f64 / 4.0,
            },
            aspect: None,
        });
        root.children.push(child);
    }
    let p = compile(&single(root, 1001, 1000)).unwrap();
    for (i, expected) in expected.into_iter().enumerate() {
        assert_eq!(planned(&p, &format!("/n{i}")).frame, expected, "case {i}");
    }
}

#[test]
fn mixed_fixed_aspect_and_weighted_items_keep_gaps_and_minimums() {
    let mut root = node("root", Some(rect(0.0, 0.0, 1200.0, 200.0)));
    root.flow = Flow::Row {
        gap: 10.0,
        sizes: vec![
            Size::Fixed { pixels: 100.0 },
            Size::Aspect,
            Size::Weight {
                weight: 1.0,
                min: 400.0,
                max: 1000.0,
            },
            Size::Weight {
                weight: 3.0,
                min: 20.0,
                max: 1000.0,
            },
        ],
    };
    let mut intrinsic = node("intrinsic", None);
    intrinsic.placement = Some(aspect(AspectMode::Height, 1, 1));
    root.children = vec![
        node("fixed", None),
        intrinsic,
        node("minimum", None),
        node("rest", None),
    ];
    let p = compile(&single(root, 1200, 200)).unwrap();
    for (name, x, width) in [
        ("fixed", 0.0, 100.0),
        ("intrinsic", 110.0, 200.0),
        ("minimum", 320.0, 400.0),
        ("rest", 730.0, 470.0),
    ] {
        assert_eq!(
            planned(&p, &format!("/{name}")).frame,
            rect(x, 0.0, width, 200.0)
        );
    }
}
#[test]
fn minimal_placement_command_is_validated_and_does_not_change_other_layouts() {
    use producer_production_core::{
        commands::{Command, Operation},
        coordinator::*,
        storage::*,
    };
    let d = fixture::responsive_layout();
    let mut c = Coordinator::new(Snapshot::new(d.clone()).unwrap(), MemoryStore::default());
    let (session, _) = c.session(true).unwrap();
    let placement = NodePlacement {
        anchor: UnitPoint { x: 1.0, y: 1.0 },
        pivot: UnitPoint { x: 1.0, y: 1.0 },
        ..NodePlacement::default()
    };
    let command = Command::Transaction {
        operations: vec![Operation::SetPlacement {
            set: "teaching".into(),
            layout: "wide".into(),
            path: vec!["root".into(), "host".into()],
            placement: Some(placement.clone()),
        }],
    };
    let ticket = c.issue(&session, Counter(0), &command, 0).unwrap();
    let result = c.submit(&session, &ticket, &command, 1).unwrap();
    assert!(matches!(result.outcome, Outcome::Saved));
    assert_eq!(c.submit(&session, &ticket, &command, 2).unwrap(), result);
    assert_eq!(
        c.state.document.sets["teaching"].layouts["tall"],
        d.sets["teaching"].layouts["tall"]
    );
    assert_eq!(
        c.state.document.sets["teaching"].layouts["wide"]
            .root
            .children[1]
            .placement,
        Some(placement)
    );
    let before = digest(&c.state.document).unwrap();
    let invalid = Command::Transaction {
        operations: vec![Operation::SetPlacement {
            set: "teaching".into(),
            layout: "tall".into(),
            path: vec!["root".into(), "screen".into()],
            placement: None,
        }],
    };
    let ticket = c.issue(&session, Counter(1), &invalid, 3).unwrap();
    assert!(matches!(
        c.submit(&session, &ticket, &invalid, 4).unwrap().outcome,
        Outcome::Rejected(_)
    ));
    assert_eq!(digest(&c.state.document).unwrap(), before);
    assert_eq!(c.state.revision, Counter(1));
}

#[test]
fn surface_styles_survive_full_and_incremental_compilation() {
    let mut root = node("root", Some(rect(0., 0., 1920., 1080.)));
    root.style = Some(SurfaceStyle {
        fill: Some(Paint::Solid {
            ink: Ink {
                color: "#101820".into(),
                opacity: 0.6,
            },
        }),
        radius: 32.,
        ..Default::default()
    });
    let mut d = single(root, 1920, 1080);
    let mut c = Compiler::default();
    let (a, _) = c.compile(&d).unwrap();
    assert_eq!(planned(&a, "/root").style.as_ref().unwrap().radius, 32.);
    d.sets
        .get_mut("teaching")
        .unwrap()
        .layouts
        .get_mut("test")
        .unwrap()
        .root
        .style
        .as_mut()
        .unwrap()
        .radius = 12.;
    let (b, _) = c.compile(&d).unwrap();
    assert_eq!(planned(&a, "/root").style.as_ref().unwrap().radius, 32.);
    assert_eq!(planned(&b, "/root").style.as_ref().unwrap().radius, 12.);
    assert_eq!(
        serde_json::to_value(&b).unwrap(),
        serde_json::to_value(compile(&d).unwrap()).unwrap()
    );
}

#[test]
fn local_surface_command_preserves_production_and_rejects_invalid_candidate() {
    use producer_production_core::commands::{self, Command, Operation};
    let root = node("root", Some(rect(0., 0., 1920., 1080.)));
    let original = single(root, 1920, 1080);
    let style = SurfaceStyle {
        radius: 24.,
        ..Default::default()
    };
    let command = |style| Command::Transaction {
        operations: vec![Operation::SetSurface {
            set: "teaching".into(),
            layout: "test".into(),
            path: vec!["root".into()],
            style,
        }],
    };
    let next = commands::apply(&original, &command(Some(style.clone()))).unwrap();
    assert_eq!(original.sources, next.sources);
    assert_eq!(original.sequences, next.sequences);
    assert_eq!(original.shows, next.shows);
    assert!(original.sets["teaching"].layouts["test"]
        .root
        .style
        .is_none());
    assert_eq!(
        next.sets["teaching"].layouts["test"].root.style,
        Some(style.clone())
    );
    assert!(commands::apply(
        &next,
        &command(Some(SurfaceStyle {
            radius: -1.,
            ..style
        }))
    )
    .is_err());
    assert_eq!(commands::apply(&next, &command(None)).unwrap(), original);
}
