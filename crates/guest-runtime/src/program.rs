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
    task::{Context, Poll, Waker},
};

pub const WIDTH: u32 = 1280;
pub const HEIGHT: u32 = 720;

#[derive(Clone)]
pub struct Sources {
    audio: NativeAudioSource,
    video: NativeVideoSource,
}
impl Sources {
    pub(crate) async fn publish(room: &Room) -> Result<(Self, (TrackSid, TrackSid)), &'static str> {
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
            width: WIDTH,
            height: HEIGHT,
        });
        let audio_publication = room
            .local_participant()
            .publish_track(
                LocalTrack::Audio(LocalAudioTrack::create_audio_track(
                    "producer-stage-audio",
                    RtcAudioSource::Native(audio.clone()),
                )),
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
        let video_publication = room
            .local_participant()
            .publish_track(
                LocalTrack::Video(LocalVideoTrack::create_video_track(
                    "producer-program-video",
                    RtcVideoSource::Native(video.clone()),
                )),
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
        Ok((
            Self { audio, video },
            (audio_publication.sid(), video_publication.sid()),
        ))
    }
    pub fn audio(&self, samples: &[i16; 480]) -> Result<(), &'static str> {
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
        if planes.0.len() != (WIDTH * HEIGHT) as usize
            || planes.1.len() != (WIDTH * HEIGHT / 4) as usize
            || planes.2.len() != planes.1.len()
            || timestamp_ns == 0
            || timestamp_ns / 1000 > i64::MAX as u64
        {
            return Err("Native program video format invalid");
        }
        let mut buffer = I420Buffer::new(WIDTH, HEIGHT);
        let (y, u, v) = buffer.data_mut();
        y.copy_from_slice(planes.0);
        u.copy_from_slice(planes.1);
        v.copy_from_slice(planes.2);
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
