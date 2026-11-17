# Contributing

Thanks for looking. This project is pre-alpha: the plan is the main artefact, and issues that argue
with the plan are as welcome as code.

## Ground rules

1. **Synthetic data only.** Never commit real customer, account, employee or bank data — including in
   fixtures, screenshots, logs or test names. Use obviously fake names and generated identifiers.
2. **No scope creep into the non-goals.** Transaction systems, customer/KYC data, core banking
   integrations, employee ranking and autonomous AI writes are out of scope by design. A pull request
   that adds one will be declined regardless of quality.
3. **Security-shaped changes need tests.** Anything touching branch isolation, permissions,
   concurrency or audit must ship with the negative test that proves the guard works.

## Local setup

The site has no build step:

```bash
python -m http.server 8080   # or: npx serve .
```

Application setup will be documented here once M0 lands (Docker Compose + `pnpm install` +
`pnpm db:migrate && pnpm db:seed`).

## Branching and commits

- Branch from `main`; keep branches short-lived and single-purpose.
- Commit subjects are imperative and specific: `Add due-date precision to task schema`, not `fixes`.
- Keep formatting-only changes in their own commit so review stays readable.
- Squash on merge.

## Pull requests

A pull request should state what changed, why, what was verified (command and result), and what was
**not** verified. Screenshots help for anything visual.

Reviewers check, in order: does it respect the non-goals, does it respect branch isolation, does it
handle time correctly, is the audit trail intact, is it accessible.

## Code conventions

- TypeScript strict mode everywhere; no `any` in shared contracts.
- Validation lives in `packages/contracts` so the client and server agree by construction.
- Dates go through `packages/date`. Constructing a `Date` from a string anywhere else is a review
  comment.
- Error responses follow RFC 7807 problem details.
- The client may hide an action it cannot perform; the server must refuse it independently.

## Reporting a problem

Security issues: see [`SECURITY.md`](./SECURITY.md), not a public issue. Everything else: open an
issue with the smallest reproduction you have.
