#!/usr/bin/env bash
set -euo pipefail
DMG="${1:?Specify the signed Intel installer DMG}"
: "${NOTARY_ID:?Apple notarization account is required}"
: "${NOTARY_PW:?Apple notarization password is required}"
: "${NOTARY_TEAM:?Apple notarization team is required}"
codesign --verify --strict --verbose=2 "$DMG"
NOTARY_RESULT="$(mktemp -t producer-intel-notary)"
trap 'unlink "$NOTARY_RESULT"' EXIT
xcrun notarytool submit "$DMG" \
  --apple-id "$NOTARY_ID" --password "$NOTARY_PW" --team-id "$NOTARY_TEAM" \
  --wait --output-format json > "$NOTARY_RESULT"
python3 - "$NOTARY_RESULT" <<'PY'
import json,sys
result=json.load(open(sys.argv[1]))
print('Intel installer notarization:', result.get('status'), 'submission:', result.get('id'))
assert result.get('status') == 'Accepted', result.get('status')
PY
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"
codesign --verify --strict --verbose=2 "$DMG"
spctl -a -t open --context context:primary-signature -vv "$DMG"
