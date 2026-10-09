/**
 * Board model: an 81-cell 9x9 grid plus precomputed peer/unit tables and
 * candidate bitmasks.
 *
 * Grid representation is a Uint8Array of length 81, row-major, 0 = empty.
 * Candidates are bitmasks over bits 1..9 (bit d set means digit d is possible),
 * so ALL = 0b1111111110.
 */

export const SIZE = 9;
export const CELLS = 81;
export const DIGITS = '123456789';
/** bitmask of digits 1..9 */
export const ALL = 0x3fe;

export const rowOf = (i) => (i / 9) | 0;
export const colOf = (i) => i % 9;
export const boxOf = (i) => ((rowOf(i) / 3) | 0) * 3 + ((colOf(i) / 3) | 0);
export const cellOf = (r, c) => r * 9 + c;

/** 27 units: 9 rows, 9 columns, 9 boxes. Each is an array of 9 cell indices. */
export const UNITS = (() => {
  const units = [];
  for (let r = 0; r < 9; r++) {
    const u = [];
    for (let c = 0; c < 9; c++) u.push(cellOf(r, c));
    units.push(u);
  }
  for (let c = 0; c < 9; c++) {
    const u = [];
    for (let r = 0; r < 9; r++) u.push(cellOf(r, c));
    units.push(u);
  }
  for (let br = 0; br < 3; br++) {
    for (let bc = 0; bc < 3; bc++) {
      const u = [];
      for (let dr = 0; dr < 3; dr++) {
        for (let dc = 0; dc < 3; dc++) u.push(cellOf(br * 3 + dr, bc * 3 + dc));
      }
      units.push(u);
    }
  }
  return units;
})();

export const ROW_UNITS = UNITS.slice(0, 9);
export const COL_UNITS = UNITS.slice(9, 18);
export const BOX_UNITS = UNITS.slice(18, 27);

/** cell -> list of units containing it */
export const UNITS_OF = (() => {
  const out = Array.from({ length: CELLS }, () => []);
  UNITS.forEach((u, ui) => {
    for (const c of u) out[c].push(ui);
  });
  return out;
})();

/** cell -> array of the 20 peer cells */
export const PEERS = (() => {
  const out = [];
  for (let i = 0; i < CELLS; i++) {
    const set = new Set();
    for (const ui of UNITS_OF[i]) {
      for (const c of UNITS[ui]) if (c !== i) set.add(c);
    }
    out.push([...set].sort((a, b) => a - b));
  }
  return out;
})();

/** index of the cell rotated 180 degrees about the centre */
export const ROT180 = (i) => 80 - i;

/** Parse an 81-char string (digits + '.'/'_'/'0' for empty). Ignores whitespace. */
export function parseGrid(str) {
  const clean = String(str).replace(/[\s|+-]/g, '');
  if (clean.length !== CELLS) {
    throw new Error(`grid must be ${CELLS} characters, got ${clean.length}`);
  }
  const grid = new Uint8Array(CELLS);
  for (let i = 0; i < CELLS; i++) {
    const ch = clean[i];
    if (ch === '.' || ch === '_' || ch === '0') grid[i] = 0;
    else {
      const d = ch.charCodeAt(0) - 48;
      if (d < 1 || d > 9) throw new Error(`bad character "${ch}" at index ${i}`);
      grid[i] = d;
    }
  }
  return grid;
}

export function gridToString(grid) {
  let s = '';
  for (let i = 0; i < CELLS; i++) s += grid[i] === 0 ? '.' : String(grid[i]);
  return s;
}

/** Pretty 3x3-blocked text rendering, useful in tests and console output. */
export function gridToText(grid) {
  const lines = [];
  for (let r = 0; r < 9; r++) {
    if (r % 3 === 0 && r !== 0) lines.push('------+-------+------');
    let line = '';
    for (let c = 0; c < 9; c++) {
      if (c % 3 === 0 && c !== 0) line += '|';
      const v = grid[r * 9 + c];
      line += v === 0 ? ' . ' : ` ${v} `;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

export const popcount = (mask) => {
  let m = mask;
  let n = 0;
  while (m) {
    n += m & 1;
    m >>= 1;
  }
  return n;
};

/** digit for a single-bit mask */
export const bitDigit = (mask) => {
  let d = 1;
  while (!(mask & (1 << d))) d++;
  return d;
};

export const digitsOf = (mask) => {
  const out = [];
  for (let d = 1; d <= 9; d++) if (mask & (1 << d)) out.push(d);
  return out;
};

/** Candidate mask for each cell given the givens. Empty cells get ALL minus peer digits. */
export function candidatesOf(grid) {
  const cands = new Int32Array(CELLS);
  for (let i = 0; i < CELLS; i++) {
    if (grid[i] !== 0) {
      cands[i] = 0;
      continue;
    }
    let mask = ALL;
    for (const p of PEERS[i]) {
      const v = grid[p];
      if (v) mask &= ~(1 << v);
    }
    cands[i] = mask;
  }
  return cands;
}

/** Does placing digit d at cell i conflict with existing values? */
export function isValidPlacement(grid, i, d) {
  for (const p of PEERS[i]) if (grid[p] === d) return false;
  return true;
}

/** Number of given (non-zero) cells. */
export function clueCount(grid) {
  let n = 0;
  for (let i = 0; i < CELLS; i++) if (grid[i] !== 0) n++;
  return n;
}

/**
 * Validate a full grid: every row, column and box holds digits 1..9 exactly once.
 * Empty cells make it invalid (this checks *completed* grids).
 */
export function isValidSolution(grid) {
  for (const u of UNITS) {
    let mask = 0;
    for (const c of u) {
      const v = grid[c];
      if (v < 1 || v > 9) return false;
      if (mask & (1 << v)) return false;
      mask |= 1 << v;
    }
    if (mask !== ALL) return false;
  }
  return true;
}

/** Is `grid` consistent (no duplicate digit in any unit)? Givens only, empties ok. */
export function isConsistent(grid) {
  for (const u of UNITS) {
    let mask = 0;
    for (const c of u) {
      const v = grid[c];
      if (v === 0) continue;
      if (mask & (1 << v)) return false;
      mask |= 1 << v;
    }
  }
  return true;
}

/** Does `attempt` extend `puzzle` (i.e. agree on every given cell)? */
export function extendsPuzzle(puzzle, attempt) {
  for (let i = 0; i < CELLS; i++) {
    if (puzzle[i] !== 0 && puzzle[i] !== attempt[i]) return false;
  }
  return true;
}
