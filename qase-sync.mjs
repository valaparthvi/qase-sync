#!/usr/bin/env node
/*
Keeps the Qase IDs in a Cypress project's specs in sync with the Qase project.

Reports, and optionally fixes, four kinds of drift between the specs and Qase
TestOps:

  stale     qase(<id>, ...) points at a case that no longer exists
  missing   an it() has no qase(...) wrapper at all
  duplicate two tests carry the same qase(<id>, ...), so one of them has to move
  qase-only a Qase case that no local test claims

Local tests match Qase cases on the suite path plus the test title:
describe()/context() titles map 1:1 to the Qase suite tree, and the it() title
maps to the case title. A leading FLEET-128: in either title is ignored when
matching - the ID that counts is the one in the qase() call.

cypress-qase-reporter accepts the wrapper in two places; both are read, per
test - see matchTest.

Installed as a bin, so it is run from the project being synced, not from here:
    QASE_API_TOKEN=... npx qase-sync                # report
    QASE_API_TOKEN=... npx qase-sync --fix          # report and rewrite

Which specs are read comes from the nearest qase-sync.config.json found by
walking up from the working directory - so the project being synced is the one
you are standing in, never the one this script happens to live in. All paths in
it are relative to the config file, and a glob starting with ! excludes:

    {
      "projectCode": "RT",
      "specs": ["tests/cypress/latest/e2e/*.spec.ts"]
    }

QASE_API_TOKEN is required. QASE_PROJECT_CODE is optional and overrides
projectCode, for syncing a checkout against a scratch Qase project.

Exit codes: 0 clean, 1 needs a human, 2 error. Exit 1 covers stale, missing and
duplicate - which --fix removes - plus the manual-review list, which it cannot.
qase-only cases and title/suite mismatches never fail the run; no change to the
specs would resolve them.
*/

import {existsSync, readFileSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {Node, Project, SyntaxKind} from 'ts-morph';

const QASE_API = 'https://api.qase.io/v1';
const PAGE_SIZE = 100;

const CONFIG_NAME = 'qase-sync.config.json';

const IT_NAMES = new Set(['it', 'xit']);
const SUITE_NAMES = new Set(['describe', 'context', 'xdescribe', 'xcontext']);
const QASE_NAME = 'qase';

// --------------------------------------------------------------------------- //
// Qase API
// --------------------------------------------------------------------------- //

/** Fetch every entity of a kind ('suite' or 'case') for a project. */
async function qaseFetchAll(kind, project, token) {
  const entities = [];
  let total = null;
  for (let offset = 0; ;) {
    const url = `${QASE_API}/${kind}/${project}?limit=${PAGE_SIZE}&offset=${offset}`;
    const response = await fetch(url, {headers: {Token: token}});
    if (!response.ok) {
      throw new Error(`Qase API ${url} returned ${response.status}: ${await response.text()}`);
    }
    const payload = await response.json();
    if (!payload.status) throw new Error(`Qase API ${url} failed: ${JSON.stringify(payload)}`);
    const batch = payload.result.entities ?? [];
    entities.push(...batch);
    if (total === null) total = payload.result.total ?? null;
    offset += batch.length;
    if (total !== null && offset >= total) return entities;
    if (batch.length > 0) continue;

    // A short page before the reported total means the fetch was truncated.
    // Comparing against half a project invents both stale IDs and orphaned
    // cases, so refuse rather than report nonsense.
    if (total === null) return entities;
    throw new Error(`Qase API ${kind} returned ${entities.length} of ${total} reported entities`);
  }
}

/** suite id -> array of titles, from the root suite down to that suite. */
function buildSuitePaths(suites) {
  const byId = new Map(suites.map((suite) => [suite.id, suite]));
  const paths = new Map();
  const resolvePath = (id) => {
    if (paths.has(id)) return paths.get(id);
    const suite = byId.get(id);
    const prefix = byId.has(suite.parent_id) ? resolvePath(suite.parent_id) : [];
    const path = [...prefix, suite.title];
    paths.set(id, path);
    return path;
  };
  for (const id of byId.keys()) resolvePath(id);
  return paths;
}

// --------------------------------------------------------------------------- //
// Reading the specs
//
// Only literal titles and IDs are understood. Anything computed - the forEach
// loops that generate tests - is handed back to the user instead.
// --------------------------------------------------------------------------- //

/** A string literal's value, or null if the title is not a plain literal. */
function literalTitle(node) {
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return node.getLiteralValue();
  }
  return null;
}

/** The case ID a qase() call declares, or null if it is not a plain number. */
function literalId(node) {
  return Node.isNumericLiteral(node) ? node.getLiteralValue() : null;
}

/**
 * Every number under a node, ignoring array indexes such as `qaseID[0]`.
 *
 * Used to claim the cases named by an expression we cannot otherwise read, so
 * they are not reported as orphans.
 */
function numericLiterals(node) {
  const literals = node.getDescendantsOfKind(SyntaxKind.NumericLiteral);
  if (Node.isNumericLiteral(node)) literals.push(node);
  return literals
    .filter((literal) => !Node.isElementAccessExpression(literal.getParent()))
    .map((literal) => literal.getLiteralValue());
}

/** The initializer of the `const` an identifier names, searched file-wide. */
function declaredValue(identifier) {
  const name = identifier.getText();
  const declaration = identifier.getSourceFile()
    .getDescendantsOfKind(SyntaxKind.VariableDeclaration)
    .find((candidate) => candidate.getName() === name);
  return declaration?.getInitializer() ?? null;
}

/**
 * The Qase IDs held under `propertyNames` in the table a loop iterates over.
 *
 * The table may be written inline or - as the specs do - declared as a const
 * just above the loop. Only the properties the loop actually passes to qase()
 * are read: a bare list of numbers is never claimed as IDs, since
 * `[3, 153].forEach(...)` is indistinguishable from a loop over ordinary values
 * and claiming those would hide real cases from the report.
 */
function idTableLiterals(receiver, propertyNames) {
  if (!propertyNames.length) return [];
  const table = Node.isIdentifier(receiver) ? declaredValue(receiver) : receiver;
  if (!table) return [];
  return table
    .getDescendantsOfKind(SyntaxKind.PropertyAssignment)
    .filter((property) => propertyNames.includes(property.getName()))
    .flatMap((property) => {
      const value = property.getInitializer();
      return value ? numericLiterals(value) : [];
    });
}

/**
 * True when a callee resolves to one of `names`, seeing through the `.skip` /
 * `.only` suffixes and the `(cond ? it.skip : it)` form the specs use.
 */
function isCalleeNamed(node, names) {
  if (Node.isIdentifier(node)) return names.has(node.getText());
  if (Node.isPropertyAccessExpression(node)) return isCalleeNamed(node.getExpression(), names);
  if (Node.isParenthesizedExpression(node)) return isCalleeNamed(node.getExpression(), names);
  if (Node.isConditionalExpression(node)) {
    return isCalleeNamed(node.getWhenTrue(), names) || isCalleeNamed(node.getWhenFalse(), names);
  }
  return false;
}

/** True for `it`, `xit`, `it.skip` and `(cond ? it.skip : it)`. */
const isItCallee = (node) => isCalleeNamed(node, IT_NAMES);

/** True for `describe`, `context` and their `x`-prefixed and `.skip`/`.only` forms. */
const isSuiteCallee = (node) => isCalleeNamed(node, SUITE_NAMES);

/** True for a direct `qase(...)` call, and nothing else. */
function isQaseCall(node) {
  if (!Node.isCallExpression(node)) return false;
  const callee = node.getExpression();
  return Node.isIdentifier(callee) && callee.getText() === QASE_NAME;
}

/** The last function-valued argument of a call - the callback, for our purposes. */
function callbackArgument(call) {
  return [...call.getArguments()]
    .reverse()
    .find((argument) => Node.isArrowFunction(argument) || Node.isFunctionExpression(argument)) ?? null;
}

/** The `{ ... }` body of the last arrow-function argument of a call. */
function arrowBody(call) {
  const body = callbackArgument(call)?.getBody();
  return body && Node.isBlock(body) ? body : null;
}

/**
 * Local name -> property name for a callback's single parameter.
 *
 * `(provider) => ...` binds the whole element, so `provider` maps to nothing and
 * the property is read at the use site instead. `({qaseID, type: kind}) => ...`
 * binds two properties, one of them renamed.
 */
function parameterBindings(callback) {
  const [parameter] = callback?.getParameters() ?? [];
  const name = parameter?.getNameNode();
  if (!name) return {element: null, destructured: new Map()};
  if (!Node.isObjectBindingPattern(name)) return {element: name.getText(), destructured: new Map()};
  const destructured = new Map(
    name.getElements().map((element) => [
      element.getName(),
      (element.getPropertyNameNode() ?? element.getNameNode()).getText(),
    ]),
  );
  return {element: null, destructured};
}

/**
 * The table properties a loop passes to qase() as the case ID.
 *
 * Read from the call rather than assumed, so the key can be named anything:
 * `(provider) => qase(provider.caseId, ...)` names `caseId`, and the
 * destructured `({qaseID}) => qase(qaseID, ...)` names `qaseID`. A loop whose
 * qase() argument is not a property of the loop variable names nothing, and
 * nothing is then claimed from its table.
 */
function idPropertyNames(forEachCall, qaseCalls) {
  const {element, destructured} = parameterBindings(callbackArgument(forEachCall));
  const names = new Set();
  for (const call of qaseCalls) {
    let [idNode] = call.getArguments();
    // provider.ids[0] reads `ids`, same as provider.ids does.
    while (idNode && Node.isElementAccessExpression(idNode)) idNode = idNode.getExpression();
    if (!idNode) continue;
    if (element && Node.isPropertyAccessExpression(idNode) && idNode.getExpression().getText() === element) {
      names.add(idNode.getName());
    } else if (Node.isIdentifier(idNode) && destructured.has(idNode.getText())) {
      names.add(destructured.get(idNode.getText()));
    }
  }
  return [...names];
}

/**
 * Qase IDs mentioned by a loop we are skipping.
 *
 * Two sources are trusted: the numbers in the first argument of a qase() call
 * inside the loop, and the table entries that argument reads - that is where the
 * IDs live when the call site says `qase(provider.qaseID, ...)`.
 */
function harvestLoopIds(forEachCall) {
  const qaseCalls = forEachCall.getDescendantsOfKind(SyntaxKind.CallExpression).filter(isQaseCall);
  const receiver = forEachCall.getExpression().getExpression();
  const ids = new Set(idTableLiterals(receiver, idPropertyNames(forEachCall, qaseCalls)));
  for (const call of qaseCalls) {
    const [idNode] = call.getArguments();
    if (idNode) numericLiterals(idNode).forEach((id) => ids.add(id));
  }
  return [...ids];
}

// --------------------------------------------------------------------------- //
// Wrapper shapes
// --------------------------------------------------------------------------- //

/**
 * The nodes that make up a test, in whichever shape it is written:
 *
 *   test    qase(651, it('title', () => {}))    the wrapper takes the test
 *   title   it(qase(651, 'title'), () => {})    the wrapper takes the title
 *
 * A project, or a single file, may use both. Reading never has to choose: the
 * two are structurally distinct - qase() outside the it() call, or inside as
 * its first argument. Only inserting a wrapper that is not there yet involves a
 * decision; see shapeChooser.
 *
 * Returns `shape: null` for an it() with no wrapper, since there is nothing to
 * read a shape from.
 */
function matchTest(node) {
  // qase(...) outside: qase(id, it(...)), and the qase(id, callee)('title', ...)
  // variant where the wrapper is itself the callee of the test call.
  if (isQaseCall(node)) {
    const [idNode, wrapped] = node.getArguments();
    const parent = node.getParent();
    const itCall = Node.isCallExpression(parent) && parent.getExpression() === node
      ? parent
      : (wrapped && Node.isCallExpression(wrapped) && isItCallee(wrapped.getExpression()) ? wrapped : null);
    if (!itCall) return null;
    return {itCall, idNode: idNode ?? null, titleNode: itCall.getArguments()[0] ?? null, shape: 'test'};
  }

  if (!Node.isCallExpression(node) || !isItCallee(node.getExpression())) return null;

  // qase(...) inside, in place of the title.
  const [first] = node.getArguments();
  if (first && isQaseCall(first)) {
    const [idNode, titleNode] = first.getArguments();
    return {itCall: node, idNode: idNode ?? null, titleNode: titleNode ?? null, shape: 'title'};
  }

  return {itCall: node, idNode: null, titleNode: first ?? null, shape: null};
}

const INSERTERS = {
  // Wrapping the whole statement keeps the trailing semicolon correct.
  test(test, id, fullText) {
    if (!test.statementSpan) return null;
    const [start, end] = test.itSpan;
    return {
      span: test.statementSpan,
      text: `qase(${id}, ${fullText.slice(start, end)}\n${test.indent});`,
    };
  },

  // Only the title argument moves, so tags and callback stay untouched.
  title(test, id, fullText) {
    if (!test.titleSpan) return null;
    const [start, end] = test.titleSpan;
    return {span: test.titleSpan, text: `qase(${id}, ${fullText.slice(start, end)})`};
  },
};

/**
 * Decides the shape to write a new wrapper in: the nearest wrapped test in the
 * same file, then the rest of the project, then nothing.
 *
 * Copying the neighbour is what a person editing that file would do, and it
 * stays right in a file that mixes the two. A project with no wrapper anywhere
 * is left alone rather than guessed at; wrapping one test by hand answers it
 * for every run after.
 */
function shapeChooser(tests) {
  const perFile = new Map();
  const totals = new Map();
  for (const test of tests) {
    if (!test.shape) continue;
    if (!perFile.has(test.file)) perFile.set(test.file, []);
    perFile.get(test.file).push(test);
    totals.set(test.shape, (totals.get(test.shape) ?? 0) + 1);
  }
  const overall = [...totals].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const choose = (test) => {
    const neighbours = perFile.get(test.file) ?? [];
    if (!neighbours.length) return overall;
    return neighbours.reduce((best, candidate) => (
      Math.abs(candidate.line - test.line) < Math.abs(best.line - test.line) ? candidate : best
    )).shape;
  };
  return {choose, totals};
}

/** Leading whitespace of the line a node starts on. */
function indentOf(node) {
  const text = node.getSourceFile().getFullText();
  const lineStart = text.lastIndexOf('\n', node.getStart()) + 1;
  return text.slice(lineStart, node.getStart()).match(/^\s*/)[0];
}

/**
 * Walk one spec file.
 *
 * Returns the tests it could read, the constructs it refused to read, and the
 * IDs harvested from those constructs so their cases are not reported as
 * orphans.
 */
function readSpec(sourceFile, file) {
  const tests = [];
  const manual = [];
  const harvested = new Set();

  /** Record a test, given the nodes it was recognised by. */
  const record = ({itCall, idNode, titleNode, shape}, suite) => {
    const line = itCall.getStartLineNumber();
    const id = idNode ? literalId(idNode) : null;

    // Already wrapped, but the ID is computed: we can neither check nor repair
    // it. Claim whatever numbers it mentions so the cases are not reported as
    // orphans, and leave the call itself alone - re-wrapping it would be wrong.
    if (idNode && id === null) {
      const ids = numericLiterals(idNode);
      ids.forEach((value) => harvested.add(value));
      manual.push({file, line, suite, ids, note: 'qase() ID is not a plain number'});
      return;
    }

    const statement = itCall.getFirstAncestorByKind(SyntaxKind.ExpressionStatement);
    tests.push({
      file,
      line,
      suite,
      title: titleNode ? literalTitle(titleNode) : null,
      id,
      shape,
      idSpan: idNode ? [idNode.getStart(), idNode.getEnd()] : null,
      titleSpan: titleNode ? [titleNode.getStart(), titleNode.getEnd()] : null,
      itSpan: [itCall.getStart(), itCall.getEnd()],
      statementSpan: statement ? [statement.getStart(), statement.getEnd()] : null,
      indent: indentOf(statement ?? itCall),
    });
  };

  const walk = (node, suite) => {
    for (const child of node.getChildren()) {
      // describe(...) / context(...): descend with the suite path extended.
      if (Node.isCallExpression(child) && isSuiteCallee(child.getExpression())) {
        const [titleArg] = child.getArguments();
        const body = arrowBody(child);
        if (body) walk(body, [...suite, titleArg ? literalTitle(titleArg) ?? titleArg.getText() : '?']);
        continue;
      }

      // x.forEach(...): generates tests we cannot read statically. Hand the
      // whole loop to a human, claiming the IDs it names so they are not also
      // reported as orphans.
      if (Node.isCallExpression(child)
          && Node.isPropertyAccessExpression(child.getExpression())
          && child.getExpression().getName() === 'forEach'
          && arrowBody(child)) {
        const ids = harvestLoopIds(child);
        ids.forEach((id) => harvested.add(id));
        manual.push({
          file, line: child.getStartLineNumber(), suite, ids,
          note: 'tests generated in a forEach loop',
        });
        continue;
      }

      // A test, in whichever shape it is written. Not descending afterwards is
      // what keeps the wrapper and the it() it holds from being counted twice.
      const found = matchTest(child);
      if (found) {
        record(found, suite);
        continue;
      }

      walk(child, suite);
    }
  };

  walk(sourceFile, []);
  return {tests, manual, harvested};
}

// --------------------------------------------------------------------------- //
// Comparison
// --------------------------------------------------------------------------- //

const samePath = (a, b) => a.length === b.length && a.every((part, i) => part === b[i]);

/**
 * A title reduced to the part that identifies the case.
 *
 * A leading `FLEET-128: ` is dropped. Some projects repeat the case ID in the
 * title, but the ID this script reads and writes is the one in the qase() call,
 * so the prefix is decoration and a test that carries it is the same test that
 * does not. Both sides are normalised, so it makes no difference whether the
 * spec, the Qase case, or neither spells it out.
 */
const matchTitle = (title) => title.replace(/^\s*[A-Za-z][\w.]*-\d+\s*:\s*/, '');

const locationKey = (suite, title) => `${suite.join(' › ')}\u0000${matchTitle(title)}`;

function compare(tests, cases, suitePaths, harvested) {
  const caseById = new Map(cases.map((c) => [c.id, c]));
  const byLocation = new Map();
  const byTitle = new Map();
  for (const entry of cases) {
    const key = locationKey(suitePaths.get(entry.suite_id) ?? [], entry.title);
    if (!byLocation.has(key)) byLocation.set(key, []);
    byLocation.get(key).push(entry.id);
    const title = matchTitle(entry.title);
    if (!byTitle.has(title)) byTitle.set(title, []);
    byTitle.get(title).push(entry.id);
  }

  const claimed = new Map();
  const stale = [];
  const missing = [];
  const duplicate = [];
  const mismatched = [];

  // Pass 1: honour every ID that still exists, so a repair can never steal it.
  for (const test of tests) {
    if (test.id !== null && caseById.has(test.id) && !claimed.has(test.id)) claimed.set(test.id, test);
  }
  for (const id of harvested) {
    if (caseById.has(id) && !claimed.has(id)) claimed.set(id, 'loop');
  }

  /**
   * The Qase case a test should point at, or the reason there isn't one.
   *
   * When the lookup fails, `candidates` carries the cases worth looking at by
   * hand: the ones at this exact location if any exist, otherwise every case
   * sharing the title, since a case that moved suite is still the same case.
   */
  const findReplacement = (test) => {
    if (test.title === null) {
      return {id: null, reason: 'title is not a plain string literal', candidates: []};
    }
    const all = byLocation.get(locationKey(test.suite, test.title)) ?? [];
    const free = all.filter((id) => !claimed.has(id));
    if (free.length === 1) return {id: free[0], reason: null, candidates: []};
    if (free.length > 1) {
      return {id: null, reason: `ambiguous - ${free.length} Qase cases share this title`, candidates: free};
    }
    if (all.length) {
      return {id: null, reason: 'all matching Qase cases are already claimed', candidates: all};
    }
    const sameTitle = byTitle.get(matchTitle(test.title)) ?? [];
    return {
      id: null,
      reason: sameTitle.length
        ? 'no Qase case at this suite path, but the title exists elsewhere'
        : 'no Qase case with this title anywhere',
      candidates: sameTitle,
    };
  };

  for (const test of tests) {
    // No wrapper at all, or one pointing at a case that no longer exists: both
    // need a replacement looked up by suite path and title.
    if (test.id === null || !caseById.has(test.id)) {
      const {id, reason, candidates} = findReplacement(test);
      if (id !== null) claimed.set(id, test);
      const bucket = test.id === null ? missing : stale;
      bucket.push({test, dead: test.id, proposed: id, reason, candidates});
      continue;
    }
    // The case exists, but pass 1 handed it to an earlier test - always a test
    // and never a loop, since literals are claimed before anything harvested.
    // Only one of the two can report results into it, so this one needs a
    // replacement of its own, exactly as a stale ID would.
    const owner = claimed.get(test.id);
    if (owner !== test) {
      const {id, reason, candidates} = findReplacement(test);
      if (id !== null) claimed.set(id, test);
      duplicate.push({test, dead: test.id, owner: `${owner.file}:${owner.line}`, proposed: id, reason, candidates});
      continue;
    }
    const entry = caseById.get(test.id);
    const suite = suitePaths.get(entry.suite_id) ?? [];
    if (test.title !== null
        && !(samePath(suite, test.suite) && matchTitle(entry.title) === matchTitle(test.title))) {
      mismatched.push({test, caseId: test.id, qaseSuite: suite, qaseTitle: entry.title});
    }
  }

  // Only now is `claimed` final, so this is where a candidate can be told
  // "nobody wants me" - which is what makes it worth suggesting at all.
  const describeCandidate = (id) => {
    const entry = caseById.get(id);
    const owner = claimed.get(id);
    return {
      id,
      suite: suitePaths.get(entry.suite_id) ?? [],
      title: entry.title,
      claimedBy: owner === undefined ? null : (owner === 'loop' ? 'a forEach loop' : `${owner.file}:${owner.line}`),
    };
  };
  for (const item of [...stale, ...missing, ...duplicate]) item.candidates = item.candidates.map(describeCandidate);

  const qaseOnly = [];
  for (const entry of [...cases].sort((a, b) => a.id - b.id)) {
    if (!claimed.has(entry.id)) {
      qaseOnly.push({suite: suitePaths.get(entry.suite_id) ?? [], id: entry.id, title: entry.title});
    }
  }

  return {stale, missing, duplicate, mismatched, qaseOnly};
}

// --------------------------------------------------------------------------- //
// Fixing
// --------------------------------------------------------------------------- //

/** Rewrite the specs in place. Returns how much was applied and left behind. */
function applyFixes(sourceFiles, report, chooseShape) {
  const edits = new Map();
  let applied = 0;
  let skipped = 0;

  const queue = (file, span, text) => {
    if (!edits.has(file)) edits.set(file, []);
    edits.get(file).push({span, text});
    applied += 1;
  };

  // Always a literal ID to overwrite: computed ones went to manual review.
  for (const item of [...report.stale, ...report.duplicate]) {
    if (item.proposed === null) skipped += 1;
    else queue(item.test.file, item.test.idSpan, String(item.proposed));
  }

  let unknownShape = 0;
  for (const item of report.missing) {
    const {test} = item;
    if (item.proposed === null) {
      skipped += 1;
      continue;
    }
    // Nothing in this project says how a wrapper is written here. Writing the
    // wrong one would silently drop the test out of the Qase run.
    const shape = chooseShape(test);
    if (!shape) {
      unknownShape += 1;
      skipped += 1;
      continue;
    }
    const edit = INSERTERS[shape](test, item.proposed, sourceFiles.get(test.file).getFullText());
    if (edit === null) {
      skipped += 1;
      continue;
    }
    queue(test.file, edit.span, edit.text);
  }
  if (unknownShape) {
    console.error(
      `${unknownShape} test(s) left unwrapped: no existing qase() to copy the shape from.`
      + ' Wrap one test by hand and re-run; the rest follow it.',
    );
  }

  for (const [file, fileEdits] of edits) {
    const sourceFile = sourceFiles.get(file);
    // Reverse order so earlier spans keep their offsets.
    for (const {span, text} of fileEdits.sort((a, b) => b.span[0] - a.span[0])) {
      sourceFile.replaceText(span, text);
    }
    sourceFile.saveSync();
  }

  return {applied, skipped};
}

// --------------------------------------------------------------------------- //
// Reporting
// --------------------------------------------------------------------------- //

const fmtSuite = (suite) => (suite.length ? suite.join(' > ') : '(no suite)');
const byLine = (a, b) => a.file.localeCompare(b.file) || a.line - b.line;

const MAX_CANDIDATES = 5;

/** Same-title Qase cases offered as a starting point when the lookup failed. */
function printCandidates(candidates) {
  if (!candidates.length) return;
  // Unclaimed first: those are the ones this test could actually be pointed at.
  const ordered = [...candidates].sort((a, b) => Number(!!a.claimedBy) - Number(!!b.claimedBy) || a.id - b.id);
  for (const entry of ordered.slice(0, MAX_CANDIDATES)) {
    const who = entry.claimedBy ? `claimed by ${entry.claimedBy}` : 'unclaimed - likely this one';
    console.log(`      candidate ${entry.id}: ${fmtSuite(entry.suite)} > '${entry.title}'  [${who}]`);
  }
  if (ordered.length > MAX_CANDIDATES) {
    console.log(`      ... and ${ordered.length - MAX_CANDIDATES} more with this title`);
  }
}

/**
 * One section of the drift report: a heading, two lines per item, and whatever
 * candidates the lookup turned up. `describe` supplies the part of the first
 * line that differs between sections.
 */
function printSection(title, items, describe) {
  console.log(`== ${title} (${items.length}) ==`);
  if (!items.length) console.log('  none');
  for (const item of [...items].sort((a, b) => byLine(a.test, b.test))) {
    console.log(`  ${item.test.file}:${item.test.line}  ${describe(item)}`);
    console.log(`      ${fmtSuite(item.test.suite)} > '${item.test.title}'`);
    printCandidates(item.candidates);
  }
  console.log();
}

function printReport(report, manual, fixing) {
  const {stale, missing, duplicate, mismatched, qaseOnly} = report;

  // Stale and duplicate both name the ID being replaced; missing has none yet.
  const repair = ({proposed, reason}) => (proposed === null
    ? `NO REPLACEMENT (${reason})`
    : (fixing ? `-> ${proposed}` : `should be ${proposed}`));

  printSection('Stale Qase IDs', stale, (item) => `${item.dead} ${repair(item)}`);

  printSection('Tests with no Qase ID', missing, ({proposed, reason}) => (proposed === null
    ? `NO MATCH (${reason}) - create the case in Qase`
    : `add qase(${proposed})`));

  printSection('Qase IDs claimed by more than one test', duplicate,
    (item) => `${item.dead} is already used by ${item.owner}, ${repair(item)}`);

  console.log(`== Qase cases not present locally (${qaseOnly.length}) ==`);
  if (!qaseOnly.length) console.log('  none');
  let lastSuite = null;
  for (const entry of [...qaseOnly].sort((a, b) => fmtSuite(a.suite).localeCompare(fmtSuite(b.suite)) || a.id - b.id)) {
    const suite = fmtSuite(entry.suite);
    if (suite !== lastSuite) {
      console.log(`  ${suite}`);
      lastSuite = suite;
    }
    console.log(`    ${String(entry.id).padStart(4)}  '${entry.title}'`);
  }
  console.log();

  console.log(`== Warning: ID exists but title/suite differs (${mismatched.length}) ==`);
  if (!mismatched.length) console.log('  none');
  for (const item of [...mismatched].sort((a, b) => byLine(a.test, b.test))) {
    console.log(`  ${item.test.file}:${item.test.line}  qase(${item.caseId})`);
    console.log(`      local: ${fmtSuite(item.test.suite)} > '${item.test.title}'`);
    console.log(`      qase:  ${fmtSuite(item.qaseSuite)} > '${item.qaseTitle}'`);
  }
  console.log();

  console.log(`== Needs manual review (${manual.length}) ==`);
  if (!manual.length) console.log('  none');
  for (const entry of [...manual].sort(byLine)) {
    console.log(`  ${entry.file}:${entry.line}  ${entry.note}`);
    // An entry names no IDs when nothing it mentions could be read as one.
    const ids = entry.ids?.length
      ? `; assuming it references ${[...entry.ids].sort((a, b) => a - b).join(', ')}`
      : '';
    console.log(`      ${fmtSuite(entry.suite)}${ids}`);
  }
  console.log();
}

// --------------------------------------------------------------------------- //
// Configuration
// --------------------------------------------------------------------------- //

/** The nearest config file at or above `start`, or null. */
function findConfig(start) {
  let dir = resolve(start);
  for (; ;) {
    const candidate = join(dir, CONFIG_NAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Read and check a config file. Throws with a message naming the file.
 *
 * Unknown keys are an error rather than being ignored, so a misspelt "spec"
 * does not quietly leave the project reading nothing.
 */
function loadConfig(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path}: ${error.message}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${path}: expected a JSON object`);
  }

  const known = new Set(['projectCode', 'specs']);
  const unknown = Object.keys(raw).filter((key) => !known.has(key));
  if (unknown.length) throw new Error(`${path}: unknown key(s): ${unknown.join(', ')}`);

  if (!Array.isArray(raw.specs) || !raw.specs.length
      || raw.specs.some((pattern) => typeof pattern !== 'string')) {
    throw new Error(`${path}: "specs" must be a non-empty array of glob patterns`);
  }
  // The environment wins, so a checkout can be synced against a scratch project
  // without editing a committed file.
  const projectCode = process.env.QASE_PROJECT_CODE || raw.projectCode;
  if (typeof projectCode !== 'string' || !projectCode) {
    throw new Error(`${path}: "projectCode" is required unless QASE_PROJECT_CODE is set`);
  }

  const dir = dirname(path);
  return {
    dir,
    projectCode,
    // For the warning: a stray QASE_PROJECT_CODE in the shell otherwise syncs
    // one project's specs against another project's cases, in silence.
    overrides: raw.projectCode && raw.projectCode !== projectCode ? raw.projectCode : null,
    // Globs are relative to the config file, not to the caller's cwd.
    specs: raw.specs.map((pattern) => (pattern.startsWith('!')
        ? `!${resolve(dir, pattern.slice(1))}`
        : resolve(dir, pattern))),
  };
}

// --------------------------------------------------------------------------- //

function usage(log) {
  log('usage: qase-sync [--fix]');
  log('       --fix   repair stale IDs and insert missing ones, in place');
  log('       run with no flags to report only; exits 1 if anything needs a human');
  log(`conf:  nearest ${CONFIG_NAME} at or above the working directory,`);
  log('       giving projectCode and specs (globs)');
  log('env:   QASE_API_TOKEN required; QASE_PROJECT_CODE overrides projectCode');
  log('note:  run from the project being synced, not from where this is installed;');
  log('       via npm run the flag needs a separator - npm run qase-sync -- --fix');
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    usage(console.log);
    return 0;
  }

  // Rejected rather than ignored: a dropped `--fx` would look like a clean
  // report instead of a repair.
  const unknown = args.filter((arg) => arg !== '--fix');
  if (unknown.length) {
    console.error(`unexpected argument(s): ${unknown.join(' ')}`);
    usage(console.error);
    return 2;
  }
  const fix = args.includes('--fix');

  const token = process.env.QASE_API_TOKEN;
  if (!token) {
    console.error('QASE_API_TOKEN is not set');
    return 2;
  }
  // Anchored to where the script was invoked, never to where it lives: the
  // project being synced is the one the caller is standing in.
  const configPath = findConfig(process.cwd());
  if (!configPath) {
    console.error(`no ${CONFIG_NAME} in ${process.cwd()} or any parent directory`);
    return 2;
  }
  let config;
  try {
    config = loadConfig(configPath);
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  const projectId = config.projectCode;
  if (config.overrides) {
    console.error(
        `warning: QASE_PROJECT_CODE=${projectId} overrides projectCode "${config.overrides}" from ${configPath}`,
    );
  }

  // skipAddingFilesFromTsConfig keeps this to just the specs; nothing is type-checked.
  const project = new Project({useInMemoryFileSystem: false, skipAddingFilesFromTsConfig: true});
  const specFiles = project.addSourceFilesAtPaths(config.specs)
      .sort((a, b) => a.getFilePath().localeCompare(b.getFilePath()));
  // Read before the API call: matching nothing is a misconfigured "specs", and
  // carrying on would report every case in the project as an orphan.
  if (!specFiles.length) {
    console.error(`${configPath}: "specs" matched no files`);
    return 2;
  }

  const sourceFiles = new Map();
  const tests = [];
  const manual = [];
  const harvested = new Set();

  for (const sourceFile of specFiles) {
    // Relative to the config, so the report reads the same wherever it is run.
    const name = relative(config.dir, sourceFile.getFilePath());
    sourceFiles.set(name, sourceFile);
    const found = readSpec(sourceFile, name);
    tests.push(...found.tests);
    manual.push(...found.manual);
    found.harvested.forEach((id) => harvested.add(id));
  }

  let suites;
  let cases;
  try {
    [suites, cases] = await Promise.all([
      qaseFetchAll('suite', projectId, token),
      qaseFetchAll('case', projectId, token),
    ]);
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  const suitePaths = buildSuitePaths(suites);

  const report = compare(tests, cases, suitePaths, harvested);
  const {choose, totals} = shapeChooser(tests);

  const shapes = [...totals].sort((a, b) => b[1] - a[1]).map(([shape, n]) => `${shape} ${n}`).join(', ');
  console.log(`Qase project ${projectId}: ${suites.length} suites, ${cases.length} cases`);
  console.log(`Local specs: ${tests.length} tests in ${specFiles.length} file(s), ${config.dir}`);
  console.log(`Wrapper shapes: ${shapes || 'none yet'}\n`);
  printReport(report, manual, fix);

  if (fix) {
    const {applied, skipped} = applyFixes(sourceFiles, report, choose);
    console.error(
      `Applied ${applied} fix(es); ${skipped} could not be repaired, ${manual.length} need manual review.`,
    );
    return skipped === 0 && manual.length === 0 ? 0 : 1;
  }

  const drift = report.stale.length > 0 || report.missing.length > 0 || report.duplicate.length > 0;
  return drift || manual.length > 0 ? 1 : 0;
}

// Exit 1 has to mean "a human is needed" and nothing else: CI reads it as a soft
// failure it can still open a PR from. A crash must not be mistaken for it.
process.exitCode = await main().catch((error) => {
  console.error(error?.stack ?? error);
  return 2;
});
