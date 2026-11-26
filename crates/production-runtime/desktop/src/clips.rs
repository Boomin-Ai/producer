//! Room-owned replay buffer. Only completed, sync-starting encoder fragments are retained.
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Output {
    #[default]
    Landscape,
    Vertical,
    Both,
}
impl Output {
    pub fn label(self) -> &'static str {
        match self {
            Self::Landscape => "Landscape",
            Self::Vertical => "Vertical",
            Self::Both => "Both",
        }
    }
    pub fn tracks(self) -> &'static [&'static str] {
        match self {
            Self::Landscape => &["program-landscape"],
            Self::Vertical => &["program-vertical"],
            Self::Both => &["program-landscape", "program-vertical"],
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub seconds: u32,
    pub memory_mb: u32,
    pub output: Output,
    pub folder: Option<PathBuf>,
    pub queue_for_publish: bool,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            seconds: 30,
            memory_mb: 128,
            output: Output::default(),
            folder: None,
            queue_for_publish: false,
        }
    }
}
impl Settings {
    pub fn directory(&self, root: &Path) -> PathBuf {
        self.folder.clone().unwrap_or_else(|| root.join("clips"))
    }
    fn validate(&self) -> Result<()> {
        ensure!(
            (1..=600).contains(&self.seconds),
            "Clip duration must be 1–600 seconds"
        );
        ensure!(
            (64..=1024).contains(&self.memory_mb),
            "Clip memory must be 64–1024 MB"
        );
        Ok(())
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct File {
    pub path: PathBuf,
    pub output: Output,
    pub duration_ms: i64,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Saved {
    pub id: u128,
    pub name: String,
    pub files: Vec<File>,
    pub error: Option<String>,
}
struct Fragment {
    start: f64,
    end: f64,
    bytes: Arc<[u8]>,
}
#[derive(Default)]
struct Track {
    init: Option<Arc<[u8]>>,
    fragments: VecDeque<Fragment>,
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub settings: Settings,
    pub enabled: bool,
    pub ready: bool,
    pub saving: bool,
    pub elapsed: u64,
    pub recent: Vec<Saved>,
    pub error: Option<String>,
}
#[derive(Default)]
struct State {
    root: PathBuf,
    status: Status,
    local_queue: Arc<Vec<Saved>>,
    queue_load_error: Option<String>,
    session: u64,
    started: Option<Instant>,
    tracks: Vec<Track>,
    bytes: usize,
    evicted_save_bytes: usize,
}
impl State {
    fn write_local_queue(&mut self, queue: Vec<Saved>) -> Result<()> {
        if let Some(error) = &self.queue_load_error {
            anyhow::bail!("{error}");
        }
        store(&self.root, "local-publish-queue.json", &queue)
            .context("Could not save the local Publish queue")?;
        self.local_queue = Arc::new(queue);
        Ok(())
    }

    fn finish_save(&mut self, item: Saved, queue_for_publish: bool) {
        self.status.error = item.error.clone();
        if queue_for_publish && item.error.is_none() && !item.files.is_empty() {
            let mut queue = self.local_queue.as_ref().clone();
            queue.insert(0, item.clone());
            if let Err(error) = self.write_local_queue(queue) {
                self.status.error = Some(format!(
                    "Clip saved, but could not add it to the local queue: {error:#}"
                ));
            }
        }
        self.status.recent.insert(0, item);
        self.status.recent.truncate(100);
        if let Err(error) = store(&self.root, "clip-library.json", &self.status.recent) {
            self.status.error = Some(error.to_string());
        }
        self.evicted_save_bytes = 0;
        self.status.saving = false;
    }

    fn evict(&mut self, track: usize) {
        let old = self.tracks[track].fragments.pop_front().unwrap();
        self.bytes -= old.bytes.len();
        if Arc::strong_count(&old.bytes) > 1 {
            self.evicted_save_bytes += old.bytes.len();
        }
    }
}
#[derive(Clone, Default)]
pub struct Clips(Arc<Mutex<State>>);
impl Clips {
    pub fn load(&self, root: &Path) {
        let mut state = self.0.lock().unwrap();
        state.root = root.to_path_buf();
        let queue = match fs::File::open(root.join("local-publish-queue.json")) {
            Ok(file) => serde_json::from_reader(file).map_err(anyhow::Error::from),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(error) => Err(error.into()),
        };
        match queue {
            Ok(items) => {
                state.local_queue = Arc::new(items);
                state.queue_load_error = None;
            }
            Err(error) => {
                let message = format!("Could not read the local Publish queue: {error}");
                state.local_queue = Arc::default();
                state.queue_load_error = Some(message.clone());
                state.status.error = Some(message);
            }
        }
        if let Ok(bytes) = fs::read(root.join("clip-settings.json")) {
            if let Ok(s) = serde_json::from_slice::<Settings>(&bytes) {
                if s.validate().is_ok() {
                    state.status.settings = s;
                }
            }
        }
        if let Ok(bytes) = fs::read(root.join("clip-library.json")) {
            if let Ok(mut list) = serde_json::from_slice::<Vec<Saved>>(&bytes) {
                list.truncate(100);
                state.status.recent = list;
            }
        }
    }
    pub fn local_queue(&self) -> Arc<Vec<Saved>> {
        Arc::clone(&self.0.lock().unwrap().local_queue)
    }

    pub fn remove_from_local_queue(&self, id: u128) -> Result<()> {
        let mut state = self.0.lock().unwrap();
        if let Some(index) = state.local_queue.iter().position(|clip| clip.id == id) {
            let mut queue = state.local_queue.as_ref().clone();
            queue.remove(index);
            state.write_local_queue(queue)?;
        }
        Ok(())
    }

    pub fn configure(&self, settings: Settings) -> Result<()> {
        settings.validate()?;
        let mut s = self.0.lock().unwrap();
        let previous = &s.status.settings;
        let same_capture = previous.seconds == settings.seconds
            && previous.memory_mb == settings.memory_mb
            && previous.output == settings.output
            && previous.folder == settings.folder;
        ensure!(
            same_capture || (!s.status.enabled && !s.status.saving),
            "Stop rolling capture before changing capture settings"
        );
        store(&s.root, "clip-settings.json", &settings)?;
        s.status.settings = settings;
        s.status.error = None;
        Ok(())
    }
    pub fn rename(&self, id: u128, name: String) -> Result<()> {
        let name = name.trim();
        ensure!(
            !name.is_empty() && name.chars().count() <= 80,
            "Enter a clip name up to 80 characters"
        );
        let mut s = self.0.lock().unwrap();
        let mut recent = s.status.recent.clone();
        recent
            .iter_mut()
            .find(|c| c.id == id)
            .context("Clip unavailable")?
            .name = name.into();
        store(&s.root, "clip-library.json", &recent)?;
        s.status.recent = recent;
        if let Some(index) = s.local_queue.iter().position(|clip| clip.id == id) {
            let mut queue = s.local_queue.as_ref().clone();
            queue[index].name = name.into();
            s.write_local_queue(queue)?;
        }
        Ok(())
    }
    pub fn begin(&self) -> Result<(u64, Settings)> {
        let mut s = self.0.lock().unwrap();
        ensure!(
            !s.status.enabled && !s.status.saving,
            "Clip capture is already active or saving"
        );
        let settings = s.status.settings.clone();
        let folder = settings.directory(&s.root);
        if settings.folder.is_none() {
            fs::create_dir_all(&folder)?;
        }
        ensure!(
            folder.is_dir(),
            "Clip folder unavailable. Connect the drive or choose another folder."
        );
        s.session += 1;
        s.tracks = (0..settings.output.tracks().len())
            .map(|_| Track::default())
            .collect();
        s.bytes = 0;
        s.evicted_save_bytes = 0;
        s.started = Some(Instant::now());
        s.status.enabled = true;
        s.status.ready = false;
        s.status.error = None;
        Ok((s.session, settings))
    }
    pub fn end(&self, error: Option<String>) {
        let mut s = self.0.lock().unwrap();
        s.status.enabled = false;
        s.status.ready = false;
        s.started = None;
        s.tracks.clear();
        s.bytes = 0;
        if error.is_some() {
            s.status.error = error;
        }
    }
    pub fn enabled(&self) -> bool {
        self.0.lock().unwrap().status.enabled
    }
    pub fn status(&self) -> Status {
        let s = self.0.lock().unwrap();
        Self::status_from(&s)
    }
    pub fn try_view(&self) -> Option<(Status, Arc<Vec<Saved>>)> {
        let s = self.0.try_lock().ok()?;
        Some((Self::status_from(&s), s.local_queue.clone()))
    }
    fn status_from(s: &State) -> Status {
        let mut status = s.status.clone();
        status.elapsed = s.started.map(|v| v.elapsed().as_secs()).unwrap_or_default();
        if status.enabled && status.elapsed >= 10 && !status.ready && status.error.is_none() {
            status.error =
                Some("Capture is waiting for complete audio and video fragments.".into());
        }
        status
    }
    pub fn event(
        &self,
        session: u64,
        track: u32,
        kind: u32,
        data: &[u8],
        spans: &[crate::recording::NativeSpan],
    ) -> bool {
        // Allocate outside the lock. Neither export nor the render loop owns these bytes.
        let bytes: Arc<[u8]> = Arc::from(data);
        let mut s = self.0.lock().unwrap();
        if session != s.session || !s.status.enabled {
            return true;
        }
        if kind == 3 {
            s.status.error = Some(String::from_utf8_lossy(data).into_owned());
            s.status.enabled = false;
            s.status.ready = false;
            s.tracks.clear();
            s.bytes = 0;
            return true;
        }
        let track = track as usize;
        if track >= s.tracks.len() {
            return false;
        }
        match kind {
            0 => {
                s.bytes += bytes.len();
                s.tracks[track].init = Some(bytes);
            }
            1 => {
                let Some(video) = spans.iter().find(|span| span.media == 0) else {
                    return true;
                };
                if video.rate <= 0 || video.duration_rate <= 0 || video.duration <= 0 {
                    return false;
                }
                let start = video.start as f64 / f64::from(video.rate);
                let end = start + video.duration as f64 / f64::from(video.duration_rate);
                s.bytes += bytes.len();
                s.tracks[track]
                    .fragments
                    .push_back(Fragment { start, end, bytes });
                let cutoff = end - f64::from(s.status.settings.seconds);
                while s.tracks[track]
                    .fragments
                    .front()
                    .is_some_and(|f| f.end <= cutoff)
                {
                    s.evict(track);
                }
            }
            2 => return true,
            _ => return false,
        }
        while s.bytes + s.evicted_save_bytes > s.status.settings.memory_mb as usize * 1024 * 1024 {
            let Some(index) = s
                .tracks
                .iter()
                .enumerate()
                .filter_map(|(i, t)| t.fragments.front().map(|f| (i, f.end)))
                .min_by(|a, b| a.1.total_cmp(&b.1))
                .map(|(i, _)| i)
            else {
                return false;
            };
            s.evict(index);
        }
        s.status.ready = s
            .tracks
            .iter()
            .all(|t| t.init.is_some() && !t.fragments.is_empty());
        true
    }
    pub fn save(&self) -> Result<()> {
        let (folder, output, tracks, seconds, queue_for_publish) = {
            let mut s = self.0.lock().unwrap();
            ensure!(
                s.status.enabled && s.status.ready && !s.status.saving,
                "Wait for rolling capture before saving"
            );
            let end = s
                .tracks
                .iter()
                .filter_map(|t| t.fragments.back().map(|f| f.end))
                .fold(f64::INFINITY, f64::min);
            let tracks = s
                .tracks
                .iter()
                .map(|t| {
                    let fragments = t
                        .fragments
                        .iter()
                        .filter(|f| {
                            f.end > end - f64::from(s.status.settings.seconds) && f.start < end
                        })
                        .collect::<Vec<_>>();
                    let cutoff = end - f64::from(s.status.settings.seconds);
                    let first = fragments
                        .iter()
                        .position(|f| f.start >= cutoff)
                        .unwrap_or(0);
                    let fragments = &fragments[first..];
                    let start = fragments
                        .first()
                        .context("Wait for both formats to buffer")?
                        .start;
                    let trim = (cutoff - start).max(0.);
                    Ok((
                        t.init.clone().context("Missing encoder header")?,
                        fragments
                            .iter()
                            .map(|f| f.bytes.clone())
                            .collect::<Vec<_>>(),
                        trim,
                        end - start - trim,
                    ))
                })
                .collect::<Result<Vec<_>>>()?;
            s.status.saving = true;
            s.status.error = None;
            (
                s.status.settings.directory(&s.root),
                s.status.settings.output,
                tracks,
                s.status.settings.seconds,
                s.status.settings.queue_for_publish,
            )
        };
        let clips = self.clone();
        if let Err(e) = std::thread::Builder::new()
            .name("producer-save-clip".into())
            .spawn(move || {
                let id = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis();
                let mut item = Saved {
                    id,
                    name: format!("Clip · {}", chrono_label(id)),
                    files: vec![],
                    error: None,
                };
                match export(&folder, id, output, tracks, seconds) {
                    Ok(files) => item.files = files,
                    Err(e) => item.error = Some(e.to_string()),
                }
                clips.0.lock().unwrap().finish_save(item, queue_for_publish);
            })
        {
            self.0.lock().unwrap().status.saving = false;
            return Err(e.into());
        }
        Ok(())
    }
}
fn store(root: &Path, name: &str, value: &impl Serialize) -> Result<()> {
    let mut file = tempfile::NamedTempFile::new_in(root)?;
    serde_json::to_writer(&mut file, value)?;
    file.as_file().sync_all()?;
    file.persist(root.join(name))?;
    Ok(())
}
fn chrono_label(ms: u128) -> String {
    let secs = (ms / 1000) % 86400;
    format!(
        "{:02}:{:02}:{:02} UTC",
        secs / 3600,
        secs / 60 % 60,
        secs % 60
    )
}
type ExportTrack = (Arc<[u8]>, Vec<Arc<[u8]>>, f64, f64);
fn export(
    folder: &Path,
    id: u128,
    output: Output,
    tracks: Vec<ExportTrack>,
    seconds: u32,
) -> Result<Vec<File>> {
    ensure!(folder.is_dir(), "Clip folder is unavailable");
    let muxer = std::env::current_exe()?.with_file_name("ffmpeg");
    ensure!(muxer.is_file(), "Clip muxer is missing from this build");
    let temp = tempfile::tempdir_in(folder)?;
    let mut result = Vec::new();
    for (index, (init, fragments, trim, duration)) in tracks.into_iter().enumerate() {
        let format = if output == Output::Both {
            [Output::Landscape, Output::Vertical][index]
        } else {
            output
        };
        let input = temp.path().join(format!("capture-{index}.mp4"));
        let mut file = fs::File::create(&input)?;
        file.write_all(&init)?;
        for fragment in fragments {
            file.write_all(&fragment)?;
        }
        drop(file);
        let name = format!("clip-{id}-{}.mp4", format.label().to_lowercase());
        let dest = temp.path().join(&name);
        let mut command = Command::new(&muxer);
        command
            .args(["-nostdin", "-v", "error", "-i"])
            .arg(&input)
            .args([
                "-t",
                &format!("{duration:.6}"),
                "-map",
                "0:v:0",
                "-map",
                "0:a:0",
            ]);
        if trim > 0. {
            // Windows shorter than an encoded fragment need a new starting keyframe.
            command.args([
                "-ss",
                &format!("{trim:.6}"),
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-crf",
                "18",
                "-c:a",
                "aac",
            ]);
        } else {
            command.args(["-c", "copy"]);
        }
        let mut writer = command
            .args(["-movflags", "+faststart"])
            .arg(&dest)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        let deadline = Instant::now() + Duration::from_secs(75);
        let status = loop {
            if let Some(status) = writer.try_wait()? {
                break status;
            }
            if Instant::now() >= deadline {
                let _ = writer.kill();
                let _ = writer.wait();
                anyhow::bail!("Clip export timed out.");
            }
            std::thread::sleep(Duration::from_millis(40));
        };
        ensure!(
            status.success(),
            "Could not finalize {} clip",
            format.label()
        );
        let duration_ms = crate::clips_media::duration_ms(&dest).map_err(anyhow::Error::msg)?;
        ensure!(
            duration_ms > 0 && duration_ms <= i64::from(seconds) * 1000 + 250,
            "Finalized clip duration was outside its capture window"
        );
        result.push((
            dest,
            File {
                path: folder.join(name),
                output: format,
                duration_ms,
            },
        ));
    }
    ensure!(
        result.iter().all(|(_, item)| !item.path.exists()),
        "Clip filename already exists"
    );
    let mut files: Vec<File> = Vec::new();
    for (path, item) in result {
        if let Err(err) = fs::rename(path, &item.path) {
            for file in &files {
                let _ = fs::remove_file(&file.path);
            }
            return Err(err.into());
        }
        files.push(item);
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recording::NativeSpan;
    #[test]
    fn local_publish_queue_keeps_only_opted_in_successful_exports_across_restarts() {
        let studio = tempfile::tempdir().unwrap();
        fs::write(
            studio.path().join("clip-settings.json"),
            r#"{"seconds":15}"#,
        )
        .unwrap();
        let clips = Clips::default();
        clips.load(studio.path());
        assert!(!clips.status().settings.queue_for_publish);
        let mut clip = Saved {
            id: 1,
            name: "Saved clip".into(),
            files: [Output::Landscape, Output::Vertical]
                .into_iter()
                .map(|output| File {
                    path: studio.path().join(format!("{}.mp4", output.label())),
                    output,
                    duration_ms: 15000,
                })
                .collect(),
            error: None,
        };
        for file in &clip.files {
            fs::write(&file.path, b"saved media").unwrap();
        }
        clips.0.lock().unwrap().finish_save(clip.clone(), false);
        assert!(clips.local_queue().is_empty());
        assert!(!studio.path().join("local-publish-queue.json").exists());

        clips.begin().unwrap();
        let mut settings = clips.status().settings;
        settings.queue_for_publish = true;
        clips.configure(settings).unwrap();
        assert!(clips.enabled());
        clip.id = 2;
        clips.0.lock().unwrap().finish_save(clip.clone(), true);
        clips.rename(2, "Final cut".into()).unwrap();
        clip.id = 3;
        clip.error = Some("Could not export".into());
        clips.0.lock().unwrap().finish_save(clip, true);
        clips.end(None);
        let reopened = Clips::default();
        reopened.load(studio.path());
        assert!(reopened.status().settings.queue_for_publish);
        let queued = reopened.local_queue();
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].name, "Final cut");
        assert_eq!(queued[0].files.len(), 2);
        let other_studio = tempfile::tempdir().unwrap();
        let other = Clips::default();
        other.load(other_studio.path());
        assert!(other.local_queue().is_empty());
        assert!(!other.status().settings.queue_for_publish);
        reopened.remove_from_local_queue(2).unwrap();
        reopened.remove_from_local_queue(2).unwrap();
        let reopened = Clips::default();
        reopened.load(studio.path());
        assert!(reopened.local_queue().is_empty());
        assert!(queued[0].files.iter().all(|file| file.path.exists()));
    }

    #[test]
    #[ignore = "uses the Native Dev encoded A/V fixture and bundled muxer"]
    fn rolling_capture_exports_both_and_reopens_library() {
        let fixture = PathBuf::from(std::env::var_os("CLIP_TAKE_FIXTURE").unwrap());
        let dir = tempfile::tempdir().unwrap();
        let clips = Clips::default();
        clips.load(dir.path());
        assert!(!clips.enabled());
        clips
            .configure(Settings {
                seconds: 3,
                output: Output::Both,
                queue_for_publish: true,
                ..Default::default()
            })
            .unwrap();
        let (session, _) = clips.begin().unwrap();
        assert!(clips.save().is_err());
        assert!(clips.configure(Default::default()).is_err());
        for index in 0..=3 {
            for track in 0..2 {
                let stem = fixture.join(format!("track-{track:02}-{index:08}"));
                let bytes = fs::read(stem.with_extension("mp4")).unwrap();
                let mut offset = 0;
                while &bytes[offset + 4..offset + 8] != b"moof" {
                    offset +=
                        u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
                }
                if index == 0 {
                    assert!(clips.event(session, track, 0, &bytes[..offset], &[]));
                }
                let meta: serde_json::Value =
                    serde_json::from_slice(&fs::read(stem.with_extension("json")).unwrap())
                        .unwrap();
                let sample = meta["spans"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|s| s["media"] == "video")
                    .unwrap();
                let span = NativeSpan {
                    start: sample["start"]["ticks"].as_str().unwrap().parse().unwrap(),
                    rate: sample["start"]["rate"].as_i64().unwrap() as i32,
                    duration: sample["duration"]["ticks"]
                        .as_str()
                        .unwrap()
                        .parse()
                        .unwrap(),
                    duration_rate: sample["duration"]["rate"].as_i64().unwrap() as i32,
                    media: 0,
                };
                assert!(clips.event(session, track, 1, &bytes[offset..], &[span]));
            }
        }
        assert!(clips.status().ready);
        clips.save().unwrap();
        assert!(clips.save().is_err());
        let mut during_export = clips.status().settings;
        during_export.queue_for_publish = false;
        clips.configure(during_export).unwrap();
        for _ in 0..160 {
            if !clips.status().saving {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let status = clips.status();
        assert!(status.enabled);
        let clip = status
            .recent
            .first()
            .expect("Export must produce a library entry");
        assert_eq!(clip.error, None);
        assert_eq!(clip.files.len(), 2);
        for f in &clip.files {
            let tool = std::env::current_exe().unwrap().with_file_name("ffmpeg");
            assert!(Command::new(tool)
                .args(["-nostdin", "-v", "error", "-xerror", "-i"])
                .arg(&f.path)
                .args(["-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-"])
                .status()
                .unwrap()
                .success());
        }
        clips.rename(clip.id, "Saved segment".into()).unwrap();
        clips.save().unwrap();
        for _ in 0..160 {
            if !clips.status().saving {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(clips.status().recent.len(), 2);
        assert!(clips
            .status()
            .recent
            .iter()
            .all(|entry| entry.error.is_none()));
        clips.end(None);
        let restarted = Clips::default();
        restarted.load(dir.path());
        assert!(!restarted.enabled());
        assert_eq!(restarted.status().recent[1].name, "Saved segment");
        assert!(!restarted.status().settings.queue_for_publish);
        assert_eq!(restarted.local_queue().len(), 1);
        assert_eq!(restarted.local_queue()[0].id, clip.id);
    }
}
