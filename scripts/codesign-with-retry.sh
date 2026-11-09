#!/bin/bash
# Keep the same signing arguments and secure timestamp on every attempt.
# Only Apple's exact timestamp-service outage is retryable, never policy errors.
set -euo pipefail
umask 077
LOG="$(mktemp)"
trap 'rm -- "$LOG"' EXIT
TIMESTAMP=0
for arg in "$@"; do [[ $arg != --timestamp ]] || TIMESTAMP=1; done
for attempt in 1 2 3; do
  if codesign "$@" > "$LOG" 2>&1; then
    cat "$LOG"
    exit 0
  else
    status=$?
  fi
  if [[ $TIMESTAMP == 1 && $attempt != 3 ]] \
    && grep -Eq '^.+: The timestamp service is not available\.$' "$LOG" \
    && ! grep -Evq '^.+: (replacing existing signature|The timestamp service is not available\.)$' "$LOG"; then
    delay_seconds=5
    [[ $attempt == 1 ]] || delay_seconds=15
    echo "Apple timestamp service unavailable; retrying signing in ${delay_seconds}s." >&2
    sleep "$delay_seconds"
  else
    cat "$LOG" >&2
    exit "$status"
  fi
done
