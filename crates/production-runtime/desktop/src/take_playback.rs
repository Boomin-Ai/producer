//! Codec/IO worker adapter for a frozen take. Paths stay in this private grant,
//! never the authoring document. At most one video and one audio chunk reader.
use crate::platform::{Frame, Movie, MovieAudio};
use anyhow::{bail, Context, Result};
use producer_native_media::{committed::CommittedTrack, recording::RecordingHead};
use producer_production_contract::{Range, Time};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TakeGrant {
    pub name: String,
    pub track: u32,
    pub head: RecordingHead,
    pub hash: String,
}
pub fn take_path(root: &Path, name: &str) -> Result<PathBuf> {
    if !name.starts_with("take-")
        || name.len() <= 5
        || name.len() > 64
        || !name[5..].bytes().all(|c| c.is_ascii_digit())
    {
        bail!("Invalid local take name");
    }
    Ok(root.join("recordings").join(name))
}
pub struct TakeDecoder {
    view: CommittedTrack,
    pub grant: TakeGrant,
    video: Option<(u64, Movie)>,
    audio: Option<(u64, MovieAudio)>,
}
impl TakeDecoder {
    pub fn open(root: &Path, name: &str, track: u32, frozen: Option<TakeGrant>) -> Result<Self> {
        let path = take_path(root, name)?;
        let view = match &frozen {
            Some(g) if g.name == name && g.track == track => {
                CommittedTrack::at_head(&path, track, g.head.clone())?
            }
            Some(_) => bail!("Take grant identity mismatch"),
            None => CommittedTrack::open(&path, track)?,
        };
        if view.track.width == 0 {
            bail!("This first take playback adapter requires a video track");
        }
        if frozen.as_ref().is_some_and(|g| g.hash != view.hash) {
            bail!("Frozen take identity changed");
        }
        let grant = TakeGrant {
            name: name.into(),
            track,
            head: view.head.clone(),
            hash: view.hash.clone(),
        };
        Ok(Self {
            view,
            grant,
            video: None,
            audio: None,
        })
    }
    pub fn available(&self) -> Range {
        self.view.available
    }
    pub fn frame(&mut self, at: f64, generation: u64) -> Result<Option<Arc<Frame>>> {
        let at = timestamp(at)?;
        let Some(c) = self.view.locate("video", at) else {
            return Ok(None);
        };
        if self.video.as_ref().is_none_or(|(i, _)| *i != c.index) {
            let index = c.index;
            let path = self.view.verified_path(index)?;
            // Release the old decoder before allocating its replacement.
            self.video = None;
            self.video = Some((index, Movie::open(&path)?));
        }
        let span = self
            .view
            .locate("video", at)
            .unwrap()
            .spans
            .iter()
            .find(|s| s.media == "video")
            .unwrap();
        let movie = &mut self.video.as_mut().unwrap().1;
        // AVFoundation rebases independently playable fMP4s to its asset
        // timeline. Manifest PTS stays on the original recording clock.
        let local = movie.start + (at.as_f64() - span.start.as_f64());
        Ok(movie.frame(local, generation))
    }
    pub fn read(&mut self, at: f64, generation: u64, out: &mut [f32; 960]) -> Result<()> {
        out.fill(0.);
        if !self.view.track.audio {
            return Ok(());
        }
        // Split a 10ms block across a fragment boundary without shifting its
        // timeline timestamp. A genuine capture gap stays silent.
        let mut done = 0;
        for _ in 0..2 {
            let point = timestamp(at + done as f64 / 48000.)?;
            let Some(c) = self.view.locate("audio", point) else {
                break;
            };
            let span = c.spans.iter().find(|s| s.media == "audio").unwrap();
            let end = span.end()?.as_f64();
            let n = (((end - point.as_f64()) * 48000.).round() as usize).min(480 - done);
            if n == 0 {
                break;
            }
            if self.audio.as_ref().is_none_or(|(i, _)| *i != c.index) {
                let index = c.index;
                let path = self.view.verified_path(index)?;
                self.audio = None;
                self.audio = Some((
                    index,
                    MovieAudio::open(&path).context("Take audio reader unavailable")?,
                ));
            }
            let mut pcm = [0.; 960];
            let audio = &mut self.audio.as_mut().unwrap().1;
            let local = audio.start + (point.as_f64() - span.start.as_f64());
            audio.read(local, generation, &mut pcm);
            out[done * 2..(done + n) * 2].copy_from_slice(&pcm[..n * 2]);
            done += n;
            if done == 480 {
                break;
            }
        }
        Ok(())
    }
}
fn timestamp(at: f64) -> Result<Time> {
    if !at.is_finite() || !(0.0..=86400.).contains(&at) {
        bail!("Take playback time outside native profile");
    }
    Ok(Time::new((at * 48000.).round() as i64, 48000)?)
}
