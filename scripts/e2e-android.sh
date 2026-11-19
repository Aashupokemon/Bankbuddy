#!/usr/bin/env bash
#
# Runs the Maestro flows in .maestro/ against the APK installed on a connected device or emulator.
#
#   npm run mobile:e2e
#
# Prerequisites, all external to this repository:
#   * Maestro CLI — https://maestro.mobile.dev (curl -Ls "https://get.maestro.mobile.dev" | bash)
#   * a booted emulator or a USB device visible to `adb devices`
#   * the APK installed: adb install -r artifacts/bankbuddy-<version>-release.apk
#
# The demo flows expect the API to be unreachable, which is what a phone without a route to the
# development machine looks like. Stop `npm run api` first, or build with EXPO_PUBLIC_DEMO_MODE=1.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_ID="com.bankbuddy.app"

die() {
  printf '\nerror: %s\n' "$*" >&2
  exit 1
}

command -v maestro >/dev/null 2>&1 || die "Maestro is not installed. Run: curl -Ls \"https://get.maestro.mobile.dev\" | bash"

command -v adb >/dev/null 2>&1 || die "adb is not on PATH. Add the Android SDK platform-tools directory."

device_state="$(adb get-state 2>/dev/null || true)"
[ "$device_state" = "device" ] || die "No device is ready. Boot an emulator or connect a phone, then check \`adb devices\`."

if ! adb shell pm list packages 2>/dev/null | tr -d '\r' | grep -qx "package:$PACKAGE_ID"; then
  die "$PACKAGE_ID is not installed. Run: adb install -r artifacts/bankbuddy-0.1.0-release.apk"
fi

if curl -fsS --max-time 1 http://127.0.0.1:8787/health >/dev/null 2>&1; then
  printf '\nnote: the API is running on this machine. The demo flow only passes offline — unable to reach\n'
  printf 'the API on the phone is what switches the app to bundled data. Stop `npm run api` (or build the\n'
  printf 'APK with EXPO_PUBLIC_DEMO_MODE=1) before running the demo flows.\n\n'
fi

exec maestro test "$REPO_ROOT/.maestro" "$@"
