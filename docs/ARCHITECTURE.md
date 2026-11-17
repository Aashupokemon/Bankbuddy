# Architecture

Status: **proposed** — this describes the intended shape of the pilot. No application code exists yet.

This document is a condensed, decision-oriented view. The reasoning, spec gaps and open questions
live in [`../IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md).

## 1. Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Web client | React + TypeScript + Vite, mobile-first PWA | Branch staff work on phones; no app-store distribution for a pilot |
| API | NestJS on Node 22, versioned under `/api/v1` | Structured modules, guards and interceptors map cleanly onto the permission matrix |
| Data | PostgreSQL 16 + Prisma, with hand-written SQL for RLS, triggers and audit | Row-level security and append-only guarantees must live in the database, not the ORM |
| Jobs | Separate worker process polling a Postgres job table | Reminders and extraction retries need at-least-once semantics and no extra infrastructure |
| Extraction | Provider-neutral adapter + deterministic rule-based fallback | The AI is swappable, optional, and can never be a hard dependency |

Rejected on purpose: BaaS/headless backends (they hide the row-level isolation this project has to
prove), NoSQL (the model is relational and audit-shaped), chat UI SDKs (they own the conversation
state we must not persist), and any hosted vendor chosen on the project's behalf — hosting region,
KMS and vendor review are bank decisions, not implementation conveniences.

## 2. Repository layout

```
apps/
  api/         NestJS HTTP API (auth, scope resolution, tasks, comments, audit)
  worker/      scheduler: reminders, notification fan-out, extraction retries
  web/         React PWA
packages/
  contracts/   Zod schemas + generated OpenAPI types shared by api and web
  date/        the single date/time service (timezone, precision, DST)
  db/          Prisma schema, migrations, RLS and trigger SQL, seed data
ops/
  docker-compose.yml, synthetic seed fixtures, runbooks
```

The `date` package exists because time handling is the most likely source of silent, expensive bugs
(see §6).

## 3. Domain model

Core entities and the relationships the plan depends on:

- `workspaces` → `branches` → `memberships` (user, branch, role). Role is resolved per request from
  membership, never accepted from the client.
- `tasks` — branch-scoped, versioned (`version` integer used for `If-Match`), with `owner_id`
  nullable **plus** an explicit "unassigned" intent flag so NULL is unambiguous.
- `task_comments`, `task_dependencies`, `task_events` (activity feed), `audit_events`.
- `reminders` — one row per scheduled occurrence with a `dedupe_key` unique constraint.
- `notification_preferences`, `branch_settings`, `categories`, `holidays`.

Schema additions required beyond the source specification are tabulated in
[`../IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md) §5.3. The important ones: due-date
precision, blocked reason, `completed_at/by`, soft delete, category table, branch-scoped settings,
audit hash chain link, and `branch_id` denormalised onto child tables.

## 4. Permission matrix

Roles: `employee`, `lead`, `manager`, `workspace admin`, `auditor`.

| Action | employee | lead | manager | admin | auditor |
| --- | --- | --- | --- | --- | --- |
| Read own tasks | ✅ | ✅ | ✅ | ✅ | ✅ |
| Read branch tasks | scoped | ✅ | ✅ | ✅ | ✅ (read-only) |
| Create task | ✅ | ✅ | ✅ | ✅ | ❌ |
| Edit own / any task | own | branch | branch | branch | ❌ |
| Change status | own | branch | branch | branch | ❌ |
| Reassign others | ❌ | ✅ | ✅ | ✅ | ❌ |
| Archive · change settings · edit categories | ❌ | ❌ | ✅ | ✅ | ❌ |
| Read audit events | ❌ | ❌ | ✅ | ✅ | ✅ |
| Manage memberships | ❌ | ❌ | ❌ | ✅ | ❌ |

Every cell is enforced server-side and backed by a negative test. The client only hides what the
server would refuse.

## 5. Task lifecycle

```
open ──▶ in_progress ──▶ done ──▶ archived
  │            │
  ├──▶ blocked ┘
  └──▶ cancelled
```

Rules that the state machine must carry:

- transitions are validated against an allow-list, not "any status to any status";
- a transition to `blocked` requires a non-sensitive reason;
- `done` stamps `completed_at` / `completed_by`; reopening clears them and is audited;
- `archived` and `cancelled` are terminal and read-only except for audit-visible reopening by a
  manager;
- each transition writes before/after state to the activity feed and an append-only audit row.

## 6. Data integrity enforcement

Application code alone is not trusted here.

1. **Isolation** — Postgres RLS policies keyed on the authenticated member's branch, applied in
   addition to query-level scoping. A missing `WHERE` clause must fail closed.
2. **Concurrency** — `PATCH` requires `If-Match: <version>`; mismatches return `409` with the current
   server state so the client can reconcile instead of overwriting.
3. **Audit** — `audit_events` is append-only (UPDATE/DELETE revoked, enforced by trigger), carries
   actor, branch, entity, before/after, reason and a `prev_hash` chain so tampering is detectable.
   Reading audit is itself audited.
4. **Time** — one service converts local input into UTC instants and preserves whether a due date was
   date-only, time-only-in-timezone, or a full instant. Ambiguous DST times are surfaced for
   confirmation; a date-only due value never silently becomes midnight.
5. **AI boundary** — extraction runs on a path with no write access, is schema-validated, is
   allow-listed, is kill-switchable, and its output is discarded unless a human confirms.
6. **Reminders** — dedupe by unique key per occurrence, one overdue reminder per workday, quiet hours
   and holidays honoured, delivery recorded.

## 7. API surface

Human-facing endpoints under `/api/v1`: `GET /me`, `GET|POST /tasks`, `GET|PATCH /tasks/{id}`,
task comments and dependencies, handover propose/accept/decline, `POST /assistant/extract`,
notifications and acknowledgement, `GET /analytics/summary`, `GET /audit/events`, and
`POST /sync/operations` for offline replay. Errors are RFC 7807 problem details.

## 8. Non-goals

No core banking or KYC integration, no customer data, no employee ranking, no autonomous AI writes,
no public sign-up. Anything that would require a bank approval is out of scope until that approval
exists.
