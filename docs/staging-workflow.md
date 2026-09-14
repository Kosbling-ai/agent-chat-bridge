# Staging workflow

`staging` is the shared integration branch for changes that may later reach `main`. It starts from the current 0.2.3 development source. `main` remains the repository default branch and the promotion target.

## Integrate and test

Start each change from the latest `staging` in a topic worktree and keep its commits reviewable. After review, push the approved commit directly to `staging`; do not open a pull request merely to enter `staging`. Fixes found there follow the same reviewed direct-to-`staging` path so the tested branch contains the complete candidate. Pull requests are reserved for promotion from `staging` to `main`.

Run the checks appropriate to the change. The repository currently has no hosted CI workflow, so record the actual command results instead of treating a branch update as a passing check:

```sh
npm ci
npm test
npm run check
npm run version:check
```

Use `npm run test:storage` only through its task-owned disposable MySQL harness. Provider or local-instance validation requires separate authorization and an isolated staging configuration; it must not reuse production credentials, conversations, databases or writers. A source-only documentation change normally needs `npm run check`, `npm run version:check` and a whitespace/diff check.

## Promote

When the integrated candidate is stable, fetch the remote and inspect the exact promotion range:

```sh
git fetch origin
git log --oneline origin/main..origin/staging
git diff --stat origin/main..origin/staging
```

Open a pull request whose head is `staging` and base is `main`. A person reviews and merges it. Do not bypass the promotion by merging an untested topic branch directly into `main`. If an authorized emergency change ever lands on `main` first, bring it back to `staging` before further staging work so the branches do not silently diverge.

## Release boundary

Updating `staging`, opening or merging the promotion pull request, and releasing are separate operations. No branch action in this repository automatically deploys a service, runs a database migration, publishes npm, creates or moves a tag, or changes the default branch. Apply migrations and deploy only through their separately reviewed and authorized procedures. Test evidence is scoped to the environment actually exercised and does not establish production or real-provider acceptance.
