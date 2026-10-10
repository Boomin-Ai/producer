// Observable lifetime and delegation checks for the optional mixer probe.
#include <cassert>
#include <iostream>
#include <thread>
#include "livekit/timed_mixer_probe.h"
#include "livekit/lab_rrtr_sdp.h"
using namespace livekit_ffi;
class FakeSource final : public webrtc::AudioMixer::Source {
 public:
  bool fail = false;
  int Ssrc() const override { return 123; }
  int PreferredSampleRate() const override { return 48000; }
  AudioFrameInfo GetAudioFrameWithInfo(int rate, webrtc::AudioFrame* frame) override {
    if (fail) return AudioFrameInfo::kError;
    std::array<int16_t,480> pcm{};
    frame->UpdateFrame(48000, pcm.data(), 480, rate, webrtc::AudioFrame::kNormalSpeech,
                      webrtc::AudioFrame::kVadUnknown, 1);
    frame->ntp_time_ms_ = 123456; frame->elapsed_time_ms_ = 1000;
    return AudioFrameInfo::kNormal;
  }
};
int main() {
  const std::string sdp = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000\r\n";
  const auto rrtr = lab_add_audio_rrtr(sdp);
  assert(lab_add_audio_rrtr(rrtr) == rrtr);
  assert(rrtr.find("a=rtcp-fb:* rrtr\r\nm=video") != std::string::npos);
  assert(rrtr.substr(rrtr.find("m=video")) == sdp.substr(sdp.find("m=video")));
  const auto before = timed_sources_created.load();
  for (int cycle = 0; cycle < 100; ++cycle) {
    FakeSource source;
    auto mixer = create_timed_mixer_probe();
    assert(!mixer->AddSource(nullptr));
    assert(mixer->AddSource(&source)); assert(!mixer->AddSource(&source));
    webrtc::AudioFrame output;
    mixer->Mix(1,&output);
    std::shared_ptr<TimedMixerState> state = timed_registry.lock();
    assert(state && state->records[0].frames == 1);
    assert(state->records[0].rtp_timestamp == 48000 && state->records[0].ntp_ms == 123456);
    assert(state->records[0].samples == 480 && output.samples_per_channel_ == 480);
    source.fail = true; mixer->Mix(1,&output);
    assert(state->records[0].frames == 1); // Failed PCM never counted as valid timing.
    source.fail = false;
    // Exercise removal serialized against an in-flight audio pull.
    std::thread pull([&] { for (int i = 0; i < 20; ++i) mixer->Mix(1,&output); });
    mixer->RemoveSource(&source); pull.join();
    assert(timed_sources_alive.load() == 0 && !state->records[0].active);
    assert(mixer->AddSource(&source));
    // Cancel/partial lifecycle: destruction without explicit RemoveSource must unlink.
    std::weak_ptr<TimedMixerState> weak = state;
    state.reset(); mixer = nullptr;
    assert(weak.expired() && timed_registry.expired());
    assert(timed_sources_alive.load() == 0);
  }
  assert(timed_sources_created.load() - before == 200);
  assert(timed_sources_created.load() == timed_sources_destroyed.load());
  std::cout << timed_mixer_probe_report() << std::endl;
}
