/**
 * Canonicalisation under Sudoku symmetries.
 *
 * Two puzzles are "the same puzzle" if one can be turned into the other by any
 * combination of:
 *   - rotations and reflections of the board (the dihedral group D4, 8 elements)
 *   - permuting the three bands (row-triples) and the three stacks (column-triples)
 *   - relabeling the digits 1..9 (any permutation of the nine symbols)
 *
 * The full geometric symmetry group of the 9x9 Sudoku grid has 3,359,232
 * elements: 1296 structure-preserving row orders (6 band orders x 6 within-band
 * row orders per band = 6 * 6^3 = 1296) x 1296 column orders x 2 (transpose).
 * Folding in the 9! = 362,880 digit relabelings gives 1,218,998,177,280
 * representations per puzzle, which is why 6.67e21 grids collapse to
 * 5,472,730,538 essentially different ones.
 *
 * Two modes:
 *
 *   'standard' - the symmetries a player names out loud: D4 rotations/reflections,
 *                band and stack swaps, digit relabel. 8 * 6 * 6 = 288 board
 *                transforms, each digit-canonicalised. ~0.2 ms per puzzle.
 *
 *   'full'     - the entire 3,359,232-element geometric group, including
 *                permuting rows inside a band and columns inside a stack.
 *                Enumerated with a lexicographic early-abort so it stays in the
 *                tens of milliseconds.
 *
 * The registry stores a 64-bit hash of the canonical string. For a personal
 * library of a few thousand puzzles the collision chance is ~1e-12; the full
 * canonical string is still recoverable via canonicalString() when debugging.
 */

import { CELLS } from './board.js';

/** Relabel by first appearance: the first distinct digit seen becomes 1, etc. */
export function relabel(str) {
  const map = new Array(10).fill(0);
  let next = 1;
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '.' || ch === '0') {
      out += '.';
      continue;
    }
    const d = ch.charCodeAt(0) - 48;
    if (map[d] === 0) map[d] = next++;
    out += String(map[d]);
  }
  return out;
}

/* -------------------------- board transforms -------------------------- */

const D4 = ['id', 'rot90', 'rot180', 'rot270', 'mirrorLR', 'mirrorUD', 'transpose', 'antiDiag'];

/** output cell index -> source cell index, for a D4 element */
function d4Map(kind) {
  const m = new Int16Array(CELLS);
  for (let R = 0; R < 9; R++) {
    for (let C = 0; C < 9; C++) {
      let r, c;
      switch (kind) {
        case 'id':
          r = R; c = C; break;
        case 'rot90':
          r = 8 - C; c = R; break;
        case 'rot180':
          r = 8 - R; c = 8 - C; break;
        case 'rot270':
          r = C; c = 8 - R; break;
        case 'mirrorLR':
          r = R; c = 8 - C; break;
        case 'mirrorUD':
          r = 8 - R; c = C; break;
        case 'transpose':
          r = C; c = R; break;
        case 'antiDiag':
          r = 8 - C; c = 8 - R; break;
        default:
          throw new Error(`unknown D4 element ${kind}`);
      }
      m[R * 9 + C] = r * 9 + c;
    }
  }
  return m;
}

const permutations = (n) => {
  const out = [];
  const used = new Array(n).fill(false);
  const cur = [];
  (function rec() {
    if (cur.length === n) {
      out.push(cur.slice());
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      cur.push(i);
      rec();
      cur.pop();
      used[i] = false;
    }
  })();
  return out;
};

const PERMS3 = permutations(3); // 6

/**
 * Structure-preserving row (or column) orders.
 *   shallow: only the three bands may be permuted (rows keep their slot) -> 6 orders
 *   deep:    bands permute AND rows permute inside each band -> 6 * 6^3 = 1296
 */
function structureOrders(deep) {
  if (!deep) {
    return PERMS3.map((p) => {
      const order = new Int16Array(9);
      for (let i = 0; i < 9; i++) order[i] = p[(i / 3) | 0] * 3 + (i % 3);
      return order;
    });
  }
  const out = [];
  for (const bandPerm of PERMS3) {
    for (const a of PERMS3) {
      for (const b of PERMS3) {
        for (const c of PERMS3) {
          const within = [a, b, c];
          const order = new Int16Array(9);
          for (let i = 0; i < 9; i++) {
            const band = (i / 3) | 0;
            order[i] = bandPerm[band] * 3 + within[band][i % 3];
          }
          out.push(order);
        }
      }
    }
  }
  return out;
}

const SHALLOW = structureOrders(false); // 6
const DEEP = structureOrders(true); // 1296
const D4MAPS = Object.fromEntries(D4.map((k) => [k, d4Map(k)]));

function applyMap(str, map) {
  let out = '';
  for (let i = 0; i < CELLS; i++) out += str[map[i]];
  return out;
}

/** All 'standard' board transforms: D4 composed with band/stack swaps. */
function standardTransforms() {
  const out = [];
  for (const kind of D4) {
    const d4 = D4MAPS[kind];
    for (const band of SHALLOW) {
      for (const stack of SHALLOW) {
        const m = new Int16Array(CELLS);
        for (let i = 0; i < CELLS; i++) {
          const src = d4[i];
          const r = (src / 9) | 0;
          const c = src % 9;
          m[i] = band[r] * 9 + stack[c];
        }
        out.push(m);
      }
    }
  }
  return out;
}

let STD_TRANSFORMS = null;
function stdTransforms() {
  if (!STD_TRANSFORMS) STD_TRANSFORMS = standardTransforms();
  return STD_TRANSFORMS;
}

/**
 * Canonical string under the chosen symmetry group: the lexicographically smallest
 * relabeled transform.
 */
export function canonicalString(gridStr, mode = 'standard') {
  const s = gridStr.replace(/0/g, '.');
  if (mode === 'standard') {
    let best = null;
    for (const m of stdTransforms()) {
      const cand = relabel(applyMap(s, m));
      if (best === null || cand < best) best = cand;
    }
    return best;
  }
  if (mode === 'full') return canonicalFull(s);
  throw new Error(`unknown canonicalisation mode "${mode}"`);
}

/**
 * Full-group canonicalisation with a lexicographic early abort.
 *
 * Enumerating 3,359,232 transforms x 81 cells is ~272M operations, too slow to
 * sit behind a button press. But the comparison is lexicographic, so a candidate
 * can be abandoned the moment one character exceeds the incumbent - and on a
 * sparse puzzle that happens after a handful of cells. The relabel map is built
 * during the same left-to-right scan, which is exactly the order relabel() needs.
 */
function canonicalFull(s) {
  let best = relabel(s);
  const map = new Int16Array(10);

  // Pre-flatten the two candidate grids (identity and transposed).
  const grids = [s, applyMap(s, D4MAPS.transpose)];

  for (let gi = 0; gi < 2; gi++) {
    const g = grids[gi];
    for (const rowOrder of DEEP) {
      for (const colOrder of DEEP) {
        map.fill(0);
        let next = 1;
        let won = false;
        let aborted = false;
        let out = '';
        let idx = 0;
        for (let ri = 0; ri < 9 && !aborted; ri++) {
          const r = rowOrder[ri] * 9;
          for (let ci = 0; ci < 9; ci++) {
            const ch = g[r + colOrder[ci]];
            let mapped;
            if (ch === '.') {
              mapped = '.';
            } else {
              const d = ch.charCodeAt(0) - 48;
              if (map[d] === 0) map[d] = next++;
              mapped = String(map[d]);
            }
            if (!won) {
              if (mapped < best[idx]) {
                // Strictly smaller at the first differing position: this candidate
                // has already won, so later characters cannot un-win it. Keep
                // building, stop comparing.
                won = true;
              } else if (mapped > best[idx]) {
                aborted = true;
                break;
              }
            }
            out += mapped;
            idx++;
          }
        }
        if (!aborted && out.length === CELLS && out < best) best = out;
      }
    }
  }
  return best;
}

/* ------------------------------ hashing ------------------------------ */

/** Two independent FNV-1a 32-bit passes -> 16 hex chars (~64 bits). */
export function hashKey(str) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c + 0x9e3779b9;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

export function canonicalKey(gridStr, mode = 'standard') {
  return hashKey(canonicalString(gridStr, mode));
}

export const SYMMETRY_INFO = {
  d4Size: 8,
  bandStackSize: 36,
  standardTransforms: 288,
  fullGeometricGroup: 3359232,
  digitRelabelings: 362880,
  fullEquivalenceClass: 3359232 * 362880,
  totalGrids: '6,670,903,752,021,072,936,960',
  essentiallyDifferent: '5,472,730,538'
};
