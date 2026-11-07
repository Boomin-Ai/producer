//! Two native audio-only decks on reserved output channels 3/4. The main
//! audio mix feeds stream/record, monitoring feeds the host. No scene item,
//! browser timer, or panel lifetime owns these sources.
use super::ffi;
use crate::dj::{
    Action, DeckState, ProgramNextKind, ProgramPhase, ProgramStatus, ProgramTrack, QueueTrack,
    Status,
};
use std::{ffi::CString, ptr, time::Instant};

const CHANNELS: [u32; 2] = [3, 4];
struct Deck {
    src: *mut ffi::obs_source_t,
    track: Option<QueueTrack>,
    wanted: i32,
    started: bool,
    looping: bool,
    fade_in: Option<Instant>,
}
impl Default for Deck {
    fn default() -> Self {
        Self {
            src: ptr::null_mut(),
            track: None,
            wanted: 5,
            started: false,
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
    incoming: Option<usize>,
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
        super::dj_audio::start()?;
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
        ffi::obs_source_set_audio_mixers(src, 3 | (1 << 5)); // Dedicated DJ analysis bus; program/stage routing preserved.
        ffi::obs_source_set_volume(src, 0.);
        ffi::obs_source_set_monitoring_type(
            src,
            if cfg!(debug_assertions)
                && (std::env::var_os("PRODUCER_DJ_SELFTEST").is_some()
                    || std::env::var_os("PRODUCER_DJ_VISUAL_PROOF").is_some())
            {
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
            started: play,
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
        d.started = true;
        d.fade_in = Some(Instant::now());
        self.active = deck;
        Ok(())
    }
    fn queue_position(&self) -> Option<usize> {
        let id = self.decks[self.active]
            .track
            .as_ref()
            .map(|t| t.id.as_str());
        self.queue.iter().position(|t| Some(t.id.as_str()) == id)
    }
    fn ordered_next_index(&self, current: Option<usize>, previous: bool) -> Option<usize> {
        let last = self.queue.len().checked_sub(1)?;
        match current {
            None => Some(0),
            Some(i) if previous => Some(if i == 0 { last } else { i - 1 }),
            Some(i) if i < last => Some(i + 1),
            Some(_) if self.repeat => Some(0),
            Some(_) => None,
        }
    }
    fn next_track(&self, previous: bool) -> Option<QueueTrack> {
        if self.queue.is_empty() {
            return None;
        }
        let current = self.queue_position();
        if self.shuffle && self.queue.len() > 1 {
            use rand::Rng;
            let mut n = rand::thread_rng().gen_range(0..self.queue.len() - 1);
            if current.is_some_and(|i| n >= i) {
                n += 1;
            }
            return self.queue.get(n).cloned();
        }
        let n = self.ordered_next_index(current, previous)?;
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
            incoming: Some(next),
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
                            incoming: None,
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
                    let gain = gains[i] * ramp * if d.wanted == 1 { 1. } else { 0. };
                    ffi::obs_source_set_volume(d.src, gain);
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
    fn program_track(track: &QueueTrack, deck: usize) -> ProgramTrack {
        let title: String = track
            .title
            .chars()
            .take(160)
            .map(|ch| if ch.is_control() { ' ' } else { ch })
            .collect();
        let title = title.trim();
        ProgramTrack {
            title: if title.is_empty() {
                "Untitled track".into()
            } else {
                title.into()
            },
            deck,
        }
    }
    fn program_status(&self, decks: &[DeckState; 2]) -> ProgramStatus {
        let track = |i: usize| decks[i].track.as_ref().filter(|_| decks[i].state != 7);
        let title = |i| track(i).map(|t| Self::program_track(t, i));
        let playing =
            |i: usize| self.decks[i].wanted == 1 && decks[i].state == 1 && track(i).is_some();
        let gains = gains(self.crossfader, 1.);
        let preferred = if self.crossfader == 0.5 {
            self.active
        } else {
            usize::from(self.crossfader > 0.5)
        };
        let active = [preferred, 1 - preferred]
            .into_iter()
            .find(|&i| playing(i) && gains[i] > 0.)
            .or_else(|| {
                [self.active, 1 - self.active]
                    .into_iter()
                    .find(|&i| track(i).is_some())
            })
            .unwrap_or(self.active);
        let other = 1 - active;
        let mut program = ProgramStatus {
            phase: ProgramPhase::Idle,
            current: title(active),
            next: None,
            next_kind: ProgramNextKind::None,
        };

        if self.stopping.is_some() {
            program.phase = ProgramPhase::Stopping;
            return program;
        }
        if let Some(fade) = &self.transition {
            // `active` switches when a handoff is requested, before its audio
            // arrives. Keep the outgoing deck in "current" during the fade.
            program.current = fade.stop.and_then(title);
            let incoming = match fade.incoming {
                Some(deck) => {
                    program.phase = if fade.waiting || !playing(deck) {
                        ProgramPhase::Loading
                    } else {
                        ProgramPhase::Crossfade
                    };
                    Some(deck)
                }
                None => {
                    program.phase = ProgramPhase::Stopping;
                    fade.stop.map(|deck| 1 - deck).filter(|&deck| playing(deck))
                }
            };
            program.next = incoming.and_then(title);
            if program.next.is_some() {
                program.next_kind = ProgramNextKind::Incoming;
            }
            return program;
        }
        if playing(active) && playing(other) && gains[active] > 0. && gains[other] > 0. {
            program.phase = ProgramPhase::Manual;
            program.next = title(other);
            program.next_kind = ProgramNextKind::Incoming;
            return program;
        }

        let deck = &self.decks[active];
        program.phase = match (program.current.is_some(), deck.wanted, decks[active].state) {
            (false, _, _) => ProgramPhase::Idle,
            (true, 1, 1) => ProgramPhase::Playing,
            (true, 1, 0 | 2 | 3) => ProgramPhase::Loading,
            (true, 4, _) if deck.started => ProgramPhase::Paused,
            _ => ProgramPhase::Ready,
        };
        let other_deck = &self.decks[other];
        if (other_deck.wanted == 4 || (other_deck.wanted == 1 && decks[other].state <= 3))
            && track(other).is_some()
        {
            program.next = title(other);
            program.next_kind = ProgramNextKind::Deck;
        } else if !decks[active].looping {
            if self.shuffle && self.queue.len() > 1 {
                // A random queue choice does not exist until the handoff.
                program.next_kind = ProgramNextKind::Shuffle;
            } else if let Some(index) = self.ordered_next_index(self.queue_position(), false) {
                program.next = Some(Self::program_track(&self.queue[index], 1 - self.active));
                program.next_kind = ProgramNextKind::Queue;
            }
        }
        program
    }
    pub fn status(&self) -> Status {
        let decks = std::array::from_fn(|i| {
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
        });
        let program = self.program_status(&decks);
        if let Some(current) = &program.current {
            let d = &decks[current.deck];
            super::dj_audio::timeline(
                d.position_ms,
                d.duration_ms,
                self.decks[current.deck].wanted == 1,
                self.crossfader,
                matches!(
                    program.phase,
                    ProgramPhase::Crossfade | ProgramPhase::Manual
                ),
            );
        } else {
            super::dj_audio::timeline(0, 0, false, self.crossfader, false);
        }
        let current_id = program
            .current
            .as_ref()
            .and_then(|track| self.decks[track.deck].track.as_ref())
            .map(|track| track.id.as_str());
        let position = self
            .queue
            .iter()
            .position(|track| Some(track.id.as_str()) == current_id)
            .unwrap_or(0);
        let start = position.min(self.queue.len().saturating_sub(6));
        let queue_titles = self
            .queue
            .iter()
            .skip(start)
            .take(6)
            .map(|track| Self::program_track(track, 0).title)
            .collect();
        Status {
            decks,
            active: self.active,
            volume: self.volume,
            crossfader: self.crossfader,
            fade: self.fade,
            repeat: self.repeat,
            shuffle: self.shuffle,
            duck: self.duck,
            transitioning: self.transition.is_some() || self.stopping.is_some(),
            error: self.error.clone(),
            program,
            queue_titles,
            audio: super::dj_audio::snapshot(),
        }
    }
    pub fn clear(&mut self) {
        unsafe {
            self.clear_deck(0);
            self.clear_deck(1);
        }
        super::dj_audio::stop();
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
    fn public_tracklist_is_bounded_and_follows_the_current_track() {
        let mut dj = Dj::default();
        dj.queue = (0..9)
            .map(|index| QueueTrack {
                id: format!("track-{index}"),
                title: format!("Track {index}"),
                path: format!("/private/music/{index}.wav"),
                ..Default::default()
            })
            .collect();
        dj.decks[0].track = Some(dj.queue[7].clone());
        let status = dj.status();
        assert_eq!(
            status.queue_titles,
            (3..9)
                .map(|index| format!("Track {index}"))
                .collect::<Vec<_>>()
        );
        assert!(!serde_json::to_string(&status.queue_titles)
            .unwrap()
            .contains("/private/"));
        dj.queue.clear();
        assert!(dj.status().queue_titles.is_empty());
    }
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
    fn sample_track(id: &str) -> QueueTrack {
        QueueTrack {
            id: id.into(),
            path: format!("/private/music/{id}.wav"),
            title: id.into(),
            ..Default::default()
        }
    }
    #[test]
    fn program_keeps_outgoing_track_until_the_native_handoff_finishes() {
        let mut dj = Dj::default();
        dj.active = 1;
        dj.decks[0].wanted = 1;
        dj.decks[1].wanted = 1;
        let mut decks = [
            DeckState {
                track: Some(sample_track("outgoing")),
                state: 1,
                ..Default::default()
            },
            DeckState {
                track: Some(sample_track("incoming")),
                state: 2,
                ..Default::default()
            },
        ];
        dj.transition = Some(Fade {
            start: Instant::now(),
            from: 0.,
            to: 1.,
            stop: Some(0),
            waiting: true,
            incoming: Some(1),
        });
        let loading = dj.program_status(&decks);
        assert_eq!(loading.phase, ProgramPhase::Loading);
        assert_eq!(loading.current.unwrap().title, "outgoing");
        assert_eq!(loading.next.unwrap().title, "incoming");
        assert_eq!(loading.next_kind, ProgramNextKind::Incoming);

        decks[1].state = 1;
        dj.transition.as_mut().unwrap().waiting = false;
        let fading = dj.program_status(&decks);
        assert_eq!(fading.phase, ProgramPhase::Crossfade);
        assert_eq!(fading.current.as_ref().unwrap().deck, 0);
        assert_eq!(fading.next.as_ref().unwrap().deck, 1);
        let serialized = serde_json::to_value(fading).unwrap();
        assert_eq!(serialized["phase"], "crossfade");
        assert_eq!(
            serialized["current"],
            serde_json::json!({"title":"outgoing","deck":0})
        );
        assert_eq!(
            serialized["next"],
            serde_json::json!({"title":"incoming","deck":1})
        );

        dj.transition = None;
        dj.crossfader = 1.;
        dj.decks[0].wanted = 5;
        decks[0].state = 5;
        let playing = dj.program_status(&decks);
        assert_eq!(playing.phase, ProgramPhase::Playing);
        assert_eq!(playing.current.unwrap().title, "incoming");
        assert_eq!(playing.next_kind, ProgramNextKind::None);
    }
    #[test]
    fn program_upcoming_prefers_cued_deck_and_respects_queue_mode() {
        let mut dj = Dj::default();
        let first = sample_track("first");
        let last = sample_track("last");
        let cue = sample_track("cue");
        dj.queue = vec![first.clone(), last.clone()];
        dj.decks[0].track = Some(last.clone());
        dj.decks[0].wanted = 1;
        let mut decks = [
            DeckState {
                track: Some(last),
                state: 1,
                ..Default::default()
            },
            DeckState::default(),
        ];
        assert_eq!(dj.program_status(&decks).next_kind, ProgramNextKind::None);
        dj.repeat = true;
        let repeat = dj.program_status(&decks);
        assert_eq!(repeat.next_kind, ProgramNextKind::Queue);
        assert_eq!(repeat.next.unwrap().title, "first");
        dj.shuffle = true;
        let shuffle = dj.program_status(&decks);
        assert_eq!(shuffle.next_kind, ProgramNextKind::Shuffle);
        assert!(shuffle.next.is_none());

        dj.decks[1].wanted = 4;
        decks[1] = DeckState {
            track: Some(cue),
            state: 4,
            ..Default::default()
        };
        let cued = dj.program_status(&decks);
        assert_eq!(cued.next_kind, ProgramNextKind::Deck);
        assert_eq!(cued.next.unwrap().title, "cue");
        dj.decks[1].wanted = 1;
        decks[1].state = 1;
        dj.crossfader = 0.75;
        let manual = dj.program_status(&decks);
        assert_eq!(manual.phase, ProgramPhase::Manual);
        assert_eq!(manual.current.unwrap().deck, 1);
        assert_eq!(manual.next_kind, ProgramNextKind::Incoming);
        dj.stopping = Some((Instant::now(), 1.));
        assert_eq!(dj.program_status(&decks).phase, ProgramPhase::Stopping);
    }
}

/// Debug-only local verification: synthetic tracks, no devices, no networks,
/// no database writes, muted local monitoring. Checks the REAL recording mix.
#[cfg(debug_assertions)]
pub fn selftest_main() -> ! {
    let _music_subscription = super::dj_audio::subscribe();
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
            let check_program =
                |status: &Status, phase, current: Option<&str>, next: Option<&str>, next_kind| {
                    let program = &status.program;
                    if program.phase != phase
                        || program.current.as_ref().map(|track| track.title.as_str()) != current
                        || program.next.as_ref().map(|track| track.title.as_str()) != next
                        || program.next_kind != next_kind
                    {
                        return Err(format!(
                            "Unexpected DJ program snapshot for {phase:?}: {program:?}"
                        ));
                    }
                    Ok(())
                };
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
            check_program(
                &s,
                ProgramPhase::Ready,
                Some("A"),
                Some("B"),
                ProgramNextKind::Queue,
            )?;
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
            check_program(
                &playing,
                ProgramPhase::Playing,
                Some("A"),
                Some("B"),
                ProgramNextKind::Queue,
            )?;
            if playing.audio.energy < 0.01 || playing.audio.bands.iter().all(|v| *v == 0.) {
                return Err(format!(
                    "Decoded DJ samples did not reach visual analysis: {:?}, {}",
                    playing.audio,
                    super::dj_audio::diagnostics()
                ));
            }
            let music_energy = playing.audio.energy;
            send(Action::Pause { deck: 0 })?;
            std::thread::sleep(Duration::from_millis(150));
            let paused = send(Action::Status)?;
            if paused.audio.energy != 0. {
                return Err("Paused DJ still drives reactive lighting".into());
            }
            check_program(
                &paused,
                ProgramPhase::Paused,
                Some("A"),
                Some("B"),
                ProgramNextKind::Queue,
            )?;
            std::thread::sleep(Duration::from_millis(350));
            if (send(Action::Status)?.decks[0].position_ms - paused.decks[0].position_ms).abs() > 60
            {
                return Err("Paused position advanced".into());
            }
            send(Action::Play {
                deck: 0,
                preserve_fader: false,
            })?;
            if h.release_idle_room()? {
                return Err("Room released DJ during recording".into());
            }
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut observed_crossfade = false;
            loop {
                let status = send(Action::Status)?;
                if status.program.phase == ProgramPhase::Crossfade {
                    check_program(
                        &status,
                        ProgramPhase::Crossfade,
                        Some("A"),
                        Some("B"),
                        ProgramNextKind::Incoming,
                    )?;
                    observed_crossfade = true;
                }
                if status.active == 1 && status.decks[1].state == 1 && !status.transitioning {
                    check_program(
                        &status,
                        ProgramPhase::Playing,
                        Some("B"),
                        None,
                        ProgramNextKind::None,
                    )?;
                    break;
                }
                if Instant::now() >= deadline {
                    return Err(format!("Auto crossfade failed: {:?}", status.program));
                }
                std::thread::sleep(Duration::from_millis(30));
            }
            if !observed_crossfade {
                return Err("The DJ program did not report the native crossfade".into());
            }
            send(Action::Seek { deck: 1, ms: 1000 })?;
            std::thread::sleep(Duration::from_millis(150));
            if (send(Action::Status)?.decks[1].position_ms - 1150).abs() > 350 {
                return Err("Native seek failed".into());
            }
            let stopping = send(Action::StopAll)?;
            check_program(
                &stopping,
                ProgramPhase::Stopping,
                Some("B"),
                None,
                ProgramNextKind::None,
            )?;
            std::thread::sleep(Duration::from_millis(650));
            if send(Action::Status)?.decks[1].state != 5 {
                return Err("Fade stop did not stop decoder".into());
            }
            h.stop_recording()?;
            if !h.release_idle_room()? {
                return Err("Idle room did not release".into());
            }
            let cleared = send(Action::Status)?;
            if cleared.decks.iter().any(|d| d.track.is_some()) {
                return Err("Room exit retained music".into());
            }
            check_program(
                &cleared,
                ProgramPhase::Idle,
                None,
                None,
                ProgramNextKind::None,
            )?;
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
                serde_json::json!({"ok":true,"checks":["load paused","play advances","pause holds position","recording survives view exit","native auto crossfade","seek","fade stop","idle room clears decks","recording contains music","DJ program ready, playing, paused, crossfade, stopping and idle"],"rms":rms,"peak":peak,"musicEnergy":music_energy,"analysis":"post-fader DJ-only bus; mixed samples; pause-silent","artifact":output}),
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
