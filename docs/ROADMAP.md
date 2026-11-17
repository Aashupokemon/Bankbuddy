# Roadmap

Status: **M0–M7 implemented for the pilot**, on synthetic data, with the gaps listed at the bottom.

Sequencing followed one rule: the security backbone (isolation, permissions, concurrency, audit) was
built and tested before features were layered on top.

## M0 — Foundations ✅

npm workspaces (`apps/api`, `apps/worker`, `apps/mobile`, `packages/*`), strict TypeScript, migration
runner, synthetic two-branch seed, CI workflow, `.env.example`.

## M1 — Security backbone ✅

Dev sign-in issuing session tokens (hashed at rest), workspace→branch→role resolution from
membership, permission matrix in `packages/contracts`, row-level security on every branch-owned table
enforced through a non-owner role, append-only audit with a per-branch hash chain, and a denial test
per matrix edge — including cross-branch reads returning 404 rather than 403.

## M2 — Task core ✅

Create/read/update with `If-Match`-style versioning and `409` reconciliation, status state machine
with required reasons, activity feed with before/after, soft delete, and list filtering/sorting by
due date then priority.

## M3 — Capture ✅

`POST /assistant/extract` with schema validation, sensitive-data redaction, an optional
OpenAI-compatible provider, a deterministic rule extractor as fallback, a kill switch, and an
explicit `requiresConfirmation` contract. Extraction never writes.

## M4 — Board & lifecycle ✅

Dashboard counts (overdue, due today, blocked, in progress, mine, unassigned), upcoming list, team
load, task detail with comments, reassignment, and an Android client for all of it.

## M5 — Reminders ✅

Reminder rows generated per occurrence with unique dedupe keys, delivery honouring quiet hours and
holidays, retries with an attempt counter, and notification fan-out to the owner (or the branch leads
when unowned).

## M6 — P1 workflow ✅

Dependencies with recursive cycle detection, shift handover (propose → accept/decline, ownership
moves on accept), recurrence materialised on completion, branch-configurable categories.

## M7 — Resilience & insight ✅ / partly

Offline operations endpoint with idempotent replay and explicit conflicts; a durable on-device queue
that survives an app restart and replays on the next launch; analytics summary; audit verification
endpoint; accessibility labels and 44pt touch targets throughout the app.

## What is not done

- **No APK artifact.** The JS bundle builds (`npm run mobile:bundle`); producing an installable APK
  needs EAS or a local Android SDK, neither of which is available in this environment.
- **No UI automation.** Backend behaviour is covered by 38 tests; the screens are typechecked and
  bundled, not driven.
- **Sync reports conflicts, it does not merge them.**
- **The AI provider path is untested against a live model** — only the rule fallback is exercised.
- **No deployment.** No staging environment, no load test, no penetration test, no accessibility
  audit beyond labels and target sizes.

## Definition of done for the pilot

- Two branches seeded; neither can read or write the other's data, proven by tests. ✅
- A task can be created by chat capture or form, edited, reassigned, blocked, completed and reopened
  with a complete tamper-evident trail. ✅
- Reminders are deduplicated and respect quiet hours. ✅
- Audit export is readable and attributable. ✅ (JSON via the API; no CSV export yet)
- Accessibility check and a 360px viewport pass. ⚠️ Labels and target sizes are in place; no audit run.
- No real customer or bank data anywhere. ✅

## Explicitly out of scope

Transaction systems, customer/KYC data, core banking integrations, employee ranking, autonomous AI
actions, and any deployment to a bank environment.
