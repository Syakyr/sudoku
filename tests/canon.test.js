import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalString, canonicalKey, relabel, hashKey, SYMMETRY_INFO } from '../js/canon.js';
import { generatePuzzle } from '../js/generator.js';
import { createRng } from '../js/prng.js';

/* Independent transform implementations, written from the definitions rather
 * than reusing canon.js internals, so the test can actually catch a bug there. */
function bandStack(str, bp, sp) {
  const o = new Array(81);
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      o[r * 9 + c] = str[(bp[(r / 3) | 0] * 3 + (r % 3)) * 9 + (sp[(c / 3) | 0] * 3 + (c % 3))];
    }
  }
  return o.join('');
}
const D4FNS = {
  id: (s) => s,
  rot90: (s) => out((r, c) => s[(8 - c) * 9 + r]),
  rot180: (s) => out((r, c) => s[(8 - r) * 9 + (8 - c)]),
  rot270: (s) => out((r, c) => s[c * 9 + (8 - r)]),
  mirrorLR: (s) => out((r, c) => s[r * 9 + (8 - c)]),
  mirrorUD: (s) => out((r, c) => s[(8 - r) * 9 + c]),
  transpose: (s) => out((r, c) => s[c * 9 + r]),
  antiDiag: (s) => out((r, c) => s[(8 - c) * 9 + (8 - r)])
};
function out(fn) {
  const o = new Array(81);
  for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) o[r * 9 + c] = fn(r, c);
  return o.join('');
}
const PERMS3 = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0]
];
function relabelWith(str, perm) {
  let s = '';
  for (const ch of str) s += ch === '.' ? '.' : String(perm[+ch - 1]);
  return s;
}

test('relabel folds digit identity by first appearance', () => {
  assert.equal(relabel('123456789'), '123456789');
  assert.equal(relabel('987654321'), '123456789');
  assert.equal(relabel('5.5.3.3.1'), '1.1.2.2.3');
});

test('standard canonical is invariant under all 288 board transforms x relabel', () => {
  const base = generatePuzzle({ seed: 'CANONTEST', difficulty: 'easy', symmetry: true, maxAttempts: 5 }).grid;
  const canon = canonicalString(base, 'standard');
  const rng = createRng('canon-perms');
  let checked = 0;
  for (const kind of Object.keys(D4FNS)) {
    for (const bp of PERMS3) {
      for (const sp of PERMS3) {
        let t = bandStack(D4FNS[kind](base), bp, sp);
        const digits = [1, 2, 3, 4, 5, 6, 7, 8, 9];
        rng.shuffle(digits);
        t = relabelWith(t, digits);
        assert.equal(canonicalString(t, 'standard'), canon, `mismatch for ${kind} bands=${bp} stacks=${sp}`);
        checked++;
      }
    }
  }
  assert.equal(checked, 288);
});

test('full canonical also folds within-band row and within-stack column swaps', () => {
  const base = generatePuzzle({ seed: 'FULLMODE', difficulty: 'easy', symmetry: true, maxAttempts: 5 }).grid;
  const swapRows01 = (s) => {
    const a = s.split('');
    for (let c = 0; c < 9; c++) {
      const t = a[c];
      a[c] = a[9 + c];
      a[9 + c] = t;
    }
    return a.join('');
  };
  const swapped = swapRows01(base);
  assert.notEqual(canonicalString(base, 'standard'), canonicalString(swapped, 'standard'),
    'standard mode does not fold within-band row swaps (by design)');
  assert.equal(canonicalString(base, 'full'), canonicalString(swapped, 'full'),
    'full mode must fold within-band row swaps');
});

test('full canonical is invariant under a random deep transform', () => {
  const base = generatePuzzle({ seed: 'DEEP1', difficulty: 'medium', symmetry: true, maxAttempts: 20 }).grid;
  const canon = canonicalString(base, 'full');
  const rng = createRng('deep-transform');
  for (let trial = 0; trial < 5; trial++) {
    // transpose? then permute rows within bands and stacks of columns, plus band/stack order
    let s = rng.chance(0.5) ? D4FNS.transpose(base) : base;
    const rowMap = [];
    for (let band = 0; band < 3; band++) {
      const rows = [0, 1, 2].map((k) => band * 3 + k);
      rng.shuffle(rows);
      rowMap.push(...rows);
    }
    const colMap = [];
    for (let stack = 0; stack < 3; stack++) {
      const cols = [0, 1, 2].map((k) => stack * 3 + k);
      rng.shuffle(cols);
      colMap.push(...cols);
    }
    const o = new Array(81);
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) o[r * 9 + c] = s[rowMap[r] * 9 + colMap[c]];
    s = o.join('');
    const digits = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    rng.shuffle(digits);
    s = relabelWith(s, digits);
    assert.equal(canonicalString(s, 'full'), canon, `deep trial ${trial} diverged`);
  }
});

test('different puzzles get different canonical keys', () => {
  const keys = new Set();
  for (const seed of ['A1', 'B2', 'C3', 'D4', 'E5']) {
    const p = generatePuzzle({ seed, difficulty: 'easy', symmetry: true, maxAttempts: 8 });
    keys.add(canonicalKey(p.grid, 'full'));
  }
  assert.equal(keys.size, 5);
});

test('hashKey is stable and 16 hex chars', () => {
  const h = hashKey('hello');
  assert.equal(h, hashKey('hello'));
  assert.match(h, /^[0-9a-f]{16}$/);
  assert.notEqual(h, hashKey('world'));
});

test('documented group sizes are consistent with each other', () => {
  assert.equal(SYMMETRY_INFO.standardTransforms, SYMMETRY_INFO.d4Size * SYMMETRY_INFO.bandStackSize);
  assert.equal(SYMMETRY_INFO.fullEquivalenceClass, 3359232 * 362880);
  // 6.67e21 / full equivalence class ~= 5.47e9 essentially different grids
  const total = 6670903752021072936960n;
  const per = Number(total / BigInt(SYMMETRY_INFO.fullEquivalenceClass));
  assert.ok(per > 5.4e9 && per < 5.6e9, `got ${per}`);
});
