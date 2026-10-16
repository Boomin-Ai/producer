// Explicit lab-only negotiation experiment; no production enablement.
#pragma once
#include <string>
namespace livekit_ffi {
inline std::string lab_add_audio_rrtr(const std::string& sdp) {
  std::string out;
  size_t start = 0;
  while (start < sdp.size()) {
    const auto next = sdp.find("\r\nm=", start);
    const auto end = next == std::string::npos ? sdp.size() : next + 2;
    auto section = sdp.substr(start, end - start);
    if (section.rfind("m=audio ", 0) == 0 && section.find("a=rtcp-fb:* rrtr\r\n") == std::string::npos) {
      section += "a=rtcp-fb:* rrtr\r\n";
    }
    out += section; start = end;
  }
  return out;
}
}
