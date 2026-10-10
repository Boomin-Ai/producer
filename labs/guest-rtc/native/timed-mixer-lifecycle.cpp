// Observable lifetime and delegation checks for the optional mixer probe.
#include <cassert>
#include <iostream>
#include <thread>
#include <filesystem>
#include <mach/mach.h>
#include "livekit/timed_mixer_probe.h"
#include "livekit/lab_rrtr_sdp.h"
#include "livekit/rtcp_exchange_probe.h"
#include "api/environment/environment_factory.h"
using namespace livekit_ffi;
class FakeSource final : public webrtc::AudioMixer::Source {
 public:
  bool fail = false;
  uint32_t timestamp = 48000;
  int16_t marker = 123;
  size_t channels = 1;
  int Ssrc() const override { return 123; }
  int PreferredSampleRate() const override { return 48000; }
  AudioFrameInfo GetAudioFrameWithInfo(int rate, webrtc::AudioFrame* frame) override {
    if (fail) return AudioFrameInfo::kError;
    std::array<int16_t,960> pcm{}; pcm.fill(marker);
    frame->UpdateFrame(timestamp, pcm.data(), 480, rate, webrtc::AudioFrame::kNormalSpeech,
                      webrtc::AudioFrame::kVadUnknown, channels);
    frame->ntp_time_ms_ = 123456; frame->elapsed_time_ms_ = 1000;
    return AudioFrameInfo::kNormal;
  }
};
size_t thread_count() {
  thread_act_array_t threads=nullptr; mach_msg_type_number_t count=0;
  assert(task_threads(mach_task_self(),&threads,&count)==KERN_SUCCESS);
  for(mach_msg_type_number_t i=0;i<count;++i) mach_port_deallocate(mach_task_self(),threads[i]);
  vm_deallocate(mach_task_self(),reinterpret_cast<vm_address_t>(threads),count*sizeof(thread_t));
  return count;
}
size_t fd_count() {
  size_t count=0; for(const auto& entry:std::filesystem::directory_iterator("/dev/fd")) { (void)entry; ++count; }
  return count;
}
int main() {
  const auto initial_threads=thread_count(), initial_fds=fd_count();
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
    auto blocks = take_timed_pcm_blocks(state->records[0].pull_us);
    assert(blocks.size() == 1 && blocks[0].pcm[0] == 123 && blocks[0].pcm[479] == 123);
    assert(blocks[0].rtp_timestamp == 48000 && blocks[0].sequence == 1 && blocks[0].ssrc == 123);
    source.timestamp = 48480; source.marker = 456; mixer->Mix(1,&output);
    blocks = take_timed_pcm_blocks(state->records[0].pull_us);
    assert(blocks.size() == 1 && blocks[0].pcm[0] == 456 && blocks[0].rtp_timestamp == 48480 && blocks[0].sequence == 2);
    source.fail = true; mixer->Mix(1,&output);
    assert(state->records[0].frames == 2); // Failed PCM never counted as valid timing.
    assert(take_timed_pcm_blocks(webrtc::TimeMicros()).empty());
    source.fail = false;
    for (int i=0;i<4;++i) { source.timestamp += 480; mixer->Mix(1,&output); }
    blocks = take_timed_pcm_blocks(state->records[0].pull_us);
    assert(blocks.size() == 3 && blocks[0].sequence == 4 && blocks[2].sequence == 6);
    assert(state->records[0].pcm_overflow == 1);
    mixer->Mix(1,&output);
    assert(take_timed_pcm_blocks(state->records[0].pull_us + 30001).empty());
    assert(state->records[0].pcm_stale == 1);
    { std::lock_guard<std::mutex> lock(state->mutex); mixer->Mix(1,&output); }
    assert(state->contention.load() == 1); // Pull must not wait for polling.
    source.channels = 2; mixer->Mix(2,&output); source.channels = 1;
    assert(state->records[0].pcm_format_rejected == 0);
    blocks = take_timed_pcm_blocks(state->records[0].pull_us);
    assert(blocks.size() == 1 && blocks[0].channels == 2 && blocks[0].pcm[959] == 456 && blocks[0].sequence == 9);
    // Exercise removal serialized against an in-flight audio pull.
    std::thread pull([&] { for (int i = 0; i < 20; ++i) mixer->Mix(1,&output); });
    mixer->RemoveSource(&source); pull.join();
    assert(timed_sources_alive.load() == 0 && !state->records[0].active);
    assert(take_timed_pcm_blocks(webrtc::TimeMicros()).empty());
    const auto& record = state->records[0];
    assert(record.frames == record.pcm_consumed + record.pcm_overflow + record.pcm_stale + record.pcm_retired + record.pcm_format_rejected);

    assert(mixer->AddSource(&source));
    // Cancel/partial lifecycle: destruction without explicit RemoveSource must unlink.
    std::weak_ptr<TimedMixerState> weak = state;
    state.reset(); mixer = nullptr;
    assert(weak.expired() && timed_registry.expired());
    assert(timed_sources_alive.load() == 0);
  }
  assert(timed_sources_created.load() - before == 200);
  {
    FakeSource source; auto state=std::make_shared<TimedMixerState>();
    { TimedMixerSource wrapper(&source,state); webrtc::AudioFrame frame;
      wrapper.GetAudioFrameWithInfo(32000,&frame);
      assert(state->records[0].pcm_format_rejected == 1 && state->records[0].pcm_size == 0);
    }
    assert(!state->records[0].active);
  }
  assert(timed_sources_created.load() == timed_sources_destroyed.load());
  const auto env=webrtc::CreateEnvironment();
  for(int cycle=0;cycle<100;++cycle) {
    std::weak_ptr<RtcpProbeState> weak;
    {
      RtcpExchangeFactory factory;
      auto outgoing=factory.Create(env), incoming=factory.Create(env);
      weak=rtcp_registry;
      const std::array<uint8_t,20> rrtr={0x80,207,0,4,0,0,0,1,4,0,0,2,0,0,0,1,0,0,0,0};
      const std::array<uint8_t,24> dlrr={0x80,207,0,5,0,0,0,2,5,0,0,3,0,0,0,1,0,1,0,0,0,0,0,0};
      outgoing->Log(std::make_unique<webrtc::RtcEventRtcpPacketOutgoing>(rrtr));
      incoming->Log(std::make_unique<webrtc::RtcEventRtcpPacketIncoming>(dlrr));
      const std::array<uint8_t,28> sr={0x80,200,0,6,0,0,0,2,0,0,0,1,0,0,0,0,0,0,187,128,0,0,0,0,0,0,0,0};
      incoming->Log(std::make_unique<webrtc::RtcEventRtcpPacketIncoming>(sr));
      auto state=weak.lock();
      assert(state->peers[1].sr_size==1 && state->peers[1].sr[0].rtp_timestamp==48000 && state->peers[1].sr[0].ntp_seconds==1);
      assert(state && state->peers[0].outgoing_rrtr==1 && state->peers[1].incoming_dlrr==1);
      assert(state->peers[0].xr[0].last_rr==65536 && state->peers[1].xr[0].target==1);
      const std::array<uint8_t,4> bad={0x80,207,0,15};
      incoming->Log(std::make_unique<webrtc::RtcEventRtcpPacketIncoming>(bad));
      assert(state->peers[1].malformed==1);
      // Overfull observations remain bounded, and preserve the latest clock fields.
      for(int n=0;n<70;++n) outgoing->Log(std::make_unique<webrtc::RtcEventRtcpPacketOutgoing>(rrtr));
      assert(state->peers[0].size==64 && state->peers[0].overwritten==7);
      assert(!outgoing->StartLogging(nullptr,0)); // Existing Null logger failure stays a failure.
      bool stopped=false; incoming->StopLogging([&] { stopped=true; }); assert(stopped);
      outgoing.reset(); incoming.reset();
      assert(rtcp_logs_alive.load()==0 && !state->peers[0].active && !state->peers[1].active);
    }
    assert(weak.expired() && rtcp_registry.expired());
  }
  assert(rtcp_logs_created.load()==200 && rtcp_logs_destroyed.load()==200);
  const auto final_threads=thread_count(), final_fds=fd_count();
  assert(final_threads<=initial_threads+2 && final_fds<=initial_fds);
  std::cout << "{\"initial_threads\":" << initial_threads << ",\"final_threads\":" << final_threads
            << ",\"initial_fds\":" << initial_fds << ",\"final_fds\":" << final_fds << ",\"mixer\":" << timed_mixer_probe_report()
            << ",\"rtcp\":" << rtcp_exchange_report() << "}" << std::endl;
}
