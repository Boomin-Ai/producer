#!/bin/bash
# Pure command fixtures: no Apple/network/app/signing operation or real sleep.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/ci-network-mac-dev.sh" --stapler-functions-only
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT
CALLS=0
DELAYS=''
ERRORS=()
SUCCEED_AT=1
EXIT_STATUS=68
xcrun() {
  [[ $# == 3 && $1 == stapler && $2 == "$ACTION" && $3 == fixture.app ]] || { echo 'Unexpected Apple command' >&2; return 99; }
  CALLS=$((CALLS+1))
  if [[ $CALLS == "$SUCCEED_AT" ]]; then return 0; fi
  printf '%s\n' "${ERRORS[$((CALLS-1))]:-permanent failure} PRIVATE_FIXTURE_SECRET" >&2
  return "$EXIT_STATUS"
}
sleep() { DELAYS="${DELAYS}${DELAYS:+,}$1"; }
fixture() {
  local label="$1" expected_calls="$2" expected_delays="$3" expected_status="$4" result
  CALLS=0; DELAYS=''
  if "$CALLER" fixture.app "$TEST_DIR" > "$TEST_DIR/fixed-output" 2>&1; then result=0; else result=$?; fi
  [[ $CALLS == "$expected_calls" && $DELAYS == "$expected_delays" && $result == "$expected_status" ]] || {
    echo "FAIL $label: calls=$CALLS delays=$DELAYS status=$result" >&2; exit 1;
  }
  if grep -q PRIVATE_FIXTURE_SECRET "$TEST_DIR/fixed-output"; then echo 'Private Apple diagnostic leaked' >&2; exit 1; fi
  echo "PASS $label"
}
for ACTION in staple validate; do
CALLER=staple_with_retry
[[ $ACTION == staple ]] || CALLER=validate_ticket_with_retry
EXIT_STATUS=68
SUCCEED_AT=1; ERRORS=(); fixture immediate-success 1 '' 0
SUCCEED_AT=2; ERRORS=('Error Domain=NSURLErrorDomain Code=-1005 network connection was lost'); fixture transient-connection-loss 2 5 0
SUCCEED_AT=3; ERRORS=('NSURLErrorDomain Code=-1001' 'CFNetwork Code=-1009'); fixture timeout-then-offline 3 5,15 0
SUCCEED_AT=0; ERRORS=('CloudKit Code=-1003' 'CloudKit Code=-1003' 'CloudKit Code=-1003'); fixture exhausted-dns-failure 3 5,15 68
SUCCEED_AT=2; EXIT_STATUS=65; ERRORS=('The code object is not signed at all'); fixture signature-failure-no-retry 1 '' 65
SUCCEED_AT=2; EXIT_STATUS=68; ERRORS=('NSURLErrorDomain Code=-1004'); fixture unlisted-network-code-no-retry 1 '' 68
SUCCEED_AT=2; EXIT_STATUS=65; ERRORS=('Ticket not yet available'); fixture accepted-ticket-propagation 2 5 0
SUCCEED_AT=2; EXIT_STATUS=68; ERRORS=('Unclassified error 68'); fixture unclassified-exit68-no-retry 1 '' 68
SUCCEED_AT=2; ERRORS=('CloudKit Code=-10050'); fixture numeric-substring-no-retry 1 '' 68
done
echo 'PASS 18 ticket retry fixtures across staple/validate; bounded attempts/delays, no Apple/network/signing operations.'
