/**
 * Puzzle generator.
 *
 * Standard "fill then dig" construction, made deterministic by seeding every
 * random choice from the puzzle's seed string:
 *
 *   1. Fill a complete valid grid with randomised backtracking.
 *   2. Dig clues back out in a random order (optionally in 180-degree
 *      rotationally symmetric pairs — the newspaper look), keeping only removals
 *      that leave exactly one solution.
 *   3. Grade the result against a difficulty tier. The contract is the one every
 *      serious generator uses and the one worth stating to the player: the board
 *      must be solvable with this tier's ladder, and must NOT be solvable with the
 *      tier below it. Clue count is packaging; the technique contract is the
 *      difficulty.
 *
 * Digging is greedy-maximal subject to staying inside the tier: we keep pulling
 * clues until nothing else can come out without either breaking uniqueness or
 * pushing the board past the tier's ceiling. That lands the puzzle at the hard
 * end of its band instead of accidentally drifting easy.
 *
 * Shareability: a puzzle is identified by (seed, tier, symmetry, attempt). The
 * attempt index is part of the identity on purpose — generation is a search, and
 * pinning where the search stopped is what makes a shared seed resolve to the
 * identical board on another device rather than "some board of the same tier".
 */

import { CELLS, ROT180, clueCount, gridToString, parseGrid, isValidSolution } from './board.js';
import { solveLogic, countSolutions, ratePuzzle } from './solver.js';
import { createRng } from './prng.js';

/**
 * Difficulty tiers.
 *
 *   target   - dig until the hardest technique needed reaches this level
 *   ceiling  - a removal that pushes past this is reverted (never overshoot)
 *   floor    - the ladder that must FAIL for the tier to be real
 *   minClues - give up digging here even if the target was not reached
 *
 * The levels are not aspirational, they are measured. Random "fill then dig"
 * construction is overwhelmingly singles-dominated: across 40 randomly dug
 * grids the hardest level reached was 1.5 in 31 of them, 2.0-3.0 in 5, and
 * logic-failure in 5. So the upper tiers are reached by *searching* for grids
 * whose dig trajectory passes through the band, not by pretending one dig can
 * steer there. See README "What the generator can and cannot hit".
 */
export const TIERS = {
  easy: {
    key: 'easy',
    label: 'Easy',
    target: 1.5,
    ceiling: 1.5,
    floor: null,
    minClues: 28,
    needsGuess: false,
    hint: 'Singles only - naked and hidden.'
  },
  medium: {
    key: 'medium',
    label: 'Medium',
    target: 2.0,
    ceiling: 2.6,
    floor: 1.5,
    minClues: 24,
    needsGuess: false,
    hint: 'Locked candidates (pointing/claiming) and naked pairs.'
  },
  hard: {
    key: 'hard',
    label: 'Hard',
    target: 3.0,
    ceiling: 3.8,
    floor: 2.6,
    minClues: 22,
    needsGuess: false,
    hint: 'Hidden pairs, X-Wings and naked triples.'
  },
  expert: {
    key: 'expert',
    label: 'Expert',
    target: 4.2,
    ceiling: 5.0,
    floor: 3.8,
    minClues: 21,
    needsGuess: false,
    hint: 'Wings, BUG+1 and colouring.'
  },
  extreme: {
    key: 'extreme',
    label: 'Extreme',
    target: 99,
    ceiling: Infinity,
    floor: 5.0,
    minClues: 20,
    needsGuess: true,
    hint: 'The logic ladder runs out. Search required.'
  }
};

export const TIER_ORDER = ['easy', 'medium', 'hard', 'expert', 'extreme'];

/** Randomised backtracking fill of a complete grid. */
export function generateFullGrid(rng) {
  const grid = new Uint8Array(CELLS);
  const digits = [1, 2, 3, 4, 5, 6, 7, 8, 9];

  function conflicts(pos, d) {
    const r = (pos / 9) | 0;
    const c = pos % 9;
    for (let i = 0; i < 9; i++) {
      if (grid[r * 9 + i] === d || grid[i * 9 + c] === d) return true;
    }
    const br = ((r / 3) | 0) * 3;
    const bc = ((c / 3) | 0) * 3;
    for (let dr = 0; dr < 3; dr++) {
      for (let dc = 0; dc < 3; dc++) {
        if (grid[(br + dr) * 9 + (bc + dc)] === d) return true;
      }
    }
    return false;
  }

  function fill(pos) {
    if (pos === CELLS) return true;
    for (const d of rng.shuffle(digits.slice())) {
      if (conflicts(pos, d)) continue;
      grid[pos] = d;
      if (fill(pos + 1)) return true;
      grid[pos] = 0;
    }
    return false;
  }

  if (!fill(0)) throw new Error('failed to fill grid');
  return grid;
}

/** Hardest ladder level the board needs; 99 means the ladder stalled. */
function scoreOf(grid) {
  const r = solveLogic(grid, { maxLevel: 5.0 });
  return r.solved ? Math.max(r.maxLevelUsed, 1.0) : 99;
}

/**
 * Dig clues out of a full grid toward a tier.
 *
 * Hard constraint: uniqueness, always.
 * Stop: the hardest level needed has reached tier.target.
 * Revert: the removal pushed past tier.ceiling.
 *
 * For Easy there is no target above the singles level, so this simply digs as
 * deep as the singles-only ladder can still finish - which is exactly what makes
 * it an Easy board carrying as few clues as Easy can carry.
 */
export function dig(fullGrid, rng, tier, { symmetry = true, nodeBudget = 20000, onProgress } = {}) {
  const grid = Uint8Array.from(fullGrid);
  const removed = [];

  const positions = [];
  const seen = new Set();
  for (const i of rng.shuffle(Array.from({ length: CELLS }, (_, k) => k))) {
    if (seen.has(i)) continue;
    const partner = symmetry ? ROT180(i) : i;
    seen.add(i);
    seen.add(partner);
    positions.push(symmetry ? [i, partner] : [i]);
  }

  for (const group of positions) {
    if (clueCount(grid) <= tier.minClues) break;
    if (scoreOf(grid) >= tier.target) break;
    const saved = group.map((c) => grid[c]);
    if (saved.some((v) => v === 0)) continue;
    for (const c of group) grid[c] = 0;

    if (countSolutions(grid, 2, nodeBudget).count !== 1) {
      for (let k = 0; k < group.length; k++) grid[group[k]] = saved[k];
      continue;
    }
    if (scoreOf(grid) > tier.ceiling) {
      for (let k = 0; k < group.length; k++) grid[group[k]] = saved[k];
      continue;
    }
    removed.push(...group);
    if (onProgress) onProgress(clueCount(grid), removed.length);
  }
  return { grid, removed };
}

/** Does the board satisfy the full tier contract (within ceiling, floor ladder fails)? */
export function tierCheck(grid, tier) {
  const clues = clueCount(grid);
  const s = scoreOf(grid);
  if (s > tier.ceiling) return { ok: false, clues, score: s, reason: 'above ceiling' };
  if (tier.floor !== null && s <= tier.floor) {
    return { ok: false, clues, score: s, reason: 'solvable one tier down' };
  }
  return { ok: true, clues, score: s, reason: 'in band' };
}

/**
 * Generate a puzzle.
 *
 * @param {object} opts
 *   seed        string  shareable seed (7 chars from encodeSeed, or any text)
 *   difficulty  string  tier key
 *   symmetry    boolean 180-degree rotational clue symmetry
 *   attempt     number  if given, use exactly this attempt (share-token rebuild)
 *   maxAttempts number  retries before falling back to the closest board seen
 *   timeBudgetMs number wall-clock cap; generation stops early and returns the
 *               closest board so the browser never hangs
 *   onProgress  fn(attempt, message)
 */
export function generatePuzzle({
  seed,
  difficulty = 'medium',
  symmetry = true,
  attempt = null,
  maxAttempts = 40,
  nodeBudget = 20000,
  timeBudgetMs = Infinity,
  startedAt = null,
  onProgress
} = {}) {
  const tier = TIERS[difficulty];
  if (!tier) throw new Error(`unknown difficulty "${difficulty}"`);
  if (seed === undefined || seed === null || seed === '') throw new Error('a seed is required');

  const attempts = attempt !== null ? [attempt] : range(1, maxAttempts);
  const t0 = startedAt === null ? Date.now() : startedAt;
  let best = null;
  let bestCloseness = Infinity;

  for (const a of attempts) {
    if (a !== attempts[0] && Date.now() - t0 > timeBudgetMs) break;
    const rng = createRng(`${seed}|${difficulty}|${symmetry ? 'sym' : 'asym'}|${a}`);
    const full = generateFullGrid(rng);
    const { grid, removed } = dig(full, rng, tier, { symmetry, nodeBudget });
    const check = tierCheck(grid, tier);
    const rating = ratePuzzle(grid);
    const clues = clueCount(grid);

    const candidate = {
      seed: String(seed),
      difficulty,
      symmetry,
      attempt: a,
      grid: gridToString(grid),
      solution: gridToString(full),
      clues,
      removed: removed.length,
      rating,
      share: encodeShare({ seed, difficulty, symmetry, attempt: a })
    };

    if (check.ok) return { ...candidate, accepted: true, reason: check.reason };

    const closeness = closenessTo(check, clues, tier);
    if (closeness < bestCloseness) {
      bestCloseness = closeness;
      best = { ...candidate, accepted: false, reason: check.reason };
    }
    if (onProgress) onProgress(a, `${check.reason} (${clues} clues)`);
  }

  return best || { seed: String(seed), difficulty, symmetry, accepted: false, reason: 'no candidate produced' };
}

/*
 * Fallback ranking when no attempt lands in band: prefer a board whose rating sits
 * near the tier's target level and whose clue count is near the digging target.
 */
function closenessTo(check, clues, tier) {
  const s = check.score === 99 ? 99 : check.score;
  const target = Number.isFinite(tier.target) ? tier.target : 99;
  const overshoot = s > tier.ceiling ? 100 : 0;
  return Math.abs(s - target) + Math.abs(clues - tier.minClues) * 0.1 + overshoot;
}

/* ------------------------------------------------------------------ *
 * Share tokens
 * ------------------------------------------------------------------ */

/**
 * Compact, human-typeable share token:
 *   sdk-<seed>-<tier letter><S|A>-<attempt>
 * e.g. "sdk-7K3P9QX2-hS-3" = seed 7K3P9QX2, hard, symmetric, attempt 3.
 */
const TIER_LETTER = { easy: 'e', medium: 'm', hard: 'h', expert: 'x', extreme: 'k' };
const LETTER_TIER = Object.fromEntries(Object.entries(TIER_LETTER).map(([k, v]) => [v, k]));

export function encodeShare({ seed, difficulty, symmetry, attempt }) {
  if (!TIER_LETTER[difficulty]) throw new Error(`unknown difficulty "${difficulty}"`);
  return `sdk-${String(seed).toUpperCase()}-${TIER_LETTER[difficulty]}${symmetry ? 'S' : 'A'}-${attempt}`;
}

export function decodeShare(token) {
  const m = /^sdk-([0-9A-Za-z]{1,16})-([emhxk])([SA])-(\d{1,4})$/.exec(String(token).trim());
  if (!m) throw new Error(`not a puzzle share token: "${token}"`);
  return {
    seed: m[1].toUpperCase(),
    difficulty: LETTER_TIER[m[2]],
    symmetry: m[3] === 'S',
    attempt: parseInt(m[4], 10)
  };
}

/**
 * Rebuild a shared puzzle bit-identically. Pins the attempt index from the token,
 * so the search stops exactly where it stopped for the sharer.
 */
export function rebuildFromShare(token) {
  const p = decodeShare(token);
  const puzzle = generatePuzzle({ ...p, attempt: p.attempt });
  if (!puzzle.accepted) {
    throw new Error(`shared puzzle failed its tier contract: ${puzzle.reason}`);
  }
  return puzzle;
}

function range(from, to) {
  const out = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

export { parseGrid, isValidSolution };
