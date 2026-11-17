# Roadmap

Status: **planning**. The site is live; the application is not built yet.

Sequencing follows one rule: the security backbone (isolation, permissions, concurrency, audit) is
proven before features are layered on top, because retrofitting those guarantees is the most
expensive mistake available to this project.

Estimates are engineer-days for a single experienced developer, not calendar commitments.

## M0 — Foundations (~3 days)

Monorepo scaffold, Docker Compose Postgres, Prisma baseline schema with the §5.3 additions, CI that
runs typecheck, lint and tests, synthetic two-branch seed.

**Done when** `docker compose up` yields a seeded database and CI is green on an empty app.

## M1 — Security backbone (~6 days)

Local OIDC stub, session/device table, workspace→branch→role resolution, permission matrix, RLS
policies, append-only audit with hash chain, denial-test table covering every matrix cell and
cross-branch access.

**Done when** every permission cell and every cross-branch request has a failing test proving denial.

## M2 — Task core (~5 days)

Create/read/update with `If-Match` versioning and `409` reconciliation, status state machine with
required reasons, activity feed with before/after, soft delete, list endpoint with filters and sort
(due, then priority).

**Done when** two concurrent writers cannot silently overwrite each other, and no transition is
possible off the allow-list.

## M3 — Capture (~4 days)

`POST /assistant/extract`: allow-list, schema validation, sensitive-data guard, provider-neutral
adapter, deterministic fallback, kill switch, and a client preview step with a hard confirmation
gate.

**Done when** extraction output with no confirmation creates zero rows, and the kill switch leaves
form-based creation fully working.

## M4 — Board & lifecycle (~4 days)

Dashboard (due today, overdue, blocked, team), filters, sorting, detail view, comments, assignment
and reassignment with notifications.

**Done when** the MVP acceptance path works end to end on a phone viewport.

## M5 — Reminders (~3 days)

Job table, scheduler worker, due and overdue reminder rules, dedupe keys, quiet hours, holidays,
retries with backoff, delivery audit.

**Done when** duplicate suppression holds under a forced double-run of the scheduler.

## M6 — P1 workflow (~6 days)

Dependencies with cycle detection, shift handover propose/accept/decline, recurring tasks materialised
under an explicit rule, branch-configurable categories.

## M7 — P1 resilience & insight (~5 days)

Offline operation queue with idempotent replay and visible conflicts, analytics summary, accessibility
pass (`axe` clean on primary flows), performance budget check.

## Definition of done for the pilot

- Two branches seeded; neither can read or write the other's data, proven by tests.
- A task can be created by chat or form, edited, reassigned, blocked, completed and reopened with a
  complete, tamper-evident trail.
- Reminders are deduplicated and respect quiet hours.
- Audit export is readable and attributable.
- The primary flows pass an accessibility check and work on a 360px viewport.
- No real customer or bank data anywhere in the repository, fixtures or test runs.

## Explicitly out of scope

Transaction systems, customer/KYC data, core banking integrations, employee ranking, autonomous AI
actions, and any deployment to a bank environment. Those are decisions for a sponsor and a security
review, not for this plan.
