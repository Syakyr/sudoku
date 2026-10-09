/**
 * Logic solver with a human-technique ladder, used for three jobs:
 *
 *   1. Uniqueness checking while digging (countSolutions, limit 2).
 *   2. Difficulty rating: the hardest technique the *cheapest* logical solve path
 *      needs. This is the same model Sudoku Explainer uses — a puzzle's rating is
 *      the single worst step, not a sum of steps.
 *   3. Hints in the UI: every step carries a human-readable explanation.
 *
 * If the ladder stalls with the grid unfinished, the puzzle needs guessing, which
 * is its own (much higher) rating band.
 *
 * Rating scale note: these numbers are OUR ladder. They are ordered consistently
 * with the published technique ordering (singles < locked candidates < pairs <
 * fish < wings < colouring < chains) but they are NOT claimed to be exact Sudoku
 * Explainer parity — SE's own table is not published in a form we can verify
 * offline, so we do not pretend.
 */

import {
  CELLS,
  UNITS,
  ROW_UNITS,
  COL_UNITS,
  BOX_UNITS,
  PEERS,
  candidatesOf,
  popcount,
  bitDigit,
  digitsOf,
  rowOf,
  colOf
} from './board.js';

/** Technique ladder, cheapest first. `level` is the rating contribution. */
export const TECHNIQUES = [
  { key: 'naked-single', level: 1.0, name: 'Naked Single', tier: 'basic', blurb: 'a cell with only one candidate left' },
  { key: 'hidden-single', level: 1.5, name: 'Hidden Single', tier: 'basic', blurb: 'a digit with only one home in a unit' },
  { key: 'pointing', level: 2.0, name: 'Pointing Pair', tier: 'intermediate', blurb: 'a digit locked to a line inside a box' },
  { key: 'claiming', level: 2.2, name: 'Claiming', tier: 'intermediate', blurb: 'a digit locked to a box inside a line' },
  { key: 'naked-pair', level: 2.6, name: 'Naked Pair', tier: 'intermediate', blurb: 'two cells sharing exactly two candidates' },
  { key: 'naked-triple', level: 3.0, name: 'Naked Triple', tier: 'advanced', blurb: 'three cells covering exactly three digits' },
  { key: 'hidden-pair', level: 3.2, name: 'Hidden Pair', tier: 'advanced', blurb: 'two digits fitting only two cells' },
  { key: 'x-wing', level: 3.4, name: 'X-Wing', tier: 'advanced', blurb: 'a digit confined to two rows and two columns' },
  { key: 'hidden-triple', level: 3.6, name: 'Hidden Triple', tier: 'advanced', blurb: 'three digits fitting only three cells' },
  { key: 'swordfish', level: 3.8, name: 'Swordfish', tier: 'expert', blurb: 'a fish on three rows and three columns' },
  { key: 'xy-wing', level: 4.2, name: 'XY-Wing', tier: 'expert', blurb: 'a bivalue pivot with two bivalue pincers' },
  { key: 'xyz-wing', level: 4.4, name: 'XYZ-Wing', tier: 'expert', blurb: 'a tri-value pivot with pincers covering the other two digits' },
  { key: 'bug-plus-1', level: 4.6, name: 'BUG+1', tier: 'expert', blurb: 'bivalue universal grave with one extra candidate' },
  { key: 'simple-colouring', level: 4.8, name: 'Simple Colouring', tier: 'expert', blurb: 'a conjugate-pair chain on one digit' },
  { key: 'jellyfish', level: 5.0, name: 'Jellyfish', tier: 'expert', blurb: 'a fish on four rows and four columns' },
  { key: 'guess', level: 7.0, name: 'Guessing / Forcing Chain', tier: 'extreme', blurb: 'no logical step available; search required' }
];

export const LEVEL = Object.fromEntries(TECHNIQUES.map((t) => [t.key, t.level]));
export const TECH_BY_KEY = Object.fromEntries(TECHNIQUES.map((t) => [t.key, t]));

/** Maximum level accepted for "solve with this ladder only". */
export const LADDER_MAX = {
  singles: 1.5,
  intermediate: 2.6,
  advanced: 3.6,
  expert: 5.0
};

// Precomputed index combinations over the 9 members of a unit.
const COMBOS = {};
for (let k = 2; k <= 4; k++) {
  const out = [];
  const cur = [];
  (function rec(start) {
    if (cur.length === k) {
      out.push(cur.slice());
      return;
    }
    for (let i = start; i <= 9 - (k - cur.length); i++) {
      cur.push(i);
      rec(i + 1);
      cur.pop();
    }
  })(0);
  COMBOS[k] = out;
}

const digitBit = (d) => 1 << d;

/** Mutable solver state: current grid plus live candidate masks. */
function makeState(grid) {
  return { grid: Uint8Array.from(grid), cands: candidatesOf(grid) };
}

function isComplete(state) {
  for (let i = 0; i < CELLS; i++) if (state.grid[i] === 0) return false;
  return true;
}

function assign(state, cell, digit, step) {
  state.grid[cell] = digit;
  state.cands[cell] = 0;
  for (const p of PEERS[cell]) state.cands[p] &= ~digitBit(digit);
  return step;
}

/** Remove candidates; returns true if anything changed. Detects contradictions. */
function eliminate(state, cell, mask) {
  const before = state.cands[cell];
  if (state.grid[cell] !== 0) return false;
  const after = before & ~mask;
  if (after === before) return false;
  state.cands[cell] = after;
  return true;
}

function findContradiction(state) {
  for (let i = 0; i < CELLS; i++) {
    if (state.grid[i] === 0 && state.cands[i] === 0) return i;
  }
  return -1;
}

/* ------------------------------------------------------------------ *
 * Techniques
 * ------------------------------------------------------------------ */

function nakedSingle(state) {
  for (let i = 0; i < CELLS; i++) {
    if (state.grid[i] === 0 && popcount(state.cands[i]) === 1) {
      const d = bitDigit(state.cands[i]);
      return {
        technique: 'naked-single',
        cell: i,
        digit: d,
        text: `R${rowOf(i) + 1}C${colOf(i) + 1} is the only cell left with one candidate: ${d}.`
      };
    }
  }
  return null;
}

function hiddenSingle(state) {
  for (const unit of UNITS) {
    for (let d = 1; d <= 9; d++) {
      const bit = digitBit(d);
      let count = 0;
      let where = -1;
      let present = false;
      for (const c of unit) {
        if (state.grid[c] === d) {
          present = true;
          break;
        }
        if (state.grid[c] === 0 && (state.cands[c] & bit)) {
          count++;
          where = c;
        }
      }
      if (!present && count === 1) {
        return {
          technique: 'hidden-single',
          cell: where,
          digit: d,
          text: `${d} has only one home in this ${unitName(unit)}.`
        };
      }
    }
  }
  return null;
}

function unitName(unit) {
  const r0 = rowOf(unit[0]);
  const c0 = colOf(unit[0]);
  if (unit.every((c) => rowOf(c) === r0)) return `row ${r0 + 1}`;
  if (unit.every((c) => colOf(c) === c0)) return `column ${c0 + 1}`;
  return `box ${boxIndex(unit) + 1}`;
}

function boxIndex(unit) {
  const r = rowOf(unit[0]);
  const c = colOf(unit[0]);
  return ((r / 3) | 0) * 3 + ((c / 3) | 0);
}

/** Pointing: inside a box, a digit confined to one row/col removes it from that line outside the box. */
function pointing(state) {
  for (const box of BOX_UNITS) {
    for (let d = 1; d <= 9; d++) {
      const bit = digitBit(d);
      const pos = box.filter((c) => state.grid[c] === 0 && (state.cands[c] & bit));
      if (pos.length < 2) continue;
      const rows = new Set(pos.map(rowOf));
      const cols = new Set(pos.map(colOf));
      if (rows.size === 1) {
        const r = [...rows][0];
        const targets = ROW_UNITS[r].filter((c) => !box.includes(c) && state.grid[c] === 0 && (state.cands[c] & bit));
        if (targets.length) {
          return {
            technique: 'pointing',
            digit: d,
            source: pos.slice(),
            targets: targets.slice(),
            text: `In this box, ${d} is locked to row ${r + 1}; remove ${d} from ${targets.map(cellLabel).join(', ')}.`
          };
        }
      } else if (cols.size === 1) {
        const c = [...cols][0];
        const targets = COL_UNITS[c].filter((x) => !box.includes(x) && state.grid[x] === 0 && (state.cands[x] & bit));
        if (targets.length) {
          return {
            technique: 'pointing',
            digit: d,
            source: pos.slice(),
            targets: targets.slice(),
            text: `In this box, ${d} is locked to column ${c + 1}; remove ${d} from ${targets.map(cellLabel).join(', ')}.`
          };
        }
      }
    }
  }
  return null;
}

/** Claiming (box/line reduction): in a line, a digit confined to one box removes it from that box elsewhere. */
function claiming(state) {
  const lines = [...ROW_UNITS, ...COL_UNITS];
  for (const line of lines) {
    for (let d = 1; d <= 9; d++) {
      const bit = digitBit(d);
      const pos = line.filter((c) => state.grid[c] === 0 && (state.cands[c] & bit));
      if (pos.length < 2) continue;
      const boxes = new Set(pos.map((c) => ((rowOf(c) / 3) | 0) * 3 + ((colOf(c) / 3) | 0)));
      if (boxes.size !== 1) continue;
      const box = BOX_UNITS[[...boxes][0]];
      const targets = box.filter((c) => !line.includes(c) && state.grid[c] === 0 && (state.cands[c] & bit));
      if (targets.length) {
        const isRow = line.every((c) => rowOf(c) === rowOf(line[0]));
        return {
          technique: 'claiming',
          digit: d,
          source: pos.slice(),
          targets: targets.slice(),
          text: `In ${isRow ? `row ${rowOf(line[0]) + 1}` : `column ${colOf(line[0]) + 1}`}, ${d} sits only inside one box; remove ${d} from ${targets.map(cellLabel).join(', ')}.`
        };
      }
    }
  }
  return null;
}

function nakedSubset(state, size) {
  const key = size === 2 ? 'naked-pair' : 'naked-triple';
  for (const unit of UNITS) {
    const empties = unit.filter((c) => state.grid[c] === 0);
    for (const combo of COMBOS[size]) {
      const cells = combo.map((k) => empties[k]);
      if (cells.some((c) => c === undefined)) continue;
      let union = 0;
      for (const c of cells) union |= state.cands[c];
      if (popcount(union) !== size) continue;
      let did = false;
      const targets = [];
      for (const c of unit) {
        if (cells.includes(c) || state.grid[c] !== 0) continue;
        if (state.cands[c] & union) {
          targets.push(c);
          did = true;
        }
      }
      if (did) {
        return {
          technique: key,
          cells: cells.slice(),
          mask: union,
          targets: targets.slice(),
          text: `${cells.map(cellLabel).join(', ')} hold only ${digitsOf(union).join('/')} in this ${unitName(unit)}; remove those from ${targets.map(cellLabel).join(', ')}.`
        };
      }
    }
  }
  return null;
}

function hiddenSubset(state, size) {
  const key = size === 2 ? 'hidden-pair' : 'hidden-triple';
  for (const unit of UNITS) {
    const empties = unit.filter((c) => state.grid[c] === 0);
    if (empties.length <= size) continue;
    for (const combo of COMBOS[size]) {
      const digits = combo.map((k) => k + 1);
      const cells = new Set();
      let ok = true;
      for (const d of digits) {
        const bit = digitBit(d);
        let n = 0;
        for (const c of empties) {
          if (state.cands[c] & bit) {
            cells.add(c);
            n++;
          }
        }
        if (n === 0 || n > size) {
          ok = false;
          break;
        }
      }
      if (!ok || cells.size !== size) continue;
      const cellList = [...cells].sort((a, b) => a - b);
      const digitMask = digits.reduce((m, d) => m | digitBit(d), 0);
      let did = false;
      const targets = [];
      for (const c of cellList) {
        if (state.cands[c] & ~digitMask) {
          targets.push(c);
          did = true;
        }
      }
      if (did) {
        return {
          technique: key,
          cells: cellList,
          mask: digitMask,
          targets: cellList.slice(),
          digits: digits.slice(),
          text: `${digits.join('/')} can only go in ${cellList.map(cellLabel).join(' and ')} in this ${unitName(unit)}; strip the other candidates there.`
        };
      }
    }
  }
  return null;
}

/** Finless fish: `size` base lines each holding the digit in at most `size` cover lines, union exactly `size`. */
function fish(state, size, transposed) {
  const key = size === 2 ? 'x-wing' : size === 3 ? 'swordfish' : 'jellyfish';
  const baseLines = transposed ? COL_UNITS : ROW_UNITS;
  const coverLines = transposed ? ROW_UNITS : COL_UNITS;
  const baseLabel = transposed ? 'column' : 'row';
  const coverLabel = transposed ? 'row' : 'column';

  for (let d = 1; d <= 9; d++) {
    const bit = digitBit(d);
    const positions = baseLines.map((line) => {
      const set = new Set();
      for (const c of line) {
        if (state.grid[c] === 0 && (state.cands[c] & bit)) {
          set.add(transposed ? rowOf(c) : colOf(c));
        }
      }
      return set;
    });
    const eligible = [];
    for (let i = 0; i < positions.length; i++) {
      if (positions[i].size >= 2 && positions[i].size <= size) eligible.push(i);
    }
    if (eligible.length < size) continue;
    for (const combo of combinations(eligible, size)) {
      const cover = new Set();
      for (const bi of combo) for (const ci of positions[bi]) cover.add(ci);
      if (cover.size !== size) continue;
      const targets = [];
      for (const ci of cover) {
        for (const c of coverLines[ci]) {
          const bIdx = transposed ? colOf(c) : rowOf(c);
          if (combo.includes(bIdx)) continue;
          if (state.grid[c] === 0 && (state.cands[c] & bit)) targets.push(c);
        }
      }
      if (targets.length) {
        return {
          technique: key,
          digit: d,
          base: combo.slice(),
          targets: targets.slice(),
          text: `${d} in these ${baseLabel}s only touches ${size} ${coverLabel}s; remove ${d} from the rest of those ${coverLabel}s (${targets.map(cellLabel).join(', ')}).`
        };
      }
    }
  }
  return null;
}

function combinations(arr, k) {
  const out = [];
  const cur = [];
  (function rec(start) {
    if (cur.length === k) {
      out.push(cur.slice());
      return;
    }
    for (let i = start; i <= arr.length - (k - cur.length); i++) {
      cur.push(arr[i]);
      rec(i + 1);
      cur.pop();
    }
  })(0);
  return out;
}

function cellLabel(i) {
  return `R${rowOf(i) + 1}C${colOf(i) + 1}`;
}

function xyWing(state) {
  for (let p = 0; p < CELLS; p++) {
    if (state.grid[p] !== 0 || popcount(state.cands[p]) !== 2) continue;
    const pv = digitsOf(state.cands[p]);
    for (const a of PEERS[p]) {
      if (state.grid[a] !== 0 || popcount(state.cands[a]) !== 2) continue;
      const av = digitsOf(state.cands[a]);
      const shared = pv.filter((x) => av.includes(x));
      if (shared.length !== 1) continue;
      const zCandidates = av.filter((x) => !pv.includes(x));
      if (zCandidates.length !== 1) continue;
      const z = zCandidates[0];
      const y = pv.find((x) => x !== shared[0]);
      for (const b of PEERS[p]) {
        if (b === a) continue;
        if (state.grid[b] !== 0 || popcount(state.cands[b]) !== 2) continue;
        const bv = digitsOf(state.cands[b]);
        if (!bv.includes(y) || !bv.includes(z)) continue;
        const targets = [];
        for (let t = 0; t < CELLS; t++) {
          if (t === p || t === a || t === b) continue;
          if (state.grid[t] === 0 && (state.cands[t] & digitBit(z)) && PEERS[a].includes(t) && PEERS[b].includes(t)) {
            targets.push(t);
          }
        }
        if (targets.length) {
          return {
            technique: 'xy-wing',
            digit: z,
            pivot: p,
            pincers: [a, b],
            targets: targets.slice(),
            text: `XY-Wing on ${z}: pivot ${cellLabel(p)}{${pv.join('')}} with pincers ${cellLabel(a)}{${av.join('')}} and ${cellLabel(b)}{${bv.join('')}}; remove ${z} from ${targets.map(cellLabel).join(', ')}.`
          };
        }
      }
    }
  }
  return null;
}

function xyzWing(state) {
  for (let p = 0; p < CELLS; p++) {
    if (state.grid[p] !== 0 || popcount(state.cands[p]) !== 3) continue;
    const pv = digitsOf(state.cands[p]);
    for (const z of pv) {
      const others = pv.filter((x) => x !== z);
      const pincers = [];
      for (const a of PEERS[p]) {
        if (state.grid[a] !== 0 || popcount(state.cands[a]) !== 2) continue;
        const av = digitsOf(state.cands[a]);
        if (!av.includes(z)) continue;
        const other = av.find((x) => x !== z);
        if (other === undefined || !pv.includes(other)) continue;
        pincers.push({ cell: a, covers: other });
      }
      const covered = new Set(pincers.map((x) => x.covers));
      if (!others.every((o) => covered.has(o))) continue;
      const allCells = [p, ...pincers.map((x) => x.cell)];
      const targets = [];
      for (let t = 0; t < CELLS; t++) {
        if (allCells.includes(t)) continue;
        if (state.grid[t] === 0 && (state.cands[t] & digitBit(z)) && allCells.every((c) => PEERS[c].includes(t))) {
          targets.push(t);
        }
      }
      if (targets.length) {
        return {
          technique: 'xyz-wing',
          digit: z,
          pivot: p,
          pincers: pincers.map((x) => x.cell),
          targets: targets.slice(),
          text: `XYZ-Wing on ${z} with pivot ${cellLabel(p)} and ${pincers.length} pincers; remove ${z} from ${targets.map(cellLabel).join(', ')}.`
        };
      }
    }
  }
  return null;
}

/**
 * BUG+1: every empty cell is bivalue except one cell with three candidates.
 * The candidate whose removal leaves a valid BUG grid is the one that must go in
 * the plus cell (a pure BUG has no solution).
 */
function bugPlusOne(state) {
  const empties = [];
  for (let i = 0; i < CELLS; i++) if (state.grid[i] === 0) empties.push(i);
  if (empties.length < 3) return null;
  const tri = empties.filter((i) => popcount(state.cands[i]) === 3);
  const bi = empties.filter((i) => popcount(state.cands[i]) === 2);
  if (tri.length !== 1 || bi.length !== empties.length - 1) return null;
  const p = tri[0];
  for (const d of digitsOf(state.cands[p])) {
    // Would removing d from the pivot leave a BUG pattern?
    const mask = state.cands[p] & ~digitBit(d);
    const saved = state.cands[p];
    state.cands[p] = mask;
    const isBug = checkBug(state);
    state.cands[p] = saved;
    if (isBug) {
      return {
        technique: 'bug-plus-1',
        cell: p,
        digit: d,
        text: `BUG+1: every other empty cell is bivalue, so the extra candidate ${d} at ${cellLabel(p)} must be the answer.`
      };
    }
  }
  return null;
}

function checkBug(state) {
  for (const unit of UNITS) {
    const counts = new Array(10).fill(0);
    for (const c of unit) {
      if (state.grid[c] !== 0) continue;
      if (popcount(state.cands[c]) !== 2) return false;
      for (const d of digitsOf(state.cands[c])) counts[d]++;
    }
    for (let d = 1; d <= 9; d++) {
      if (counts[d] !== 0 && counts[d] !== 2) return false;
    }
  }
  return true;
}

/**
 * Simple colouring on one digit: conjugate pairs (units where the digit has exactly
 * two homes) form a bipartite graph. A cell seeing two cells of opposite parity in
 * the same component cannot hold the digit; a component with an odd cycle kills the
 * parity that contradicts.
 */
function simpleColouring(state) {
  for (let d = 1; d <= 9; d++) {
    const bit = digitBit(d);
    const cells = [];
    const index = new Map();
    for (let i = 0; i < CELLS; i++) {
      if (state.grid[i] === 0 && (state.cands[i] & bit)) {
        index.set(i, cells.length);
        cells.push(i);
      }
    }
    if (cells.length < 4) continue;
    const adj = cells.map(() => []);
    for (const unit of UNITS) {
      const pos = unit.filter((c) => state.grid[c] === 0 && (state.cands[c] & bit));
      if (pos.length !== 2) continue;
      const a = index.get(pos[0]);
      const b = index.get(pos[1]);
      adj[a].push(b);
      adj[b].push(a);
    }
    const colour = new Int8Array(cells.length).fill(-1);
    for (let s = 0; s < cells.length; s++) {
      if (colour[s] !== -1) continue;
      colour[s] = 0;
      const comp = [s];
      const queue = [s];
      let conflict = false;
      while (queue.length) {
        const u = queue.shift();
        for (const v of adj[u]) {
          if (colour[v] === -1) {
            colour[v] = colour[u] ^ 1;
            comp.push(v);
            queue.push(v);
          } else if (colour[v] === colour[u]) {
            conflict = true;
          }
        }
      }
      if (conflict) continue; // degenerate/invalid pattern; skip rather than mis-eliminate
      const byParity = [[], []];
      for (const i of comp) byParity[colour[i]].push(cells[i]);
      // A cell outside the component seeing both parities cannot hold the digit.
      const targets = [];
      for (let t = 0; t < CELLS; t++) {
        if (state.grid[t] !== 0 || !(state.cands[t] & bit)) continue;
        if (index.has(t) && comp.includes(index.get(t))) continue;
        const seesA = byParity[0].some((c) => PEERS[c].includes(t));
        const seesB = byParity[1].some((c) => PEERS[c].includes(t));
        if (seesA && seesB) targets.push(t);
      }
      if (targets.length) {
        return {
          technique: 'simple-colouring',
          digit: d,
          chain: cells.filter((c, i) => comp.includes(i)),
          targets: targets.slice(),
          text: `Simple colouring on ${d}: ${cellLabel(targets[0])} sees both parities of the ${d}-chain, so it cannot be ${d} (${targets.length} elimination${targets.length === 1 ? '' : 's'}).`
        };
      }
    }
  }
  return null;
}

/**
 * Ordered list of finders. Each entry: [maxLevelAtOrAboveWhichThisIsAllowed, fn].
 * The solver always takes the cheapest available step, which is what makes the
 * resulting rating a "hardest single step" measure.
 */
const FINDERS = [
  [1.0, nakedSingle],
  [1.5, hiddenSingle],
  [2.0, pointing],
  [2.2, claiming],
  [2.6, (s) => nakedSubset(s, 2)],
  [3.0, (s) => nakedSubset(s, 3)],
  [3.2, (s) => hiddenSubset(s, 2)],
  [3.4, (s) => fish(s, 2, false)],
  [3.4, (s) => fish(s, 2, true)],
  [3.6, (s) => hiddenSubset(s, 3)],
  [3.8, (s) => fish(s, 3, false)],
  [3.8, (s) => fish(s, 3, true)],
  [4.2, xyWing],
  [4.4, xyzWing],
  [4.6, bugPlusOne],
  [4.8, simpleColouring],
  [5.0, (s) => fish(s, 4, false)],
  [5.0, (s) => fish(s, 4, true)]
];

function applyStep(state, step) {
  if (step.cell !== undefined && step.digit !== undefined && step.targets === undefined) {
    return assign(state, step.cell, step.digit, step);
  }
  if (step.mask !== undefined) {
    if (step.technique.startsWith('hidden')) {
      // hidden subsets: keep only the digit mask on the target cells
      for (const c of step.targets) {
        if (state.grid[c] === 0) state.cands[c] &= step.mask;
      }
    } else {
      for (const c of step.targets) eliminate(state, c, step.mask);
    }
    return step;
  }
  if (step.digit !== undefined && step.targets !== undefined) {
    const bit = digitBit(step.digit);
    for (const c of step.targets) eliminate(state, c, bit);
    return step;
  }
  return step;
}

/**
 * Solve using only techniques at or below `maxLevel`.
 * Never mutates the input grid.
 */
export function solveLogic(grid, { maxLevel = 5.0, maxSteps = 1000 } = {}) {
  const state = makeState(grid);
  const used = {};
  const steps = [];
  let maxLevelUsed = 0;

  const active = FINDERS.filter(([lvl]) => lvl <= maxLevel);

  while (!isComplete(state)) {
    let step = null;
    for (const [, fn] of active) {
      step = fn(state);
      if (step) break;
    }
    if (!step) {
      return {
        solved: false,
        stalled: true,
        grid: Uint8Array.from(state.grid),
        used,
        steps,
        maxLevelUsed,
        contradiction: findContradiction(state)
      };
    }
    applyStep(state, step);
    used[step.technique] = (used[step.technique] || 0) + 1;
    maxLevelUsed = Math.max(maxLevelUsed, LEVEL[step.technique]);
    steps.push(step);
    const bad = findContradiction(state);
    if (bad >= 0) {
      return {
        solved: false,
        stalled: true,
        contradiction: bad,
        grid: Uint8Array.from(state.grid),
        used,
        steps,
        maxLevelUsed
      };
    }
    if (steps.length > maxSteps) {
      return { solved: false, stalled: true, grid: Uint8Array.from(state.grid), used, steps, maxLevelUsed };
    }
  }
  return { solved: true, stalled: false, grid: Uint8Array.from(state.grid), used, steps, maxLevelUsed, contradiction: -1 };
}

/* ------------------------------------------------------------------ *
 * Solution counting (backtracking with MRV) — uniqueness checking
 * ------------------------------------------------------------------ */

/**
 * Count solutions up to `limit` (default 2). A puzzle with exactly one solution
 * is a valid Sudoku puzzle; more than one means a dig went too far.
 *
 * `maxNodes` bounds the search: proving uniqueness on a hard grid can blow up,
 * and the generator would rather reject a removal than hang the browser. On
 * timeout `count` is null and `timedOut` is true.
 */
export function countSolutions(grid, limit = 2, maxNodes = Infinity) {
  const cands = candidatesOf(grid);
  const work = Uint8Array.from(grid);
  let count = 0;
  let nodes = 0;
  let timedOut = false;

  function search() {
    if (count >= limit) return;
    if (nodes > maxNodes) {
      timedOut = true;
      return;
    }
    // pick the empty cell with fewest candidates (MRV)
    let best = -1;
    let bestCount = 10;
    for (let i = 0; i < CELLS; i++) {
      if (work[i] !== 0) continue;
      const n = popcount(cands[i]);
      if (n === 0) return; // dead end
      if (n < bestCount) {
        bestCount = n;
        best = i;
        if (n === 1) break;
      }
    }
    if (best === -1) {
      count++;
      return;
    }
    const mask = cands[best];
    for (let d = 1; d <= 9 && count < limit; d++) {
      if (!(mask & digitBit(d))) continue;
      const saved = Int32Array.from(cands);
      work[best] = d;
      cands[best] = 0;
      for (const p of PEERS[best]) cands[p] &= ~digitBit(d);
      search();
      work[best] = 0;
      cands.set(saved);
      nodes++;
    }
  }

  search();
  if (timedOut) return { count: null, nodes, timedOut: true };
  return { count, nodes, timedOut: false };
}

export function hasUniqueSolution(grid, maxNodes = Infinity) {
  const r = countSolutions(grid, 2, maxNodes);
  return r.count === 1;
}

/* ------------------------------------------------------------------ *
 * Rating
 * ------------------------------------------------------------------ */

/**
 * Rate a puzzle: solve it with the full logic ladder. If the ladder finishes it,
 * the rating is the hardest step used. If it stalls, the puzzle needs guessing
 * and the rating is 7.0 plus a term that grows with the search work required.
 */
export function ratePuzzle(grid) {
  const logic = solveLogic(grid, { maxLevel: 5.0 });
  if (logic.solved) {
    return {
      score: round1(Math.max(logic.maxLevelUsed, 1.0)),
      hardest: hardestTechnique(logic.used),
      techniques: { ...logic.used },
      logicSolved: true,
      guessNodes: 0,
      steps: logic.steps.length
    };
  }
  const { count, nodes } = countSolutions(grid, 2);
  const score = count === 1 ? 7.0 + Math.min(2.0, Math.log10(Math.max(1, nodes)) / 2) : Infinity;
  return {
    score: round1(score),
    hardest: 'guess',
    techniques: { ...logic.used, guess: 1 },
    logicSolved: false,
    unique: count === 1,
    guessNodes: nodes,
    steps: logic.steps.length
  };
}

function hardestTechnique(used) {
  let bestKey = 'naked-single';
  let bestLevel = -1;
  for (const [k, n] of Object.entries(used)) {
    if (n > 0 && LEVEL[k] > bestLevel) {
      bestLevel = LEVEL[k];
      bestKey = k;
    }
  }
  return bestKey;
}

const round1 = (x) => Math.round(x * 10) / 10;
