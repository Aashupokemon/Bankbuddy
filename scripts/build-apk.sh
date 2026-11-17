#!/usr/bin/env bash
#
# Builds the release Android APK in one command.
#
# Every step here exists because the default Expo + Gradle build fails in this repository:
#   * `expo prebuild` generates apps/mobile/android (it is gitignored, so it may not exist yet).
#   * Gradle's bundle task needs EXPO_NO_METRO_WORKSPACE_ROOT=1. Otherwise Expo treats this repo as a
#     Metro workspace and roots the bundler at the repository root, where the `index.ts` handed over by
#     Gradle does not exist.
#   * expo-modules-core picks its Compose compiler from `android.kotlinVersion`. Expo's template declares
#     1.9.25, the React Native Gradle plugin ships Kotlin 1.9.24, and that mismatch aborts the Kotlin
#     compile with "Compose Compiler 1.5.15 requires Kotlin version 1.9.25".
#   * Windows caps object file paths at 250 characters. From a long checkout the CMake build of
#     expo-modules-core never settles ("ninja: error: manifest 'build.ninja' still dirty after 100
#     tries"), so a long Windows checkout is built from a short staging copy and the APK is copied back.
#
# Usage:
#   npm run mobile:apk              # release APK into artifacts/
#   npm run mobile:apk -- clean     # extra arguments are passed through to Gradle
#
# Requires JDK 17 (Gradle 8.10.2 does not run on newer JDKs) and the Android SDK with platform 35.
# Both are auto-detected from JAVA_HOME / ANDROID_HOME, a local .tools/jdk17, and the usual SDK paths.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MOBILE_DIR="$REPO_ROOT/apps/mobile"
ARTIFACTS_DIR="$REPO_ROOT/artifacts"

# Object paths above roughly this length overflow the Windows 250 character limit once
# node_modules/expo-modules-core/android/.cxx/... and the flattened source names are appended.
MAX_IN_PLACE_PATH=60

log() { printf '\n== %s\n' "$*"; }
die() {
  printf '\nerror: %s\n' "$*" >&2
  exit 1
}

is_windows() {
  case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN*) return 0 ;;
    *) return 1 ;;
  esac
}

# Windows tools accept forward slashes, and `C:\...` inside double quotes mangles backslashes.
to_unix_path() {
  local p="$1"
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$p"
  else
    printf '%s' "${p//\\//}"
  fi
}

find_java_home() {
  local candidate
  if [ -n "${JAVA_HOME:-}" ] && { [ -x "$JAVA_HOME/bin/java" ] || [ -x "$JAVA_HOME/bin/java.exe" ]; }; then
    printf '%s' "$JAVA_HOME"
    return 0
  fi
  for candidate in "$REPO_ROOT"/.tools/jdk17/*/; do
    candidate="${candidate%/}"
    if [ -x "$candidate/bin/java" ] || [ -x "$candidate/bin/java.exe" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

find_android_home() {
  local candidate
  if [ -n "${ANDROID_HOME:-}" ]; then
    printf '%s' "$(to_unix_path "$ANDROID_HOME")"
    return 0
  fi
  if [ -n "${ANDROID_SDK_ROOT:-}" ]; then
    printf '%s' "$(to_unix_path "$ANDROID_SDK_ROOT")"
    return 0
  fi
  for candidate in \
    "${LOCALAPPDATA:-${USERPROFILE:-$HOME}/AppData/Local}/Android/Sdk" \
    "$HOME/Library/Android/sdk" \
    "$HOME/Android/Sdk"; do
    if [ -d "$candidate" ]; then
      printf '%s' "$(to_unix_path "$candidate")"
      return 0
    fi
  done
  return 1
}

# Copies the working tree (sources only) into a build directory, so an npm install in the
# staging copy never disturbs the checkout.
sync_source() {
  local dest="$1"
  mkdir -p "$dest"
  tar -cf - -C "$REPO_ROOT" \
    --exclude=./node_modules \
    --exclude=./.git \
    --exclude=./.tools \
    --exclude=./.freebuff \
    --exclude=./dist-mobile \
    --exclude=./artifacts \
    --exclude=./apps/mobile/android \
    --exclude=./apps/mobile/ios \
    --exclude=./apps/mobile/.expo \
    . 2>/dev/null | tar -xf - -C "$dest"
}

sync_dependencies() {
  local dest="$1"
  local lock_hash current_hash=""
  current_hash="$(sha256sum "$dest/package-lock.json" | cut -d' ' -f1)"
  if [ -f "$dest/.npm-lock.sha" ]; then
    lock_hash="$(cat "$dest/.npm-lock.sha")"
  fi
  if [ -d "$dest/node_modules" ] && [ "$lock_hash" = "$current_hash" ]; then
    log "Reusing installed dependencies in $dest"
    return 0
  fi
  log "Installing dependencies in $dest"
  (cd "$dest" && npm install --no-audit --no-fund)
  printf '%s' "$current_hash" >"$dest/.npm-lock.sha"
}

# expo prebuild rewrites package.json (it adds convenience scripts). The build does not need those and
# must not leave the checkout modified, so the original file is put back afterwards.
prebuild_android() {
  local project_dir="$1"
  local backup
  backup="$(mktemp)"
  cp "$project_dir/apps/mobile/package.json" "$backup"
  log "Generating the native Android project"
  (cd "$project_dir/apps/mobile" && npx expo prebuild --platform android --no-install)
  cp "$backup" "$project_dir/apps/mobile/package.json"
  rm -f "$backup"
}

pin_kotlin_version() {
  local project_dir="$1"
  local props="$project_dir/apps/mobile/android/gradle.properties"
  local rn_kotlin
  # The Kotlin the React Native Gradle plugin actually compiles with; the plugin's version catalog is
  # the source of truth, with 1.9.24 as the fallback for this template.
  rn_kotlin="$(sed -n 's/^kotlin = "\(.*\)"/\1/p' "$project_dir/node_modules/@react-native/gradle-plugin/gradle/libs.versions.toml" 2>/dev/null | head -1)"
  rn_kotlin="${rn_kotlin:-1.9.24}"

  if grep -q '^android\.kotlinVersion=' "$props"; then
    sed -i.bak "s/^android\.kotlinVersion=.*/android.kotlinVersion=$rn_kotlin/" "$props"
    rm -f "$props.bak"
  else
    {
      printf '\n# Pinned to the Kotlin version the React Native Gradle plugin uses. Declaring anything else\n'
      printf '# makes expo-modules-core select a mismatched Compose compiler.\n'
      printf 'android.kotlinVersion=%s\n' "$rn_kotlin"
    } >>"$props"
  fi
  log "Pinned android.kotlinVersion=$rn_kotlin"
}

main() {
  local java_home android_home project_dir staged=0 java_major version apk_name apk source_apk

  java_home="$(find_java_home)" || die "No JDK found. Set JAVA_HOME to a JDK 17 installation."
  java_major="$("$java_home/bin/java" -version 2>&1 | sed -n 's/.*version "\([0-9]*\).*/\1/p' | head -1)"
  if [ -n "$java_major" ] && [ "$java_major" -gt 17 ]; then
    die "Gradle 8.10.2 needs JDK 17, but $java_home is JDK $java_major. Point JAVA_HOME at a JDK 17."
  fi
  export JAVA_HOME="$java_home"

  android_home="$(find_android_home)" || die "No Android SDK found. Set ANDROID_HOME to the SDK directory."
  export ANDROID_HOME="$android_home"
  export ANDROID_SDK_ROOT="$android_home"

  # Metro must treat apps/mobile as the project root, not this monorepo's root.
  export EXPO_NO_METRO_WORKSPACE_ROOT=1

  log "JDK: $(basename "$JAVA_HOME")"
  log "Android SDK: $ANDROID_HOME"

  project_dir="$REPO_ROOT"
  if is_windows; then
    local measured
    measured="$(to_unix_path "$REPO_ROOT")"
    if [ "${#measured}" -gt "$MAX_IN_PLACE_PATH" ]; then
      local stage_dir
      stage_dir="$(to_unix_path "${STAGE_DIR:-${USERPROFILE:-$HOME}/bb-apk}")"
      if [ "${#stage_dir}" -ge "${#measured}" ]; then
        die "This checkout's path is too long for the Android NDK build (${#measured} characters) and the staging directory $stage_dir is not shorter. Move the project somewhere shorter or set STAGE_DIR."
      fi
      log "Checkout path is ${#measured} characters; too long for the native build on Windows."
      log "Staging the sources in $stage_dir"
      project_dir="$stage_dir"
      staged=1
      sync_source "$project_dir"
      sync_dependencies "$project_dir"
    fi
  fi

  prebuild_android "$project_dir"
  pin_kotlin_version "$project_dir"

  log "Compiling the release APK"
  (
    cd "$project_dir/apps/mobile/android"
    ./gradlew assembleRelease --no-daemon "$@"
  )

  source_apk="$project_dir/apps/mobile/android/app/build/outputs/apk/release/app-release.apk"
  [ -f "$source_apk" ] || die "Gradle finished but $source_apk is missing."

  version="$(node -p "require('$REPO_ROOT/apps/mobile/app.json').expo.version" 2>/dev/null || echo 0.0.0)"
  apk_name="bankbuddy-$version-release.apk"
  mkdir -p "$ARTIFACTS_DIR"
  apk="$ARTIFACTS_DIR/$apk_name"
  cp "$source_apk" "$apk"

  log "APK: $apk ($(du -h "$apk" | cut -f1))"
  printf 'Install it with: adb install "%s"\n' "$apk"
  if [ "$staged" -eq 1 ]; then
    printf 'The staging copy in %s is kept so the next build can reuse its dependencies.\n' "$project_dir"
  fi
}

main "$@"
