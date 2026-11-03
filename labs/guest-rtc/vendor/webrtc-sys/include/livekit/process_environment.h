#pragma once
#include <cstdlib>
#ifdef WEBRTC_WIN
#include "rtc_base/win32.h"
#endif

namespace livekit_ffi {
// Rust updates the process environment. MSVC getenv reads a separate CRT copy
// captured at startup, so it misses flags configured before the first factory.
inline bool process_flag_enabled(const char* name) {
#ifdef WEBRTC_WIN
  char value[2] = {};
  return GetEnvironmentVariableA(name, value, sizeof(value)) == 1 &&
         value[0] == '1';
#else
  const char* value = std::getenv(name);
  return value && value[0] == '1' && value[1] == '\0';
#endif
}
}  // namespace livekit_ffi
