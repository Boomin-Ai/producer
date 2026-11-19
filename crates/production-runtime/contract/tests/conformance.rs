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
#[test]
fn streamed_canonical_hash_preserves_rfc_bytes_and_propagates_sink_failures() {
    use sha2::{Digest, Sha256};
    let mut values = vec![
        serde_json::to_value(fixture::classic_like()).unwrap(),
        serde_json::to_value(fixture::nested_timeline()).unwrap(),
        serde_json::json!({"😀":"\"\n\\\t\r","\u{e000}":[-0.0,1e-7,1e30,1.0/3.0]}),
    ];
    for n in 0..128 {
        values.push(serde_json::json!({"label":format!("value {n}"),"array":[n,n as f64 / 17.0,format!("\\{n}\n")]}));
    }
    for value in values {
        let bytes = ingress::canonical(&value).unwrap();
        let mut h = Sha256::new();
        h.update(b"producer.production/1\0");
        h.update(&bytes);
        assert_eq!(digest(&value).unwrap(), format!("{:x}", h.finalize()));
    }
    struct Fail;
    impl std::io::Write for Fail {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("injected"))
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    assert_eq!(
        ingress::canonical_to(&serde_json::json!(["bounded"]), &mut Fail)
            .unwrap_err()
            .code,
        "JCS_IO"
    );
}

#[test]
fn discard_ingress_preserves_collecting_parser_admission_and_errors() {
    fn same(bytes: &[u8], limit: usize) {
        assert_eq!(
            ingress::parse(bytes, limit).map(|_| ()),
            ingress::check(bytes, limit),
            "document admission differs: {:?}",
            &bytes[..bytes.len().min(80)]
        );
        assert_eq!(
            ingress::parse_envelope(bytes, limit).map(|_| ()),
            ingress::check_envelope(bytes, limit),
            "envelope admission differs: {:?}",
            &bytes[..bytes.len().min(80)]
        );
    }
    for bytes in [
        &b"null"[..],
        &b"true"[..],
        &b"{}{}"[..],
        &b"[1,]"[..],
        &[0xff],
        br#"{"id":1,"\u0069d":2}"#,
        br#"{"a":{"x":1,"x":2}}"#,
        br#"{"__proto__":0}"#,
        br#"{"constructor":0}"#,
        br#"{"prototype":0}"#,
        br#"["\ud800"]"#,
        br#"[1e999]"#,
        br#"[9007199254740993]"#,
        br#"[9007199254740992.0]"#,
        br#"[-9007199254740992]"#,
        br#"[-0.0,1.25,1e-30,9007199254740991,"\ud83d\ude00"]"#,
    ] {
        same(bytes, DOCUMENT_BYTES);
    }
    for depth in [0, 31, 32, 33, 40, 41] {
        let bytes = format!("{}0{}", "[".repeat(depth), "]".repeat(depth));
        same(bytes.as_bytes(), DOCUMENT_BYTES);
    }
    for len in [STRING_BYTES, STRING_BYTES + 1] {
        let bytes = serde_json::to_vec(&"x".repeat(len)).unwrap();
        same(&bytes, DOCUMENT_BYTES);
        let bytes =
            serde_json::to_vec(&std::collections::BTreeMap::from([("x".repeat(len), 0)])).unwrap();
        same(&bytes, DOCUMENT_BYTES);
    }
    for limit in [0, 3, 4, 5] {
        same(b"null", limit);
    }
    for fixture in [
        fixture::classic_like(),
        fixture::nested_timeline(),
        fixture::responsive_layout(),
    ] {
        same(&serde_json::to_vec(&fixture).unwrap(), DOCUMENT_BYTES);
    }
    let mut seed = 0x7f42_c15a_0912_ede1u64;
    for _ in 0..10_000 {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        let len = (seed % 96) as usize;
        let bytes: Vec<_> = (0..len)
            .map(|_| {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                seed as u8
            })
            .collect();
        same(&bytes, DOCUMENT_BYTES);
    }
}

#[test]
fn discard_ingress_enforces_exact_work_ceiling_inside_envelopes_too() {
    // Root array counts as one value. Envelopes have separate wrapper headroom.
    let mut bytes = Vec::with_capacity((RAW_VALUES + 65_536) * 2 + 1);
    bytes.push(b'[');
    for _ in 0..RAW_VALUES - 2 {
        bytes.extend_from_slice(b"0,");
    }
    bytes.extend_from_slice(b"0]");
    assert!(ingress::check(&bytes, DOCUMENT_BYTES).is_ok());
    bytes.pop();
    bytes.extend_from_slice(b",0]");
    assert!(ingress::check(&bytes, DOCUMENT_BYTES).is_err());
    assert!(ingress::check_envelope(&bytes, DOCUMENT_BYTES).is_ok());
    for _ in 0..65_536 {
        bytes.pop();
        bytes.extend_from_slice(b",0]");
    }
    assert!(ingress::check_envelope(&bytes, DOCUMENT_BYTES).is_err());
}

#[test]
fn borrowed_wire_hash_matches_value_oracle_across_serde_representations() {
    fn same<T: serde::Serialize>(v: &T) {
        use sha2::{Digest, Sha256};
        let raw = serde_json::to_value(v);
        let actual = digest(v);
        match raw {
            Ok(raw) => {
                let mut oracle = Sha256::new();
                oracle.update(b"producer.production/1\0");
                oracle.update(ingress::canonical(&raw).unwrap());
                assert_eq!(actual.unwrap(), format!("{:x}", oracle.finalize()));
            }
            Err(_) => assert!(actual.is_err()),
        }
    }
    #[derive(serde::Serialize)]
    enum Shape {
        Unit,
        New(f32),
        Tuple(String, u64),
        Struct { y: f64, x: Vec<u8> },
    }
    same(&Shape::Unit);
    same(&Shape::New(0.1));
    same(&Shape::Tuple("\\\n😀".into(), u64::MAX));
    same(&Shape::Struct {
        y: -0.0,
        x: vec![0, 255],
    });
    for v in [
        0.1f32,
        -0.0,
        f32::MIN,
        f32::MAX,
        f32::MIN_POSITIVE,
        f32::NAN,
        f32::INFINITY,
        f32::NEG_INFINITY,
    ] {
        same(&v);
    }
    for v in [
        i128::MIN,
        i64::MIN as i128,
        0,
        u64::MAX as i128,
        u64::MAX as i128 + 1,
        i128::MAX,
    ] {
        same(&v);
    }
    for v in [0u128, u64::MAX as u128, u64::MAX as u128 + 1, u128::MAX] {
        same(&v);
    }
    struct Keys;
    impl serde::Serialize for Keys {
        fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
            use serde::ser::SerializeMap;
            let mut m = s.serialize_map(None)?;
            m.serialize_entry(&0.1f32, &0.1f32)?;
            m.serialize_entry(&true, &true)?;
            m.serialize_entry(&u128::MAX, &"large string key")?;
            m.serialize_entry("same", &1)?;
            m.serialize_entry("same", &2)?;
            m.serialize_entry("😀", &0)?;
            m.serialize_entry("\u{e000}", &0)?;
            m.end()
        }
    }
    same(&Keys);
    let mut seed = 0x345a_87f0_ade1_17c1u64;
    for n in 0..2048 {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        let f = f64::from_bits(seed);
        same(&f);
        same(&(f as f32));
        same(
            &serde_json::json!({"label":format!("{n}\\\n😀"),"values":[n,f,-f],"nested":{"z":null,"a":[true,false]}}),
        );
    }
    same(&fixture::classic_like());
    same(&fixture::nested_timeline());
    same(&fixture::responsive_layout());
    struct Fail;
    impl std::io::Write for Fail {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("injected"))
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    assert!(wire::canonical_bytes_to(br#"{"a":["b"]}"#, &mut Fail).is_err());
    assert!(wire::canonical_bytes_to(b"null null", &mut Vec::new()).is_err());
}

#[test]
fn owned_wire_scratch_is_bounded_and_reuses_its_high_water_capacity() {
    let mut scratch = wire::Scratch::default();
    let text = "x".repeat(128 * 1024);
    assert_eq!(
        scratch.serialize(&text, 64 * 1024).unwrap_err().code,
        "RAW_LIMIT"
    );
    assert!(scratch.capacity() <= 64 * 1024);
    let expected = serde_json::to_vec(&text).unwrap();
    assert_eq!(scratch.serialize(&text, 256 * 1024).unwrap(), expected);
    let capacity = scratch.capacity();
    for _ in 0..100 {
        assert_eq!(scratch.serialize(&text, 256 * 1024).unwrap(), expected);
        assert_eq!(scratch.capacity(), capacity);
    }
    assert!(scratch.serialize(&0, wire::SCRATCH_BYTES + 1).is_err());
    assert_eq!(scratch.serialize(&true, 4).unwrap(), b"true");
    assert!(scratch.capacity() <= wire::SCRATCH_BYTES);
}

#[test]
fn metadata_private_serde_keys_remain_literal_across_document_decoding() {
    let literal = serde_json::json!({
        "$serde_json::private::RawValue": "{\"constructor\":0,\"n\":9007199254740992}",
        "extra": [true, {"$serde_json::private::RawValue":"not JSON"}]
    });
    let mut document = Document::empty("literal-metadata", "Literal metadata");
    document.metadata.insert("data".into(), literal.clone());
    document
        .metadata
        .insert("array".into(), serde_json::json!([literal]));
    let bytes = serde_json::to_vec(&document).unwrap();
    for decoded in [
        parse_document(&bytes).unwrap(),
        serde_json::from_slice::<Document>(&bytes).unwrap(),
        serde_json::from_value::<Document>(ingress::parse(&bytes, DOCUMENT_BYTES).unwrap())
            .unwrap(),
    ] {
        assert_eq!(decoded, document);
        assert_eq!(digest(&decoded).unwrap(), digest(&document).unwrap());
    }
    let unsafe_key = br#"{"schema":"producer.production/1","id":"unsafe","title":"test","metadata":{"data":{"constructor":0}}}"#;
    assert!(parse_document(unsafe_key).is_err());
    assert!(serde_json::from_slice::<Document>(unsafe_key).is_err());
}

#[test]
fn surface_paint_and_typography_roundtrip_and_fail_closed() {
    let mut d = fixture::classic_like();
    let style = SurfaceStyle {
        fill: Some(Paint::Linear {
            from: Ink {
                color: "#FFFFFF".into(),
                opacity: 0.05,
            },
            to: Ink {
                color: "#FFFFFF".into(),
                opacity: 0.85,
            },
            angle: 90.,
        }),
        radius: 28.,
        border: Some(SurfaceBorder {
            ink: Ink {
                color: "#72DDBA".into(),
                opacity: 0.7,
            },
            width: 1.,
        }),
        grain: 0.025,
        text: None,
    };
    d.sets
        .get_mut("classic")
        .unwrap()
        .layouts
        .get_mut("wide")
        .unwrap()
        .root
        .style = Some(style.clone());
    validate_document(&d).unwrap();
    let bytes = serde_json::to_vec(&d).unwrap();
    assert_eq!(parse_document(&bytes).unwrap(), d);
    for invalid in [
        SurfaceStyle {
            radius: f64::NAN,
            ..style.clone()
        },
        SurfaceStyle {
            grain: 0.151,
            ..style.clone()
        },
        SurfaceStyle {
            fill: Some(Paint::Solid {
                ink: Ink {
                    color: "rgba(1,2,3,4)".into(),
                    opacity: 1.,
                },
            }),
            ..style.clone()
        },
        SurfaceStyle {
            text: Some(TextStyle {
                font_size: 48.,
                weight: 600,
                align: TextAlign::Left,
                ink: Ink {
                    color: "#FFFFFF".into(),
                    opacity: 1.,
                },
            }),
            ..style.clone()
        },
    ] {
        d.sets
            .get_mut("classic")
            .unwrap()
            .layouts
            .get_mut("wide")
            .unwrap()
            .root
            .style = Some(invalid);
        assert!(validate_document(&d).is_err());
    }
}

#[test]
fn veil_material_is_portable_and_its_cost_controls_are_bounded() {
    let mut d = fixture::classic_like();
    let style = SurfaceStyle {
        fill: Some(Paint::Veil {
            from: Ink {
                color: "#8BC9E8".into(),
                opacity: 0.82,
            },
            to: Ink {
                color: "#D9A7CB".into(),
                opacity: 0.78,
            },
            glow: Ink {
                color: "#E4EAD8".into(),
                opacity: 0.9,
            },
            cell: 4.,
            motion: 0.35,
        }),
        ..Default::default()
    };
    d.sets
        .get_mut("classic")
        .unwrap()
        .layouts
        .get_mut("wide")
        .unwrap()
        .root
        .style = Some(style.clone());
    validate_document(&d).unwrap();
    assert_eq!(parse_document(&serde_json::to_vec(&d).unwrap()).unwrap(), d);
    for (cell, motion) in [(1., 0.3), (25., 0.3), (4., f64::NAN), (4., 1.1)] {
        let mut bad = style.clone();
        if let Some(Paint::Veil {
            cell: c, motion: m, ..
        }) = &mut bad.fill
        {
            *c = cell;
            *m = motion;
        }
        d.sets
            .get_mut("classic")
            .unwrap()
            .layouts
            .get_mut("wide")
            .unwrap()
            .root
            .style = Some(bad);
        assert!(validate_document(&d).is_err());
    }
}
