import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generatePuzzle,
  generateFullGrid,
  dig,
  tierCheck,
  TIERS,
  TIER_ORDER,
  encodeShare,
  decodeShare,
  rebuildFromShare
} from '../js/generator.js';
import { createRng, encodeSeed, decodeSeed, randomSeedString } from '../js/prng.js';
import { parseGrid, gridToString, isValidSolution, clueCount, ROT180 } from '../js/board.js';
import { countSolutions, solveLogic } from '../js/solver.js';

test('prng: same seed reproduces the same stream', () => {
  const a = createRng('abc');
  const b = createRng('abc');
  const xs = Array.from({ length: 20 }, () => a.float());
  const ys = Array.from({ length: 20 }, () => b.float());
  assert.deepEqual(xs, ys);
  assert.notDeepEqual(xs, Array.from({ length: 20 }, () => createRng('abd').float()));
});

test('seed encode/decode round trip', () => {
  for (const n of [0, 1, 123456789, 0xffffffff]) {
    const s = encodeSeed(n);
    assert.equal(s.length, 7);
    assert.equal(decodeSeed(s), n);
  }
  assert.throws(() => decodeSeed('short'));
  assert.throws(() => decodeSeed('!!!!!!!'));
  assert.equal(randomSeedString('entropy-1').length, 7);
});

test('full grid generation produces valid solutions', () => {
  const rng = createRng('fill');
  for (let i = 0; i < 25; i++) {
    assert.ok(isValidSolution(generateFullGrid(rng)), `grid ${i} invalid`);
  }
});

test('generation is deterministic for a given seed+tier+symmetry', () => {
  const a = generatePuzzle({ seed: 'DET1', difficulty: 'easy', symmetry: true, maxAttempts: 5 });
  const b = generatePuzzle({ seed: 'DET1', difficulty: 'easy', symmetry: true, maxAttempts: 5 });
  assert.equal(a.grid, b.grid);
  assert.equal(a.solution, b.solution);
  assert.equal(a.attempt, b.attempt);
});

test('every accepted puzzle is unique, valid and inside its tier band', () => {
  for (const tier of TIER_ORDER) {
    const p = generatePuzzle({ seed: `BAND-${tier}`, difficulty: tier, symmetry: true, maxAttempts: 120, timeBudgetMs: 6000 });
    if (!p.accepted) continue; // rare tiers may fall back; checked separately below
    const g = parseGrid(p.grid);
    const sol = parseGrid(p.solution);
    assert.ok(isValidSolution(sol), `${tier}: solution must be a valid completed grid`);
    for (let i = 0; i < 81; i++) {
      if (g[i] !== 0) assert.equal(g[i], sol[i], `${tier}: givens must match the solution`);
    }
    assert.equal(countSolutions(g, 2).count, 1, `${tier}: puzzle must have exactly one solution`);
    const t = TIERS[tier];
    const lvl = solveLogic(g, { maxLevel: 5.0 });
    const level = lvl.solved ? Math.max(lvl.maxLevelUsed, 1) : 99;
    assert.ok(level <= t.ceiling, `${tier}: level ${level} must not exceed ceiling ${t.ceiling}`);
    if (t.floor !== null) assert.ok(level > t.floor, `${tier}: level ${level} must exceed floor ${t.floor}`);
  }
});

test('symmetric puzzles have a 180-degree symmetric clue pattern', () => {
  for (const tier of ['easy', 'medium', 'hard']) {
    const p = generatePuzzle({ seed: `SYM-${tier}`, difficulty: tier, symmetry: true, maxAttempts: 60 });
    if (!p.accepted) continue;
    for (let i = 0; i < 81; i++) {
      const a = p.grid[i] !== '.';
      const b = p.grid[ROT180(i)] !== '.';
      assert.equal(a, b, `${tier}: clue pattern must be 180-degree symmetric at ${i}`);
    }
  }
});

test('dig never breaks uniqueness even when it cannot reach the tier', () => {
  const rng = createRng('dig-safety');
  const full = generateFullGrid(rng);
  const { grid } = dig(full, rng, TIERS.extreme, { symmetry: true, nodeBudget: 5000 });
  assert.equal(countSolutions(grid, 2).count, 1, 'dug grid must still be uniquely solvable');
  assert.ok(clueCount(grid) < 81, 'dig must actually remove something');
});

test('share tokens round trip and rebuild the identical board', () => {
  const p = generatePuzzle({ seed: 'SHARE1', difficulty: 'easy', symmetry: true, maxAttempts: 10 });
  const token = p.share;
  const decoded = decodeShare(token);
  assert.equal(decoded.seed, 'SHARE1');
  assert.equal(decoded.difficulty, 'easy');
  assert.equal(decoded.symmetry, true);
  assert.equal(decoded.attempt, p.attempt);
  const rebuilt = rebuildFromShare(token);
  assert.equal(rebuilt.grid, p.grid, 'shared seed must regenerate the exact same board');
  assert.equal(rebuilt.solution, p.solution);
});

test('share token encodes tier and symmetry distinctly', () => {
  const t1 = encodeShare({ seed: 'AAAAAAA', difficulty: 'hard', symmetry: true, attempt: 3 });
  const t2 = encodeShare({ seed: 'AAAAAAA', difficulty: 'hard', symmetry: false, attempt: 3 });
  assert.notEqual(t1, t2);
  assert.equal(decodeShare(t2).symmetry, false);
  assert.throws(() => decodeShare('nonsense-token'));
});

test('unaccepted fallbacks are reported honestly, never silently mislabelled', () => {
  // A tier the search may fail to reach must come back with accepted=false and a reason.
  let sawFallback = false;
  for (let i = 0; i < 12; i++) {
    const p = generatePuzzle({ seed: `FAIL${i}`, difficulty: 'hard', symmetry: true, maxAttempts: 1 });
    if (!p.accepted) {
      sawFallback = true;
      assert.ok(typeof p.reason === 'string' && p.reason.length > 0);
    }
  }
  assert.ok(sawFallback, 'single-attempt hard generation is expected to miss sometimes');
});

test('generatePuzzle validates its inputs', () => {
  assert.throws(() => generatePuzzle({ seed: 'X', difficulty: 'impossible' }));
  assert.throws(() => generatePuzzle({ difficulty: 'easy' }));
});
