# Contributing

Thanks for looking. This project is pre-alpha: issues that argue with the design are as welcome as
code.

## Ground rules

1. **Synthetic data only.** Never commit real customer, account, employee or bank data — including in
   fixtures, screenshots, logs or test names. Use obviously fake names and generated identifiers.
2. **No scope creep into the non-goals.** Transaction systems, customer/KYC data, core banking
   integrations, employee ranking and autonomous AI writes are out of scope by design.
3. **Security-shaped changes need tests.** Anything touching branch isolation, permissions,
   concurrency, audit or the assistant boundary must ship with the test that proves the guard works.

## Local setup

```bash
npm install
npm run db:reset     # migrate + seed two synthetic branches
npm run api          # http://127.0.0.1:8787
npm run worker       # optional: reminder scheduler
npm test             # API + date tests against an in-memory Postgres
npm run typecheck
```

No Docker is required: with `DATABASE_URL` unset the app uses embedded PGlite under `.data/pg`. To use
a real Postgres, `docker compose -f ops/docker-compose.yml up -d` and set `DATABASE_URL`.

Android app: `cd apps/mobile && npx expo start --android`. See [`MOBILE.md`](./MOBILE.md).

## Where things live

- `packages/contracts` — schemas, permission matrix, state machine. Change a rule here once and both
  the API and the app follow.
- `packages/date` — every date/time decision. Do not construct `Date` objects elsewhere.
- `packages/db/src/migrations` — numbered SQL. Migrations are append-only once merged; add a new file
  rather than editing an old one.
- `apps/api` — routes in `app.ts`, rules in the service modules next to it.

## Conventions

- TypeScript strict; no `any` in shared contracts.
- Every query that touches branch data carries `branch_id`, in addition to row-level security.
- Mutating a task goes through `tasks.ts` so the version check, activity row and audit row cannot be
  forgotten.
- Errors are RFC 7807 problem details (`title`, `status`, `code`, optional `errors`).
- The client may hide an action it cannot perform; the server must refuse it independently.

## Branching and commits

- Branch from `main`, keep branches short-lived and single-purpose.
- Imperative, specific commit subjects: `Add due-date precision to task schema`, not `fixes`.
- Keep formatting-only changes in their own commit.
- Squash on merge.

## Pull requests

State what changed, why, what you verified (command and result) and what you did **not** verify.
Reviewers check, in order: non-goals respected, branch isolation intact, time handled through
`@bankbuddy/date`, audit trail complete, accessible on a phone.
