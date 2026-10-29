#!/usr/bin/env bash
# Upload a built APK as the newest Meira beta, so the site's "Download for
# Android" button (…/releases/latest/download/Meira.apk) serves it.
#
# Trigger: by hand, after a build you want testers to get —
#   npm run android:local && npm run apk:publish
#   npm run apk:publish -- path/to/other.apk       (a different file)
#   BUILT_FROM=9a1e74b npm run apk:publish          (when HEAD is not the build's commit)
set -euo pipefail

REPO="MeiraSecretary/meirasecretary.github.io"
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
APK="${1:-lumi-local.apk}"
FROM="${BUILT_FROM:-$(git rev-parse --short HEAD)}"

[ -f "$APK" ] || { echo "✗ $APK not found. Build first: npm run android:local" >&2; exit 1; }

# Refuse an old build: everything before 2026-10-06 is labelled "Lumi".
AAPT="$(ls /opt/homebrew/share/android-commandlinetools/build-tools/*/aapt 2>/dev/null | tail -1 || true)"
if [ -n "$AAPT" ]; then
  LABEL="$("$AAPT" dump badging "$APK" | sed -n "s/^application-label:'\(.*\)'/\1/p")"
  [ "$LABEL" = "Meira" ] || { echo "✗ $APK is labelled '$LABEL', not 'Meira'. Is it an old build?" >&2; exit 1; }
fi

TAG="beta-$(date +%Y%m%d-%H%M)"
SIZE_MB=$(( $(stat -f%z "$APK") / 1048576 ))
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cp "$APK" "$TMP/Meira.apk"

gh release create "$TAG" "$TMP/Meira.apk" --repo "$REPO" --latest \
  --title "Meira beta · $(date +%d.%m.%Y)" \
  --notes "Android beta, ${SIZE_MB} MB, built from ${FROM}.

Install: download Meira.apk on the phone and open it. If Android asks, allow installs from this source."

echo "✓ released $TAG"
echo "  download: https://github.com/$REPO/releases/latest/download/Meira.apk"
