use producer_production_core::{compile::*, contract::*, timeline::*, transport::*};
fn at(ns: u64) -> Counter {
    Counter(ns)
}
fn sec(s: u64) -> Counter {
    at(s * 1_000_000_000)
}
fn t(n: i64, d: u32) -> Time {
    Time::new(n, d).unwrap()
}
fn plan() -> Plan {
    compile(&fixture::nested_timeline()).unwrap()
}
fn timeline(looping: bool) -> Timeline {
    Timeline::new(
        plan().sequences["timeline"].clone(),
        looping,
        OutputInstant(sec(0)),
    )
    .unwrap()
}
fn value(plan: &SequencePlan, time: Time) -> Vec<Option<Sample>> {
    let mut v = vec![None; plan.tracks.len()];
    plan.evaluate_into(time, &mut v).unwrap();
    v
}
#[test]
fn shared_definitions_have_independent_scoped_targets_trims_and_players() {
    let p = plan();
    let q = &p.sequences["timeline"];
    assert_eq!(q.tracks.len(), 2);
    assert_eq!(q.players.len(), 2);
    assert_eq!(q.cues.len(), 6);
    assert_eq!(q.routes.len(), 2);
    let v = value(q, t(1, 2));
    assert_eq!(v[0].unwrap().value, CompactValue::Number(0.25));
    assert_eq!(v[1].unwrap().value, CompactValue::Number(0.75));
    assert_ne!(v[0].unwrap().target, v[1].unwrap().target);
    assert!(p.targets[v[1].unwrap().target]
        .path
        .contains("second-badge"));
    assert_eq!(q.players[0].sample(t(1, 2)).unwrap(), Some(t(3, 2)));
    assert_eq!(q.players[1].sample(t(1, 2)).unwrap(), Some(t(5, 2)));
    assert_eq!(q.players[0].sample(t(2, 1)).unwrap(), Some(t(1, 1)));
    assert_eq!(
        value(q, t(2, 1))[0].unwrap().value,
        CompactValue::Number(0.0)
    );
    assert!(value(q, t(8, 1)).iter().all(Option::is_none));
    assert!(q
        .players
        .iter()
        .all(|p| p.sample(t(8, 1)).unwrap().is_none()));
    assert_ne!(q.tracks[0].id, q.tracks[1].id);
}
#[test]
fn nested_property_collision_is_rejected_after_rebinding() {
    let mut d = fixture::nested_timeline();
    let i = &mut d.sequences.get_mut("timeline").unwrap().instances[1];
    i.target_bindings[0].to = i.target_bindings[0].from.clone();
    assert_eq!(compile(&d).unwrap_err().code, "DRIVER_CONFLICT");
}
#[test]
fn shared_file_with_different_nested_playheads_requires_separate_player() {
    let mut d = fixture::nested_timeline();
    d.sequences.get_mut("timeline").unwrap().instances[1]
        .source_bindings
        .clear();
    assert_eq!(compile(&d).unwrap_err().code, "DRIVER_CONFLICT");
    // Identical playheads may borrow one player; route contribution coalesces.
    d.sequences.get_mut("timeline").unwrap().instances[1].source_in = Time::ZERO;
    let p = compile(&d).unwrap();
    assert_eq!(p.sequences["timeline"].routes.len(), 1);
}
#[test]
fn nonoverlapping_rebound_property_drivers_are_valid_half_open() {
    let mut d = fixture::nested_timeline();
    let instances = &mut d.sequences.get_mut("timeline").unwrap().instances;
    instances[0].range.duration = t(4, 1);
    instances[1].range = Range {
        start: t(4, 1),
        duration: t(4, 1),
    };
    instances[1].target_bindings[0].to = instances[1].target_bindings[0].from.clone();
    let p = compile(&d).unwrap();
    let v = value(&p.sequences["timeline"], t(4, 1));
    assert!(v[0].is_none());
    assert!(v[1].is_some());
}
#[test]
fn exact_trim_speed_and_negative_source_origin_are_not_wall_time() {
    use temporal::TimeMap;
    let map = TimeMap {
        range: Range {
            start: t(3, 1),
            duration: t(3, 1),
        },
        source_range: Range {
            start: t(-2, 1),
            duration: t(4, 1),
        },
        source_in: t(-1, 1),
        speed: Speed {
            numerator: 2,
            denominator: 1,
        },
        looping: true,
    };
    map.validate().unwrap();
    assert_eq!(map.map(t(2, 1)).unwrap(), None);
    assert_eq!(map.map(t(3, 1)).unwrap(), Some((t(-1, 1), 0)));
    assert_eq!(map.map(t(9, 2)).unwrap(), Some((t(-2, 1), 1)));
    assert_eq!(map.map(t(6, 1)).unwrap(), None);
    assert_eq!(map.inverse(t(-2, 1), 1).unwrap(), t(9, 2));
    let mut finite = map;
    finite.looping = false;
    assert!(finite.validate().is_err());
}
#[test]
fn speed_cancellation_keeps_wide_exact_intermediates_and_rejects_final_overflow() {
    use temporal::{map_chain, TimeMap};
    let base = TimeMap {
        range: Range {
            start: Time::ZERO,
            duration: t(10, 1),
        },
        source_range: Range {
            start: Time::ZERO,
            duration: t(10, 999_999),
        },
        source_in: Time::ZERO,
        speed: Speed {
            numerator: 1,
            denominator: 999_999,
        },
        looping: false,
    };
    let fast = TimeMap {
        range: base.source_range,
        source_range: base.range,
        speed: Speed {
            numerator: 999_999,
            denominator: 1,
        },
        ..base
    };
    base.validate().unwrap();
    fast.validate().unwrap();
    let input = t(1, 999_983);
    assert!(base.map(input).is_err()); // Not a wire Time by itself.
    assert_eq!(map_chain(&[base, fast], input).unwrap(), Some(input));
    assert!(map_chain(&[base], input).is_err()); // No lossy rate coercion.
    assert!(map_chain(&vec![base; TEMPORAL_DEPTH + 2], input).is_err());
}
#[test]
fn loops_do_not_unroll_the_numeric_plan_and_preflight_work_is_bounded() {
    let mut d = fixture::nested_timeline();
    d.sequences.get_mut("timeline").unwrap().duration = t(86_400, 1);
    for i in &mut d.sequences.get_mut("timeline").unwrap().instances {
        i.range.duration = t(86_400, 1);
    }
    let p = compile(&d).unwrap();
    let q = &p.sequences["timeline"];
    assert_eq!(q.tracks.len(), 2);
    assert_eq!(q.tracks[0].maps.len(), 2);
    assert_eq!(
        value(q, t(86_399, 1))[0].unwrap().value,
        CompactValue::Number(0.5)
    );
    // Ambiguous shared controllers require bounded interval proof, not a guessed answer.
    let right = &mut d.sequences.get_mut("timeline").unwrap().instances[1];
    right.source_bindings.clear();
    assert_eq!(compile(&d).unwrap_err().code, "TEMPORAL_WORK_LIMIT");
}
#[test]
fn temporal_cycles_unused_bindings_and_kind_changes_reject() {
    let original = fixture::nested_timeline();
    let mut d = original.clone();
    d.sequences.get_mut("timeline").unwrap().instances[0].sequence = "timeline".into();
    assert!(compile(&d).unwrap_err().message.contains("cycle"));
    let mut d = original.clone();
    d.sequences.get_mut("timeline").unwrap().instances[0].target_bindings[0]
        .from
        .path = "missing".into();
    assert!(compile(&d).unwrap_err().message.contains("unused"));
    let mut d = original;
    d.sequences.get_mut("timeline").unwrap().instances[0].source_bindings[0].to = "host".into();
    assert!(compile(&d).unwrap_err().message.contains("incompatible"));
}
#[test]
fn rebound_hosted_authority_and_expansion_exhaustion_fail_closed() {
    let mut d = fixture::nested_timeline();
    d.components.get_mut("badge").unwrap().authority = Authority::Hosted;
    assert!(compile(&d).is_err());
    let d = fixture::nested_timeline();
    assert_eq!(
        temporal::expand(&d, "timeline", &mut 1).unwrap_err().code,
        "TEMPORAL_WORK_LIMIT"
    );
    let mut d = fixture::nested_timeline();
    let i = d.sequences["motif"].instances[0].clone();
    d.sequences
        .get_mut("pulse")
        .unwrap()
        .instances
        .push(SequenceInstance {
            sequence: "motif".into(),
            ..i
        });
    assert!(compile(&d).is_err());
}
#[test]
fn nested_cues_have_root_times_scoped_identity_and_loop_ancestry() {
    let p = plan();
    let mut c = CueCursor::from_sequence(Counter(1), &p.sequences["timeline"], false);
    let start = c.start().unwrap();
    assert_eq!(start.len(), 1);
    assert_eq!(start[0].cue, "entry");
    assert!(start[0].path.contains("instances/left/instances/beat"));
    assert_eq!(start[0].ancestry, vec![Counter(0), Counter(0)]);
    assert!(c.start().unwrap().is_empty());
    let half = c.advance(t(1, 2)).unwrap();
    assert_eq!(half.len(), 1);
    assert_eq!(half[0].cue, "beat");
    let one = c.advance(t(1, 1)).unwrap();
    assert_eq!(
        one.iter().map(|x| x.cue.as_str()).collect::<Vec<_>>(),
        vec!["once", "entry"]
    );
    assert_eq!(one[1].ancestry, vec![Counter(0), Counter(1)]);
    let later = c.advance(t(4, 1)).unwrap();
    assert!(later.windows(2).all(|w| w[0].at <= w[1].at));
    assert!(later.iter().all(|x| x.cue != "once"));
    assert!(later.iter().any(|x| x.ancestry[0] == Counter(1)));
}
#[test]
fn seeks_consume_effect_history_and_only_explicit_new_run_rearms() {
    let mut q = timeline(true);
    let start = q.apply(TimelineEvent::Start { at: sec(0) }).unwrap();
    assert_eq!(start.cues.len(), 1);
    let first = q.apply(TimelineEvent::Advance { at: sec(1) }).unwrap();
    assert!(!first.cues.is_empty());
    let seek = q
        .apply(TimelineEvent::Seek {
            at: sec(1),
            to: Time::ZERO,
        })
        .unwrap();
    assert!(seek.cues.is_empty());
    assert!(!q.accepts_completion(&start.execution, start.run, start.epoch));
    assert!(q
        .apply(TimelineEvent::Advance { at: sec(2) })
        .unwrap()
        .cues
        .is_empty());
    let seek = q
        .apply(TimelineEvent::Seek {
            at: sec(2),
            to: t(4, 1),
        })
        .unwrap();
    assert!(seek.cues.is_empty());
    let past = q.apply(TimelineEvent::Advance { at: sec(3) }).unwrap();
    assert!(past.cues.iter().all(|c| c.at > t(4, 1)));
    let stopped = q.apply(TimelineEvent::Stop { at: sec(3) }).unwrap();
    assert!(!stopped.active);
    assert!(stopped.values.iter().all(Option::is_none));
    assert!(stopped.players.iter().all(|p| p.source_time.is_none()));
    assert!(q
        .apply(TimelineEvent::Advance { at: sec(5) })
        .unwrap()
        .cues
        .is_empty());
    let next = q.apply(TimelineEvent::Start { at: sec(5) }).unwrap();
    assert_eq!(next.run, Counter(2));
    assert_eq!(next.cues.len(), 1);
    assert!(!q.accepts_completion(&start.execution, start.run, next.epoch));
    assert!(q.accepts_completion(&next.execution, next.run, next.epoch));
}
#[test]
fn independent_pause_owners_preserve_unwrapped_loop_progress() {
    let mut q = timeline(true);
    q.apply(TimelineEvent::Start { at: sec(0) }).unwrap();
    // Smaller catch-up windows keep cue dispatch bounded.
    q.apply(TimelineEvent::Advance { at: sec(4) }).unwrap();
    let p = q
        .apply(TimelineEvent::Pause {
            at: sec(9),
            owner: "operator".into(),
        })
        .unwrap();
    assert_eq!(p.position, t(1, 1));
    assert_eq!(p.progress, t(9, 1));
    assert!(p.paused);
    assert!(p.cues.iter().any(|c| c.occurrence == Counter(1)));
    q.apply(TimelineEvent::Pause {
        at: sec(10),
        owner: "hidden".into(),
    })
    .unwrap();
    q.apply(TimelineEvent::Resume {
        at: sec(11),
        owner: "operator".into(),
    })
    .unwrap();
    let still = q.apply(TimelineEvent::Advance { at: sec(12) }).unwrap();
    assert_eq!(still.progress, t(9, 1));
    assert!(still.cues.is_empty());
    q.apply(TimelineEvent::Resume {
        at: sec(12),
        owner: "hidden".into(),
    })
    .unwrap();
    let resumed = q.apply(TimelineEvent::Advance { at: sec(13) }).unwrap();
    assert_eq!(resumed.progress, t(10, 1));
    assert!(resumed.cues.iter().all(|c| c.at > t(9, 1)));
}
#[test]
fn failed_clock_catchup_or_pause_event_does_not_partially_advance_transport() {
    let mut q = timeline(true);
    q.apply(TimelineEvent::Start { at: sec(0) }).unwrap();
    let before = q.apply(TimelineEvent::Advance { at: sec(1) }).unwrap();
    assert!(q
        .apply(TimelineEvent::Seek {
            at: sec(0),
            to: t(4, 1)
        })
        .is_err());
    assert!(q
        .apply(TimelineEvent::Pause {
            at: sec(2),
            owner: "bad owner".into()
        })
        .is_err());
    assert_eq!(
        q.apply(TimelineEvent::Advance { at: sec(1000) })
            .unwrap_err()
            .code,
        "CUE_CATCHUP_LIMIT"
    );
    let after = q.apply(TimelineEvent::Advance { at: sec(1) }).unwrap();
    assert_eq!(after.epoch, before.epoch);
    assert!(!after.paused);
    assert!(after.cues.is_empty());
    let crossed = q.apply(TimelineEvent::Advance { at: sec(2) }).unwrap();
    assert!(!crossed.cues.is_empty());
}
#[test]
fn finite_end_releases_drivers_without_stopping_live_capture_or_external_effects() {
    let mut q = timeline(false);
    q.apply(TimelineEvent::Start { at: sec(0) }).unwrap();
    q.apply(TimelineEvent::Advance { at: sec(4) }).unwrap();
    let end = q.apply(TimelineEvent::Advance { at: sec(8) }).unwrap();
    assert!(!end.active);
    assert!(end.values.iter().all(Option::is_none));
    assert!(q
        .apply(TimelineEvent::Pause {
            at: sec(8),
            owner: "operator".into()
        })
        .is_err());
    // A live source is only gated, never assigned a local file playhead.
    let mut d = fixture::nested_timeline();
    let p = &mut d.sequences.get_mut("pulse").unwrap().placements[0];
    p.source = "host".into();
    p.source_in = Time::ZERO;
    for i in &mut d.sequences.get_mut("timeline").unwrap().instances {
        i.source_bindings.clear();
    }
    let p = compile(&d).unwrap();
    let player = &p.sequences["timeline"].players[0];
    assert!(player.available.is_none());
    assert_eq!(player.sample(t(1, 1)).unwrap(), Some(Time::ZERO));
}
#[test]
fn wire_roundtrip_and_unknown_nested_keys_use_native_admission() {
    let d = fixture::nested_timeline();
    let bytes = serde_json::to_vec(&d).unwrap();
    assert_eq!(parse_document(&bytes).unwrap(), d);
    let mut v = serde_json::to_value(&d).unwrap();
    v["sequences"]["timeline"]["instances"][0]["unchecked"] = true.into();
    assert_eq!(
        parse_document(&serde_json::to_vec(&v).unwrap())
            .unwrap_err()
            .code,
        "STRUCTURE"
    );
}

#[test]
fn projected_intervals_match_dense_independent_membership_and_mapping_roundtrips() {
    use temporal::{map_chain, project_ranges, TimeMap};
    let outer = TimeMap {
        range: Range {
            start: t(1, 1),
            duration: t(12, 1),
        },
        source_range: Range {
            start: Time::ZERO,
            duration: t(4, 1),
        },
        source_in: t(1, 2),
        speed: Speed {
            numerator: 3,
            denominator: 2,
        },
        looping: true,
    };
    let inner = TimeMap {
        range: Range {
            start: t(1, 2),
            duration: t(3, 1),
        },
        source_range: Range {
            start: t(-2, 1),
            duration: t(2, 1),
        },
        source_in: t(-3, 2),
        speed: Speed {
            numerator: 2,
            denominator: 1,
        },
        looping: true,
    };
    outer.validate().unwrap();
    inner.validate().unwrap();
    let leaf = Range {
        start: t(-7, 4),
        duration: t(1, 2),
    };
    let mut work = TEMPORAL_WORK;
    let intervals = project_ranges(&[outer, inner], leaf, &mut work).unwrap();
    for tick in 0..1300 {
        let root = t(tick, 100);
        let expected = map_chain(&[outer, inner], root)
            .unwrap()
            .is_some_and(|time| leaf.contains(time).unwrap());
        let actual = intervals.iter().any(|range| range.contains(root).unwrap());
        assert_eq!(actual, expected, "{root:?}");
        if let Some((mapped, count)) = outer.map(root).unwrap() {
            assert_eq!(outer.inverse(mapped, count).unwrap(), root);
        }
    }
}
#[test]
fn nested_cue_projection_matches_independent_discrete_oracle_at_different_speeds() {
    let mut d = fixture::nested_timeline();
    let instances = &mut d.sequences.get_mut("timeline").unwrap().instances;
    instances[0].speed = Speed {
        numerator: 3,
        denominator: 2,
    };
    instances[1].speed = Speed {
        numerator: 2,
        denominator: 1,
    };
    let p = compile(&d).unwrap();
    let q = &p.sequences["timeline"];
    let mut c = CueCursor::from_sequence(Counter(1), q, false);
    let mut actual = c.start().unwrap();
    for tick in 1..=32 {
        actual.extend(c.advance(t(tick, 4)).unwrap());
    }
    let mut expected = Vec::new();
    for tick in 0..96 {
        // Independent integer oracle: root grid 1/12, then parent speed and
        // 4s/2s modulo, without calling TimeMap/project_ranges/cue_points.
        for (side, local, counts, denominator) in [
            (
                "left",
                tick % 16,
                vec![
                    Counter((tick / 32) as u64),
                    Counter(((tick % 32) / 16) as u64),
                ],
                8,
            ),
            (
                "right",
                (tick + 6) % 12,
                vec![
                    Counter(((tick + 6) / 24) as u64),
                    Counter((((tick + 6) % 24) / 12) as u64),
                ],
                6,
            ),
        ] {
            let cue = if local == 0 {
                "entry"
            } else if local == denominator / 2 {
                "beat"
            } else if local == denominator {
                "once"
            } else {
                continue;
            };
            if (cue == "once" && (tick == 0 || counts.iter().any(|c| c.0 > 0)))
                || (tick == 0 && cue != "entry")
            {
                continue;
            }
            expected.push((
                t(tick, 12),
                format!("sequences/timeline/instances/{side}/instances/beat/cues/{cue}"),
                counts,
            ));
        }
    }
    expected.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
    assert_eq!(
        actual
            .into_iter()
            .map(|c| (c.at, c.path, c.ancestry))
            .collect::<Vec<_>>(),
        expected
    );
}
#[test]
fn nested_depth_boundary_is_explicit_and_stopped_cursors_cannot_revive() {
    let mut d = fixture::nested_timeline();
    d.sequences.clear();
    d.shows.clear();
    let blank = Sequence {
        duration: t(1, 1),
        instances: vec![],
        tracks: vec![],
        placements: vec![],
        cues: vec![],
        audio_routes: vec![],
    };
    d.sequences.insert("level-0".into(), blank.clone());
    for depth in 1..=TEMPORAL_DEPTH + 1 {
        let mut sequence = blank.clone();
        sequence.instances.push(SequenceInstance {
            id: "child".into(),
            sequence: format!("level-{}", depth - 1),
            range: Range {
                start: Time::ZERO,
                duration: t(1, 1),
            },
            source_in: Time::ZERO,
            speed: Speed::default(),
            looping: false,
            target_bindings: vec![],
            source_bindings: vec![],
        });
        d.sequences.insert(format!("level-{depth}"), sequence);
        assert_eq!(compile(&d).is_ok(), depth <= TEMPORAL_DEPTH);
    }
    let p = plan();
    let mut c = CueCursor::from_sequence(Counter(4), &p.sequences["timeline"], true);
    c.start().unwrap();
    c.stop();
    c.seek_silent(Time::ZERO).unwrap();
    assert!(c.start().unwrap().is_empty());
    assert!(c.advance(t(1, 1)).unwrap().is_empty());
    assert_eq!(c.rearm(Counter(4)).unwrap_err().code, "RUN_ID");
    c.rearm(Counter(5)).unwrap();
    assert!(!c.start().unwrap().is_empty());
}

#[test]
fn rebound_file_availability_is_checked_after_player_binding() {
    let mut d = fixture::nested_timeline();
    let mut short = d.assets["movie"].clone();
    short.hash = "e".repeat(64);
    short.available = Some(Range {
        start: Time::ZERO,
        duration: t(1, 1),
    });
    d.assets.insert("short".into(), short);
    d.sources.insert(
        "short-player".into(),
        Source::Player {
            asset: "short".into(),
        },
    );
    d.sequences.get_mut("timeline").unwrap().instances[1].source_bindings[0].to =
        "short-player".into();
    assert!(compile(&d).unwrap_err().message.contains("trim exceeds"));
}
#[test]
fn unrepresentable_inverse_boundary_rejects_instead_of_approximating_collision_proof() {
    use temporal::{map_chain, project_ranges, TimeMap};
    let slow = TimeMap {
        range: Range {
            start: Time::ZERO,
            duration: t(10, 1),
        },
        source_range: Range {
            start: Time::ZERO,
            duration: t(10, 999_999),
        },
        source_in: Time::ZERO,
        speed: Speed {
            numerator: 1,
            denominator: 999_999,
        },
        looping: false,
    };
    let fast = TimeMap {
        range: slow.source_range,
        source_range: slow.range,
        speed: Speed {
            numerator: 999_999,
            denominator: 1,
        },
        ..slow
    };
    let point = t(1, 999_983);
    assert_eq!(map_chain(&[slow, fast], point).unwrap(), Some(point));
    let leaf = Range {
        start: point,
        duration: point,
    };
    let mut work = TEMPORAL_WORK;
    assert_eq!(
        project_ranges(&[slow, fast], leaf, &mut work)
            .unwrap_err()
            .code,
        "TIME_UNREPRESENTABLE"
    );
}
