# Injected via CMAKE_PROJECT_INCLUDE (runs right after project()).
# At OBS 32.1.2, enable_language(Swift) only exists inside mac-virtualcam's
# camera extension — which our allowlist disables — leaving the all-Swift
# libobs-metal target with no language ("CMake can not determine linker
# language"). Master fixed this in compilerconfig; we inject the same fix
# without patching upstream (obs.lock patchset stays null).
if(CMAKE_HOST_SYSTEM_NAME STREQUAL "Darwin")
  enable_language(Swift)
endif()
