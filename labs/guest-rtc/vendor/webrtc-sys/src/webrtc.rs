// Copyright 2025 LiveKit, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

use crate::impl_thread_safety;

#[cxx::bridge(namespace = "livekit_ffi")]
pub mod ffi {
    #[derive(Debug)]
    #[repr(i32)]
    pub enum MediaType {
        Audio,
        Video,
        Data,
        Unsupported,
    }

    #[derive(Debug)]
    #[repr(i32)]
    pub enum Priority {
        VeryLow,
        Low,
        Medium,
        High,
    }

    #[derive(Debug)]
    #[repr(i32)]
    pub enum RtpTransceiverDirection {
        SendRecv,
        SendOnly,
        RecvOnly,
        Inactive,
        Stopped,
    }

    #[derive(Debug)]
    #[repr(i32)]
    pub enum LoggingSeverity {
        Verbose,
        Info,
        Warning,
        Error,
        None,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    #[repr(i32)]
    pub enum VideoEncoderBackend {
        Auto,
        Software,
        Hardware,
        Nvenc,
        Vaapi,
        VideoToolbox,
        PreEncoded,
    }

    #[derive(Debug, Clone)]
    pub struct DecodedAudioBlock {
        pub samples: [i16; 960],
        pub generation: u64,
        pub sequence: u64,
        pub channels: u32,
        pub ssrc: u32,
        pub rtp_timestamp: u32,
        pub pull_us: i64,
        pub elapsed_ms: i64,
        pub capture_sender_ntp_us: i64,
        pub speech_type: i32,
        pub muted: bool,
    }

    pub struct IncomingClockReport {
        pub ssrc: u32,
        pub ntp_seconds: u32,
        pub ntp_fraction: u32,
        pub rtp_timestamp: u32,
        pub observed_us: i64,
    }

    unsafe extern "C++" {
        include!("livekit/webrtc.h");

        type LogSink;

        fn create_random_uuid() -> String;
        fn diagnostic_process_flag_enabled(name: &str) -> bool;
        fn diagnostic_timed_mixer_report() -> String;
        fn diagnostic_take_decoded_audio() -> Vec<DecodedAudioBlock>;
        fn diagnostic_rtcp_exchange_report() -> String;
        fn diagnostic_incoming_clock_reports() -> Vec<IncomingClockReport>;
        fn video_encoder_backend_list() -> Vec<VideoEncoderBackend>;
        fn new_log_sink(fnc: fn(String, LoggingSeverity)) -> UniquePtr<LogSink>;
    }
}

impl_thread_safety!(ffi::LogSink, Send + Sync);

#[cfg(all(test, target_os = "windows"))]
mod tests {
    #[test]
    fn cpp_observes_flags_changed_by_rust_after_startup() {
        let name = "PRODUCER_TEST_CPP_PROCESS_FLAG";
        std::env::remove_var(name);
        assert!(!super::ffi::diagnostic_process_flag_enabled(name));
        for _ in 0..8 {
            std::env::set_var(name, "1");
            assert!(super::ffi::diagnostic_process_flag_enabled(name));
            std::env::set_var(name, "10");
            assert!(!super::ffi::diagnostic_process_flag_enabled(name));
            std::env::remove_var(name);
            assert!(!super::ffi::diagnostic_process_flag_enabled(name));
        }
    }
}
