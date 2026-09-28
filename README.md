# qase-sync

Reconciles the Qase IDs in a Cypress project's specs against Qase TestOps. It is a standalone
tool: it reads its configuration from the project you run it in, so one copy serves any number
of Cypress repos.

Tests are tied to Qase TestOps cases by wrapping them. `cypress-qase-reporter` accepts the
wrapper in either of two places, and both are read:

```ts
qase(651, it('title', () => {}))    // the wrapper takes the test
it(qase(651, 'title'), () => {})    // the wrapper takes the title
```

The `describe`/`context` titles map 1:1 to the Qase suite tree and the `it` title to the case
title, so a test is identified by its suite path plus its title.

It compares the specs against the live Qase project and reports:

* **stale** — `qase(<id>, ...)` points at a case that no longer exists
* **missing** — an `it()` has no `qase(...)` wrapper
* **duplicate** — two tests carry the same `qase(<id>, ...)`, so one of them has to move
* **qase-only** — a Qase case that no local test claims
* **mismatched** — the ID resolves, but the case's title or suite path no longer matches the test

## Installing

Nothing needs to be vendored into the project being synced — it installs straight from git,
so there is no npm registry involved:

```
npx --yes github:valaparthvi/qase-sync#v1.0.0 --fix    # one-off, pinned to a tag
npm i -D github:valaparthvi/qase-sync#v1.0.0           # then: npx qase-sync --fix
```

Pin to a tag. Without the `#v1.0.0` you silently track whatever is on the default branch, and
a git install resolves `ts-morph` fresh rather than from this repo's lockfile, so the tag is
the only thing holding a consumer steady.

From a local checkout instead:

```
npm i -D /path/to/qase-sync    # or: (cd /path/to/qase-sync && npm link) then npm link qase-sync
```

## Running

```
export QASE_API_TOKEN=<your token>
npx qase-sync          # report only; exits 1 if anything needs a human
npx qase-sync --fix    # repair stale IDs and insert missing ones, in place
```

Run it **from the project being synced** — anywhere at or below that project's
`qase-sync.config.json` — not from the directory this tool is installed in. The config is
found by walking up from the working directory, and the working directory is the only thing
that decides which project gets read.

Pass flags directly: `npx qase-sync --fix`, never `npx qase-sync -- --fix`. npx forwards the
`--` through as a literal argument, and unrecognised arguments are rejected rather than
ignored — a dropped `--fix` would otherwise look like a clean report instead of a repair.

## Configuration

Which specs are read comes from `qase-sync.config.json` — the nearest one at or above the
working directory, so the project being synced is the one you are standing in, never the one
this tool lives in. Each Cypress project commits one of its own, usually at its repo root:

```json
{
  "projectCode": "RT",
  "specs": ["tests/cypress/latest/e2e/*.spec.ts"]
}
```

Paths are relative to the config file, and a glob starting with `!` excludes what it matches.
The glob above is deliberately non-recursive, which is what keeps a `legacy/` sub-folder out.
An unknown key is an error rather than being ignored, so a misspelt `"spec"` cannot quietly
leave the project reading nothing.

`QASE_API_TOKEN` is required. `QASE_PROJECT_CODE` is optional and overrides `projectCode`, for
syncing a checkout against a scratch Qase project — if it disagrees with the config the run
says so on stderr, since a stray value left in a shell otherwise compares one project's specs
against another project's cases in silence.

## What `--fix` will and will not do

Only stale, missing and duplicate are repaired, and only when exactly one unclaimed Qase case
matches the test's suite path and title; anything ambiguous is reported for you to resolve.
Qase-only cases always need a human — they are either a test that was never automated or a
duplicate case that should be deleted in Qase.

When a test needs a wrapper inserted, the shape is copied from the nearest already-wrapped test
in the same file, falling back to whichever shape the rest of the project uses. A project with
no wrapped test anywhere is left alone rather than guessed at: wrap one by hand and every run
after follows it.

A mismatch is only ever a warning and never fails the run: renaming a test or moving it between
`describe` blocks is a legitimate thing to do, and the ID still points at the right case. It is
printed so the drift is visible — either retitle the case in Qase or accept that the two sides
read differently. A leading `RT-651: ` on either side is ignored when matching; the ID that
counts is the one in the `qase()` call.

When no case matches, the report lists every Qase case sharing the test's title, marked
`unclaimed` or `claimed by <file>:<line>` — an unclaimed one is almost always the case the test
should point at, with the suite spelled differently on one of the two sides.

Each test carries exactly one ID. Anything the script cannot read as a plain number — tests
generated inside a `forEach` loop, or a `qase(...)` whose ID is an expression — is listed under
**needs manual review** and left untouched. Those entries do fail the run: the exit code is 1
whenever anything is left for a person, whether or not `--fix` repaired the rest.

## Exit codes

| code | meaning |
|---|---|
| 0 | clean |
| 1 | a human is needed — stale, missing, duplicate, or anything under manual review |
| 2 | the run itself failed: bad arguments, no token, no config, Qase unreachable |

CI should treat 1 as a soft failure worth raising a PR from, and anything above it as a real
one. Qase-only cases and title/suite mismatches never affect the exit code; no change to the
specs would resolve them.

## Using it in CI

A minimal monthly job for a consuming repo:

```yaml
name: Qase ID check
on:
  schedule:
    - cron: '0 6 1 * *'
  workflow_dispatch:

jobs:
  qase-id-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: current
      - env:
          QASE_API_TOKEN: ${{ secrets.QASE_API_TOKEN }}
        run: |
          EXIT_CODE=0
          npx --yes github:valaparthvi/qase-sync#v1.0.0 --fix || EXIT_CODE=$?
          # Above 1 is a genuine failure; 1 just means something was left for a person.
          [ "${EXIT_CODE}" -gt 1 ] && exit "${EXIT_CODE}"
          exit 0
```

`npx` runs from the repository root, which is where the consuming project's
`qase-sync.config.json` lives, so nothing else needs configuring.

This only works while **this repo is public**. A consumer's `GITHUB_TOKEN` is scoped to its
own repository, so installing from a private tool repo would need a PAT and git URL rewriting.

That leaves the repaired specs uncommitted. For a fuller worked example — committing the fixes
to a throwaway branch, opening or updating a PR with the report in its body, and failing the
job at the end if any ID still needs a human — see `.github/workflows/qase-id-check.yaml` in
[rancher/rancher-turtles-e2e](https://github.com/rancher/rancher-turtles-e2e).

## Developing

`npm test` runs the whole reporter against a stubbed Qase API and diffs the output against
`test/expected.txt`. The fixture in `test/fixture` is small but fires every branch of the
report. After an intended change: `node test/run.mjs --update`, then read the diff.

`AGENTS.md` records the design decisions that are easy to undo by accident.
