use producer_native_media::{
    native::LocalAsset,
    player::{Player, Reply},
    Error,
};
use producer_production_contract::Time;
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    thread,
    time::{Duration, Instant},
};

fn frame(player: &Player, ticks: i64, rate: u32) -> Reply {
    let at = Time::new(ticks, rate).unwrap();
    let start = Instant::now();
    let id = loop {
        match player.request(at) {
            Ok(id) => break id,
            Err(Error::Busy) => thread::yield_now(),
            e => panic!("request: {e:?}"),
        }
    };
    loop {
        assert!(start.elapsed() < Duration::from_secs(5), "decode timed out");
        match player.poll() {
            Ok(Some(reply)) => {
                assert_eq!(reply.request, id);
                return reply;
            }
            Ok(None) | Err(Error::Busy) => thread::sleep(Duration::from_micros(200)),
            e => panic!("poll: {e:?}"),
        }
    }
}
fn main() {
    let args: Vec<_> = std::env::args().collect();
    let path = Path::new(args.get(1).expect("media_proof fixture.mov"));
    let asset = LocalAsset::grant(path).unwrap();
    let a = asset.clone().open_player().unwrap();
    let b = asset.open_player().unwrap();
    let mut results = Vec::new();
    for (player, name, ticks, rate) in [
        (&a, "a", 0, 1),
        (&b, "b", 7, 10),
        (&a, "a", 2, 10),
        (&b, "b", 1, 10),
        (&a, "a", 119, 100),
        (&a, "a", 0, 1),
    ] {
        let reply = frame(player, ticks, rate);
        let image = reply.frame.expect("expected decoded frame");
        assert!(image.covers(reply.requested));
        results.push(serde_json::json!({"player": name, "requested": reply.requested, "start": image.start, "end": image.end, "width":image.width,"height":image.height,"rgbaSha256":format!("{:x}",Sha256::digest(image.rgba())),"workerMs":reply.elapsed.as_secs_f64()*1000.0,"requestToReplyMs":reply.request_latency.as_secs_f64()*1000.0}));
    }
    let references: serde_json::Value =
        serde_json::from_slice(&std::fs::read(path.with_file_name("reference.json")).unwrap())
            .unwrap();
    let reference = &references[path.file_stem().unwrap().to_str().unwrap()];
    let timebase = reference["timeBase"].as_str().unwrap();
    let (num, den) = timebase.split_once('/').unwrap();
    let num: i64 = num.parse().unwrap();
    let den: u32 = den.parse().unwrap();
    let frames = reference["frames"].as_array().unwrap();
    let mut checks = 0;
    let mut timings = Vec::new();
    // Every frame, reverse order and between-frame positions: includes the drained final B-frame.
    for (index, expected) in frames.iter().enumerate().rev() {
        let start = expected["pts"].as_i64().unwrap();
        let end = frames
            .get(index + 1)
            .map(|f| f["pts"].as_i64().unwrap())
            .unwrap_or(start + expected["duration"].as_i64().unwrap());
        for (player, ticks) in [(&a, start), (&b, start + (end - start) / 2)] {
            let reply = frame(player, ticks * num, den);
            timings.push(reply.elapsed.as_secs_f64() * 1000.0);
            let image = reply.frame.unwrap();
            assert_eq!(image.start, Time::new(start * num, den).unwrap());
            assert_eq!(image.end, Time::new(end * num, den).unwrap());
            assert_eq!(
                format!("{:x}", Sha256::digest(image.rgba())),
                expected["sha256"].as_str().unwrap()
            );
            checks += 1;
        }
    }
    let mut first_seeks = None;
    let mut last_seeks = 0;
    let mut sequential_timings = Vec::new();
    for expected in frames {
        let reply = frame(&a, expected["pts"].as_i64().unwrap() * num, den);
        first_seeks.get_or_insert(reply.statistics.seek_calls);
        last_seeks = reply.statistics.seek_calls;
        sequential_timings.push(reply.elapsed.as_secs_f64() * 1000.0);
        let image = reply.frame.unwrap();
        assert_eq!(
            format!("{:x}", Sha256::digest(image.rgba())),
            expected["sha256"].as_str().unwrap()
        );
        checks += 1;
    }
    assert_eq!(
        Some(last_seeks),
        first_seeks,
        "sequential playback must not seek per frame"
    );
    // A scrub flood must not publish any obsolete intermediate generation.
    let mut latest = None;
    for n in 0..500 {
        loop {
            match a.request(Time::new(n % 10, 10).unwrap()) {
                Ok(id) => {
                    latest = Some(id);
                    break;
                }
                Err(Error::Busy) => thread::yield_now(),
                e => panic!("{e:?}"),
            }
        }
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        assert!(Instant::now() < deadline);
        match a.poll() {
            Ok(Some(r)) => {
                assert_eq!(Some(r.request), latest);
                assert!(r.frame.unwrap().covers(Time::new(9, 10).unwrap()));
                break;
            }
            Ok(None) | Err(Error::Busy) => thread::yield_now(),
            e => panic!("{e:?}"),
        }
    }
    let end = frame(&a, 6, 1);
    assert_eq!(end.frame.unwrap_err(), Error::Unavailable);
    a.shutdown().unwrap();
    b.shutdown().unwrap();
    assert_eq!(producer_native_media::retained_frame_bytes(), 0);
    assert_eq!(producer_native_media::player::active_workers(), 0);
    timings.sort_by(f64::total_cmp);
    sequential_timings.sort_by(f64::total_cmp);
    println!("{}",serde_json::to_string_pretty(&serde_json::json!({"frames":results,"oracleChecks":checks,"sequentialPlaybackExtraSeeks":0,"sequentialWorkerP50Ms":sequential_timings[sequential_timings.len()/2],"sequentialWorkerP99Ms":sequential_timings[sequential_timings.len()-1],"scrubFloodRequests":500,"workerP50Ms":timings[timings.len()/2],"workerP99Ms":timings[timings.len()-1],"workersAfterShutdown":0,"frameBytesAfterRelease":0})).unwrap());
}
