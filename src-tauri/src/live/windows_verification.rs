//! Opt-in GPU integration test. No devices, server accounts, or live outputs.
use crate::live::{engine, ffi, graph, sets_v2::contract::Action};
use serde_json::json;
use std::time::{Duration, Instant};

#[test]
#[ignore = "requires the Windows engine and D3D11; run alone"]
fn windows_gpu_presets_compile_and_render() {
    use crate::live::shaders::{self, ShaderEffect};
    struct Probe {
        source: *mut ffi::obs_source_t,
        lit: usize,
    }
    extern "C" fn pixels(param: *mut std::ffi::c_void) {
        unsafe {
            let p = &mut *param.cast::<Probe>();
            ffi::obs_enter_graphics();
            let target = ffi::gs_texrender_create(ffi::GS_RGBA, ffi::GS_ZS_NONE);
            let stage = ffi::gs_stagesurface_create(64, 36, ffi::GS_RGBA);
            if !target.is_null() && !stage.is_null() && ffi::gs_texrender_begin(target, 64, 36) {
                let clear = ffi::vec4 {
                    x: 0.,
                    y: 0.,
                    z: 0.,
                    w: 0.,
                };
                ffi::gs_clear(1, &clear, 0., 0);
                ffi::gs_ortho(0., 320., 0., 180., -100., 100.);
                ffi::gs_matrix_push();
                ffi::gs_matrix_identity();
                ffi::obs_source_video_render(p.source);
                ffi::gs_matrix_pop();
                ffi::gs_texrender_end(target);
                ffi::gs_stage_texture(stage, ffi::gs_texrender_get_texture(target));
                let mut data = std::ptr::null_mut();
                let mut stride = 0;
                if ffi::gs_stagesurface_map(stage, &mut data, &mut stride) {
                    for y in 0..36 {
                        p.lit += std::slice::from_raw_parts(data.add(y * stride as usize), 64 * 4)
                            .chunks_exact(4)
                            .filter(|v| v[3] > 0 && v[..3].iter().any(|n| *n > 4))
                            .count();
                    }
                    ffi::gs_stagesurface_unmap(stage);
                }
            }
            if !stage.is_null() {
                ffi::gs_stagesurface_destroy(stage);
            }
            if !target.is_null() {
                ffi::gs_texrender_destroy(target);
            }
            ffi::obs_leave_graphics();
        }
    }
    let dir = std::env::temp_dir().join(format!("producer-windows-shaders-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    engine::persist_video(&dir, 720, 30);
    assert!(engine::bootstrap_with_config(&dir).ok);
    for preset in shaders::PRESETS {
        let config = ShaderEffect {
            effect: (*preset).into(),
            colors: vec!["#ff8877".into(), "#77ffbb".into(), "#88bbff".into()],
            speed: 1.,
            intensity: 1.,
            scale: 1.,
            opacity: 1.,
            radius: 12.,
            glow: 0.6,
            variant: 0,
            quality: "low".into(),
            clock: "show".into(),
        };
        unsafe {
            let source =
                shaders::create(&config, 320., 180.).unwrap_or_else(|e| panic!("{preset}: {e}"));
            ffi::producer_shader_frame(source, 1.7, 1., 1., 1.);
            let mut probe = Probe { source, lit: 0 };
            ffi::obs_queue_task(1, pixels, (&mut probe as *mut Probe).cast(), true);
            ffi::obs_source_release(source);
            assert!(probe.lit > 0, "{preset} must paint real pixels");
        }
    }
    unsafe {
        ffi::obs_shutdown();
    }
}

#[test]
#[cfg(feature = "guest-rtc-pilot")]
#[ignore = "requires a Windows native engine and D3D11; run alone"]
fn windows_native_guest_ingress_and_retirement() {
    use crate::live::rtc_ingest;
    let temp =
        std::env::temp_dir().join(format!("producer-windows-ingress-{}", std::process::id()));
    std::fs::create_dir_all(&temp).unwrap();
    engine::persist_video(&temp, 720, 30);
    let report = engine::bootstrap_with_config(&temp);
    assert!(report.ok, "bootstrap: {report:?}");
    let mut room = graph::SceneGraph::create().unwrap();
    let hub = graph::ThumbHub::new();
    hub.fps.store(30, std::sync::atomic::Ordering::Relaxed);
    let param = (&hub as *const graph::ThumbHub).cast_mut().cast();
    unsafe {
        ffi::obs_add_main_render_callback(super::thumb_render_cb, param);
    }
    let y = vec![145u8; 320 * 180];
    let u = vec![54u8; 160 * 90];
    let v = vec![34u8; 160 * 90];
    let pcm = vec![4096i16; 480];
    for cycle in 0..8 {
        let participant = format!("12345678-1234-1234-1234-{cycle:012}");
        let id = format!("guest-{participant}");
        room.add_extra(
            &id,
            "Windows guest proof",
            &graph::ExtraSpec::RtcGuest {
                participant_id: participant,
            },
        )
        .unwrap();
        let endpoint = rtc_ingest::endpoint(&id).unwrap();
        let weak = std::sync::Arc::downgrade(&endpoint);
        let old = endpoint.replace().unwrap();
        let current = endpoint.replace().unwrap();
        assert!(
            !old.audio(&pcm, 1, unsafe { ffi::os_gettime_ns() }),
            "replaced sender must be fenced"
        );
        hub.publish_targets(&room);
        let mut accepted_audio = 0;
        for _ in 0..25 {
            let at = unsafe { ffi::os_gettime_ns() };
            assert!(current.video(
                rtc_ingest::Video {
                    planes: (&y, &u, &v),
                    width: 320,
                    height: 180,
                    strides: (320, 160, 160)
                },
                at
            ));
            accepted_audio += usize::from(current.audio(&pcm, 1, at));
            std::thread::sleep(Duration::from_millis(20));
        }
        let colored = {
            let slots = hub.slots.lock().unwrap();
            let slot = slots.get(&id).expect("native guest thumbnail");
            assert!(slot.seq >= 2);
            slot.rgba
                .chunks_exact(4)
                .filter(|p| p[1] > 80 && p[1] > p[0].saturating_add(30))
                .count()
        };
        assert!(
            colored > 1000,
            "native guest video must contain decoded green pixels"
        );
        assert!(
            accepted_audio >= 20,
            "guest audio queue must keep draining: {accepted_audio}"
        );
        room.remove_extra(&id).unwrap();
        hub.publish_targets(&room);
        assert!(rtc_ingest::endpoint(&id).is_none());
        assert!(
            !current.audio(&pcm, 1, unsafe { ffi::os_gettime_ns() }),
            "retired source must reject late media"
        );
        drop(current);
        drop(old);
        drop(endpoint);
        assert!(
            weak.upgrade().is_none(),
            "guest owner must be destroyed each cycle"
        );
    }
    unsafe {
        ffi::obs_remove_main_render_callback(super::thumb_render_cb, param);
        ffi::obs_enter_graphics();
        for (_, ring) in hub.rings.lock().unwrap().drain() {
            ffi::gs_texrender_destroy(ring.rt);
            for surface in ring.surfs {
                ffi::gs_stagesurface_destroy(surface);
            }
        }
        ffi::obs_leave_graphics();
        ffi::obs_set_output_source(0, std::ptr::null_mut());
        ffi::obs_scene_release(room.scene);
    }
    drop(room);
    unsafe {
        ffi::obs_shutdown();
    }
}

#[test]
#[ignore = "requires a Windows engine artifact and D3D11 adapter; run alone"]
fn windows_native_set_and_portrait_lifecycle() {
    let directory =
        std::env::temp_dir().join(format!("producer-windows-proof-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    engine::persist_video(&directory, 720, 30);
    let report = engine::bootstrap_with_config(&directory);
    assert!(report.ok, "engine bootstrap: {report:?}");
    let mut room = graph::SceneGraph::create().unwrap();
    let sources = room
        .create_set_source(
            "proof",
            "Windows proof",
            &graph::ExtraSpec::Color {
                color: "#ff0000".into(),
            },
        )
        .unwrap();
    assert!(sources.items.iter().any(|item| item.id == "proof"));
    let generation = room.presentation_status().generation;
    for (output, width, height) in [("program", 1280, 720), ("portrait", 720, 1280)] {
        let plan = json!({
            "definitionId":"windowsProof", "definitionRevision":1, "instanceId":"proof",
            "canvasId":output,
            "target":{"id":output,"orientation":if output=="portrait" {"portrait"} else {"landscape"},"width":width,"height":height,"scaling":"stretch"},
            "viewport":{"scaleX":1,"scaleY":1,"offsetX":0,"offsetY":0,"clip":{"x":0,"y":0,"width":width,"height":height}},
            "root":{"id":"root","kind":"group","bounds":{"x":0,"y":0,"width":width,"height":height},"properties":{},"children":[
                {"id":"picture","kind":"source","bounds":{"x":0,"y":0,"width":width,"height":height},"properties":{},"resource":"proof","fit":"cover","children":[]},
                {"id":"title","kind":"text","bounds":{"x":20,"y":20,"width":400,"height":80},"properties":{"text":"Windows Set proof","color":"#ffffff","fontSize":32},"children":[]}
            ]},
            "resources":["proof"]
        });
        let action = serde_json::from_value(json!({"op":"prepare","generation":generation,"outputId":output,"revision":1,"plan":plan})).unwrap();
        room.sets_v2(action).unwrap();
        let until = Instant::now() + Duration::from_secs(10);
        loop {
            let status = room
                .sets_v2(Action::Status {
                    generation,
                    output_id: Some(output.into()),
                })
                .unwrap();
            if status.ready {
                assert!(
                    status.graphics_layers > 0,
                    "CEF graphics must paint before readiness"
                );
                break;
            }
            assert!(
                Instant::now() < until,
                "{output} did not become ready: {status:?}"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        room.sets_v2(Action::Take {
            generation,
            output_id: Some(output.into()),
            revision: 1,
            duration_ms: 0.,
            mode: "dissolve".into(),
        })
        .unwrap();
        loop {
            let status = room
                .sets_v2(Action::Status {
                    generation,
                    output_id: Some(output.into()),
                })
                .unwrap();
            if status.rendered_revision == 1 {
                break;
            }
            assert!(
                Instant::now() < until,
                "{output} did not render: {status:?}"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    assert!(!room.portrait_video().unwrap().is_null());
    room.sets_v2(Action::Return {
        generation,
        output_id: Some("portrait".into()),
    })
    .unwrap();
    let returned = room
        .sets_v2(Action::Return {
            generation,
            output_id: Some("program".into()),
        })
        .unwrap();
    assert!(returned.generation > generation);
    assert!(
        room.sets_v2(Action::Status {
            generation,
            output_id: None
        })
        .is_err(),
        "stale generation must fail"
    );
    room.portrait_stop();
    room.clear_room().unwrap();
    unsafe {
        ffi::obs_set_output_source(0, std::ptr::null_mut());
        ffi::obs_scene_release(room.scene);
    }
    drop(room);
    unsafe { ffi::obs_shutdown() };
}

/// Read real native pixels on the graphics thread, with an isolated target.
unsafe fn source_pixels(source: *mut ffi::obs_source_t, width: u32, height: u32) -> Vec<u8> {
    struct Read {
        source: *mut ffi::obs_source_t,
        w: u32,
        h: u32,
        pixels: Vec<u8>,
    }
    extern "C" fn read(data: *mut std::ffi::c_void) {
        unsafe {
            let p = &mut *data.cast::<Read>();
            ffi::obs_enter_graphics();
            let target = ffi::gs_texrender_create(ffi::GS_RGBA, ffi::GS_ZS_NONE);
            let stage = ffi::gs_stagesurface_create(p.w, p.h, ffi::GS_RGBA);
            assert!(!target.is_null() && !stage.is_null());
            assert!(ffi::gs_texrender_begin(target, p.w, p.h));
            let clear = ffi::vec4 {
                x: 0.,
                y: 0.,
                z: 0.,
                w: 0.,
            };
            ffi::gs_clear(1, &clear, 0., 0);
            ffi::gs_ortho(
                0.,
                ffi::obs_source_get_width(p.source) as f32,
                0.,
                ffi::obs_source_get_height(p.source) as f32,
                -100.,
                100.,
            );
            ffi::gs_matrix_push();
            ffi::gs_matrix_identity();
            ffi::obs_source_video_render(p.source);
            ffi::gs_matrix_pop();
            ffi::gs_texrender_end(target);
            ffi::gs_stage_texture(stage, ffi::gs_texrender_get_texture(target));
            let mut bytes = std::ptr::null_mut();
            let mut stride = 0;
            assert!(ffi::gs_stagesurface_map(stage, &mut bytes, &mut stride));
            for y in 0..p.h as usize {
                p.pixels.extend_from_slice(std::slice::from_raw_parts(
                    bytes.add(y * stride as usize),
                    p.w as usize * 4,
                ));
            }
            ffi::gs_stagesurface_unmap(stage);
            ffi::gs_stagesurface_destroy(stage);
            ffi::gs_texrender_destroy(target);
            ffi::obs_leave_graphics();
        }
    }
    let mut p = Read {
        source,
        w: width,
        h: height,
        pixels: Vec::new(),
    };
    ffi::obs_queue_task(1, read, (&mut p as *mut Read).cast(), true);
    p.pixels
}

#[test]
#[ignore = "requires bundled ONNX Runtime and the Windows D3D11 engine; run alone"]
fn windows_cutout_and_virtual_camera_pixels_and_lifecycle() {
    use crate::live::{filters, studio};
    use std::{ffi::CString, ptr};
    let dir = std::env::temp_dir().join(format!("producer-windows-cutout-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    engine::persist_video(&dir, 720, 30);
    assert!(engine::bootstrap_with_config(&dir).ok);
    unsafe {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../scripts/fixtures/astronaut.png");
        let settings = ffi::obs_data_create();
        ffi::obs_data_set_string(
            settings,
            b"file\0".as_ptr().cast(),
            CString::new(path.to_str().unwrap()).unwrap().as_ptr(),
        );
        let source = ffi::obs_source_create_private(
            b"image_source\0".as_ptr().cast(),
            b"Segmentation fixture\0".as_ptr().cast(),
            settings,
        );
        ffi::obs_data_release(settings);
        assert!(!source.is_null());
        ffi::obs_source_inc_active(source);
        let original = source_pixels(source, 128, 128);
        assert!(original.chunks_exact(4).filter(|p| p[3] > 200).count() > 15000);
        // Mirror only the private output placement, without modifying its input.
        for _ in 0..8 {
            let mirror = ffi::obs_source_create_private(
                b"producer_vcam_mirror\0".as_ptr().cast(),
                b"Mirror fixture\0".as_ptr().cast(),
                ptr::null_mut(),
            );
            assert!(!mirror.is_null());
            assert!(ffi::producer_vcam_mirror_source(
                mirror,
                source,
                ptr::null_mut(),
                512,
                512
            ));
            let normal = source_pixels(mirror, 128, 128);
            ffi::producer_vcam_mirror_set(mirror, true);
            let flipped = source_pixels(mirror, 128, 128);
            let error: u64 = (0..128)
                .flat_map(|y| (0..128).map(move |x| (y, x)))
                .map(|(y, x)| {
                    (0..3)
                        .map(|c| {
                            normal[(y * 128 + x) * 4 + c]
                                .abs_diff(flipped[(y * 128 + 127 - x) * 4 + c])
                                as u64
                        })
                        .sum::<u64>()
                })
                .sum();
            assert!(
                error / (128 * 128 * 3) < 3,
                "mirror must reverse the complete picture"
            );
            assert!(
                original == source_pixels(source, 128, 128),
                "mirroring must leave its input unchanged"
            );
            ffi::obs_source_release(mirror);
            let mut mix = studio::RoomMix::build(source).unwrap();
            mix.set_mirrored(true);
            mix.set_mirrored(false);
            mix.set_source(source);
            mix.teardown();
        }
        for cycle in 0..8 {
            filters::add(source, "producer_person_mask", "Cutout proof").unwrap();
            filters::update(
                source,
                "Cutout proof",
                &json!({"mode":"cut","erode":0.0,"edge_refine":0.65}),
            )
            .unwrap();
            let filter =
                ffi::obs_source_get_filter_by_name(source, b"Cutout proof\0".as_ptr().cast());
            assert!(!filter.is_null());
            // Alternate full inference with removal during startup to prove joins
            // and partial-initialization cleanup, not just steady-state success.
            if cycle % 2 == 0 {
                let until = Instant::now() + Duration::from_secs(15);
                loop {
                    let pixels = source_pixels(source, 128, 128);
                    assert!(
                        ffi::producer_person_mask_status(filter) >= 0,
                        "Cutout runtime failed"
                    );
                    if ffi::producer_person_mask_completed(filter) > 1 {
                        let foreground = pixels[(28 * 128 + 56) * 4 + 3];
                        let background = pixels[(12 * 128 + 12) * 4 + 3];
                        assert!(foreground > 200, "the face remains opaque: {foreground}");
                        assert!(
                            background < 80,
                            "the wall becomes transparent: {background}"
                        );
                        std::fs::write(dir.join(format!("cutout-{cycle}.rgba")), &pixels).unwrap();
                        break;
                    }
                    assert!(Instant::now() < until, "Cutout must finish real inference");
                    std::thread::sleep(Duration::from_millis(40));
                }
                filters::update(source, "Cutout proof", &json!({"mode":"soft","blur":1.0}))
                    .unwrap();
                let until = Instant::now() + Duration::from_secs(5);
                let soft = loop {
                    let px = source_pixels(source, 128, 128);
                    if px[(12 * 128 + 12) * 4 + 3] > 240 && px != original {
                        break px;
                    }
                    assert!(
                        Instant::now() < until,
                        "Soft must finish inference and blur the background"
                    );
                    std::thread::sleep(Duration::from_millis(40));
                };
                assert!(
                    soft != original,
                    "Soft must actually alter background pixels"
                );
                filters::set_enabled(source, "Cutout proof", false).unwrap();
                assert!(
                    source_pixels(source, 128, 128) == original,
                    "bypass restores the input"
                );
            }
            ffi::obs_source_release(filter);
            filters::remove(source, "Cutout proof").unwrap();
        }
        ffi::obs_source_dec_active(source);
        ffi::obs_source_release(source);
        ffi::obs_shutdown();
    }
}
