// Isolated lab probe: observes existing AudioMixer pulls without altering PCM.
#pragma once
#include <array>
#include <atomic>
#include <memory>
#include <mutex>
#include <sstream>
#include <vector>
#include "api/audio/audio_frame.h"
#include "api/audio/audio_mixer.h"
#include "api/make_ref_counted.h"
#include "modules/audio_mixer/audio_mixer_impl.h"
#include "rtc_base/time_utils.h"

namespace livekit_ffi {
inline std::atomic<uint64_t> timed_sources_alive{0}, timed_sources_created{0}, timed_sources_destroyed{0};
struct TimedMixerRecord {
  uint64_t generation = 0, frames = 0, ntp_valid_frames = 0, packet_info_frames = 0;
  uint32_t ssrc = 0, rtp_timestamp = 0;
  int64_t ntp_ms = -1, elapsed_ms = -1, pull_us = 0;
  size_t samples = 0, channels = 0;
  int rate = 0, speech_type = 0;
  bool active = false;
};
struct TimedMixerState {
  std::mutex mutex;
  std::array<TimedMixerRecord, 64> records{};
  size_t used = 0;
  std::atomic<uint64_t> contention{0}, capacity_exceeded{0};
};
// Weak publication for polling: it never owns factory, mixer, source or runtime.
inline std::mutex timed_registry_mutex;
inline std::weak_ptr<TimedMixerState> timed_registry;
class TimedMixerSource final : public webrtc::AudioMixer::Source {
 public:
  TimedMixerSource(Source* source, std::shared_ptr<TimedMixerState> state)
      : source_(source), state_(std::move(state)) {
    timed_sources_alive.fetch_add(1);
    const auto generation = timed_sources_created.fetch_add(1) + 1;
    std::lock_guard<std::mutex> lock(state_->mutex);
    if (state_->used < state_->records.size()) {
      slot_ = state_->used++;
      auto& record = state_->records[slot_];
      record.generation = generation; record.ssrc = static_cast<uint32_t>(source_->Ssrc()); record.active = true;
    } else state_->capacity_exceeded.fetch_add(1);
  }
  ~TimedMixerSource() override {
    if (slot_ < state_->records.size()) {
      std::lock_guard<std::mutex> lock(state_->mutex); state_->records[slot_].active = false;
    }
    timed_sources_alive.fetch_sub(1); timed_sources_destroyed.fetch_add(1);
  }
  int Ssrc() const override { return source_->Ssrc(); }
  int PreferredSampleRate() const override { return source_->PreferredSampleRate(); }
  AudioFrameInfo GetAudioFrameWithInfo(int rate, webrtc::AudioFrame* frame) override {
    const auto result = source_->GetAudioFrameWithInfo(rate, frame);
    if (result != AudioFrameInfo::kError && slot_ < state_->records.size()) {
      std::unique_lock<std::mutex> lock(state_->mutex, std::try_to_lock);
      if (!lock.owns_lock()) state_->contention.fetch_add(1);
      else {
        auto& record = state_->records[slot_];
        record.frames++; record.ntp_valid_frames += frame->ntp_time_ms_ > 0;
        record.packet_info_frames += !frame->packet_infos_.empty();
        record.rtp_timestamp = frame->timestamp_; record.ntp_ms = frame->ntp_time_ms_;
        record.elapsed_ms = frame->elapsed_time_ms_; record.pull_us = webrtc::TimeMicros();
        record.samples = frame->samples_per_channel_; record.channels = frame->num_channels_;
        record.rate = frame->sample_rate_hz_; record.speech_type = static_cast<int>(frame->speech_type_);
      }
    }
    return result;
  }
  Source* original() const { return source_; }
 private:
  // Borrowed under the existing AudioMixer AddSource/RemoveSource contract.
  Source* source_;
  std::shared_ptr<TimedMixerState> state_;
  size_t slot_ = 64;
};
class TimedMixerProbe : public webrtc::AudioMixer {
 public:
  explicit TimedMixerProbe(std::shared_ptr<TimedMixerState> state)
      : state_(std::move(state)), delegate_(webrtc::AudioMixerImpl::Create()) {}
  ~TimedMixerProbe() override {
    // Unlink the delegate's borrowed pointers before destroying wrappers.
    for (const auto& source : sources_) delegate_->RemoveSource(source.get());
    sources_.clear(); delegate_ = nullptr;
  }
  bool AddSource(Source* source) override {
    if (!source) return false;
    std::lock_guard<std::mutex> lock(mutex_);
    for (const auto& old : sources_) if (old->original() == source) return false;
    auto wrapper = std::make_unique<TimedMixerSource>(source, state_);
    if (!delegate_->AddSource(wrapper.get())) return false;
    sources_.push_back(std::move(wrapper)); return true;
  }
  void RemoveSource(Source* source) override {
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto it = sources_.begin(); it != sources_.end(); ++it) {
      if ((*it)->original() == source) { delegate_->RemoveSource(it->get()); sources_.erase(it); return; }
    }
  }
  void Mix(size_t channels, webrtc::AudioFrame* frame) override {
    std::lock_guard<std::mutex> lock(mutex_); delegate_->Mix(channels, frame);
  }
 private:
  std::shared_ptr<TimedMixerState> state_;
  webrtc::scoped_refptr<webrtc::AudioMixer> delegate_;
  std::mutex mutex_;
  std::vector<std::unique_ptr<TimedMixerSource>> sources_;
};
inline webrtc::scoped_refptr<webrtc::AudioMixer> create_timed_mixer_probe() {
  auto state = std::make_shared<TimedMixerState>();
  { std::lock_guard<std::mutex> lock(timed_registry_mutex); timed_registry = state; }
  return webrtc::make_ref_counted<TimedMixerProbe>(std::move(state));
}
inline std::string timed_mixer_probe_report() {
  std::shared_ptr<TimedMixerState> state;
  { std::lock_guard<std::mutex> lock(timed_registry_mutex); state = timed_registry.lock(); }
  std::ostringstream out;
  out << "{\"sources_alive\":" << timed_sources_alive.load()
      << ",\"sources_created\":" << timed_sources_created.load()
      << ",\"sources_destroyed\":" << timed_sources_destroyed.load()
      << ",\"registry_expired\":" << (state ? "false" : "true")
      << ",\"observations_only\":true,\"sources\":[";
  if (state) {
    std::lock_guard<std::mutex> lock(state->mutex);
    for (size_t i = 0; i < state->used; ++i) {
      const auto& r = state->records[i]; if (i) out << ',';
      out << "{\"generation\":" << r.generation << ",\"ssrc\":" << r.ssrc
          << ",\"active\":" << (r.active ? "true" : "false") << ",\"frames\":" << r.frames
          << ",\"ntp_valid_frames\":" << r.ntp_valid_frames << ",\"packet_info_frames\":" << r.packet_info_frames
          << ",\"rtp_timestamp\":" << r.rtp_timestamp << ",\"ntp_ms\":" << r.ntp_ms
          << ",\"elapsed_ms\":" << r.elapsed_ms << ",\"pull_us\":" << r.pull_us
          << ",\"samples_per_channel\":" << r.samples << ",\"channels\":" << r.channels
          << ",\"sample_rate\":" << r.rate << ",\"speech_type\":" << r.speech_type << '}';
    }
    out << "],\"contention_dropped\":" << state->contention.load()
        << ",\"capacity_exceeded\":" << state->capacity_exceeded.load();
  } else out << ']';
  out << '}'; return out.str();
}
}  // namespace livekit_ffi
