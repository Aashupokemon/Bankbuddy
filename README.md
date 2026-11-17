# BankBuddy

A shared task workspace for branch banking teams — capture work in a sentence, track it on one board,
and keep every change accountable.

> **Status: pre-alpha pilot.** The API, reminder worker and Android client are implemented against
> synthetic data. There is no bank integration, no production deployment and no security review. See
> [`docs/ROADMAP.md`](./docs/ROADMAP.md) for exactly what is and is not done.

**Repository:** <https://github.com/Aashupokemon/Bankbuddy>  
**Landing page:** <https://aashupokemon.github.io/Bankbuddy/>

---

## What it does

- **Capture in a sentence** — free text becomes an extracted draft (task, owner, due date, priority),
  which a person edits and confirms. The extractor has no write access; nothing is saved until the
  draft is confirmed, and a rule-based extractor keeps the flow working when no model is configured.
- **One board** — due today, overdue, blocked, mine, with priority and due-date ordering.
- **Accountable by design** — status changes follow an explicit state machine, some transitions
  require a reason, edits keep before/after values, and the audit trail is append-only and
  hash-chained per branch.
- **Reminders that don't spam** — one row per (task, occurrence) with a unique dedupe key, quiet
  hours, holiday awareness and retry accounting.
- **Branch isolation** — every request runs in a transaction whose branch comes from the authenticated
  membership, with Postgres row-level security enforced through a non-owner role.

## What this is not

Independent project, synthetic data only. Not affiliated with or approved by any bank, and nothing
here is a compliance or security certification. Deliberately excluded: transaction systems,
customer/KYC data, core banking integrations, employee ranking, autonomous AI writes, public sign-up.

## Architecture at a glance

| Layer | Built with |
| --- | --- |
| Android app | React Native + Expo (TypeScript), SecureStore for the session token, AsyncStorage for the offline queue |
| API | Express 5 + Zod, versioned under `/api/v1` |
| Data | PostgreSQL 16+ via `pg`, or embedded PGlite (real Postgres in WASM) for local runs and tests |
| Worker | Node process that materialises and delivers reminders |
| Shared | `@bankbuddy/contracts` (schemas, permission matrix, state machine), `@bankbuddy/date` (timezone rules) |

Full detail, including the permission matrix and integrity rules, is in
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## Repository layout

```
apps/
  api/        Express API: auth, tasks, comments, dependencies, handover, assistant, audit, sync
  worker/     reminder scheduler
  mobile/     Expo Android app (screens, API client, offline queue)
packages/
  contracts/  Zod schemas, permission matrix, state machine, DTOs
  date/       timezone, precision and DST rules (the only place dates are constructed)
  db/         driver (pg + PGlite), migrations, RLS and audit SQL, synthetic seed
docs/         architecture, roadmap, contributing, security, mobile
index.html    public landing page (GitHub Pages)
```

## Running it locally

Requires Node 22+. No Docker needed: with `DATABASE_URL` unset the app uses an embedded Postgres
file in `.data/pg`.

```bash
npm install
npm run db:reset          # migrate + seed two synthetic branches
npm run api               # http://127.0.0.1:8787
npm run worker            # optional: reminder scheduler
npm test                  # 47 tests: isolation, versioning, audit, extraction, reminders, sync, offline queue
npm run typecheck
```

To use a real Postgres instead, set `DATABASE_URL` (see `.env.example`) and run the same commands.
`ops/docker-compose.yml` starts one locally.

### Android app

```bash
cd apps/mobile
npx expo start --android     # emulator, or scan the QR code with Expo Go on a device
```

The app talks to `http://10.0.2.2:8787` by default (the emulator's route to the host). On a physical
device set `EXPO_PUBLIC_API_URL` to your machine's LAN address. Sign in with one of the synthetic
users the app lists — there are no passwords.

A release APK has been built locally and is not committed (60 MB): `artifacts/bankbuddy-1.0.0-release.apk`,
installed with `adb install artifacts/bankbuddy-1.0.0-release.apk`. It ships the JS bundle but no backend,
so point it at a running API (`npm run api`) first. `npm run mobile:bundle` and the exact Gradle recipe are
documented in [`docs/MOBILE.md`](./docs/MOBILE.md).

## Documentation

| Document | What it covers |
| --- | --- |
| [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) | Spec analysis, gaps, scope cut, milestones, risks |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | Stack, domain model, permission matrix, integrity rules, API surface |
| [`docs/ROADMAP.md`](./docs/ROADMAP.md) | Milestone status and what remains |
| [`docs/MOBILE.md`](./docs/MOBILE.md) | Android app: screens, configuration, building an APK |
| [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md) | Local setup, conventions, review expectations |
| [`docs/SECURITY.md`](./docs/SECURITY.md) | Data policy, isolation invariants, reporting |

## Contributing

See [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md). Report security issues privately per
[`docs/SECURITY.md`](./docs/SECURITY.md).

## License

Released under the [MIT License](./LICENSE). The license covers the code only: it does not grant
rights over the BankBuddy name or the site's visual identity, and it is not a statement that the
project is approved for real bank or customer data.

## Copyright

Copyright © 2026 Aashupokemon.

The copyright notice is part of [`LICENSE`](./LICENSE) and must be retained in all copies or
substantial portions of the software. Questions about use beyond the license should go to the
copyright holder.
