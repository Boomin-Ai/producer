#!/bin/bash
# One notarization/ticket policy for Intel, Silicon, app bundles and installers.
set -euo pipefail
umask 077
source "$(dirname "${BASH_SOURCE[0]}")/macos-ticket-retry.sh"
ARTIFACT="${1:?usage: notarize-macos-artifact.sh signed.app-or.dmg}"
ARTIFACT="$(cd "$(dirname "$ARTIFACT")" && pwd)/$(basename "$ARTIFACT")"
: "${NOTARY_ID:?Apple notarization account is required}"
: "${NOTARY_PW:?Apple notarization password is required}"
: "${NOTARY_TEAM:?Apple notarization team is required}"
PRIVATE="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/producer-notary.XXXXXX")"
trap 'rm -r -- "$PRIVATE"' EXIT
codesign --verify --strict "$ARTIFACT"
SUBMISSION="$ARTIFACT"
if [[ -d "$ARTIFACT" ]]; then
  SUBMISSION="$PRIVATE/submission.zip"
  ditto -c -k --keepParent "$ARTIFACT" "$SUBMISSION"
fi
xcrun notarytool submit "$SUBMISSION" --apple-id "$NOTARY_ID" --password "$NOTARY_PW" \
  --team-id "$NOTARY_TEAM" --wait --output-format json > "$PRIVATE/notary.json"
python3 - "$PRIVATE/notary.json" <<'PY'
import json,sys
result=json.load(open(sys.argv[1]))
print('Apple notarization:', result.get('status'), 'submission:', result.get('id'))
assert result.get('status')=='Accepted', 'Apple did not accept this artifact'
PY
if [[ -n ${PRODUCER_NOTARY_RECEIPT_DIR:-} ]]; then
  mkdir -p "$PRODUCER_NOTARY_RECEIPT_DIR"
  cp "$PRIVATE/notary.json" "$PRODUCER_NOTARY_RECEIPT_DIR/$(basename "$ARTIFACT")-notary.json"
fi
if staple_with_retry "$ARTIFACT" "$PRIVATE" && validate_ticket_with_retry "$ARTIFACT" "$PRIVATE"; then
  :
else
  status=$?
  if [[ -n ${PRODUCER_NOTARY_RECEIPT_DIR:-} ]]; then
    cp "$SUBMISSION" "$PRODUCER_NOTARY_RECEIPT_DIR/accepted-$(basename "$SUBMISSION")"
    echo 'Preserved unchanged accepted submission for ticket-delivery recovery.'
  fi
  exit "$status"
fi
codesign --verify --strict "$ARTIFACT"
if [[ -d "$ARTIFACT" ]]; then
  spctl -a -t exec -vv "$ARTIFACT"
else
  spctl -a -t open --context context:primary-signature -vv "$ARTIFACT"
fi
