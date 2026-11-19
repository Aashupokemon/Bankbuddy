# Testing

Three layers, cheapest first. None of them needs real bank data: every test runs on the synthetic
two-branch seed.

## 1. Unit and API tests — `npm test`

Node's built-in runner over `packages/*/test`, `apps/api/test` and `apps/mobile/test`. It covers the
permission matrix, branch isolation through row-level security, version conflicts, transitions,
reminders, the offline queue (including conflict retention) and the mobile demo fallback. No emulator,
no network; the API tests open a throwaway database per run.

`npm run typecheck` builds the server packages; `cd apps/mobile && npm run typecheck` checks the app
(it is a separate project and is not part of the root build).

## 2. Bundle check — `npm run mobile:bundle`

Bundles the Android JS with Metro. This catches broken imports and anything React Native cannot
resolve, without an SDK. It does not prove the UI works.

## 3. Device flows — `npm run mobile:e2e`

Maestro drives the installed APK on an emulator or a connected phone: sign in, board, search, open a
task, change its status, the More tab, sign out.

```bash
# one-time: install the CLI (needs Java, which the APK build already needs)
curl -Ls "https://get.maestro.mobile.dev" | bash

# build and install
npm run mobile:apk
adb install -r artifacts/bankbuddy-0.1.0-release.apk

# run the flows
npm run mobile:e2e
```

The flow in `.maestro/demo-smoke.yaml` expects the API to be **unreachable** — that is what switches
the app to bundled demo data and makes the run deterministic. Stop `npm run api` first, or build with
`EXPO_PUBLIC_DEMO_MODE=1`. `scripts/e2e-android.sh` warns if the API is up on the development machine.

Selectors use the app's accessibility labels and `testID`s (`demo-banner`, `board-search`). A renamed
button should fail the flow rather than pass silently, so keep those names in place when editing
screens.

## What is still not covered

- No live-API device flow: the journey above runs on demo data. A second flow against
  `http://10.0.2.2:8787` would need a seeded database and a rebuilt APK (`EXPO_PUBLIC_API_URL`).
- No accessibility audit beyond labels and 44pt targets.
- The AI provider path is exercised only through its rule-based fallback.
