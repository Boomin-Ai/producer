use producer_native_media::{
    player::{active_workers, Cancellation, Decoder, Player},
    retained_frame_bytes, Error, Result, VideoFrame,
};
use producer_production_contract::Time;
use std::{
    sync::{Arc, Barrier},
    thread,
    time::{Duration, Instant},
};
struct Controlled {
    started: Arc<Barrier>,
    release: Arc<Barrier>,
    first: bool,
}
impl Decoder for Controlled {
    fn seek(&mut self, at: Time, cancel: &Cancellation) -> Result<VideoFrame> {
        if self.first {
            self.first = false;
            self.started.wait();
            self.release.wait();
        }
        cancel.check()?;
        VideoFrame::allocate(at, at.checked_add(Time::seconds(1)).unwrap(), 16, 16)
    }
}
fn request(player: &Player, at: Time) -> producer_native_media::player::RequestId {
    loop {
        match player.request(at) {
            Ok(id) => return id,
            Err(Error::Busy) => thread::yield_now(),
            other => panic!("{other:?}"),
        }
    }
}
#[test]
fn worker_admission_latest_request_close_and_frame_charge() {
    let baseline = retained_frame_bytes();
    let started = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    let d = Controlled {
        started: started.clone(),
        release: release.clone(),
        first: true,
    };
    let player = Player::start(move || Ok(d)).unwrap();
    request(&player, Time::seconds(1));
    started.wait();
    let idle = Player::start(|| Err::<Controlled, _>(Error::Invalid("no video"))).unwrap();
    assert!(matches!(
        Player::start(|| Err::<Controlled, _>(Error::Unavailable)),
        Err(Error::Limit("decoder workers"))
    ));
    for i in 2..100 {
        request(&player, Time::seconds(i));
    }
    let latest = request(&player, Time::seconds(100));
    release.wait();
    let deadline = Instant::now() + Duration::from_secs(3);
    let reply = loop {
        assert!(Instant::now() < deadline);
        match player.poll() {
            Ok(Some(r)) => break r,
            Ok(None) | Err(Error::Busy) => thread::yield_now(),
            other => panic!("{other:?}"),
        }
    };
    assert_eq!(reply.request, latest);
    let held = reply.frame.unwrap();
    assert!(held.covers(Time::seconds(100)));
    assert!(!held.covers(Time::seconds(101)));
    player.close();
    assert_eq!(player.poll().unwrap_err(), Error::Closed);
    assert_eq!(player.request(Time::ZERO).unwrap_err(), Error::Closed);
    player.shutdown().unwrap();
    idle.shutdown().unwrap();
    assert_eq!(active_workers(), 0);
    assert_eq!(retained_frame_bytes(), baseline + 16 * 16 * 4);
    drop(held);
    assert_eq!(retained_frame_bytes(), baseline);
    assert!(matches!(
        VideoFrame::allocate(Time::ZERO, Time::ZERO, 16, 16),
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        VideoFrame::allocate(Time::ZERO, Time::seconds(1), 1921, 16),
        Err(Error::Limit(_))
    ));
    let mut frames = Vec::new();
    for _ in 0..4 {
        frames.push(VideoFrame::allocate(Time::ZERO, Time::seconds(1), 1920, 1920).unwrap());
    }
    assert!(matches!(
        VideoFrame::allocate(Time::ZERO, Time::seconds(1), 1920, 1920),
        Err(Error::Limit("held frames"))
    ));
    drop(frames);
    assert_eq!(retained_frame_bytes(), baseline);
    let panicked =
        Player::start(|| -> Result<Controlled> { panic!("injected decoder open panic") }).unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        assert!(Instant::now() < deadline);
        if matches!(panicked.poll(), Err(Error::Closed)) {
            break;
        }
        thread::yield_now();
    }
    assert_eq!(panicked.request(Time::ZERO).unwrap_err(), Error::Closed);
    assert!(panicked.shutdown().is_err());
    assert_eq!(active_workers(), 0);
}
