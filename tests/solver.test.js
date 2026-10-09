import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGrid,
  gridToString,
  gridToText,
  isValidSolution,
  isConsistent,
  candidatesOf,
  clueCount,
  UNITS,
  PEERS,
  ALL,
  CELLS
} from '../js/board.js';
import { solveLogic, countSolutions, hasUniqueSolution, ratePuzzle, TECHNIQUES } from '../js/solver.js';
// The Wikipedia example puzzle — solvable with singles alone.
const WIKI = '53..7....6..195....98....6.8...6...34..8.3..17...2...6.6....28....419..5....8..79';
const WIKI_SOLUTION =
  '534678912672195348198342567859761423426853791713924856961537284287419635345286179';

test('board tables are well formed', () => {
  assert.equal(UNITS.length, 27);
  for (const u of UNITS) assert.equal(u.length, 9);
  for (let i = 0; i < CELLS; i++) assert.equal(PEERS[i].length, 20);
});

test('parse/string round trip', () => {
  const g = parseGrid(WIKI);
  assert.equal(gridToString(g), WIKI.replace(/\./g, '.'));
  assert.equal(clueCount(g), 30);
  assert.ok(isConsistent(g));
});

test('candidates exclude peer digits', () => {
  const g = parseGrid(WIKI);
  const c = candidatesOf(g);
  // R1C3 (index 2) sees 5,3 in row 1, 6 in col 3 top... verify against known: it must not contain 5 or 3
  assert.equal(c[2] & (1 << 5), 0);
  assert.equal(c[2] & (1 << 3), 0);
  // givens have no candidates
  assert.equal(c[0], 0);
});

test('logic solver solves the wiki puzzle with singles only', () => {
  const r = solveLogic(parseGrid(WIKI), { maxLevel: 5.0 });
  assert.equal(r.solved, true);
  assert.ok(r.maxLevelUsed <= 1.5, `wiki puzzle should need nothing above hidden single, got ${r.maxLevelUsed}`);
  for (const k of Object.keys(r.used)) {
    assert.ok(['naked-single', 'hidden-single'].includes(k), `unexpected technique ${k}`);
  }
  assert.ok(isValidSolution(r.grid));
  assert.equal(gridToString(r.grid), WIKI_SOLUTION);
});

test('wiki puzzle has a unique solution', () => {
  const { count } = countSolutions(parseGrid(WIKI), 2);
  assert.equal(count, 1);
});

test('a grid with two solutions is detected as non-unique', () => {
  const full = parseGrid(WIKI_SOLUTION);
  assert.equal(hasUniqueSolution(full), true);
  assert.equal(isValidSolution(full), true);
  // An empty grid has many solutions; the counter must stop as soon as it passes the limit.
  const empty = new Uint8Array(81);
  const { count } = countSolutions(empty, 2);
  assert.equal(count, 2);
});

test('rating: singles-only puzzle rates low', () => {
  const r = ratePuzzle(parseGrid(WIKI));
  assert.equal(r.logicSolved, true);
  assert.ok(r.score <= 1.5, `expected <=1.5, got ${r.score}`);
});

test('logic solver does not mutate its input', () => {
  const g = parseGrid(WIKI);
  const before = gridToString(g);
  solveLogic(g, { maxLevel: 5.0 });
  assert.equal(gridToString(g), before);
});

test('ladder gating is monotonic: a wider ladder never solves less', () => {
  const g = parseGrid(WIKI);
  const narrow = solveLogic(g, { maxLevel: 1.0 });
  const wide = solveLogic(g, { maxLevel: 5.0 });
  assert.equal(narrow.solved, wide.solved, 'same puzzle must agree across ladders when it needs no gating');
  assert.ok(wide.maxLevelUsed >= narrow.maxLevelUsed);
});

test('every technique key has a level and a finder ordering', () => {
  const levels = TECHNIQUES.map((t) => t.level);
  assert.deepEqual(levels, [...levels].sort((a, b) => a - b), 'ladder must be ordered cheapest first');
});
