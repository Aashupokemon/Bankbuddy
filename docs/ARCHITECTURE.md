# Architecture

Status: **implemented for the pilot**. Synthetic data only; no bank system is touched.

This document describes what is in the repository. The reasoning, spec gaps and open questions live
in [`../IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md).

## 1. Stack (as built)

| Layer | Choice | Why |
| --- | --- | --- |
| Android client | React Native + Expo, TypeScript | A real Android app without an app-store release; no JDK/SDK needed to develop or bundle |
| API | Express 5 + Zod, `/api/v1` | Small surface, explicit middleware, one validation source shared with the client |
| Data | PostgreSQL via `pg`, or PGlite (Postgres compiled to WASM) | Identical semantics either way: RLS, triggers and constraints are all real Postgres |
| Worker | Node process polling the reminder tables | No extra infrastructure; idempotent by dedupe key |
| Shared | `@bankbuddy/contracts`, `@bankbuddy/date` | The permission matrix, state machine and date rules exist once |

Two deliberate departures from the original plan, both driven by the environment this was built in
(no Docker, no local Postgres, no Android SDK):

- **`pg` + hand-written SQL instead of Prisma.** Row-level security needs a per-request
  `SET LOCAL app.branch_id` plus a role switch, which is awkward through an ORM, and PGlite cannot be
  reached by Prisma at all. Hand-written SQL also keeps the audit hash chain and RLS policies visible
  in review.
- **Express instead of NestJS.** The permission checks are four small functions; a full DI container
  would add indirection without adding safety.

## 2. Repository layout

```
apps/api/src/          server.ts (boot), app.ts (routes), auth.ts, tasks.ts, collaboration.ts,
                       assistant.ts, admin.ts, sync.ts, http.ts
apps/api/test/         end-to-end API tests against a real (in-memory) Postgres
apps/worker/src/       reminder generation and delivery
apps/mobile/src/       App.tsx (shell), api.ts (client + offline queue), screens/, ui.tsx, theme.ts
packages/contracts/    Zod schemas, permission matrix, state machine, DTO types
packages/date/         timezone/precision service + tests
packages/db/src/       driver.ts (pg + PGlite), migrate.ts, seed.ts, migrations/*.sql
```

## 3. Domain model

`workspaces → branches → memberships(user, branch, role)`, plus:

- `tasks` — branch-scoped, `version` for optimistic concurrency, `due_at` + `due_precision`,
  explicit-unassigned flag, blocked reason, completion stamps, soft delete, recurrence.
- `task_comments`, `task_dependencies`, `task_events` (activity feed), `audit_events`.
- `reminders` (one row per occurrence, unique dedupe key), `notifications`,
  `notification_preferences`, `branch_settings`, `categories`, `holidays`, `sessions`,
  `handovers`/`handover_tasks`, `sync_operations`, `jobs`.

Every branch-owned table carries `branch_id`, including child tables, so RLS needs no joins.

## 4. Permission matrix

Roles: `employee`, `lead`, `manager`, `workspace_admin`, `auditor`. Encoded once in
`packages/contracts` and consumed by both the API and the Android client.

| Action | employee | lead | manager | admin | auditor |
| --- | --- | --- | --- | --- | --- |
| Read own tasks | ✅ | ✅ | ✅ | ✅ | ✅ |
| Read branch tasks | scoped | ✅ | ✅ | ✅ | ✅ |
| Create task | ✅ | ✅ | ✅ | ✅ | ❌ |
| Edit own / any task | own | branch | branch | branch | ❌ |
| Change status | own | branch | branch | branch | ❌ |
| Assign to others | ❌ | ✅ | ✅ | ✅ | ❌ |
| Archive · settings | ❌ | ❌ | ✅ | ✅ | ❌ |
| Read audit | ❌ | ❌ | ✅ | ✅ | ✅ |
| Analytics | ❌ | ❌ | ✅ | ✅ | ✅ |
| Manage memberships | ❌ | ❌ | ❌ | ✅ | ❌ |

Employees never receive another person's task from the list endpoint, even if they ask for the team
scope. Every refusal is tested (`apps/api/test/api.test.ts`).

## 5. Task lifecycle

```
open ⇄ in_progress → done → archived
  │         │
  ├→ blocked ┘
  └→ cancelled
```

- Transitions are validated against an allow-list, not "any status to any status".
- `blocked` requires a non-sensitive reason; cancelling and reopening require a reason.
- `done` stamps `completed_at`/`completed_by`; leaving `done` clears them.
- Reopening cancelled or archived work is manager-only; an owner may reopen their own completed task.
- Every transition writes a `task_events` row with before/after and an append-only audit row.

## 6. Data integrity

1. **Isolation.** Each request opens a transaction, sets `app.branch_id`/`app.user_id`, and switches
   to the non-owner `bankbuddy_app` role so row-level security is actually enforced. Queries are also
   scoped by `branch_id` explicitly — a missing filter fails closed, not open.
2. **Concurrency.** `PATCH` and status changes require the current version (`If-Match` or body
   `version`); a mismatch returns `409` with the current server state.
3. **Audit.** `audit_events` is append-only (UPDATE/DELETE revoked *and* blocked by a trigger), hashes
   each row over the previous hash plus its content, and takes a per-branch advisory lock so the chain
   cannot fork. Reads of audit are audited. `GET /audit/verify` recomputes the chain in SQL.
4. **Time.** `@bankbuddy/date` is the only place dates are constructed. Date-only values keep
   `due_precision = 'date'` and never silently become midnight or end-of-business; overdue means "past
   the end of the local day". DST gaps and overlaps are reported, not coerced.
5. **AI boundary.** Extraction runs with no write access, is schema-validated, redacts
   card/account/phone/email/IFSC patterns, is kill-switchable, and falls back to the rule extractor.
6. **Reminders.** Unique dedupe key per occurrence, one overdue nudge per workday, quiet hours defer
   delivery, holidays suppress overdue nudges, failures are retried with an attempt counter.

## 7. API surface

`/api/v1`: `me`, `members`, `dashboard`, `tasks` (list/create/get/patch/delete), `tasks/{id}/status`,
`activity`, `comments`, `dependencies`, `handovers` (+ respond), `assistant/extract`, `notifications`
(+ ack), `audit/events`, `audit/verify`, `analytics/summary`, `settings`, `categories`,
`sync/operations`, `auth/dev-login`, `auth/logout`. Errors are RFC 7807 problem details.

## 8. Client

The Android app keeps the session token in Expo SecureStore, renders the board from
`/dashboard` + `/tasks`, and shows an editable extraction draft before anything is created. Writes
that fail for lack of connectivity are persisted to device storage (AsyncStorage) and replayed
through `/sync/operations` with client-generated ids — on the next app launch if necessary — so a
restart loses nothing, a retry applies each change once, and a version mismatch surfaces as a
conflict rather than an overwrite. An operation only leaves the queue once the server has answered
for it; a dropped response means it is sent again and answered `replayed`.

## 9. Known gaps

No APK artifact is built or published; no UI automation; the optional AI provider path has not been
exercised against a live model (only the rules fallback is covered by tests); the offline queue is
durable, but `sync` reports conflicts rather than merging them.
