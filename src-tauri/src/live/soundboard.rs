use super::ffi;
use crate::soundboard::{Native, Reply, Status};
use std::{ptr, sync::Once};
extern "C" {
    fn producer_soundboard_register();
    fn producer_soundboard_has(s: *mut ffi::obs_source_t, id: u64) -> i32;
    fn producer_soundboard_load(
        s: *mut ffi::obs_source_t,
        id: u64,
        pcm: *const f32,
        frames: usize,
    ) -> i32;
    fn producer_soundboard_trigger(
        s: *mut ffi::obs_source_t,
        id: u64,
        mode: i32,
        gain: f32,
        fade: u32,
    ) -> i32;
    fn producer_soundboard_stop(s: *mut ffi::obs_source_t);
    fn producer_soundboard_gain(s: *mut ffi::obs_source_t, gain: f32);
    fn producer_soundboard_status(
        s: *mut ffi::obs_source_t,
        ids: *mut u64,
        cap: usize,
        bytes: *mut usize,
    ) -> usize;
}
static REGISTER: Once = Once::new();
pub struct Soundboard {
    room: String,
    sources: [*mut ffi::obs_source_t; 2],
    volume: f32,
    monitor: bool,
}
impl Default for Soundboard {
    fn default() -> Self {
        Self {
            room: String::new(),
            sources: [ptr::null_mut(); 2],
            volume: 0.8,
            monitor: true,
        }
    }
}
impl Soundboard {
    fn init(&mut self) -> Result<(), String> {
        unsafe {
            REGISTER.call_once(|| producer_soundboard_register());
            for i in 0..2 {
                if self.sources[i].is_null() {
                    let name = if i == 0 {
                        c"Producer Sounds"
                    } else {
                        c"Producer Sound Preview"
                    };
                    let s = ffi::obs_source_create(
                        c"producer_soundboard".as_ptr(),
                        name.as_ptr(),
                        ptr::null_mut(),
                        ptr::null_mut(),
                    );
                    if s.is_null() {
                        self.clear();
                        return Err("Could not create native soundboard".into());
                    }
                    self.sources[i] = s;
                    ffi::obs_source_set_audio_mixers(s, 3);
                    ffi::obs_source_set_monitoring_type(
                        s,
                        if i == 1 {
                            1
                        } else if self.monitor {
                            2
                        } else {
                            0
                        },
                    );
                    ffi::obs_set_output_source(5 + i as u32, s);
                }
            }
        }
        Ok(())
    }
    pub fn room(&self) -> &str {
        &self.room
    }
    pub fn clear(&mut self) {
        unsafe {
            for (i, s) in self.sources.iter_mut().enumerate() {
                if !s.is_null() {
                    producer_soundboard_stop(*s);
                    ffi::obs_set_output_source(5 + i as u32, ptr::null_mut());
                    ffi::obs_source_release(*s);
                    *s = ptr::null_mut();
                }
            }
        }
        self.room.clear();
        if let Ok(mut r) = crate::soundboard::ACTIVE.lock() {
            *r = None;
        }
    }
    fn status(&self) -> Status {
        let mut result = Status {
            room: self.room.clone(),
            volume: self.volume,
            monitor: self.monitor,
            ..Default::default()
        };
        for (i, s) in self.sources.iter().enumerate() {
            if s.is_null() {
                continue;
            }
            let mut ids = [0u64; 32];
            let mut bytes = 0;
            let n = unsafe { producer_soundboard_status(*s, ids.as_mut_ptr(), 32, &mut bytes) };
            let mut list = ids[..n].iter().map(|n| n.to_string()).collect::<Vec<_>>();
            list.sort();
            list.dedup();
            if i == 0 {
                result.playing = list
            } else {
                result.previewing = list
            }
            result.cached_bytes += bytes;
        }
        result
    }
    pub fn apply(&mut self, n: Native) -> Result<Reply, String> {
        if let Native::Activate(room) = n {
            if self.room != room {
                self.clear();
                self.room = room;
            }
            self.init()?;
            return Ok(Reply::Status(self.status()));
        }
        let room = match &n {
            Native::Has(r, _)
            | Native::Load(r, _, _)
            | Native::Trigger(r, ..)
            | Native::Mix(r, ..)
            | Native::Stop(r)
            | Native::Status(r) => r,
            _ => unreachable!(),
        };
        if room != &self.room || self.sources[0].is_null() {
            return Err("Soundboard room is no longer active".into());
        }
        unsafe {
            match n {
                Native::Has(_, id) => {
                    return Ok(Reply::Cached(
                        producer_soundboard_has(self.sources[0], id) != 0
                            && producer_soundboard_has(self.sources[1], id) != 0,
                    ))
                }
                Native::Load(_, id, pcm) => {
                    for s in self.sources {
                        if producer_soundboard_load(s, id, pcm.as_ptr(), pcm.len() / 2) == 0 {
                            return Err("Sound cache is full; stop an active sound and retry".into());
                        }
                    }
                }
                Native::Trigger(_, id, mode, gain, fade, preview) => {
                    if mode == 4 {
                        producer_soundboard_trigger(self.sources[1], id, mode, gain, fade);
                    }
                    if producer_soundboard_trigger(
                        self.sources[preview as usize],
                        id,
                        mode,
                        gain,
                        fade,
                    ) == 0
                    {
                        return Err("Sound not ready or 32 voices already playing".into());
                    }
                }
                Native::Stop(_) => {
                    for s in self.sources {
                        producer_soundboard_stop(s)
                    }
                }
                Native::Mix(_, volume, monitor) => {
                    self.volume = volume;
                    self.monitor = monitor;
                    for s in self.sources {
                        producer_soundboard_gain(s, volume)
                    }
                    ffi::obs_source_set_monitoring_type(
                        self.sources[0],
                        if monitor { 2 } else { 0 },
                    );
                }
                Native::Status(_) => {}
                _ => unreachable!(),
            }
        }
        Ok(Reply::Status(self.status()))
    }
}
impl Drop for Soundboard {
    fn drop(&mut self) {
        self.clear();
    }
}

#[cfg(debug_assertions)]
pub fn selftest() -> ! {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = (|| -> Result<serde_json::Value, String> {
            let dir = std::env::temp_dir().join("producer-soundboard-proof");
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let _report = super::engine::bootstrap_with_config(&dir.join("config"));
            if unsafe { ffi::obs_get_audio() }.is_null() {
                return Err("Audio bootstrap failed".into());
            }
            let mut board = Soundboard::default();
            board.apply(Native::Activate("proof".into()))?;
            board.apply(Native::Mix("proof".into(), 1., false))?;
            let tone = (0..48000 * 2)
                .flat_map(|n| {
                    let v = (n as f32 * std::f32::consts::TAU * 440. / 48000.).sin() * 0.2;
                    [v, v]
                })
                .collect::<Vec<_>>();
            board.apply(Native::Load("proof".into(), 1, tone))?;
            super::program_audio::start()?;
            board.apply(Native::Trigger("proof".into(), 1, 3, 1., 0, false))?;
            let program = super::program_audio::verification::measure();
            board.apply(Native::Stop("proof".into()))?;
            let stopped = super::program_audio::verification::measure();
            board.apply(Native::Trigger("proof".into(), 1, 0, 1., 0, true))?;
            let preview = super::program_audio::verification::measure();
            board.apply(Native::Activate("next".into()))?;
            let left = super::program_audio::verification::measure();
            if program.iter().any(|v| *v < 0.05)
                || stopped
                    .iter()
                    .chain(preview.iter())
                    .chain(left.iter())
                    .any(|v| *v > 0.001)
            {
                return Err(format!("Routing failed: program {program:?}, stopped {stopped:?}, preview {preview:?}, left {left:?}"));
            }
            if board
                .apply(Native::Trigger("proof".into(), 1, 0, 1., 0, false))
                .is_ok()
            {
                return Err("Stale room accepted".into());
            }
            let mut decoded = 0;
            let mut errors = vec![];
            if let Some(folder) = std::env::var_os("PRODUCER_SOUNDBOARD_TEST_FOLDER") {
                for file in std::fs::read_dir(folder).map_err(|e| e.to_string())? {
                    let f = file.map_err(|e| e.to_string())?.path();
                    if f.extension().is_some_and(|e| e == "mp3") {
                        match crate::soundboard::pcm(&f) {
                            Ok(p) if !p.is_empty() => decoded += 1,
                            Ok(_) => errors.push("empty audio".to_string()),
                            Err(e) => errors.push(format!(
                                "{}: {e}",
                                f.file_name().unwrap_or_default().to_string_lossy()
                            )),
                        }
                    }
                }
            }
            super::program_audio::stop();
            board.clear();
            Ok(
                serde_json::json!({"ok":errors.is_empty(),"program_rms":program,"stopped_rms":stopped,"private_preview_leak_rms":preview,"room_exit_rms":left,"decoded_files":decoded,"decode_errors":errors}),
            )
        })();
        let _ = tx.send(result);
    });
    loop {
        match rx.try_recv() {
            Ok(Ok(value)) => {
                println!("SOUNDBOARD_PROOF {}", value);
                std::process::exit(if value["ok"] == true { 0 } else { 1 })
            }
            Ok(Err(e)) => {
                eprintln!("Soundboard proof failed: {e}");
                std::process::exit(1)
            }
            Err(std::sync::mpsc::TryRecvError::Empty) => super::idle_tick(),
            Err(_) => std::process::exit(2),
        }
    }
}
