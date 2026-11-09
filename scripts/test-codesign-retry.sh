#!/bin/bash
# Pure command fixtures: no real signing, Apple requests, or waits.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE="$(mktemp -d)"
export FIXTURE
trap 'rm -r -- "$FIXTURE"' EXIT
codesign() {
  local count
  count=$(cat "$FIXTURE/count")
  count=$((count+1))
  echo "$count" > "$FIXTURE/count"
  printf '%s\0' "$@" > "$FIXTURE/args-$count"
  [[ $count != "$SUCCEED_AT" ]] || return 0
  echo 'fixture with spaces.app: replacing existing signature' >&2
  case "$DIAGNOSTIC" in
    outage) echo 'fixture with spaces.app: The timestamp service is not available.' >&2 ;;
    policy) echo 'fixture with spaces.app: code object is not signed at all' >&2 ;;
    mixed) printf '%s\n' 'fixture with spaces.app: The timestamp service is not available.' 'fixture with spaces.app: invalid certificate chain' >&2 ;;
    *) echo 'fixture with spaces.app: unclassified failure' >&2 ;;
  esac
  return 42
}
sleep() { echo "$1" >> "$FIXTURE/delays"; }
export -f codesign sleep
fixture() {
  local label="$1" expected_calls="$2" expected_delays="$3" expected_status="$4" status count i
  shift 4
  echo 0 > "$FIXTURE/count"
  : > "$FIXTURE/delays"
  printf '%s\0' "$@" > "$FIXTURE/expected-args"
  if bash "$ROOT/scripts/codesign-with-retry.sh" "$@" > "$FIXTURE/output" 2>&1; then status=0; else status=$?; fi
  count=$(cat "$FIXTURE/count")
  [[ $count == "$expected_calls" && $status == "$expected_status" && $(paste -sd, "$FIXTURE/delays") == "$expected_delays" ]] || {
    echo "FAIL $label: calls=$count status=$status" >&2; exit 1;
  }
  for ((i=1;i<=count;i++)); do cmp "$FIXTURE/expected-args" "$FIXTURE/args-$i"; done
  echo "PASS $label"
}
export SUCCEED_AT DIAGNOSTIC
args=(--force --timestamp --options runtime --entitlements 'fixture entitlements.plist' --sign 'fixture identity' 'fixture with spaces.app')
SUCCEED_AT=1 DIAGNOSTIC=outage; fixture immediate 1 '' 0 "${args[@]}"
SUCCEED_AT=2; fixture recovered 2 5 0 "${args[@]}"
SUCCEED_AT=3; fixture second-retry 3 5,15 0 "${args[@]}"
SUCCEED_AT=0; fixture exhausted 3 5,15 42 "${args[@]}"
SUCCEED_AT=2 DIAGNOSTIC=policy; fixture policy-no-retry 1 '' 42 "${args[@]}"
DIAGNOSTIC=mixed; fixture mixed-policy-no-retry 1 '' 42 "${args[@]}"
DIAGNOSTIC=unknown; fixture unclassified-no-retry 1 '' 42 "${args[@]}"
DIAGNOSTIC=outage; fixture no-timestamp-no-retry 1 '' 42 --force --sign - fixture.app
fixture disabled-timestamp-no-retry 1 '' 42 --force --timestamp=none --sign - fixture.app
echo 'PASS 9 signing retry fixtures; exact arguments, bounded delays, policy failures closed.'
