#!/usr/bin/env node
/*
Golden-output test. Runs qase-sync.mjs against test/fixture with the Qase API
stubbed out, and diffs the report against expected.txt.

The fixture is small but deliberately exhaustive: between them a.spec.ts and
b.spec.ts fire every branch of the report - stale with and without a
replacement, missing with a clean proposal / an ambiguous pair / a candidate
already claimed by another test, the "... and N more" truncation, a duplicate,
a four-deep suite path, a Qase-side title prefix, a forEach with a literal ID
and with a property lookup, a non-numeric ID, both wrapper shapes, and 266
cases so the fetch pages three times.

Run with --update to re-record expected.txt after an intended change.
*/

import {spawnSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, 'fixture');
const expectedPath = join(here, 'expected.txt');

// The report prints the config's directory, which differs on every checkout.
const normalise = (text) => text.split(fixture).join('<fixture>');

// QASE_PROJECT_CODE is dropped rather than set: a stray value in the shell
// would override the fixture's config and print an extra warning.
const env = {...process.env, QASE_API_TOKEN: 'stub'};
delete env.QASE_PROJECT_CODE;

const run = spawnSync(process.execPath, [
  '--import', pathToFileURL(join(here, 'stub.mjs')).href,
  join(here, '..', 'qase-sync.mjs'),
], {cwd: fixture, env, encoding: 'utf8'});

if (run.error) {
  console.error(run.error);
  process.exit(1);
}

const actual = normalise(run.stdout);

if (process.argv.includes('--update')) {
  writeFileSync(expectedPath, actual);
  console.log(`recorded ${expectedPath}`);
  process.exit(0);
}

let failed = false;

// The fixture has drift in it, so 1 is the pass condition; 2 means the script
// itself failed and stderr is the interesting part.
if (run.status !== 1) {
  console.error(`FAIL: expected exit code 1, got ${run.status}`);
  if (run.stderr) console.error(run.stderr);
  failed = true;
}

const expected = readFileSync(expectedPath, 'utf8');
if (actual !== expected) {
  console.error(`FAIL: report does not match ${expectedPath}`);
  const actualLines = actual.split('\n');
  const expectedLines = expected.split('\n');
  for (let i = 0; i < Math.max(actualLines.length, expectedLines.length); i++) {
    if (actualLines[i] !== expectedLines[i]) {
      console.error(`  line ${i + 1}:`);
      console.error(`    expected: ${expectedLines[i] ?? '<end of file>'}`);
      console.error(`    actual:   ${actualLines[i] ?? '<end of file>'}`);
    }
  }
  console.error('\nIf the change was intended: node test/run.mjs --update');
  failed = true;
}

if (failed) process.exit(1);
console.log('ok: report matches expected.txt, exit code 1');
