# Security and data policy

## Data policy

**Synthetic data only.** This repository, its fixtures and its running environments must never contain
real customer, account, KYC, transaction or employee data. Names, account numbers and branches in
seeds and tests are fabricated. If you believe real data has entered the project, stop and report it
privately rather than opening an issue.

No credentials belong in the repository: no API keys, tokens, connection strings or certificates.
Configuration arrives through environment variables, `.env` files stay untracked, and the commit
history is treated as public and permanent.

## What this project is not

BankBuddy is an independent pilot. Nothing here is a bank approval, a compliance opinion, a
penetration-test result or a certification. Absence of a documented control is not evidence that the
control exists.

## Isolation guarantees the build must keep

These are the invariants contributors are expected to defend in review:

1. **Scope comes from identity.** Branch and workspace are resolved from the authenticated membership
   on every request. A client-supplied `branch_id`, `workspace_id` or role is ignored, never trusted.
2. **Defence in depth.** Query-level scoping *and* database row-level security. A forgotten filter
   fails closed rather than leaking.
3. **Deny by default.** New endpoints start closed and require an explicit permission rule plus a
   negative test.
4. **No enumeration.** Resource IDs that a caller cannot see return `404`, not `403`, where returning
   `403` would confirm existence.
5. **Audit is append-only.** `audit_events` cannot be updated or deleted, and reads of audit are
   themselves audited.
6. **AI cannot write.** Extraction runs with no write access and its output is discarded unless a
   human confirms it. It is schema-validated, allow-listed and kill-switchable.
7. **Sessions are revocable.** Sessions and devices are recorded so access can be withdrawn.

## Reporting a vulnerability

Do not open a public issue. Contact the repository owner privately with:

- a description of the issue and the impact you believe it has;
- the smallest reproduction you can manage;
- whether you accessed any data that was not yours (and if so, stop and say so).

Please do not run tests against other people's data, do not pivot from a finding into further access,
and give reasonable time to fix before disclosing publicly.

## Known limitations

The project is pre-alpha. There is no production deployment, no formal incident process and no
security review yet. The current public surface is a static coming-soon page with no data collection,
no cookies, no analytics and no third-party requests.
