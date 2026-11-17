# Branch Task Workspace — Implementation Plan

Source: `branch-banking-task-management-specification.docx` (v1.0, 17 Nov 2026).
Status: **plan only — no application code exists in this repository yet.**
This document is a product/technical starting point. It is not bank approval, a compliance
opinion, or authorisation to process real bank or customer data.

---

## 1. What the specification actually asks for

A single-branch, synthetic-data pilot of a shared task workspace with two co-equal front doors:

- **chat capture** — free-text sentence → extracted draft → human edits → confirm → task saved;
- **dashboard/list** — triage of due, overdue, blocked and (role-gated) team work.

Everything else in the document is either a *constraint on how those two things behave*
(permissions, audit, versioning, timezone handling, AI guardrails) or a **P1 capability**
(dependencies, recurrence, handover, offline sync, analytics, configurable categories).

### 1.1 Complexity hotspots (where the real engineering cost sits)

Ranked by implementation risk, not by spec page order:

1. **Branch/tenant isolation.** Every read and write is scoped from *authenticated membership*,
   never from a client-supplied `branch_id`. This is the one requirement where a mistake is a
   security incident rather than a bug, so it gets defence in depth (see §6.3).
2. **Optimistic concurrency.** `PATCH` + `If-Match`/version + 409, plus the same rule applied to
   status transitions, and later to offline replay. Retrofitting this is painful — build it in
   milestone B.
3. **Time semantics.** UTC instant + branch timezone + no silent midnight, no silent
   end-of-business, DST ambiguity confirmed, past dates rejected. This needs one central
   date service with wide unit coverage; string-based date handling scattered across the UI will
   fail the spec.
4. **Audit integrity.** Append-only, attributable, reason-bearing, tamper-evident, and *reads of
   audit are themselves audited*. Needs DB-level enforcement, not just application discipline.
5. **AI extraction as untrusted input.** Strict allow-list, schema validation, sensitive-data
   guard, no persistence before confirmation, kill switch, deterministic fallback. The AI must be
   on a code path that cannot write.
6. **Reminder deduplication.** `unique dedupe_key` per occurrence + quiet hours + one overdue
   reminder per workday + retries/backoff + delivery audit.
7. **P1 offline sync.** Version-checked, idempotent operation replay with visible conflicts.

### 1.2 Ambiguities that will block coding unless resolved

The spec's schema (§10) is thinner than its functional requirements (§4). These gaps must be
filled by schema additions — listed in §5.3 — and a handful need a sponsor answer (§12).

Notable contradictions/gaps found while reading:

- **`tasks` has no `blocked_reason`**, yet FR-07 requires a non-sensitive blocked reason.
- **`due_at` alone cannot express "date-only stays date-only"** (§8). A precision flag is required
  or the client will silently invent midnight.
- **No `categories` table**, yet FR-15 and create-body validation reference `category_key`, and
  priorities/categories must be manager-configurable.
- **No notification-preferences / quiet-hours / holiday-calendar storage**, all referenced by
  FR-09, §8 and screen 11.
- **`memberships` has no `created_by` / role-change trail**, yet role changes are security events.
- **`task_dependencies` has no `branch_id`**, and cycle detection needs either a recursive query
  or a closure table — decide at implementation time (§5.4).
- **MVP acceptance requires `description`**, while the extraction schema treats it as optional and
  chat capture may produce a one-liner. Plan: description is required *and* defaulted to the user's
  confirmed text when extraction returns nothing.
- **"owner may be null only when explicitly unassigned"** needs a boolean/intent flag, otherwise
  NULL and "not yet chosen" are indistinguishable.
- **Status list includes `archived`,** but §8/Appendix A also speak of archival as an action; treat
  `archived` as a status whose transitions are manager-only and whose rows are read-only.
- **`audit_events` has no `tenant_id` denormalisation on child entities** (comments/reminders) —
  audit lookups by branch will need joins; add `branch_id` to comments/reminders or accept joins.

---

## 2. Scope cut for this iteration

### In scope (MVP, spec §17)

Auth dev stub → real OIDC; workspace/branch/role resolution; task CRUD with versioning;
status transitions with reason + audit; comments; assignment/reassignment with notification;
chat extraction with editable preview and hard confirmation gate; dashboard + list + filters and
sort (due, then priority); reminders (in-app) with dedupe and quiet hours; append-only audit with a
manager-only read view; manager settings for categories/templates/reminder defaults; WCAG 2.2 AA
baseline; privacy notice; AI kill switch and deterministic fallback.

### Explicitly deferred

P1: dependencies (FR-08), recurrence (FR-10), handover (FR-11), analytics (FR-13), offline sync
(FR-14), retention/export/legal hold (FR-17), push channel. Schema and API shapes for these are
designed now so they slot in without migration churn, but no UI ships for them.

### Never in scope

Transaction initiation/approval, core banking or customer/HR/email integrations, customer
identifiers or financial data, AI decisions or autonomous actions, cross-branch visibility,
employee ranking or productivity scoring.

---

## 3. Recommended stack

| Layer | Choice | Why this, for this spec |
| --- | --- | --- |
| Client | **React + TypeScript + Vite, mobile-first PWA**, installable | Chat + dashboard co-equal fits a responsive app; offline cache/outbox via IndexedDB is a natural later step; no app-store signing or MDM gate for the synthetic pilot (open decision #1/#2 in the spec). The API contract is client-neutral so a React Native or native Android client can be added in Phase 4 without server changes. **Confirm before building the shell** (§12, Q1). |
| API | **NestJS (TypeScript)**, REST `/api/v1` | Spec names TypeScript/Nest as an accepted option; same language as the client so the extraction schema and permission matrix are shared types, not duplicated definitions. |
| DB | **PostgreSQL 16** + Prisma + hand-written SQL for RLS/policies | Spec mandates Postgres. Prisma for ordinary CRUD, raw SQL migrations for RLS, triggers, recursive CTEs. |
| Worker | Separate NestJS process ("scheduler") on a Postgres-backed job table | Reminders/recurrence are the only background work in MVP; a queue broker is not justified at one branch. Transactional outbox now, swap in a broker if volume demands. |
| Auth | OIDC (provider-neutral) with a local dev issuer | Spec requires approved identity; the pilot may use test accounts. Dev stub behind an env flag, never in production builds. |
| AI | Provider-neutral `ExtractionProvider` interface: one hosted implementation + one rule-based fallback | Kill switch, region/retention gating, and "AI off" are hard requirements. The fallback is not a toy: it must produce a useful draft by itself. |

**Deliberately not chosen:** a BaaS/headless backend (branch-scoped RBAC, audit integrity and RLS
are core requirements, not glue), a NoSQL store (Postgres RLS is the isolation mechanism the spec
asks for), and a chat-SDK UI (the confirmation gate is the product, and it needs custom control).

Hosting, region, KMS and whether this runs bank-hosted are **open decisions pending bank review**
(spec §12, §19). Therefore this plan provisions nothing external: the pilot runs locally with
Docker Compose Postgres, and deployment provider selection is a separate, approval-gated step. No
third-party service is integrated at this stage by design.

### 3.1 Repository layout

```
/                       README, docker-compose.yml, pnpm-workspace.yaml
/apps/api               NestJS API (modules: auth, me, tasks, comments, assignments,
                        notifications, reminders, assistant, audit, settings, health)
/apps/worker            scheduler process: reminders, recurrence (P1), outbox drain
/apps/web              React + Vite PWA (routes: sign-in, home, chat, task preview,
                        task list, task detail, form, notifications, settings, manager)
/packages/contracts     zod schemas: API DTOs, extraction schema, enums, permission matrix
/packages/date          branch-timezone date service (parse, resolve relative, format, DST)
/packages/db            Prisma schema, migrations, RLS SQL, seeds (synthetic branch)
/ops                    docker-compose, .env.example, run scripts
```

Tooling: pnpm workspaces, TypeScript strict, ESLint + Prettier, Vitest (unit), Supertest
(API/integration against a real Postgres), Playwright only for the critical capture→confirm path.

---

## 4. Domain model in code terms

Shared enums (single source of truth in `packages/contracts`):

```ts
type Role = 'employee' | 'lead' | 'manager' | 'admin' | 'auditor';
type TaskStatus = 'open' | 'in_progress' | 'blocked' | 'done' | 'cancelled' | 'archived';
type Priority = 'low' | 'normal' | 'high' | 'urgent';
```

### 4.1 State machine (Appendix A), encoded as data

```
open        -> in_progress | blocked | done | cancelled
in_progress -> blocked | done | open | cancelled
blocked     -> open | in_progress | cancelled
done        -> open            (reopen; reason required, audited)
cancelled   -> open            (manager restore only; reason required, audited)
any non-terminal -> archived   (manager only, policy-gated; row becomes read-only)
archived    -> (terminal in MVP)
```

Rules enforced server-side in one `TaskTransitionService`:

- version must match `If-Match` before and after evaluation (409 otherwise);
- actor must be owner, or lead/manager per matrix (403 otherwise);
- `blocked` requires `blocked_reason` (≤280 chars) that passes the content guard;
- `done` stamps `completed_at`/`completed_by`; `cancelled`/`reopen`/`restore` require `reason`
  which is written to the audit event;
- `archived` rows reject `PATCH`, comments and status changes at the repository layer;
- every accepted transition emits its audit event **inside the same transaction**.

### 4.2 Permission matrix as code

`can(actor, action, task)` where `actor` carries `{ userId, branchId, role, isOwner }`, derived
only from the DB membership row for the *authenticated* user. Branch equality is checked inside
`can`, not by the caller. Matrix (Appendix A generalised):

```
view_branch_tasks   employee✓ lead✓ manager✓ auditor(read)
create_task         all but auditor
edit_task           owner | lead(same branch, team) | manager
change_status       owner | lead | manager
assign              lead (own team) | manager (any branch task)
reassign_any        manager (lead configurable — default off)
change_priority     owner(low|normal|high) ; urgent/any escalation -> manager override + reason
change_deadline     owner(propose) lead(propose) manager(apply)
comment             all but auditor
cancel              owner | lead | manager (reason)
archive             manager
branch_settings     manager
analytics           lead(team) manager(branch) auditor(configurable)
audit_read          manager(limited) auditor(authorized); every read audited
```

Table-driven tests iterate the matrix × roles × ownership and assert 200/403 per cell — the spec
requires denial to be *tested*, not just implemented.

---

## 5. Data model

### 5.1 Implementation order

1. `tenants`, `branches`, `users`, `memberships` (+ unique `branch_id,user_id`)
2. `tasks` (+ indexes, version, timezone, precision flags)
3. `task_comments`, `notifications`, `reminders`
4. `audit_events` (+ append-only enforcement)
5. `idempotency_keys`
6. `categories`, `branch_settings`, `notification_preferences`, `holidays`
7. P1 shells: `task_dependencies`, `recurrence_series`, `handovers`, `sync_operations`

### 5.2 Indexes (from §10) 

```
tasks (branch_id, status, due_at)
tasks (branch_id, owner_id, status, due_at)
tasks (branch_id, updated_at desc)          -- incremental sync / list default
audit_events (branch_id, entity_type, entity_id, occurred_at desc)
reminders (state, fire_at)                  -- worker claim query
notifications (user_id, state, created_at desc)
```

### 5.3 Required schema additions (gaps found in §1.2)

| Table | Add | Reason |
| --- | --- | --- |
| `tasks` | `due_precision` (`instant`\|`date`), `unassigned_explicit` bool, `blocked_reason`, `completed_at`, `completed_by`, `archived_at`, `deleted_at` (soft) | date-only deadlines, explicit unassignment, FR-07, status bookkeeping, retention |
| `tasks` | `due_source_phrase` text (nullable, retention-limited) | §8 asks for the original phrase under retention controls |
| `categories` | `id, branch_id, key, label, sort, active` | FR-15 configurable categories; create-body validates `category_key` |
| `branch_settings` | `branch_id` PK, `work_days`, `workday_end`, `quiet_hours`, `reminder_defaults_json`, `overdue_policy`, `analytics_min_cohort`, `deadline_convention` | §8, §9, §19(7) |
| `notification_preferences` | `user_id`, `channel`, `event_type`, `enabled`, `quiet_hours_override` | FR-09, screen 11 |
| `holidays` | `branch_id`, `date`, `label` | holiday behaviour for reminders/recurrence |
| `memberships` | `created_by`, `role_changed_at`, `role_changed_by` | role changes are security-relevant audit subjects |
| `reminders` | `branch_id`, `task_version_at_schedule` | scoping + resolve stale reminders on edit |
| `task_comments` | `branch_id` (denormalised) | audit/analytics without extra joins |
| `audit_events` | `tenant_id` explicit (spec implies it), `prev_hash` | tamper-evidence chain |
| `sessions`/`devices` | minimal table for revocation | §13 requires revocation |

All tenant rows carry `tenant_id` **and** `branch_id`; FKs are composite where practical
(`(branch_id, owner_id)` → memberships) so a cross-branch reference cannot even be inserted.

### 5.4 Integrity enforcement

- **Append-only audit:** `REVOKE UPDATE, DELETE ON audit_events FROM app_role`; a `BEFORE UPDATE OR
  DELETE` trigger raises; `prev_hash = sha256(prev_hash || canonical(row))` computed in the insert
  path; a nightly verifier job reports breaks.
- **No self/cyclic dependencies (P1):** insert path runs a recursive CTE reachability check plus
  same-branch equality check; composite PK blocks duplicates; self-edge blocked by CHECK.
- **Optimistic concurrency:** `tasks.version` incremented in the same `UPDATE ... WHERE id=$1 AND
  version=$2` statement; zero rows → 409. Never read-then-write.
- **RLS:** `ENABLE ROW LEVEL SECURITY` on all tenant tables with
  `USING (branch_id = current_setting('app.branch_id')::uuid)`. The API sets
  `app.branch_id`/`app.user_id` per connection/transaction from the resolved membership. Tests
  connect as the restricted role and prove cross-branch select *and* insert fail.
- **Seeds:** one synthetic tenant, two branches (so isolation tests have a foreign branch), ~12
  synthetic users, dummy task text only. No real bank data may enter this repo.

---

## 6. API design

Base `/api/v1`, JSON, RFC 9457 problem+json errors, opaque cursors, `ETag` on task detail,
`If-Match` required on `PATCH`, `Idempotency-Key` required on all POST/PATCH that mutate.

### 6.1 Endpoints (MVP subset marked •)

| Endpoint | Notes |
| --- | --- |
| • `GET /me` | profile, memberships, effective permissions, settings, branch timezone |
| • `GET /tasks` | filters: status, owner (`me`/uuid/unassigned), priority, category, due window, q; sort `due,priority`; cursor |
| • `POST /tasks` | confirm-from-preview and form both land here; validates enums, owner membership, due policy; 201 + id/version/status/timestamps |
| • `GET /tasks/{id}` | detail + activity (paginated) |
| • `PATCH /tasks/{id}` | partial, versioned; every changed field → audit diff |
| • `POST /tasks/{id}/status` | transition endpoint (separate from PATCH so reason/version rules are explicit) |
| • `POST /tasks/{id}/comments` | content guard, printable length limits |
| • `POST /tasks/{id}/assign` | assign/reassign within branch + notification |
| • `POST /assistant/extract` | stateless; returns candidate + confidence + needs_clarification; **writes nothing** |
| • `GET /notifications`, • `POST /notifications/{id}/ack` | generic payloads only |
| • `GET /audit/events` | manager limited / auditor authorised; emits `audit.read` |
| • `GET /categories`, • `PATCH /branch/settings` | manager only |
| `POST /tasks/{id}/handover`, `POST /handovers/{id}/accept\|decline` | P1 |
| `POST /tasks/{id}/dependencies` | P1 |
| `GET /analytics/summary` | P1 |
| `POST /sync/operations` | P1 |
| `GET /health`, `GET /health/ready` | liveness/readiness |

### 6.2 Cross-cutting conventions

- **Scope resolution middleware** produces the `actor` context once per request from the token
  subject → `users` → `memberships` (active only) → `branches` (active only). Missing/ambiguous
  membership → 403 with no branch detail.
- **Not-found ambiguity:** out-of-scope task IDs return **404**, never 403, and error bodies never
  name another branch.
- **Idempotency:** `(scope, key)` unique; replay returns the stored response; a different request
  hash with the same key → 409.
- **Rate limits:** per user per route class (extract is the tightest, e.g. 10/min).
- **Logging:** request id, route, status, latency, actor id hash — never titles, descriptions,
  comments or chat text.
- **DTO validation:** zod schemas from `packages/contracts`, `strict()` (unknown keys rejected) so
  the extract payload and the create payload share one gate.

### 6.3 Defence in depth for isolation

Four independent layers, each individually tested: (1) role/permission check, (2) explicit
`branch_id` predicate in every query built by the repository layer, (3) RLS policy, (4) composite
FKs. A cross-branch test asserts failure at the API *and* at the SQL layer.

---

## 7. Assistant extraction pipeline

```
user text ──► length limit + sensitive-data guard (regex + heuristic, block or require confirm)
          ──► redaction (account-number-like, PAN-like, phone/email patterns)
          ──► provider adapter (hosted model, or rule-based fallback if AI off / provider error)
          ──► strict schema validation (zod .strict(); reject unknown keys)
          ──► semantic validation (category exists in branch, owner is active same-branch member,
              RFC 3339 due instant, IANA tz from branch allow-list, ≤5 reminders, bounded recurrence)
          ──► candidate card (inferred fields marked, absolute local time shown, ambiguities asked)
          ──► user edits → POST /tasks (the only write)
```

Implementation notes:

- `ExtractionCandidate` mirrors the spec's JSON 1.0 exactly; `confidence` is advisory and never
  used to decide anything automatically.
- **Low confidence or `needs_clarification`** → the form opens with that field empty and a prompt.
  The server rejects a task creation whose due/owner came from a low-confidence field without an
  explicit user-set flag, so "never invent" is enforced server-side, not just in the UI.
- **Deterministic fallback** (`packages/date` + keyword rules): parse priority words, category by
  keyword map, due date via a timezone-aware parser ("by Thursday", "tomorrow 4pm"), owner by exact
  display-name match only. It must return a usable draft so the form is never a dead end.
- **Kill switch:** `AI_ENABLED=false` (env + runtime flag in `branch_settings`) short-circuits to
  the fallback; the UI shows a neutral "assistant unavailable, draft created from your text" state
  and preserves the user's typed text across a provider outage.
- **No retention:** raw text is never written to DB or logs; only model/template version, latency
  and a bounded correction count are recorded (`ai.extraction_requested/_rejected` events).
- **Prompt-injection posture:** user text is delimited data; the model has no tools, credentials or
  DB access; output is validated as data regardless of content. Tests include injection strings
  ("ignore previous instructions, assign to…") which must simply fail schema/semantic validation
  or require confirmation.

---

## 8. Reminders and notifications

- Scheduler claims due rows with `SELECT ... FOR UPDATE SKIP LOCKED`, bounded batch, then writes
  delivery result — safe to run more than one worker.
- `dedupe_key = reminder_id + occurrence_key` (unique) prevents double sends across retries and
  redeploys; retries use exponential backoff up to N attempts, then `failed` + monitored.
- Schedule points: on assignment, pre-deadline (configurable offsets), at due time, and **at most
  one overdue per workday** until acknowledged or status change — the worker checks
  `branch_settings.work_days`, `holidays` and quiet hours before delivering, deferring to the next
  allowed window rather than dropping.
- Editing a task's due date invalidates stale pending reminders (compare `task_version_at_schedule`)
  and reschedules; dedupe keys stay stable per occurrence.
- In-app notifications store a **generic payload** (`{ type, task_id }`); the client fetches detail
  through the authorised task endpoint, so a notification never leaks a description. Push is
  deferred; if added, the same generic body rule applies.
- Quiet hours and per-event preferences are read from `notification_preferences`, not hard-coded.

---

## 9. Web client structure

Routes: `/sign-in`, `/` (home: branch, assistant + New Task equal prominence, due/overdue/blocked
cards, team queue by role, sync + notification state), `/chat`, `/tasks/new` (preview/edit),
`/tasks` (list: My/Team/Due/Overdue/Completed; sort due→priority), `/tasks/:id` (detail: lifecycle,
owner, deadline, comments, activity; role-limited actions), `/tasks/:id/edit` (form: same fields,
inline validation, explicit "no deadline"), `/notifications`, `/settings`, `/manage/*` (members,
categories, templates, reminder defaults, audit).

Engineering constraints that are part of the requirement, not polish:

- One primary action per screen; text labels beside colour; `aria-live` for validation and status
  changes; focus management on route change; ≥44px targets; reflow at 200% zoom; contrast checked.
- A central `useTaskMutation` handles `If-Match`, 409 (offer compare/reload), and 403/404 messaging.
- Strings and date formats go through one i18n layer from day one (FR-16) — retrofitting is
  expensive; English-only content initially.
- No description text placed in `localStorage`; later offline cache is IndexedDB with encrypted
  payloads (P1).

---

## 10. Build sequence

Each milestone ends with a demonstrable state and a check that must pass before the next begins.

**M0 — Foundation (2–3 days)**
Workspace scaffold, docker-compose Postgres, Prisma schema + first migration, RLS SQL, synthetic
seed (2 branches, 12 users), `GET /health`, CI running typecheck + lint + unit tests.
*Check:* `pnpm test` green; seed reproducible from empty DB.

**M1 — Identity, scope, permissions (3–4 days)**
Dev OIDC issuer, token verification, `actor` resolution, `GET /me`, permission matrix + full
denial test table, audit table with append-only trigger and hash chain.
*Check:* matrix tests pass; direct `UPDATE audit_events` fails as the app role.

**M2 — Task core (4–5 days)**
Create/list/detail/patch/status/comment/assign; versioning + `If-Match`; state machine; audit diffs
in-transaction; idempotency keys; filters, cursor pagination, sort.
*Check:* API tests for 201/403/404/409/422/429; concurrent update test yields exactly one 200 and
one 409.

**M3 — Dashboard, list, form (4–5 days)**
Shell + home cards + list + detail + form, mobile-first, a11y pass, role-limited actions.
*Check:* critical path Playwright test (form → create → appears in list → status change → audit
event visible to manager); axe scan with no serious violations on the main four screens.

**M4 — Assistant capture (3–4 days)**
Extraction provider interface, hosted adapter, deterministic fallback, guard/redaction, schema +
semantic validation, preview UI with confirmation gate, kill switch.
*Check:* synthetic evaluation set (≥30 sentences incl. injections and prohibited data) — 100%
rejection of unknown keys/prohibited values, 0 writes before confirm, latency p95 < 5s or fallback
engaged, app fully usable with `AI_ENABLED=false`.

**M5 — Reminders and notifications (3–4 days)**
Scheduler worker, dedupe, quiet hours/holidays/workdays, notification centre, ack, preferences.
*Check:* duplicate-run test produces one delivery per occurrence; quiet-hours deferral test; overdue
cap of one per workday; editing due date reschedules.

**M6 — Manager configuration and audit view (2–3 days)**
Categories CRUD, member/role management, templates, reminder defaults, audit read view (audited),
privacy notice, sign-out.
*Check:* role change and category change produce attributable audit rows; audit read emits
`audit.read`.

**M7 — Hardening for pilot (3–4 days)**
Rate limits, sensitive-data guard on comments, error-shape audit, log redaction review, backup
restore rehearsal on the chosen environment, dependency/secret scan, accessibility re-check,
synthetic-data-only guardrails.
*Check:* MVP acceptance list in spec §17 walked item by item with evidence recorded.

**P1 track (after pilot acceptance):** dependencies → handover → recurrence → offline sync →
analytics, in that order (dependency rules and version semantics are prerequisites for offline
conflict resolution).

Estimates assume one engineer familiar with the stack; they are engineering estimates, not the
sponsor-facing roadmap durations.

---

## 11. Test plan (mirrors spec §15)

| Area | Representative cases |
| --- | --- |
| Isolation | cross-branch list/detail/patch/assign → 404; RLS blocks raw SQL; composite FK blocks insert; ambiguous membership → 403 |
| Permissions | full matrix × role × ownership truth table; auditor cannot mutate; employee cannot reassign |
| Transitions | every legal edge; illegal edges 409/422; reopen/cancel without reason rejected; archived is read-only; done stamps actor/time |
| Dates/DST | "by Friday" with and without `deadline_convention`; date-only preserved; past date rejected; DST spring-forward/fall-back ambiguity asks; tz from branch not device |
| Concurrency | two PATCHes same version → one 409; idempotency replay returns same body; same key different body → 409 |
| Reminders | dedupe across worker restarts; quiet hours; holidays; overdue cap; retry/backoff; stale reminder invalidated on edit |
| Audit | append-only enforced; hash chain verifies; changes_json excludes secrets; audit read audited |
| Assistant | schema rejections; enum/length bounds; prohibited-data refusal; injection resistance; owner-not-in-branch rejected; AI-off fallback; provider timeout → draft preserved |
| P1 later | dependency cycles, recurrence idempotency, handover expiry, offline replay conflicts |

Fixtures are generated synthetic text; a linter rule forbids realistic customer identifiers in
fixtures and seeds.

---

## 12. Decisions needed before/while building

Blocking M0–M2 (I will proceed with the stated default if unanswered):

1. **Client shell:** mobile-first PWA (default) vs React Native vs native Android. Affects offline
   and distribution strategy, not the API.
2. **Dev auth:** local OIDC stub for the synthetic pilot (default) vs bank-approved identity
   provider from day one.
3. **Deployment target:** local/docker only for now (default) — hosting, region and KMS stay with
   bank review.

Blocking M3+ content:

4. Branch timezone, work days, workday end time, holidays, and the "by Friday" convention
   (end-of-business vs ask) — needed for the date service and reminder scheduler.
5. Category set and any task templates for the pilot branch.
6. Quiet hours defaults and reminder offsets (assignment notice, pre-deadline, overdue).
7. Whether leads may reassign any branch task (default: no, manager only).
8. AI provider, region, retention/training terms — or AI off, which is a fully supported mode.

Not blocking, needed before any live use (spec §19): naming/brand, retention and legal hold,
analytics/export rights, offline write scope, notification channels, SLO/RPO/RTO, and all bank
security/privacy/legal/records/compliance approvals.

---

## 13. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Cross-branch leak | four-layer isolation + RLS tests in CI as a release gate |
| Silent deadline drift from timezone bugs | single date service, exhaustive DST tests, absolute local time shown before confirm |
| Audit table silently mutable | DB grants + trigger + hash chain verifier, tested by attempting tampering |
| AI writes or invents data | extraction endpoint has no write capability; server-side confirmation flag for low-confidence fields |
| Scope creep into "compliance/performance" territory | explicit non-goals in README, no ranking endpoints, no scoring fields in schema |
| Single-branch demo mistaken for multi-branch ready | tenant/branch columns from day one; RLS and scoping tests include a foreign branch |
| Reminder storms | dedupe keys, workday cap, quiet hours, monitored dead-letter state |

---

## 14. Definition of done for the MVP

The build is done when, on synthetic data only:

- a new user signs in, sees their branch, and cannot see the second seeded branch by any endpoint
  or via direct SQL as the app role;
- a task can be created from chat (with preview + explicit confirm) and from the form, and nothing
  is persisted before confirmation;
- due/overdue/blocked/unassigned/team views and all filters work on a phone-width viewport with no
  serious accessibility violations;
- every status/priority/deadline/owner change is attributable in the audit view, and the audit table
  cannot be edited or deleted by the application role;
- reminders deduplicate, respect quiet hours and workdays, and send generic in-app text only;
- turning AI off leaves the product fully usable;
- the isolation, permission, transition, date, concurrency and reminder test suites pass in CI.

---

## 15. Suggested next step

Start **M0 + M1**: scaffold the monorepo, the Postgres schema with the §5.3 additions, RLS, the
synthetic seed, and the permission matrix with its test table. That establishes the security
backbone before any feature work, and it is the part most expensive to change later.
