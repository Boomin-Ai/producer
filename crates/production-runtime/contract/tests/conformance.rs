use producer_production_contract::*;
use std::collections::BTreeMap;

#[test]
fn shows_and_segment_collections_have_explicit_boundary_limits() {
    let mut d = fixture::classic_like();
    let segment = d.shows["pilot"].segments[0].clone();
    d.shows.get_mut("pilot").unwrap().segments.clear();
    assert!(validate_document(&d).is_err());
    d.shows.get_mut("pilot").unwrap().segments = (0..256)
        .map(|i| Segment {
            id: format!("s-{i}"),
            ..segment.clone()
        })
        .collect();
    validate_document(&d).unwrap();
    d.shows.get_mut("pilot").unwrap().segments.push(Segment {
        id: "overflow".into(),
        ..segment
    });
    assert!(validate_document(&d).is_err());
    d.shows.get_mut("pilot").unwrap().segments.pop();
    let show = d.shows["pilot"].clone();
    for i in 0..3 {
        d.shows.insert(format!("show-{i}"), show.clone());
    }
    validate_document(&d).unwrap(); // 1024 aggregate segments
    d.shows.insert(
        "one-too-many".into(),
        Show {
            segments: vec![show.segments[0].clone()],
            ..show.clone()
        },
    );
    assert!(validate_document(&d).is_err());
    d.shows.clear();
    for i in 0..64 {
        d.shows.insert(
            format!("show-{i}"),
            Show {
                segments: vec![show.segments[0].clone()],
                ..show.clone()
            },
        );
    }
    validate_document(&d).unwrap();
    d.shows.insert(
        "one-too-many".into(),
        Show {
            segments: vec![show.segments[0].clone()],
            ..show
        },
    );
    assert!(validate_document(&d).is_err());
}

#[test]
fn paired_component_player_show_fixture_roundtrips() {
    let d = fixture::classic_like();
    let i = validate_document(&d).unwrap();
    assert_eq!(i.instances, 1000);
    assert_eq!(i.tracks, 2);
    assert!(i
        .nodes
        .contains_key("sets/classic/layouts/tall/root/first-badge/badge/label"));
    let bytes = serde_json::to_vec(&d).unwrap();
    let parsed = parse_document(&bytes).unwrap();
    assert_eq!(d, parsed);
    assert_eq!(digest(&d).unwrap(), digest(&parsed).unwrap());
}
#[test]
fn raw_ingress_rejects_duplicate_decoded_keys_and_dangerous_keys() {
    for s in [
        r#"{"id":1,"\u0069d":2}"#,
        r#"{"constructor":0}"#,
        r#"[NaN]"#,
        r#"[1e999]"#,
        r#"[9007199254740993]"#,
        r#"["\ud800"]"#,
        r#"{}{}"#,
    ] {
        assert!(ingress::parse(s.as_bytes(), DOCUMENT_BYTES).is_err(), "{s}");
    }
    assert!(ingress::parse(&[0xff], DOCUMENT_BYTES).is_err());
}
#[test]
fn utf8_bytes_and_nested_work_are_bounded() {
    let s = format!("\"{}\"", "😀".repeat(20_000));
    assert!(ingress::parse(s.as_bytes(), DOCUMENT_BYTES).is_err());
    let s = format!("{}0{}", "[".repeat(34), "]".repeat(34));
    assert!(ingress::parse(s.as_bytes(), DOCUMENT_BYTES).is_err());
    assert!(ingress::parse(b"null", 3).is_err());
}
#[test]
fn jcs_uses_ecmascript_numbers_and_utf16_key_order() {
    let v = serde_json::json!({"\u{e000}":0,"😀":0,"a":1e-7,"b":0.000001,"c":-0.0});
    assert_eq!(
        String::from_utf8(ingress::canonical(&v).unwrap()).unwrap(),
        "{\"a\":1e-7,\"b\":0.000001,\"c\":0,\"😀\":0,\"\u{e000}\":0}"
    );
    // RFC 8785 §3.2.2 numeric vector, tested directly outside the stricter authored integer profile.
    let v: serde_json::Value =
        serde_json::from_str("[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001]")
            .unwrap();
    assert_eq!(
        String::from_utf8(ingress::canonical(&v).unwrap()).unwrap(),
        "[333333333.3333333,1e+30,4.5,0.002,1e-27]"
    );
}
#[test]
fn exact_counters_and_time_normalization() {
    let c: Counter = serde_json::from_str("\"18446744073709551615\"").unwrap();
    assert_eq!(c.0, u64::MAX);
    for s in ["1", "\"01\"", "\"+1\"", "\"18446744073709551616\""] {
        assert!(serde_json::from_str::<Counter>(s).is_err());
    }
    let t: Time = serde_json::from_str(r#"{"ticks":"120","rate":60}"#).unwrap();
    assert_eq!(t, Time::seconds(2));
    for s in [
        r#"{"ticks":"-0","rate":1}"#,
        r#"{"ticks":"1","rate":1.0}"#,
        r#"{"ticks":"1","rate":1e0}"#,
        r#"{"ticks":"01","rate":1}"#,
    ] {
        assert!(serde_json::from_str::<Time>(s).is_err(), "{s}");
    }
    assert!(Time::seconds(i64::MAX)
        .checked_add(Time::seconds(1))
        .is_err());
}
#[test]
fn half_open_mapping_modulo_and_ties_even() {
    let r = Range {
        start: Time::seconds(5),
        duration: Time::seconds(2),
    };
    assert_eq!(
        r.source_time(Time::seconds(6), Time::seconds(-1), Speed::default())
            .unwrap(),
        Some(Time::ZERO)
    );
    assert_eq!(
        r.source_time(Time::seconds(7), Time::ZERO, Speed::default())
            .unwrap(),
        None
    );
    assert_eq!(
        Time::seconds(7)
            .loop_offset(Time::new(3, 2).unwrap())
            .unwrap(),
        (Time::seconds(1), 4)
    );
    assert_eq!(Time::new(1, 2).unwrap().snap(1).unwrap(), Time::ZERO);
    assert_eq!(Time::new(3, 2).unwrap().snap(1).unwrap(), Time::seconds(2));
    assert_eq!(
        Time::new(-3, 2).unwrap().snap(1).unwrap(),
        Time::seconds(-2)
    );
}
#[test]
fn exact_24h_and_seeded_roundtrip_time_properties() {
    assert_eq!(
        Time::new(4_147_200_000, 48_000).unwrap(),
        Time::seconds(86_400)
    );
    let mut seed = 9u64;
    for _ in 0..10_000 {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        let a = Time::new((seed % 1_000_000) as i64 - 500_000, 48_000).unwrap();
        let b = Time::new((seed % 90_000) as i64, 30_000).unwrap();
        assert_eq!(a.checked_add(b).unwrap().checked_sub(b).unwrap(), a);
    }
}
#[test]
fn independent_media_player_and_audio_routes() {
    let mut d = fixture::classic_like();
    validate_document(&d).unwrap();
    d.sequences.get_mut("opener").unwrap().placements[1].source = "player-a".into();
    assert!(validate_document(&d).is_err());
    let mut d = fixture::classic_like();
    let r = d.sequences["opener"].audio_routes[0].clone();
    let mut r2 = r;
    r2.id = "duplicate".into();
    d.sequences.get_mut("opener").unwrap().audio_routes.push(r2);
    assert!(validate_document(&d).is_err());
}
#[test]
fn pins_cycles_driver_conflicts_and_3d_caps() {
    let mut d = fixture::classic_like();
    d.components.get_mut("badge").unwrap().version = 2;
    assert!(validate_document(&d).is_err());
    let mut d = fixture::classic_like();
    let mut t = d.sequences["opener"].tracks[0].clone();
    t.id = "second-writer".into();
    d.sequences.get_mut("opener").unwrap().tracks.push(t);
    assert_eq!(validate_document(&d).unwrap_err().code, "DRIVER_CONFLICT");
    let mut d = fixture::classic_like();
    if let Source::Graphics { scene } = d.sources.get_mut("stage").unwrap() {
        scene.batches[0].instances = 4097;
    }
    assert!(validate_document(&d).is_err());
    let mut d = fixture::classic_like();
    if let Source::Graphics { scene } = d.sources.get_mut("stage").unwrap() {
        scene.analytic = false;
    }
    assert_eq!(validate_document(&d).unwrap_err().code, "UNSUPPORTED");
}
#[test]
fn bounded_binding_evaluation_rejects_hidden_division_by_zero() {
    let num = |n| {
        Box::new(Expr::Literal {
            value: Value::Number(n),
        })
    };
    let e = Expr::Select {
        condition: Box::new(Expr::Literal {
            value: Value::Bool(true),
        }),
        yes: num(1.0),
        no: Box::new(Expr::Divide {
            a: num(1.0),
            b: num(0.0),
        }),
    };
    assert!(validate::evaluate(&e, &BTreeMap::new(), &mut 256).is_err());
}
