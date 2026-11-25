use ffmpeg::packet::Mut;
use ffmpeg_next as ffmpeg;
use producer_native_media::{
    native::LocalAsset,
    player::Player,
    take::{TakeLane, TakePair},
    Error,
};
use producer_production_contract::Time;
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    thread,
    time::{Duration, Instant},
};
fn read_at(path: &Path, at: Time) -> String {
    let player = LocalAsset::grant(path).unwrap().open_player().unwrap();
    read_player(player, at)
}
fn read_player(player: Player, at: Time) -> String {
    let start = Instant::now();
    loop {
        match player.request(at) {
            Ok(_) => break,
            Err(Error::Busy) => thread::yield_now(),
            e => panic!("{e:?}"),
        }
    }
    let result = loop {
        assert!(start.elapsed() < Duration::from_secs(5));
        match player.poll() {
            Ok(Some(reply)) => break reply.frame.unwrap(),
            Ok(None) | Err(Error::Busy) => thread::sleep(Duration::from_micros(200)),
            e => panic!("{e:?}"),
        }
    };
    assert!(result.covers(at));
    let hash = format!("{:x}", Sha256::digest(result.rgba()));
    drop(result);
    Player::shutdown(player).unwrap();
    hash
}
fn main() {
    let args: Vec<_> = std::env::args().collect();
    let fixture = Path::new(args.get(1).expect("fixture.mov"));
    let root = Path::new(args.get(2).expect("new take folder"));
    ffmpeg::init().unwrap();
    let mut input = ffmpeg::format::input(fixture).unwrap();
    let video = input
        .streams()
        .best(ffmpeg::media::Type::Video)
        .unwrap()
        .index();
    let mut take = TakePair::create(root, &input).unwrap();
    assert!(matches!(
        TakePair::create(
            &root.with_file_name("must-not-create-second-writer"),
            &input
        ),
        Err(Error::Limit("take writers"))
    ));
    let mut checkpoints = Vec::new();
    let mut frozen = None;
    let mut count = 0;
    for (stream, original) in input.packets() {
        let mut program = original.clone();
        if stream.index() == video {
            count += 1;
            // Simulate distinct program pixels. Copy-on-write must preserve the original packet.
            let code = unsafe { ffmpeg::ffi::av_packet_make_writable(program.as_mut_ptr()) };
            assert_eq!(code, 0);
            for b in program.data_mut().unwrap() {
                *b = 255 - *b;
            }
        }
        take.push(program, original).unwrap();
        if stream.index() == video && count % 6 == 0 {
            let committed = take.checkpoint().unwrap();
            let at = committed
                .available_end
                .checked_sub(Time::new(1, 48000).unwrap())
                .unwrap();
            let program = read_player(take.open_committed(TakeLane::Program).unwrap(), at);
            let original = read_player(take.open_committed(TakeLane::Original).unwrap(), at);
            assert_ne!(program, original, "program and original pixels aliased");
            let on_disk: serde_json::Value =
                serde_json::from_slice(&std::fs::read(root.join("manifest.json")).unwrap())
                    .unwrap();
            assert_eq!(on_disk, serde_json::to_value(&committed).unwrap());
            checkpoints.push(serde_json::json!({"manifest":committed,"programFrameSha256":program,"originalFrameSha256":original}));
            if frozen.is_none() {
                frozen = Some((
                    take.open_committed(TakeLane::Original).unwrap(),
                    committed.available_end,
                ));
            }
        }
    }
    let finished = take.finish().unwrap();
    let (frozen, end) = frozen.unwrap();
    loop {
        match frozen.request(end) {
            Ok(_) => break,
            Err(Error::Busy) => thread::yield_now(),
            e => panic!("{e:?}"),
        }
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        assert!(Instant::now() < deadline);
        match frozen.poll() {
            Ok(Some(reply)) => {
                assert_eq!(reply.frame.unwrap_err(), Error::Unavailable);
                break;
            }
            Ok(None) | Err(Error::Busy) => thread::yield_now(),
            e => panic!("{e:?}"),
        }
    }
    frozen.shutdown().unwrap();
    // Reopen both lanes after finalization, independently from any recording transport.
    assert_ne!(
        read_at(&root.join("program.mov"), Time::new(3, 2).unwrap()),
        read_at(&root.join("original.mov"), Time::new(3, 2).unwrap())
    );

    // A failed manifest write must preserve the previous committed range and stop this writer.
    let mut input = ffmpeg::format::input(fixture).unwrap();
    let failure_root = root.with_file_name(format!(
        "{}-failure",
        root.file_name().unwrap().to_str().unwrap()
    ));
    let mut failed = TakePair::create(&failure_root, &input).unwrap();
    let mut commits = 0;
    let mut previous = None;
    for (_, packet) in input.packets() {
        failed.push(packet.clone(), packet).unwrap();
        if failed.committed().available_end == Time::ZERO && commits == 0 {
            match failed.checkpoint() {
                Ok(manifest) => {
                    commits += 1;
                    previous = Some(manifest);
                }
                Err(Error::Unavailable) => {}
                e => panic!("{e:?}"),
            }
        } else if commits == 1 {
            std::fs::write(failure_root.join("manifest.pending"), b"occupied").unwrap();
            assert!(failed.checkpoint().is_err());
            assert_eq!(failed.committed(), previous.as_ref().unwrap());
            let on_disk: producer_native_media::take::TakeManifest =
                serde_json::from_slice(&std::fs::read(failure_root.join("manifest.json")).unwrap())
                    .unwrap();
            assert_eq!(on_disk, previous.clone().unwrap());
            assert_eq!(failed.checkpoint().unwrap_err(), Error::Closed);
            break;
        }
    }
    assert_eq!(commits, 1);
    assert_eq!(producer_native_media::retained_frame_bytes(), 0);
    assert_eq!(producer_native_media::player::active_workers(), 0);
    println!("{}",serde_json::to_string_pretty(&serde_json::json!({"checkpointsWhileWriting":checkpoints,"finished":finished,"writerAdmissionRejectedSecond":true,"snapshotReaderCannotSeeLaterRanges":true,"failedCheckpointRetainedPreviousRange":true})).unwrap());
}
