#!/bin/bash
# Use only after notarization returned Accepted for these unchanged bytes.
# Retry known transient delivery failures; signature/policy failures fail closed.
apple_ticket_with_retry() {
  local action="$1" app="$2" private_logs="$3" attempt status log delay_seconds
  [[ $action == staple || $action == validate ]] || return 64
  [[ -d $private_logs && ! -L $private_logs ]] || return 64
  for attempt in 1 2 3; do
    log="$private_logs/stapler-$action-attempt-$attempt.log"
    if xcrun stapler "$action" "$app" > "$log" 2>&1; then
      echo "Apple ticket $action succeeded on attempt $attempt."
      return 0
    else
      status=$?
    fi
    if [[ $attempt == 3 ]]; then
      echo "Apple ticket $action failed after 3 bounded attempts (exit $status)." >&2
      return "$status"
    fi
    if { grep -Eiq 'NSURLErrorDomain|CloudKit|CFNetwork|network' "$log" && grep -Eq '(^|[^0-9])-100(5|1|9|3)([^0-9]|$)' "$log"; } \
      || grep -Eiq 'ticket.*(not yet available|not available yet|not yet ready|not found)|CloudKit.*record not found' "$log"; then
      delay_seconds=5
      [[ $attempt == 1 ]] || delay_seconds=15
      echo "Transient Apple ticket $action failure; retrying in ${delay_seconds}s."
      sleep "$delay_seconds"
    else
      echo "Apple ticket $action failed with non-retryable error (exit $status)." >&2
      return "$status"
    fi
  done
}
staple_with_retry() { apple_ticket_with_retry staple "$1" "$2"; }
validate_ticket_with_retry() { apple_ticket_with_retry validate "$1" "$2"; }
