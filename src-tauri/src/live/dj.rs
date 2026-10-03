//! Two native audio-only decks on reserved output channels 3/4. The main
//! audio mix feeds stream/record, monitoring feeds the host. No scene item,
//! browser timer, or panel lifetime owns these sources.
use super::ffi;
use crate::dj::{Action, DeckState, QueueTrack, Status};
use std::{ffi::CString, ptr, time::Instant};

const CHANNELS: [u32; 2] = [3, 4];
struct Deck {
    src: *mut ffi::obs_source_t,
    track: Option<QueueTrack>,
    wanted: i32,
    looping: bool,
    fade_in: Option<Instant>,
}
impl Default for Deck {
    fn default() -> Self {
        Self {
            src: ptr::null_mut(),
            track: None,
            wanted: 5,
            looping: false,
            fade_in: None,
        }
    }
}
struct Fade {
    start: Instant,
    from: f32,
    to: f32,
    stop: Option<usize>,
    waiting: bool,
}
pub struct Dj {
    decks: [Deck; 2],
    queue: Vec<QueueTrack>,
    active: usize,
    volume: f32,
    crossfader: f32,
    fade: f32,
    repeat: bool,
    shuffle: bool,
    duck: bool,
    duck_gain: f32,
    master_gain: f32,
    stopping: Option<(Instant, f32)>,
    transition: Option<Fade>,
    error: Option<String>,
}
impl Default for Dj {
    fn default() -> Self {
        Self {
            decks: Default::default(),
            queue: vec![],
            active: 0,
            volume: 0.65,
            crossfader: 0.5,
            fade: 2.,
            repeat: false,
            shuffle: false,
            duck: false,
            duck_gain: 1.,
            master_gain: 1.,
            stopping: None,
            transition: None,
            error: None,
        }
    }
}
// Linear crossfade keeps a same-beat handoff from adding a 3 dB bump.
pub fn gains(x: f32, volume: f32) -> [f32; 2] {
    [(1. - x.clamp(0., 1.)) * volume, x.clamp(0., 1.) * volume]
}
impl Dj {
    fn deck(&self, deck: usize) -> Result<(), String> {
        if deck > 1 {
            Err("Unknown DJ deck".into())
        } else {
            Ok(())
        }
    }
    unsafe fn clear_deck(&mut self, deck: usize) {
        let d = &mut self.decks[deck];
        if !d.src.is_null() {
            ffi::obs_source_media_stop(d.src);
            ffi::obs_set_output_source(CHANNELS[deck], ptr::null_mut());
            ffi::obs_source_release(d.src);
        }
        *d = Deck::default();
    }
    unsafe fn load(&mut self, deck: usize, track: QueueTrack, play: bool) -> Result<(), String> {
        self.deck(deck)?;
        let path = crate::dj::audio_path(&track.path)?;
        let path =
            CString::new(path.to_string_lossy().as_bytes()).map_err(|_| "Invalid music path")?;
        let data = ffi::obs_data_create();
        ffi::obs_data_set_bool(data, c"is_local_file".as_ptr(), true);
        ffi::obs_data_set_string(data, c"local_file".as_ptr(), path.as_ptr());
        ffi::obs_data_set_bool(data, c"restart_on_activate".as_ptr(), false);
        ffi::obs_data_set_bool(data, c"close_when_inactive".as_ptr(), false);
        ffi::obs_data_set_bool(data, c"clear_on_media_end".as_ptr(), false);
        let name = CString::new(format!("Producer DJ {}", deck)).unwrap();
        let src = ffi::obs_source_create(
            c"ffmpeg_source".as_ptr(),
            name.as_ptr(),
            data,
            ptr::null_mut(),
        );
        ffi::obs_data_release(data);
        if src.is_null() {
            return Err("The native audio player couldn't open this track".into());
        }
        ffi::obs_source_set_audio_mixers(src, 3);
        ffi::obs_source_set_volume(src, 0.);
        ffi::obs_source_set_monitoring_type(
            src,
            if cfg!(debug_assertions) && std::env::var_os("PRODUCER_DJ_SELFTEST").is_some() {
                0
            } else {
                2
            },
        ); // monitor AND output; harness stays silent
        self.clear_deck(deck);
        ffi::obs_set_output_source(CHANNELS[deck], src);
        ffi::obs_source_media_play_pause(src, !play);
        self.decks[deck] = Deck {
            src,
            track: Some(track),
            wanted: if play { 1 } else { 4 },
            looping: false,
            fade_in: if play { Some(Instant::now()) } else { None },
        };
        self.error = None;
        Ok(())
    }
    unsafe fn play(&mut self, deck: usize) -> Result<(), String> {
        self.deck(deck)?;
        self.stopping = None;
        self.master_gain = 1.;
        let d = &mut self.decks[deck];
        if d.src.is_null() {
            return Err("Load a track first".into());
        }
        let state = ffi::obs_source_media_get_state(d.src);
        if state == 5 || state == 6 {
            ffi::obs_source_media_restart(d.src);
        } else {
            ffi::obs_source_media_play_pause(d.src, false);
        }
        d.wanted = 1;
        d.fade_in = Some(Instant::now());
        self.active = deck;
        Ok(())
    }
    fn next_track(&self, previous: bool) -> Option<QueueTrack> {
        let id = self.decks[self.active]
            .track
            .as_ref()
            .map(|t| t.id.as_str());
        let current = self.queue.iter().position(|t| Some(t.id.as_str()) == id);
        if self.queue.is_empty() {
            return None;
        }
        if self.shuffle && self.queue.len() > 1 {
            use rand::Rng;
            let mut n = rand::thread_rng().gen_range(0..self.queue.len() - 1);
            if current.is_some_and(|i| n >= i) {
                n += 1;
            }
            return self.queue.get(n).cloned();
        }
        let n = match current {
            None => 0,
            Some(i) if previous => {
                if i == 0 {
                    self.queue.len() - 1
                } else {
                    i - 1
                }
            }
            Some(i) => {
                if i + 1 < self.queue.len() {
                    i + 1
                } else if self.repeat {
                    0
                } else {
                    return None;
                }
            }
        };
        self.queue.get(n).cloned()
    }
    unsafe fn next(&mut self, previous: bool) -> Result<(), String> {
        if self.transition.is_some() {
            return Ok(());
        }
        let track = self.next_track(previous).ok_or("End of tracklist")?;
        let old = self.active;
        let next = 1 - old;
        self.load(next, track, true)?;
        self.decks[next].fade_in = None;
        self.active = next;
        self.transition = Some(Fade {
            start: Instant::now(),
            from: self.crossfader,
            to: next as f32,
            stop: Some(old),
            waiting: true,
        });
        Ok(())
    }
    pub fn apply(&mut self, action: Action) -> Result<Status, String> {
        unsafe {
            match action {
                Action::Status => {}
                Action::PauseAll => {
                    self.transition = None;
                    self.stopping = None;
                    for d in &mut self.decks {
                        if !d.src.is_null() {
                            ffi::obs_source_media_play_pause(d.src, true);
                            d.wanted = 4;
                        }
                    }
                }
                Action::StopAll => {
                    self.transition = None;
                    self.stopping = Some((Instant::now(), self.master_gain));
                }
                Action::Queue { tracks } => {
                    if tracks.len() > 10000 {
                        return Err("Tracklist is too large".into());
                    }
                    self.queue = tracks;
                }
                Action::Load { deck, track } => {
                    if self.transition.is_some() {
                        return Err("Wait for the crossfade to finish before loading a deck".into());
                    }
                    self.load(deck, track, false)?;
                }
                Action::Play {
                    deck,
                    preserve_fader,
                } => {
                    self.play(deck)?;
                    if !preserve_fader && self.decks[1 - deck].wanted != 1 {
                        self.crossfader = deck as f32;
                    }
                }
                Action::Pause { deck } => {
                    self.deck(deck)?;
                    if self.transition.take().is_some() {
                        // Pause a handoff coherently; resuming a deck selects it.
                        for d in &mut self.decks {
                            if !d.src.is_null() {
                                ffi::obs_source_media_play_pause(d.src, true);
                                d.wanted = 4;
                            }
                        }
                    }
                    if !self.decks[deck].src.is_null() {
                        ffi::obs_source_media_play_pause(self.decks[deck].src, true);
                        self.decks[deck].wanted = 4;
                    }
                }
                Action::Stop { deck } => {
                    self.deck(deck)?;
                    if !self.decks[deck].src.is_null() {
                        self.transition = Some(Fade {
                            start: Instant::now(),
                            from: self.crossfader,
                            to: (1 - deck) as f32,
                            stop: Some(deck),
                            waiting: true,
                        });
                    }
                }
                Action::Seek { deck, ms } => {
                    self.deck(deck)?;
                    if !self.decks[deck].src.is_null() {
                        let duration = ffi::obs_source_media_get_duration(self.decks[deck].src);
                        ffi::obs_source_media_set_time(
                            self.decks[deck].src,
                            ms.clamp(0, duration.max(0)),
                        );
                    }
                }
                Action::Loop { deck, on } => {
                    self.deck(deck)?;
                    self.decks[deck].looping = on;
                }
                Action::Next { previous } => {
                    self.next(previous)?;
                }
                Action::Mix {
                    volume,
                    crossfader,
                    fade,
                    repeat,
                    shuffle,
                    duck,
                } => {
                    if !volume.is_finite() || !crossfader.is_finite() || !fade.is_finite() {
                        return Err("Invalid DJ mix setting".into());
                    }
                    self.volume = volume.clamp(0., 1.);
                    self.crossfader = crossfader.clamp(0., 1.);
                    self.fade = fade.clamp(0., 12.);
                    self.repeat = repeat;
                    self.shuffle = shuffle;
                    self.duck = duck;
                    let dominant = usize::from(self.crossfader >= 0.5);
                    if self.transition.is_none()
                        && self.stopping.is_none()
                        && self.decks[dominant].wanted == 1
                    {
                        self.active = dominant;
                    }
                }
                Action::Clear => {
                    self.clear();
                }
            }
        }
        self.levels();
        Ok(self.status())
    }
    fn levels(&self) {
        let gains = gains(
            self.crossfader,
            self.volume * self.duck_gain * self.master_gain,
        );
        unsafe {
            for (i, d) in self.decks.iter().enumerate() {
                if !d.src.is_null() {
                    let ramp = d
                        .fade_in
                        .map(|start| {
                            if self.fade <= 0. {
                                1.
                            } else {
                                (start.elapsed().as_secs_f32() / self.fade).min(1.)
                            }
                        })
                        .unwrap_or(1.);
                    ffi::obs_source_set_volume(
                        d.src,
                        gains[i] * ramp * if d.wanted == 1 { 1. } else { 0. },
                    );
                }
            }
        }
    }
    pub fn tick(&mut self, speaking: bool) {
        if let Some((start, from)) = self.stopping {
            let p = if self.fade <= 0. {
                1.
            } else {
                (start.elapsed().as_secs_f32() / self.fade).min(1.)
            };
            self.master_gain = from * (1. - p);
            if p >= 1. {
                unsafe {
                    for d in &mut self.decks {
                        if !d.src.is_null() {
                            ffi::obs_source_media_stop(d.src);
                            d.wanted = 5;
                        }
                    }
                }
                self.stopping = None;
            }
        }
        let target = if self.duck && speaking { 0.25 } else { 1. };
        self.duck_gain +=
            (target - self.duck_gain) * if target < self.duck_gain { 0.65 } else { 0.15 };
        if let Some(f) = &mut self.transition {
            // Wait until the incoming decoder is actually playing before
            // taking the old deck down. Decoder errors keep the old beat up.
            let incoming = self.active;
            let ready = f.stop == Some(incoming)
                || self.decks[incoming].src.is_null()
                || unsafe { ffi::obs_source_media_get_state(self.decks[incoming].src) == 1 };
            if ready && f.waiting {
                f.start = Instant::now();
                f.waiting = false;
            }
            let p = if self.fade <= 0. {
                1.
            } else {
                (f.start.elapsed().as_secs_f32() / self.fade).clamp(0., 1.)
            };
            if ready {
                self.crossfader = f.from + (f.to - f.from) * p;
                if p >= 1. {
                    let stop = f.stop;
                    self.transition = None;
                    if let Some(i) = stop {
                        unsafe {
                            if !self.decks[i].src.is_null() {
                                ffi::obs_source_media_stop(self.decks[i].src);
                                self.decks[i].wanted = 5;
                            }
                        }
                    }
                }
            } else if f.start.elapsed().as_secs() > 10 {
                if let Some(old) = f.stop {
                    self.active = old;
                    self.crossfader = old as f32;
                }
                self.transition = None;
                self.error =
                    Some("The next track couldn't start. Select another audio file.".into());
            }
        }
        for d in &mut self.decks {
            if !d.src.is_null() {
                unsafe {
                    let state = ffi::obs_source_media_get_state(d.src);
                    // Some decoders finish opening after their first pause command.
                    if d.wanted == 4 && state == 1 {
                        ffi::obs_source_media_play_pause(d.src, true);
                    }
                    if state == 7 {
                        self.error =
                            Some("This track couldn't be decoded. Try another audio file.".into());
                        d.wanted = 5;
                    }
                    if state == 6 && d.looping && d.wanted == 1 {
                        ffi::obs_source_media_restart(d.src);
                    }
                }
            }
        }
        let d = &self.decks[self.active];
        if !d.src.is_null()
            && d.wanted == 1
            && !d.looping
            && self.transition.is_none()
            && self.stopping.is_none()
        {
            unsafe {
                let state = ffi::obs_source_media_get_state(d.src);
                let duration = ffi::obs_source_media_get_duration(d.src);
                let pos = ffi::obs_source_media_get_time(d.src);
                if (state == 6
                    || (state == 1
                        && duration > 0
                        && pos > 500
                        && duration - pos <= (self.fade * 1000.) as i64))
                    && self.next_track(false).is_some()
                {
                    if let Err(e) = self.next(false) {
                        self.error = Some(e);
                    }
                }
            }
        }
        self.levels();
    }
    pub fn status(&self) -> Status {
        Status {
            decks: std::array::from_fn(|i| {
                let d = &self.decks[i];
                unsafe {
                    DeckState {
                        track: d.track.clone(),
                        position_ms: if d.src.is_null() {
                            0
                        } else {
                            ffi::obs_source_media_get_time(d.src)
                        },
                        duration_ms: if d.src.is_null() {
                            0
                        } else {
                            ffi::obs_source_media_get_duration(d.src)
                        },
                        state: if d.src.is_null() {
                            5
                        } else {
                            ffi::obs_source_media_get_state(d.src)
                        },
                        looping: d.looping,
                    }
                }
            }),
            active: self.active,
            volume: self.volume,
            crossfader: self.crossfader,
            fade: self.fade,
            repeat: self.repeat,
            shuffle: self.shuffle,
            duck: self.duck,
            transitioning: self.transition.is_some() || self.stopping.is_some(),
            error: self.error.clone(),
        }
    }
    pub fn clear(&mut self) {
        unsafe {
            self.clear_deck(0);
            self.clear_deck(1);
        }
        self.master_gain = 1.;
        self.stopping = None;
        self.queue.clear();
        self.transition = None;
        self.error = None;
    }
}
impl Drop for Dj {
    fn drop(&mut self) {
        self.clear();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn crossfade_keeps_sum_bounded() {
        for n in 0..101 {
            let g = gains(n as f32 / 100., 0.8);
            assert!((g[0] + g[1] - 0.8).abs() < 0.00001);
        }
    }
    #[test]
    fn mic_ducking_recovers_and_manual_fader_selects_audible_deck() {
        let mut dj = Dj::default();
        dj.duck = true;
        dj.tick(true);
        assert!(dj.duck_gain < 0.6);
        for _ in 0..40 {
            dj.tick(false);
        }
        assert!(dj.duck_gain > 0.99);
        dj.decks[1].wanted = 1;
        dj.apply(Action::Mix {
            volume: 0.65,
            crossfader: 1.,
            fade: 2.,
            repeat: false,
            shuffle: false,
            duck: true,
        })
        .unwrap();
        assert_eq!(dj.active, 1);
    }
    #[test]
    fn queue_end_and_repeat_are_distinct() {
        let mut dj = Dj::default();
        dj.queue = vec![
            QueueTrack {
                id: "a".into(),
                ..Default::default()
            },
            QueueTrack {
                id: "b".into(),
                ..Default::default()
            },
        ];
        dj.decks[0].track = Some(dj.queue[1].clone());
        assert!(dj.next_track(false).is_none());
        dj.repeat = true;
        assert_eq!(dj.next_track(false).unwrap().id, "a");
        assert_eq!(dj.next_track(true).unwrap().id, "a");
    }
}

/// Debug-only local verification: synthetic tracks, no devices, no networks,
/// no database writes, muted local monitoring. Checks the REAL recording mix.
#[cfg(debug_assertions)]
pub fn selftest_main() -> ! {
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = (|| -> Result<serde_json::Value, String> {
            use std::time::Duration;
            let dir = std::env::temp_dir().join(format!("producer-dj-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let tone = |name: &str, hz: f32| -> Result<QueueTrack, String> {
                let path = dir.join(format!("{name}.wav"));
                let rate = 44100;
                let mut w = hound::WavWriter::create(
                    &path,
                    hound::WavSpec {
                        channels: 1,
                        sample_rate: rate,
                        bits_per_sample: 16,
                        sample_format: hound::SampleFormat::Int,
                    },
                )
                .map_err(|e| e.to_string())?;
                for n in 0..rate * 4 {
                    w.write_sample(
                        ((n as f32 * 2. * std::f32::consts::PI * hz / rate as f32).sin() * 6500.)
                            as i16,
                    )
                    .map_err(|e| e.to_string())?;
                }
                w.finalize().map_err(|e| e.to_string())?;
                Ok(QueueTrack {
                    id: name.into(),
                    path: path.to_string_lossy().into(),
                    title: name.into(),
                    matched_bpm: None,
                })
            };
            let a = tone("A", 440.)?;
            let b = tone("B", 660.)?;
            let (ready_tx, ready_rx) = std::sync::mpsc::channel();
            let h = super::engine::start(dir.join("config"), move |ev| {
                if let super::engine::LiveEvent::EngineReady { ok, .. } = ev {
                    let _ = ready_tx.send(*ok);
                }
            });
            if !ready_rx
                .recv_timeout(Duration::from_secs(30))
                .map_err(|e| e.to_string())?
            {
                return Err("Engine bootstrap failed".into());
            }
            let send = |action| h.dj_dispatch().and_then(|call| call(action));
            send(Action::Mix {
                volume: 0.65,
                crossfader: 0.5,
                fade: 0.3,
                repeat: false,
                shuffle: false,
                duck: false,
            })?;
            send(Action::Queue {
                tracks: vec![a.clone(), b.clone()],
            })?;
            send(Action::Load { deck: 0, track: a })?;
            std::thread::sleep(Duration::from_millis(450));
            let s = send(Action::Status)?;
            if s.decks[0].state != 4 {
                return Err(format!("Load should pause, got {}", s.decks[0].state));
            }
            let stamp = format!("DJ verification {}", uuid::Uuid::new_v4());
            let record = h.start_recording(stamp)?;
            send(Action::Play {
                deck: 0,
                preserve_fader: true,
            })?;
            std::thread::sleep(Duration::from_millis(850));
            let playing = send(Action::Status)?;
            if (playing.crossfader - 0.5).abs() > 0.001 {
                return Err("Mix Play moved the centered crossfader".into());
            }
            if playing.decks[0].state != 1 || playing.decks[0].position_ms < 300 {
                return Err("Play did not advance the native decoder".into());
            }
            send(Action::Pause { deck: 0 })?;
            std::thread::sleep(Duration::from_millis(150));
            let paused = send(Action::Status)?.decks[0].position_ms;
            std::thread::sleep(Duration::from_millis(350));
            if (send(Action::Status)?.decks[0].position_ms - paused).abs() > 60 {
                return Err("Paused position advanced".into());
            }
            send(Action::Play {
                deck: 0,
                preserve_fader: false,
            })?;
            if h.release_idle_room()? {
                return Err("Room released DJ during recording".into());
            }
            std::thread::sleep(Duration::from_millis(3900));
            let switched = send(Action::Status)?;
            if switched.active != 1
                || switched.decks[1].track.as_ref().map(|t| t.id.as_str()) != Some("B")
                || switched.decks[1].state != 1
            {
                return Err(format!(
                    "Auto crossfade failed: {}",
                    serde_json::to_string(&switched).unwrap()
                ));
            }
            send(Action::Seek { deck: 1, ms: 1000 })?;
            std::thread::sleep(Duration::from_millis(150));
            if (send(Action::Status)?.decks[1].position_ms - 1150).abs() > 350 {
                return Err("Native seek failed".into());
            }
            send(Action::StopAll)?;
            std::thread::sleep(Duration::from_millis(650));
            if send(Action::Status)?.decks[1].state != 5 {
                return Err("Fade stop did not stop decoder".into());
            }
            h.stop_recording()?;
            if !h.release_idle_room()? {
                return Err("Idle room did not release".into());
            }
            if send(Action::Status)?
                .decks
                .iter()
                .any(|d| d.track.is_some())
            {
                return Err("Room exit retained music".into());
            }
            let output = dir.join("mix.mp4");
            std::fs::rename(record, &output).map_err(|e| e.to_string())?;
            let mut sum = 0f64;
            let mut count = 0;
            let mut peak = 0f32;
            crate::dj::decode(&output, |samples, _, _| {
                for &s in samples {
                    sum += (s as f64).powi(2);
                    count += 1;
                    peak = peak.max(s.abs());
                }
                Ok(true)
            })?;
            let rms = (sum / count.max(1) as f64).sqrt();
            if rms < 0.015 || peak > 0.8 {
                return Err(format!(
                    "Recording mix is silent or clipped: rms={rms},peak={peak}"
                ));
            }
            h.shutdown();
            Ok(
                serde_json::json!({"ok":true,"checks":["load paused","play advances","pause holds position","recording survives view exit","native auto crossfade","seek","fade stop","idle room clears decks","recording contains music"],"rms":rms,"peak":peak,"artifact":output}),
            )
        })();
        let _ = done_tx.send(result);
    });
    loop {
        match done_rx.try_recv() {
            Ok(Ok(report)) => {
                println!("{}", serde_json::to_string_pretty(&report).unwrap());
                std::process::exit(0);
            }
            Ok(Err(error)) => {
                eprintln!("DJ SELFTEST FAILED: {error}");
                std::process::exit(1);
            }
            Err(std::sync::mpsc::TryRecvError::Empty) => super::idle_tick(),
            Err(_) => std::process::exit(2),
        }
    }
}
