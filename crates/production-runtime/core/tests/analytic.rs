use producer_production_core::{
    analytic::*, compile::*, contract::*, coordinator::*, incremental::Compiler, show::*,
    storage::*, timeline::*, transport::OutputInstant,
};
use std::sync::Arc;

fn t(n: i64, d: u32) -> Time {
    Time::new(n, d).unwrap()
}
fn sample(q: &SequencePlan, at: Time) -> Vec<Option<EffectInputs>> {
    let mut out = vec![None; q.effects.len()];
    q.evaluate_effects_into(at, &mut out).unwrap();
    out
}
fn descriptor(d: &mut Document) -> &mut AnalyticReconstruction {
    let Source::Graphics { scene } = d.sources.get_mut("stage").unwrap() else {
        unreachable!()
    };
    scene.reconstruction.as_mut().unwrap()
}
#[test]
fn strict_authored_protocol_preserves_legacy_and_rejects_implicit_randomness() {
    let legacy = fixture::classic_like();
    let bytes = serde_json::to_vec(&legacy).unwrap();
    assert!(!String::from_utf8(bytes.clone())
        .unwrap()
        .contains("reconstruction"));
    assert_eq!(parse_document(&bytes).unwrap(), legacy);
    let p = compile(&legacy).unwrap();
    assert!(p.analytic_sources.is_empty());
    assert!(p.sequences.values().all(|q| q.effects.is_empty()));
    let mut d = fixture::analytic_reconstruction();
    for period in [Time::ZERO, t(-1, 1), t(1, 1001), Time::seconds(86_401)] {
        descriptor(&mut d).period = period;
        assert!(validate_document(&d).is_err());
    }
    for period in [t(1, 1000), Time::seconds(86_400)] {
        descriptor(&mut d).period = period;
        validate_document(&d).unwrap();
    }
    for (key, value) in [
        ("version", serde_json::json!("producer.analytic/2")),
        ("seed", serde_json::json!(42)),
        ("scope", serde_json::json!("wallClock")),
        ("random", serde_json::json!(true)),
    ] {
        let mut raw = serde_json::to_value(fixture::analytic_reconstruction()).unwrap();
        raw["sources"]["stage"]["scene"]["reconstruction"][key] = value;
        assert!(parse_document(&serde_json::to_vec(&raw).unwrap()).is_err());
    }
    let mut raw = serde_json::to_value(fixture::analytic_reconstruction()).unwrap();
    raw["sources"]["stage"]["scene"]["reconstruction"]
        .as_object_mut()
        .unwrap()
        .remove("seed");
    assert!(parse_document(&serde_json::to_vec(&raw).unwrap()).is_err());
}
#[test]
fn exact_phase_cycle_large_time_and_half_open_boundaries() {
    let p = compile(&fixture::analytic_reconstruction()).unwrap();
    let c = p.analytic_sources["stage"]
        .bind("static/layout/host")
        .unwrap();
    assert_eq!(c.sample(t(3, 4)).unwrap().phase_q32, 1 << 31);
    assert_eq!(c.sample(t(3, 2)).unwrap().phase_q32, 0);
    assert_eq!(c.sample(t(3, 2)).unwrap().cycle, Counter(1));
    assert_eq!(c.sample(t(1, 3)).unwrap().phase_q32, 954_437_176);
    let huge = c.sample(Time::seconds(i64::MAX)).unwrap();
    assert_eq!(huge.cycle, Counter(6_148_914_691_236_517_204));
    assert_eq!(huge.phase_q32, 2_863_311_530);
    assert_eq!(c.sample(t(-1, 1)), Err(EvalError::TimeRange));
    let fast = AnalyticClock {
        period: t(1, 1000),
        ..c
    };
    assert_eq!(
        fast.sample(Time::seconds(i64::MAX)),
        Err(EvalError::TimeRange)
    );
    let q = &p.sequences["timeline"];
    assert!(sample(q, Time::seconds(8)).iter().all(Option::is_none));
    assert!(q.evaluate_effects_into(Time::ZERO, &mut []).is_err());
    assert!(q
        .evaluate_effects_into(Time::seconds(9), &mut vec![None; q.effects.len()])
        .is_err());
}
#[test]
fn source_domain_pairs_orientations_placement_domain_separates_instances() {
    let p = compile(&fixture::analytic_reconstruction()).unwrap();
    let local = &p.analytic_sources["stage"];
    assert!(local.bind("").is_err());
    assert_ne!(
        local.bind("wide/root/effect").unwrap().seed,
        local.bind("tall/root/effect").unwrap().seed
    );
    let shared = &p.analytic_sources["stage-shared"];
    let wide = shared.bind("wide/root/effect").unwrap();
    let tall = shared.bind("tall/root/effect").unwrap();
    assert_eq!(wide, tall);
    assert_eq!(wide.sample(t(7, 5)), tall.sample(t(7, 5)));
    assert_eq!(wide.substream("lights"), tall.substream("lights"));
    assert_ne!(
        wide.substream("lights").seed,
        wide.substream("other-lights").seed
    );
    let q = &p.sequences["timeline"];
    let by_source = |source: &str| {
        q.effects
            .iter()
            .filter(|e| e.source == source)
            .collect::<Vec<_>>()
    };
    let local = by_source("stage");
    let shared = by_source("stage-shared");
    assert_eq!(local.len(), 2);
    assert_eq!(shared.len(), 2);
    assert_ne!(local[0].clock.seed, local[1].clock.seed);
    assert_eq!(shared[0].clock.seed, shared[1].clock.seed);
}
#[test]
fn sampling_order_recompile_unrelated_edits_and_substreams_are_stable() {
    let mut d = fixture::analytic_reconstruction();
    let p = compile(&d).unwrap();
    let q = &p.sequences["timeline"];
    let expected = sample(q, t(17, 7));
    for time in [t(7, 1), t(1, 10), t(0, 1), t(17, 7), t(8, 1)] {
        sample(q, time);
    }
    assert_eq!(sample(q, t(17, 7)), expected);
    d.title = "Unrelated copy edit".into();
    assert_eq!(
        sample(&compile(&d).unwrap().sequences["timeline"], t(17, 7)),
        expected
    );
    let input = expected.iter().flatten().next().unwrap();
    let random = input.random_word(7, 12, 3);
    assert_eq!(random, input.random_word(7, 12, 3));
    assert_ne!(random, input.random_word(7, 13, 3));
    assert_ne!(random, input.random_word(7, 12, 4));
    let later = EffectInputs {
        time: t(7, 1),
        phase_q32: 0,
        cycle: Counter(7),
        ..*input
    };
    assert_eq!(later.random_word(7, 12, 3), random);
}
#[test]
fn version_one_noise_matches_independent_integer_golden_vectors() {
    // Produced with an independent Python u32 oracle, including wrapping edges.
    let cases = [
        (
            [0, 0, 0, 0],
            [0, 1_470_471_396, 3_546_706_075, 1_831_708_461],
        ),
        (
            [1, 2, 3, 4],
            [2_423_077_775, 2_561_102_441, 4_233_459_012, 3_617_170_796],
        ),
        (
            [u32::MAX, 0x1234_5678, 0xabcd_ef01, 7],
            [1_637_176_147, 2_646_568_778, 3_874_522_475, 4_018_156_627],
        ),
    ];
    for (seed, expected) in cases {
        let input = AnalyticClock {
            version: AnalyticVersion::V1,
            seed,
            period: Time::seconds(1),
        }
        .sample(Time::ZERO)
        .unwrap();
        for ((s, i, c), want) in [
            (0, 0, 0),
            (7, 12, 3),
            (u32::MAX, u32::MAX, u32::MAX),
            (3, 4095, 11),
        ]
        .into_iter()
        .zip(expected)
        {
            assert_eq!(input.random_word(s, i, c), want);
        }
    }
}
#[test]
fn effect_command_is_incremental_atomic_and_type_checked() {
    use producer_production_core::commands::{self, Command, Operation};
    let d = fixture::classic_like();
    let r = *descriptor(&mut fixture::analytic_reconstruction());
    let apply = |source: &str, value| {
        commands::apply(
            &d,
            &Command::Transaction {
                operations: vec![Operation::SetAnalyticReconstruction {
                    source: source.into(),
                    value,
                }],
            },
        )
    };
    let edited = apply("stage", r).unwrap();
    assert_eq!(edited.sets, d.sets);
    assert_eq!(edited.shows, d.shows);
    assert_eq!(edited.sequences, d.sequences);
    assert!(apply("host", r).is_err());
    assert!(apply("missing", r).is_err());
    assert!(apply(
        "stage",
        AnalyticReconstruction {
            period: Time::ZERO,
            ..r
        }
    )
    .is_err());
    let Source::Graphics { scene } = &d.sources["stage"] else {
        unreachable!()
    };
    assert_eq!(scene.reconstruction, None);
}
#[test]
fn reconstruction_changes_fence_source_incarnations_but_numeric_edits_do_not() {
    use producer_production_core::lifecycle::*;
    let mut d = fixture::classic_like();
    let mut runtime = Runtime::default();
    let mut c = Coordinator::new(Snapshot::new(d.clone()).unwrap(), MemoryStore::default());
    let grant = c.session(true).unwrap().1;
    let take = |runtime: &mut Runtime, d: &Document, revision: u64| {
        let token = runtime.prepare(d, Counter(revision), 0).unwrap();
        for source in d.sources.keys() {
            let fence = runtime
                .fence(token, source, Counter(1), Counter(1))
                .unwrap();
            runtime
                .ready(token, source, fence, Counter(1), Counter(1))
                .unwrap();
        }
        runtime
            .take(
                token,
                Counter(revision),
                1,
                &grant,
                Counter(1),
                Counter(1),
                &[Output::Landscape, Output::Vertical],
                Swap::Confirmed,
            )
            .unwrap();
        token
    };
    let a = take(&mut runtime, &d, 0);
    let initial = runtime.instances["sources/stage"].incarnation;
    let Source::Graphics { scene } = d.sources.get_mut("stage").unwrap() else {
        unreachable!()
    };
    scene.reconstruction = Some(*descriptor(&mut fixture::analytic_reconstruction()));
    let b = take(&mut runtime, &d, 1);
    let next = runtime.instances["sources/stage"].incarnation;
    assert_ne!(initial, next);
    runtime.disposal_complete(a).unwrap();
    let Source::Graphics { scene } = d.sources.get_mut("stage").unwrap() else {
        unreachable!()
    };
    scene.parameters.get_mut("key-light").unwrap().initial = Value::Number(0.5);
    let c = take(&mut runtime, &d, 2);
    assert_eq!(runtime.instances["sources/stage"].incarnation, next);
    runtime.disposal_complete(b).unwrap();
    descriptor(&mut d).seed = Counter(77);
    take(&mut runtime, &d, 3);
    assert_ne!(runtime.instances["sources/stage"].incarnation, next);
    runtime.disposal_complete(c).unwrap();
}
#[test]
fn nested_clocks_follow_parent_trim_speed_loops_and_binding() {
    let mut d = fixture::analytic_reconstruction();
    let p = compile(&d).unwrap();
    let q = &p.sequences["timeline"];
    // Compare each placement's exact final map to the clock sampled from it;
    // independent Fraction oracle also covers these maps through the CLI.
    for at in [t(0, 1), t(1, 2), t(1, 1), t(7, 2), t(7, 1)] {
        let inputs = sample(q, at);
        for (effect, input) in q.effects.iter().zip(inputs) {
            let local = temporal::map_chain(&effect.maps, at).unwrap();
            assert_eq!(input.map(|i| i.time), local);
        }
    }
    d.sequences.get_mut("timeline").unwrap().instances[1]
        .source_bindings
        .push(SourceBinding {
            from: "stage".into(),
            to: "stage-shared".into(),
        });
    let rebound = compile(&d).unwrap();
    assert_eq!(
        rebound.sequences["timeline"]
            .effects
            .iter()
            .filter(|e| e.source == "stage-shared")
            .count(),
        3
    );
    // A procedural placement does not silently acquire file seek/speed controls.
    d.sequences.get_mut("pulse").unwrap().placements[1].speed = Speed {
        numerator: 2,
        denominator: 1,
    };
    assert!(validate_document(&d).is_err());
}
#[test]
fn delayed_effect_entry_and_cross_kind_rebinding_do_not_invent_a_file_clock() {
    let mut d = fixture::analytic_reconstruction();
    d.sequences.get_mut("pulse").unwrap().placements[1].range = Range {
        start: t(1, 2),
        duration: t(1, 1),
    };
    let p = compile(&d).unwrap();
    let q = &p.sequences["pulse"];
    assert!(q.effects[0].sample(t(0, 1)).unwrap().is_none());
    assert_eq!(
        q.effects[0].sample(t(1, 2)).unwrap().unwrap().time,
        Time::ZERO
    );
    assert_eq!(q.effects[0].sample(t(5, 4)).unwrap().unwrap().time, t(3, 4));
    assert!(q.effects[0].sample(t(3, 2)).unwrap().is_none());
    // The movie's trim is legal on its original source, but not when rebound to
    // graphics. Both validation and compilation must reject, not ignore it.
    d.sequences.get_mut("motif").unwrap().instances[0]
        .source_bindings
        .push(SourceBinding {
            from: "player-a".into(),
            to: "stage".into(),
        });
    assert!(validate_document(&d).is_err());
    assert!(compile(&d).is_err());
}
#[test]
fn seed_period_scope_and_document_changes_invalidate_compiled_effects() {
    let mut d = fixture::analytic_reconstruction();
    let mut cache = Compiler::default();
    let (a, _) = cache.compile(&d).unwrap();
    d.title = "Keep caches".into();
    let (b, _) = cache.compile(&d).unwrap();
    assert!(Arc::ptr_eq(
        &a.sequences["timeline"],
        &b.sequences["timeline"]
    ));
    descriptor(&mut d).seed = Counter(42);
    let (c, _) = cache.compile(&d).unwrap();
    assert!(!Arc::ptr_eq(
        &b.sequences["timeline"],
        &c.sequences["timeline"]
    ));
    assert_ne!(
        b.sequences["timeline"].effects[0].clock.seed,
        c.sequences["timeline"].effects[0].clock.seed
    );
    descriptor(&mut d).period = t(1, 7);
    let (e, _) = cache.compile(&d).unwrap();
    assert!(!Arc::ptr_eq(
        &c.sequences["timeline"],
        &e.sequences["timeline"]
    ));
    descriptor(&mut d).scope = SeedScope::Source;
    let (f, _) = cache.compile(&d).unwrap();
    assert!(!Arc::ptr_eq(
        &e.sequences["timeline"],
        &f.sequences["timeline"]
    ));
    d.id = "other-document".into();
    let (g, _) = cache.compile(&d).unwrap();
    assert_ne!(
        f.sequences["timeline"].effects[0].clock.seed,
        g.sequences["timeline"].effects[0].clock.seed
    );
    descriptor(&mut d).period = Time::ZERO;
    assert!(cache.compile(&d).is_err());
    descriptor(&mut d).period = t(1, 7);
    let (h, _) = cache.compile(&d).unwrap();
    assert!(Arc::ptr_eq(
        &g.sequences["timeline"],
        &h.sequences["timeline"]
    ));
}
#[test]
fn timeline_seek_pause_stop_and_new_execution_reconstruct_without_cue_replay() {
    let p = compile(&fixture::analytic_reconstruction()).unwrap();
    let mut timeline = Timeline::new(
        p.sequences["timeline"].clone(),
        true,
        OutputInstant(Counter(0)),
    )
    .unwrap();
    timeline
        .apply(TimelineEvent::Start { at: Counter(0) })
        .unwrap();
    let original = timeline
        .apply(TimelineEvent::Advance {
            at: Counter(500_000_000),
        })
        .unwrap();
    timeline
        .apply(TimelineEvent::Seek {
            at: Counter(1_000_000_000),
            to: t(1, 2),
        })
        .unwrap();
    let sought = timeline
        .apply(TimelineEvent::Pause {
            at: Counter(1_000_000_000),
            owner: "host".into(),
        })
        .unwrap();
    assert_eq!(original.effects, sought.effects);
    assert!(sought.cues.is_empty());
    assert_eq!(
        timeline
            .apply(TimelineEvent::Advance {
                at: Counter(3_000_000_000)
            })
            .unwrap()
            .effects,
        original.effects
    );
    let stopped = timeline
        .apply(TimelineEvent::Stop {
            at: Counter(3_000_000_000),
        })
        .unwrap();
    assert!(stopped.effects.iter().all(Option::is_none));
    let mut fresh = Timeline::new(
        p.sequences["timeline"].clone(),
        true,
        OutputInstant(Counter(9_000_000_000)),
    )
    .unwrap();
    fresh
        .apply(TimelineEvent::Start {
            at: Counter(9_000_000_000),
        })
        .unwrap();
    let repeated = fresh
        .apply(TimelineEvent::Advance {
            at: Counter(9_500_000_000),
        })
        .unwrap();
    assert_ne!(original.execution, repeated.execution);
    assert_eq!(original.effects, repeated.effects);
    let mut out = vec![None; fresh.effect_scratch_len()];
    fresh
        .evaluate_effects_into(OutputInstant(Counter(9_500_000_000)), &mut out)
        .unwrap();
    assert_eq!(out, repeated.effects);
}
#[test]
fn show_effect_sampling_follows_segment_and_revocation_fences() {
    let mut d = fixture::analytic_reconstruction();
    let mut static_segment = d.shows["pilot"].segments[0].clone();
    static_segment.id = "static".into();
    static_segment.sequence = None;
    d.shows
        .get_mut("pilot")
        .unwrap()
        .segments
        .push(static_segment);
    let mut coordinator =
        Coordinator::new(Snapshot::new(d.clone()).unwrap(), MemoryStore::default());
    let grant = coordinator.session(true).unwrap().1;
    let mut show = ShowRun::compile(&d, "pilot", grant.clone(), OutputInstant(Counter(0))).unwrap();
    let mut out = vec![None; show.effect_scratch_len()];
    show.apply(ShowEvent::Start {
        at: Counter(0),
        segment: None,
    })
    .unwrap();
    show.evaluate_effects_into(OutputInstant(Counter(500_000_000)), &mut out)
        .unwrap();
    assert!(out.iter().any(Option::is_some));
    show.apply(ShowEvent::Next {
        at: Counter(500_000_000),
    })
    .unwrap();
    show.evaluate_effects_into(OutputInstant(Counter(500_000_000)), &mut out)
        .unwrap();
    assert!(out.iter().all(Option::is_none));
    show.apply(ShowEvent::Start {
        at: Counter(1_000_000_000),
        segment: None,
    })
    .unwrap();
    grant.revoke();
    show.evaluate_effects_into(OutputInstant(Counter(1_000_000_000)), &mut out)
        .unwrap();
    assert!(out.iter().all(Option::is_none));
}
