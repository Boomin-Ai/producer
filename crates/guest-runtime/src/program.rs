//! Explicit program publication; no capture devices or implicit SDK queue.
use livekit::webrtc::{
    audio_source::native::NativeAudioSource, prelude::*, video_source::native::NativeVideoSource,
};
use livekit::{
    id::TrackSid,
    options::{TrackPublishOptions, VideoCodec},
    track::{LocalAudioTrack, LocalTrack, LocalVideoTrack, TrackSource},
    Room,
};
use std::{
    borrow::Cow,
    future::Future,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    task::{Context, Poll, Waker},
};

pub const WIDTH: u32 = VideoProfile::HOST_720P.width;
pub const HEIGHT: u32 = VideoProfile::HOST_720P.height;

#[path = "program_profile.rs"]
mod profile;
pub use profile::VideoProfile;

#[derive(Clone)]
pub struct Sources {
    audio: NativeAudioSource,
    video: NativeVideoSource,
    profile: VideoProfile,
    audio_enabled: bool,
    video_enabled: bool,
    enabled: Arc<(AtomicBool, AtomicBool)>,
}
impl Sources {
    pub(crate) async fn publish(room: &Room) -> Result<(Self, (TrackSid, TrackSid)), &'static str> {
        let (sources, tracks) =
            Self::publish_guest(room, VideoProfile::HOST_720P, true, true, true, true).await?;
        let mut tracks = tracks.into_iter();
        Ok((sources, (tracks.next().unwrap(), tracks.next().unwrap())))
    }

    /// The guest owner supplies its current, checked camera/microphone grants.
    /// Merely creating source objects never publishes an ungranted track.
    pub(crate) async fn publish_guest(
        room: &Room,
        profile: VideoProfile,
        audio_allowed: bool,
        video_allowed: bool,
        initial_audio_enabled: bool,
        initial_video_enabled: bool,
    ) -> Result<(Self, Vec<TrackSid>), &'static str> {
        let profile = profile.validate()?;
        if !audio_allowed && !video_allowed {
            return Err("Native appearance has no publication grant");
        }
        let audio = NativeAudioSource::new(
            AudioSourceOptions {
                echo_cancellation: false,
                noise_suppression: false,
                auto_gain_control: false,
            },
            48000,
            1,
            0,
        );
        // This raw-capable constructor does not synthesize epoch-clock frames.
        let video = NativeVideoSource::new_encoded(VideoResolution {
            width: profile.width,
            height: profile.height,
        });
        let mut tracks = Vec::with_capacity(2);
        if audio_allowed {
            let track = LocalAudioTrack::create_audio_track(
                "producer-stage-audio",
                RtcAudioSource::Native(audio.clone()),
            );
            if !initial_audio_enabled {
                track.mute();
            }
            let audio_publication = room
                .local_participant()
                .publish_track(
                    LocalTrack::Audio(track),
                    TrackPublishOptions {
                        source: TrackSource::Microphone,
                        stream: "producer-program".into(),
                        dtx: false,
                        red: false,
                        ..Default::default()
                    },
                )
                .await
                .map_err(|_| "Native program audio publication failed")?;
            tracks.push(audio_publication.sid());
        }
        if video_allowed {
            let track = LocalVideoTrack::create_video_track(
                "producer-program-video",
                RtcVideoSource::Native(video.clone()),
            );
            if !initial_video_enabled {
                track.mute();
            }
            let video_publication = room
                .local_participant()
                .publish_track(
                    LocalTrack::Video(track),
                    TrackPublishOptions {
                        source: TrackSource::Camera,
                        video_codec: VideoCodec::VP8,
                        stream: "producer-program".into(),
                        simulcast: false,
                        ..Default::default()
                    },
                )
                .await
                .map_err(|_| "Native program video publication failed")?;
            tracks.push(video_publication.sid());
        }
        Ok((
            Self {
                audio,
                video,
                profile,
                audio_enabled: audio_allowed,
                video_enabled: video_allowed,
                enabled: Arc::new((
                    AtomicBool::new(audio_allowed && initial_audio_enabled),
                    AtomicBool::new(video_allowed && initial_video_enabled),
                )),
            },
            tracks,
        ))
    }
    pub fn profile(&self) -> VideoProfile {
        self.profile
    }
    pub fn audio_enabled(&self) -> bool {
        self.enabled.0.load(Ordering::Acquire)
    }
    pub fn video_enabled(&self) -> bool {
        self.enabled.1.load(Ordering::Acquire)
    }
    /// Local mute is shared only by clones of this publication's source pair.
    /// An enabled flag can never grant a track omitted at publication time.
    pub fn set_enabled(&self, audio: bool, video: bool) {
        self.enabled
            .0
            .store(audio && self.audio_enabled, Ordering::Release);
        self.enabled
            .1
            .store(video && self.video_enabled, Ordering::Release);
    }
    pub fn audio(&self, samples: &[i16; 480]) -> Result<(), &'static str> {
        if !self.audio_enabled {
            return Ok(());
        }
        let silence = [0; 480];
        let samples = if self.audio_enabled() {
            samples
        } else {
            &silence
        };
        let frame = AudioFrame {
            data: Cow::Borrowed(samples),
            sample_rate: 48000,
            num_channels: 1,
            samples_per_channel: 480,
        };
        let mut capture = std::pin::pin!(self.audio.capture_frame(&frame));
        match capture
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
        {
            Poll::Ready(Ok(())) => Ok(()),
            Poll::Ready(Err(_)) => Err("Native program audio submission failed"),
            Poll::Pending => Err("Native program audio unexpectedly queued"),
        }
    }
    pub fn video(
        &self,
        planes: (&[u8], &[u8], &[u8]),
        timestamp_ns: u64,
    ) -> Result<bool, &'static str> {
        if !self.video_enabled {
            return Ok(false);
        }
        if timestamp_ns == 0 || timestamp_ns / 1000 > i64::MAX as u64 {
            return Err("Native program video format invalid");
        }
        let (width, height) = (self.profile.width, self.profile.height);
        let mut buffer = I420Buffer::new(width, height);
        profile::copy_i420(
            self.profile,
            self.video_enabled(),
            planes,
            buffer.data_mut(),
        )?;
        Ok(self.video.capture_frame(&VideoFrame {
            rotation: VideoRotation::VideoRotation0,
            timestamp_us: (timestamp_ns / 1000) as i64,
            frame_metadata: None,
            buffer,
        }))
    }
    pub fn clear(&self) {
        self.audio.clear_buffer();
    }
}
