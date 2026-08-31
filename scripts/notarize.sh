#!/bin/bash
# notarize.sh — submit a signed Producer.app to Apple, wait, staple, verify.
#
# Notarization is the gate that unlocks distribution outside the App Store
# AND is a hard requirement for the virtual camera: macOS refuses to install
# a system extension from an un-notarized app (UI-POWER.md R13).
#
#   scripts/notarize.sh --preflight <app>   # check readiness, submit nothing
#   scripts/notarize.sh <app>               # full submit → staple → verify
#
# Credentials are read from a keychain profile, never from this repo. Create
# it once (see --preflight output for the exact command).
set -euo pipefail

PROFILE="${NOTARY_PROFILE:-producer-notary}"
PREFLIGHT_ONLY=0
if [[ ${1:-} == "--preflight" ]]; then
  PREFLIGHT_ONLY=1
  shift
fi
APP="${1:?usage: notarize.sh [--preflight] /path/to/Producer.app}"
[[ -d $APP ]] || { echo "no such app: $APP" >&2; exit 1; }

fail=0
# Capture codesign's report ONCE. Piping it under `set -o pipefail` makes a
# successful grep look like a failure whenever codesign itself exits non-zero,
# which it does for some query forms — that silently inverted two checks.
INFO="$(codesign -dvvv "$APP" 2>&1 || true)"
ENTS="$(codesign -d --entitlements - "$APP" 2>/dev/null || true)"

say() { printf '%-42s %s\n' "$1" "$2"; }
bad() { say "$1" "✗ $2"; fail=1; }
ok() { say "$1" "✓ $2"; }

echo "── preflight ─────────────────────────────────────────────"

# 1. Developer ID, not ad-hoc. Apple rejects anything else outright.
auth="$(printf '%s\n' "$INFO" | grep '^Authority=' | head -1 | cut -d= -f2- || true)"
if [[ $auth == Developer\ ID\ Application:* ]]; then
  ok "signing identity" "$auth"
else
  bad "signing identity" "need a Developer ID Application cert, got: ${auth:-none}"
fi

# 2. Hardened runtime — required since macOS 10.14.
if printf '%s\n' "$INFO" | grep -q 'flags=.*runtime'; then
  ok "hardened runtime" "enabled"
else
  bad "hardened runtime" "missing — sign with --options runtime"
fi

# 3. Secure timestamp. Our dev builds set CODESIGN_TIMESTAMP=none to skip the
#    network round-trip; that shortcut is fatal here, and the failure is
#    confusing (Apple reports it per-binary), so catch it up front.
if printf '%s\n' "$INFO" | grep -qi '^Timestamp='; then
  ok "secure timestamp" "present"
else
  bad "secure timestamp" "absent — re-assemble WITHOUT CODESIGN_TIMESTAMP=none"
fi

# 4. get-task-allow is a debug entitlement; its presence fails notarization.
if printf '%s\n' "$ENTS" | grep -q 'get-task-allow'; then
  bad "debug entitlement" "get-task-allow present — strip it from release builds"
else
  ok "debug entitlement" "absent"
fi

# 5. Every nested Mach-O must be signed and intact.
if codesign --verify --deep --strict "$APP" >/dev/null 2>&1; then
  ok "nested signatures" "deep --strict verify passes"
else
  bad "nested signatures" "deep --strict verify FAILS — run it directly to see which"
fi

# 6. Credentials, checked without ever printing them.
if xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1; then
  ok "notary credentials" "keychain profile '$PROFILE'"
else
  bad "notary credentials" "no usable keychain profile '$PROFILE'"
  cat <<EOF

  Create it once — this needs YOUR Apple ID and an app-specific password
  (appleid.apple.com → Sign-In and Security → App-Specific Passwords).
  Nothing is written into this repo; it lands in your login keychain:

    xcrun notarytool store-credentials "$PROFILE" \\
      --apple-id "<your-apple-id-email>" \\
      --team-id "9936A69867" \\
      --password "<app-specific-password>"

EOF
fi

echo "──────────────────────────────────────────────────────────"
if ((fail)); then
  echo "NOT READY — fix the ✗ items above." >&2
  exit 1
fi
echo "READY to notarize."
((PREFLIGHT_ONLY)) && exit 0

echo "── submitting ────────────────────────────────────────────"
ZIP="$(mktemp -d)/$(basename "${APP%.app}").zip"
# ditto preserves the bundle's symlinks and extended attributes; `zip` does not
# and Apple will reject the result.
ditto -c -k --keepParent "$APP" "$ZIP"
# `--wait` crashes notarytool 1.0(38) with Bus error 10 on this machine after
# the upload succeeds — the submission is fine, the waiter is not. Submit,
# capture the id, then poll with `info`, which is stable.
SUB_ID="$(xcrun notarytool submit "$ZIP" --keychain-profile "$PROFILE" 2>&1 \
  | awk '/^  id: /{print $2; exit}')"
[[ -n ${SUB_ID:-} ]] || { echo "submission failed — no id returned" >&2; exit 1; }
echo "submission: $SUB_ID"
for _ in $(seq 1 60); do
  sleep 15
  st="$(xcrun notarytool info "$SUB_ID" --keychain-profile "$PROFILE" 2>/dev/null \
    | awk '/^  status: /{ $1=""; sub(/^ *status: */,""); print; exit }')"
  echo "  status: ${st:-unknown}"
  [[ $st == "Accepted" ]] && break
  if [[ $st == "Invalid" || $st == "Rejected" ]]; then
    xcrun notarytool log "$SUB_ID" --keychain-profile "$PROFILE" 2>&1 | head -40
    exit 1
  fi
done
[[ $st == "Accepted" ]] || { echo "notarization did not complete in time" >&2; exit 1; }

echo "── stapling ──────────────────────────────────────────────"
# Staple so the app validates offline; without this a first launch on a
# machine with no network still shows the unidentified-developer warning.
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
spctl --assess --type execute --verbose=4 "$APP" 2>&1 | tail -3
echo "notarized + stapled: $APP"
