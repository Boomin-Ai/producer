#pragma once
#include <cstdint>
#include <vector>
#include "api/rtp_parameters.h"
#include "api/rtp_packet_infos.h"

namespace livekit_ffi {
inline bool enable_capture_time_headers(std::vector<webrtc::RtpHeaderExtensionCapability>& headers) {
  bool found = false;
  for (auto& header : headers) {
    if (header.uri == "http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time") {
      header.direction = webrtc::RtpTransceiverDirection::kSendRecv;
      found = true;
    }
  }
  return found;
}
// Availability probe only. No scheduling, interpolation or substitution for
// missing packet metadata. This capture clock is distinct from local time.
inline int64_t first_packet_capture_ntp_us(const webrtc::RtpPacketInfos& packets) {
  for (const auto& packet : packets) {
    if (const auto& capture = packet.absolute_capture_time()) {
      const uint64_t ticks = capture->absolute_capture_timestamp;
      return static_cast<int64_t>((ticks >> 32) * 1000000 + ((ticks & 0xffffffff) * 1000000 >> 32));
    }
  }
  return 0;
}
// Convert capture-system time to the publishing sender's NTP domain. The
// extension defines Capture = Sender + Offset, so normalization subtracts it.
// RTP interpolation labels this exact decoded frame, not the packet's first
// sample. Reject remixed CSRC sources and ambiguous or distant RTP positions.
inline int64_t packet_capture_sender_ntp_us(const webrtc::RtpPacketInfos& packets,
                                           uint32_t frame_rtp, uint32_t rate,
                                           uint32_t ssrc) {
  if (rate == 0 || ssrc == 0) return 0;
  for (const auto& packet : packets) {
    const auto& capture = packet.absolute_capture_time();
    if (!capture || packet.ssrc() != ssrc || !packet.csrcs().empty()) continue;
    const int64_t delta = static_cast<int32_t>(frame_rtp - packet.rtp_timestamp());
    if (delta > static_cast<int64_t>(rate / 5) || delta < -static_cast<int64_t>(rate / 5)) continue;
    const auto ticks = capture->absolute_capture_timestamp;
    const int64_t raw = static_cast<int64_t>((ticks >> 32) * 1000000 + ((ticks & 0xffffffff) * 1000000 >> 32));
    const int64_t scale = int64_t{1} << 32;
    const int64_t offset = capture->estimated_capture_clock_offset.value_or(0);
    // Decomposition bounds every intermediate to fit int64, including INT64_MIN.
    const int64_t offset_us = (offset / scale) * 1000000 + (offset % scale) * 1000000 / scale;
    const int64_t sender = raw - offset_us + delta * 1000000 / rate;
    if (sender > 0) return sender;
  }
  return 0;
}
}
