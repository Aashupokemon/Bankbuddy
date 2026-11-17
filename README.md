# BankBuddy

A shared task workspace for branch banking teams — capture work in a sentence, track it on one
board, and keep every change accountable.

> **Status: pre-alpha.** The public site is a coming-soon page. There is no application code in this
> repository yet; the design and build plan is in [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md).

**Repository:** <https://github.com/Aashupokemon/Bankbuddy>  
**Live page:** <https://aashupokemon.github.io/Bankbuddy/> (GitHub Pages)

---

## What this is

Branch teams carry work in chat threads, registers and memory. BankBuddy gives that work one shared
home:

- **Chat capture** — a free-text sentence becomes an extracted draft (task, owner, due date,
  priority). A person edits and confirms it; the model never writes.
- **One board** — due, overdue, blocked and team views with filters, sorting and comments.
- **Accountable by design** — status changes require a reason, edits keep before-and-after values,
  and the audit trail is append-only.

## What this is not

BankBuddy is an independent project on **synthetic data only**. It is not affiliated with or approved
by any bank, and nothing in this repository is a compliance, regulatory or security certification.

It deliberately does **not** include, now or in the pilot scope:

- transaction systems, ledgers or payment flows;
- customer, KYC or personally identifiable banking data;
- core banking, CRM or identity-provider integrations;
- employee ranking, scoring or performance measurement;
- autonomous AI actions — extraction produces drafts, never committed records.

## Repository layout

```
.
├── index.html              # public coming-soon page (served by GitHub Pages)
├── IMPLEMENTATION_PLAN.md  # full product + technical plan
├── docs/
│   ├── ARCHITECTURE.md     # stack, domain model, permissions, data integrity
│   ├── ROADMAP.md          # milestones M0–M7 and definition of done
│   ├── CONTRIBUTING.md     # local setup, conventions, review flow
│   └── SECURITY.md         # data policy, isolation rules, reporting
└── .github/workflows/      # GitHub Pages deployment
```

## Previewing the site locally

The page is a single static file with no build step and no dependencies.

```bash
# any static server works
python -m http.server 8080
# or
npx serve .
```

Then open <http://localhost:8080>.

## Deployment

GitHub Pages deploys `.github/workflows/pages.yml` on every push to `main` and can also be triggered
manually from the Actions tab. Pages must be configured with **Source: GitHub Actions**
(Settings → Pages). The site is plain HTML/CSS with a small inline script — no build, no secrets, no
third-party assets or fonts.

## Documentation

| Document | What it covers |
| --- | --- |
| [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) | Spec analysis, gaps, MVP scope cut, milestones, risks |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | Stack, monorepo layout, domain model, permission matrix |
| [`docs/ROADMAP.md`](./docs/ROADMAP.md) | Delivery milestones and what "done" means for each |
| [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md) | Branching, commit style, review expectations |
| [`docs/SECURITY.md`](./docs/SECURITY.md) | Data handling, isolation guarantees, reporting a problem |

## Contributing

See [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md). Security issues should follow
[`docs/SECURITY.md`](./docs/SECURITY.md) rather than a public issue.

## License

No license has been chosen yet. Until one is added, all rights are reserved and the code is public
for reading and review rather than reuse.
