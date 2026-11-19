use producer_production_core::{contract::*, lifecycle::*};

fn prepared_cost(d: &Document) -> Cost {
    let mut runtime = Runtime::default();
    runtime.prepare(d, Counter(0), 0).unwrap();
    runtime.ledger.used()
}

#[test]
fn native_scenes_do_not_consume_optional_browser_capacity() {
    let mut d = fixture::classic_like();
    let mut stage = d.sources["stage"].clone();
    if let Source::Graphics { scene } = &mut stage {
        scene.batches[0].instances = 100;
    }
    d.sources.insert("stage".into(), stage.clone());
    for n in 1..5 {
        d.sources.insert(format!("stage-{n}"), stage.clone());
    }
    let mut runtime = Runtime::default();
    let token = runtime.prepare(&d, Counter(0), 0).unwrap();
    let used = runtime.ledger.used();
    assert_eq!(used.browsers, 0);
    assert_eq!(used.graphics.scenes, 5);
    assert_eq!(used.graphics.instances, 500);
    assert_eq!(used.graphics.buffers, 20);
    assert_eq!(used.graphics.pipelines, 7);
    assert_eq!(used.graphics.textures, 12);
    assert_eq!(used.graphics.render_passes, 12);
    assert_eq!(used.gpu, 12 * 1920 * 1080 * 4 + 500 * 64);
    // The optional adapter can reserve browser slots independently. Cancellation
    // must release graphics without releasing that unrelated reservation.
    runtime
        .ledger
        .reserve(Cost {
            browsers: CAP.browsers,
            ..Cost::default()
        })
        .unwrap();
    runtime.cancel(token).unwrap();
    assert_eq!(
        runtime.ledger.used(),
        Cost {
            browsers: CAP.browsers,
            ..Cost::default()
        }
    );
}

#[test]
fn additional_prepared_views_charge_targets_and_passes_without_duplicating_scene_state() {
    let mut d = fixture::classic_like();
    let before = prepared_cost(&d);
    let layouts = &mut d.sets.get_mut("classic").unwrap().layouts;
    layouts.insert("extra".into(), layouts["wide"].clone());
    let after = prepared_cost(&d);
    assert_eq!(after.graphics.scenes, before.graphics.scenes);
    assert_eq!(after.graphics.instances, before.graphics.instances);
    assert_eq!(after.graphics.buffers, before.graphics.buffers);
    assert_eq!(after.surfaces, before.surfaces + 1);
    assert_eq!(after.graphics.pipelines, before.graphics.pipelines + 1);
    assert_eq!(
        after.graphics.render_passes,
        before.graphics.render_passes + 2
    );
    assert_eq!(after.graphics.textures, before.graphics.textures + 2);
    assert_eq!(after.gpu, before.gpu + 2 * 1920 * 1080 * 4);
}

#[test]
fn equal_asset_hashes_do_not_erase_independent_batch_reservations() {
    let mut d = fixture::classic_like();
    let before = prepared_cost(&d);
    if let Source::Graphics { scene } = d.sources.get_mut("stage").unwrap() {
        let mut batch = scene.batches[0].clone();
        batch.id = "other-lights".into();
        scene.batches.push(batch);
    }
    let after = prepared_cost(&d);
    assert_eq!(after.graphics.instances, before.graphics.instances + 1000);
    assert_eq!(after.graphics.buffers, before.graphics.buffers + 3);
    assert_eq!(after.graphics.pipelines, before.graphics.pipelines + 1);
    assert_eq!(after.graphics.render_passes, before.graphics.render_passes);
    assert_eq!(after.graphics.textures, before.graphics.textures);
    assert_eq!(after.gpu, before.gpu + 1000 * 64);
}

type Dimension = (&'static str, fn(&mut GraphicsCost) -> &mut u32);
const DIMENSIONS: [Dimension; 6] = [
    ("scenes", |c| &mut c.scenes),
    ("pipelines", |c| &mut c.pipelines),
    ("render passes", |c| &mut c.render_passes),
    ("textures", |c| &mut c.textures),
    ("buffers", |c| &mut c.buffers),
    ("instances", |c| &mut c.instances),
];

#[test]
fn every_graphics_dimension_rejects_excess_and_overflow_without_partial_admission() {
    for (name, field) in DIMENSIONS {
        let mut caps = CAP.graphics;
        let cap = *field(&mut caps);
        let mut ledger = Ledger::default();
        let mut excessive = Cost::default();
        *field(&mut excessive.graphics) = cap + 1;
        assert_eq!(
            ledger.reserve(excessive).unwrap_err().code,
            "RESOURCE_LIMIT",
            "{name}"
        );
        assert_eq!(ledger.used(), Cost::default(), "{name}");
        assert_eq!(ledger.reservation_count(), 0, "{name}");

        let mut almost = Cost::default();
        *field(&mut almost.graphics) = cap - 1;
        assert_eq!(ledger.reserve(almost).unwrap(), 1, "{name}");
        let mut one = Cost::default();
        *field(&mut one.graphics) = 1;
        assert_eq!(ledger.reserve(one).unwrap(), 2, "{name}");
        let admitted = ledger.used();
        assert_eq!(
            ledger.reserve(one).unwrap_err().code,
            "RESOURCE_LIMIT",
            "{name}"
        );
        *field(&mut excessive.graphics) = u32::MAX;
        assert_eq!(
            ledger.reserve(excessive).unwrap_err().code,
            "RESOURCE_LIMIT",
            "{name}"
        );
        assert_eq!(ledger.used(), admitted, "{name}");
        assert_eq!(ledger.reservation_count(), 2, "{name}");
        assert_eq!(ledger.reserve(Cost::default()).unwrap(), 3, "{name}");
    }
}

#[test]
fn retirement_capacity_counts_objects_instead_of_work_or_buffer_contents() {
    let work_only = Cost {
        graphics: GraphicsCost {
            render_passes: u32::MAX,
            instances: u32::MAX,
            ..GraphicsCost::default()
        },
        ..Cost::default()
    };
    assert_eq!(work_only.retire_slots(), 0);
    assert_eq!(RETIREMENT_SLOTS, 488);
    assert_eq!(CAP.retire_slots(), RETIREMENT_SLOTS);
    let max = Cost {
        players: u32::MAX,
        captures: u32::MAX,
        browsers: u32::MAX,
        surfaces: u32::MAX,
        voices: u32::MAX,
        graphics: GraphicsCost {
            scenes: u32::MAX,
            pipelines: u32::MAX,
            textures: u32::MAX,
            buffers: u32::MAX,
            ..work_only.graphics
        },
        ..Cost::default()
    };
    assert_eq!(max.retire_slots(), 9 * u64::from(u32::MAX));
}

#[test]
fn failed_preparation_leaves_existing_graphics_and_token_budget_intact() {
    let mut runtime = Runtime::default();
    let mut d = fixture::classic_like();
    let token = runtime.prepare(&d, Counter(0), 0).unwrap();
    let before = runtime.ledger.used();
    // Five large targets exceed the synthetic byte budget once scene projection
    // targets and the currently prepared candidate are included.
    let layouts = &mut d.sets.get_mut("classic").unwrap().layouts;
    let mut large = layouts["wide"].clone();
    large.width = 3840;
    large.height = 2160;
    for n in 0..5 {
        layouts.insert(format!("large-{n}"), large.clone());
    }
    assert_eq!(
        runtime.prepare(&d, Counter(1), 0).unwrap_err().code,
        "RESOURCE_LIMIT"
    );
    assert_eq!(runtime.ledger.used(), before);
    assert_eq!(runtime.ledger.reservation_count(), 1);
    assert_eq!(runtime.state(token), Some(TakeState::Prepared));
    runtime.cancel(token).unwrap();
    assert_eq!(runtime.ledger.used(), Cost::default());
}
