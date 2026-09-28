# Context

This repo *is* the tool: `./qase-sync.mjs`, a ~920-line Node ESM script that reconciles the
Qase IDs in a Cypress project's specs against Qase TestOps, using ts-morph to read and
rewrite the specs. It ships as an npm package with a `bin`, so consuming projects install it
rather than vendoring it. `README.md` is the conceptual doc; `test/` holds a stubbed-API
golden test with its own fixture project.

It was extracted from `.github/scripts/qase-sync/` in `rancher/rancher-turtles-e2e`, which
still carries a copy on its `qase-sync-2` branch along with the `qase-id-check.yaml` workflow
that runs it monthly. Changes here do not reach that copy.

Read the script's header docstring and `README.md` first. Verify anything below against the
code before relying on it — this brief may have aged.

## Design decisions that are deliberate — do not "fix" them

1. **The tool is project-agnostic, and now lives outside every project it syncs.** It finds
   `qase-sync.config.json` by walking up from `process.cwd()`, never from `import.meta.url`.
   Since it is installed into `node_modules` or run via `npx`, its own location is somewhere
   irrelevant and anchoring anything to it is unambiguously wrong. There is no config at this
   repo's root — only `test/fixture` has one. Do not hardcode spec paths such as
   `tests/cypress/latest/e2e`.

2. **Two wrapper shapes, detected per test, never configured.**
   `qase(651, it('t', cb))` and `it(qase(651, 't'), cb)` are both valid and one project —
   even one file — may use both. `matchTest` distinguishes them structurally. A
   project-level "dialect" setting was proposed and explicitly rejected. Reading never
   guesses; only *inserting* a wrapper needs a choice, and `shapeChooser` takes it from the
   nearest already-wrapped test in the file, then the project majority, then gives up. The
   give-up path is intentional: a `defaultDialect` config key existed and was removed.

3. **Exit codes are a published contract**, documented in `README.md` and relied on by every
   consumer's workflow: 0 clean, 1 a human is needed, 2 error. Consumers treat 1 as a soft
   failure they still open a PR from, and >1 as a real failure. Manual-review entries count
   toward 1. Never collapse 1 and 2, and keep the top-level `.catch` that maps crashes to 2.
   Changing this breaks repos you cannot see.

4. **Matching is suite path + title; the ID is separate and authoritative.** See
   `compare`. Two ordered passes: pass 1 claims every live ID so pass 2's repairs can never
   steal one. Do not reorder them. A leading `RT-651: ` is stripped from *both* sides by
   `matchTitle`. `locationKey` joins with `\u0000` so a suite/title boundary can't collide.

5. **`--fix` edits by byte span, applied in descending offset order** so earlier spans keep
   their offsets. Any new edit must go through the same queue in `applyFixes`.

6. **The forEach harvester is load-bearing.** Loop-generated tests can't be read
   statically, so they go to manual review, and `harvestLoopIds` claims the IDs they
   mention to stop those cases being reported as orphans. It reads the ID property name
   from the `qase()` call rather than assuming `qaseID`.

7. **These AST branches look speculative but are exercised by real specs.** None of those
   specs are in this repo, so nothing here will fail if you delete a branch — `test/fixture`
   covers some but not all of them. Do not treat them as dead code:
    - `qase(id, (cond ? it.skip : it))('title', …)` — rancher-turtles-e2e
      `providers_setup.spec.ts:70`
    - `(cond ? it.skip : it)('title', …)` — rancher-turtles-e2e
      `capz_rke2_clusterclass.spec.ts:80`
    - destructured `forEach(({qase_id, …}) =>` — fleet-e2e `p0_fleet.spec.ts:69` and others
    - property rename `forEach(({ name: chartName }) =>` — fleet-e2e
      `appco_fleet_tests.spec.ts:312`
    - `xit` / `xdescribe` / `context`

8. **Comment policy: one home per fact.** The file was deliberately trimmed so each fact
   appears once — conceptual prose in `README.md`, wrapper shapes in `matchTest`'s
   docstring, the insertion rule in `shapeChooser`'s. Do not re-duplicate across the header,
   section banners and docstrings. If you change behaviour, update the one place that
   describes it plus `README.md`.

9. **The header is a `/* */` block comment.** A `*/` inside it terminates the comment and
   breaks the file — this happened once with a `**/legacy/**` glob in a JSON example.
   Never put `*/` in that block.

# Verification

Qase API credentials are usually not available, and are not needed for the first four steps.
Do them in order.

1. `node --check qase-sync.mjs`

2. `npm test` — runs the reporter against a stubbed Qase API over `test/fixture` and diffs the
   whole report against `test/expected.txt`. The fixture fires every branch: stale with and
   without a replacement, missing with a clean proposal / an ambiguous pair / a candidate
   already claimed, the `... and N more` truncation, a duplicate, a 4-deep suite path, a
   Qase-side title prefix, a `forEach` with a literal ID and with a property lookup, a
   non-numeric ID, both wrapper shapes, and 266 cases so the fetch pages three times.

   **A diff here is the point, not a nuisance.** Read every line of it and satisfy yourself the
   change explains it before running `node test/run.mjs --update`. Re-recording a golden file
   you have not read turns this test into decoration.

3. **If your change is comments/docs only**, prove the program is untouched — strip comments
   from both versions and diff; it must be empty:

   ```
   diff <(node test/strip.mjs qase-sync.mjs) <(node test/strip.mjs /path/to/old/qase-sync.mjs)
   ```

4. **If you changed the parser or the printers**, `npm test` alone is a small sample. Also run
   the script over a real Cypress checkout with an empty stub —
   `globalThis.fetch = async () => ({ok: true, json: async () => ({status: true, result: {total: 0, entities: []}})})`
   — which pushes every test in that repo through the parser and printers and reports them all
   as missing. rancher-turtles-e2e gives ~381 tests and ~790 lines of output. Diff it against
   the same run on the pre-change script.

5. **Live run**, if you have a token, from a consuming project's root with `QASE_PROJECT_CODE`
   unset so its config is the only source:

   ```
   QASE_API_TOKEN=<token> npx qase-sync
   ```

   For rancher-turtles-e2e the baseline as of 2026-09-28 was: `168 suites, 420 cases`,
   `381 tests in 39 file(s)`, `Wrapper shapes: test 367`, 3 stale / 14 missing / 0 duplicate /
   26 qase-only / 0 mismatched / 4 manual, exit 1. That is a fact about that repo on that day,
   not about this one — expect it to have moved, and re-baseline rather than assuming a
   regression.

6. **Never run `--fix` against a checkout you care about.** Copy it to a scratch directory,
   run there, and inspect `git diff`.

# Reporting

State plainly which verification steps ran and which you skipped for lack of credentials. Do
not claim a live report is unchanged if you only ran the stub.
