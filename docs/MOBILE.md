# Android app

The client is a React Native app built with Expo, in `apps/mobile`. It is the only client: there is
no web application.

## What is in it

| Screen | Purpose |
| --- | --- |
| Sign in | Development sign-in listing the synthetic pilot users. No passwords, no real accounts. |
| Board | Dashboard counts (overdue, due today, blocked, in progress, mine, unassigned), filters, task list. |
| Capture | Free-text capture → editable extraction draft → explicit confirm; plus a plain form. |
| Task | Status transitions (with required reasons), reassignment, handover, dependencies, comments, history. |
| More | Offline queue, notifications, handovers to accept, analytics, audit trail with chain verification, sign out. |

Accessibility: every interactive element has a role and label, touch targets are at least 44pt, and
the layout is single-column for small screens. No accessibility audit has been run yet.

## Running against the API

The API must be reachable from the device. Start it first:

```bash
npm run api        # http://127.0.0.1:8787
```

Then:

```bash
cd apps/mobile
npx expo start --android
```

- **Emulator:** the default base URL `http://10.0.2.2:8787` is the emulator's route to the host.
- **Physical device (Expo Go):** set the host machine's LAN address, e.g.
  `EXPO_PUBLIC_API_URL=http://192.168.1.20:8787 npx expo start`.

Sign in with any listed user, for example `ravi@alpha.example` (employee) or
`priya@alpha.example` (manager). The manager sees audit and analytics; the employee does not.

## Verifying the build without an Android SDK

```bash
npm run mobile:bundle      # expo export --platform android
```

This produces the Hermes bundle in `dist-mobile/`, which is what an APK would ship. It proves the app
compiles and bundles; it does not prove it renders, because no emulator or device is attached in this
environment.

## Building an installable APK

A release APK has been built from this tree: `artifacts/bankbuddy-1.0.0-release.apk` (59 MB, 715 entries,
Hermes bundle at `assets/index.android.bundle`). It is signed with the generated debug keystore, so it
installs on a device for review but is not a Play-ready artifact. The file is gitignored; rebuild it with
the steps below.

Prerequisites: JDK 17 (Gradle 8.10.2 does not run on JDK 21+), the Android SDK with platform 35 and
build-tools 35.0.0, and Bash. `JAVA_HOME` and `ANDROID_HOME` are used when set; otherwise the script looks
in `.tools/jdk17/` and the standard SDK locations.

```bash
npm run mobile:apk          # -> artifacts/bankbuddy-<version>-release.apk
npm run mobile:apk -- clean # extra arguments go to Gradle
```

[`scripts/build-apk.sh`](../scripts/build-apk.sh) does the whole job. Beyond `expo prebuild` and
`gradlew assembleRelease`, it handles four things the generated project gets wrong in this repo:

1. `apps/mobile/android/gradle.properties` needs `android.kotlinVersion` pinned to the Kotlin the React
   Native Gradle plugin ships (read from its version catalog, 1.9.24 today). Expo's template declares a
   newer Kotlin, which makes `expo-modules-core` select a Compose compiler that refuses to run.
2. The build needs `EXPO_NO_METRO_WORKSPACE_ROOT=1`. Otherwise Expo treats this repo as a Metro workspace
   and roots the bundler at the repository root, where the `--entry-file index.ts` handed over by Gradle
   does not exist. Workspace packages still resolve through `apps/mobile/metro.config.js`.
3. Windows caps object file paths at 250 characters. From a long checkout `expo-modules-core`'s CMake
   build loops forever with `ninja: error: manifest 'build.ninja' still dirty after 100 tries`, so a
   checkout whose path is longer than 60 characters is copied to a short staging directory (default
   `<home>/bb-apk`, override with `STAGE_DIR`), built there, and the APK is copied back. The staging copy
   is kept so later builds reuse its `node_modules`; Linux and macOS build in place.
4. `expo prebuild` rewrites `apps/mobile/package.json` with extra scripts; the script restores it, so the
   checkout is left untouched.

To do it by hand instead, run `npx expo prebuild --platform android --no-install` in `apps/mobile`, apply
the `android.kotlinVersion` pin above, then `EXPO_NO_METRO_WORKSPACE_ROOT=1 ./gradlew assembleRelease` in
`apps/mobile/android` — from a short path on Windows.

The output is `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`, copied to `artifacts/`. The package name is
`com.bankbuddy.app` and the app is configured in `apps/mobile/app.json`. An EAS cloud build
(`npx eas build --platform android --profile preview`) also works once `eas.json` exists, but it needs an
expo.dev account.

## What the APK talks to

The APK ships the JS bundle but no backend. It is preconfigured for `http://10.0.2.2:8787`, which is the
API from `npm run api` as seen from an Android emulator; on a physical device set `EXPO_PUBLIC_API_URL`
to the machine's LAN address and rebuild, or point the app at a deployed API.

## Offline behaviour

Writes that fail with a network error are written to AsyncStorage with a client-generated id and
replayed through `POST /api/v1/sync/operations`. The queue survives an app restart: on launch, once
the session is restored, anything left over is replayed automatically, and the "More" tab shows the
pending count with a manual **Sync now** button.

The API applies each operation at most once, keyed by that id. An operation is removed from the queue
only after the server has answered for it, so a dropped response means it is retried and answered
`replayed` rather than applied twice. Version mismatches come back as `conflict` — reported, not
merged — and the entry is then dropped so it cannot loop forever.

## Configuration

| Variable | Meaning |
| --- | --- |
| `EXPO_PUBLIC_API_URL` | API base URL. Default `http://10.0.2.2:8787`. |

The offline queue lives under the `bankbuddy.offline-queue.v1` AsyncStorage key and is verified by
`apps/mobile/test/offlineQueue.test.ts`, which simulates a relaunch by opening a second queue over
the same storage.

The session token is stored with Expo SecureStore and cleared on sign out. No other data is persisted
on the device.
