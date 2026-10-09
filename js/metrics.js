/**
 * Metrics.
 *
 * Pure functions over puzzle records — no storage, no DOM — so they are trivially
 * testable and can be recomputed on every render.
 *
 * The set is what a Sudoku player actually asks about: how many have I done, how
 * fast am I at each level, am I improving, how often do I reach for notes or
 * hints, how many mistakes, what patterns have my puzzles actually demanded, and
 * what should I play next.
 */

import { decodeNotes, STATUS } from './store.js';
import { TECH_BY_KEY } from './solver.js';
import { parseGrid } from './board.js';

const TIER_KEYS = ['easy', 'medium', 'hard', 'expert', 'extreme'];

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (a, b) => (b > 0 ? a / b : 0);

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

export function formatPct(x, digits = 0) {
  if (!Number.isFinite(x)) return '—';
  return `${(x * 100).toFixed(digits)}%`;
}

function userFilledCells(p) {
  const ug = p.progress && p.progress.userGrid ? p.progress.userGrid : '';
  if (ug.length !== 81) return 0;
  let n = 0;
  for (let i = 0; i < 81; i++) {
    const ch = ug[i];
    if (ch !== '.' && ch !== '0' && ch !== '') {
      // only count cells the player could legally fill (not givens)
      if (p.grid[i] === '.') n++;
    }
  }
  return n;
}

function notesUsed(p) {
  const notes = decodeNotes((p.progress && p.progress.notes) || '');
  return notes.some((m) => m !== 0);
}

function emptyTierStat() {
  return {
    played: 0,
    completed: 0,
    abandoned: 0,
    active: 0,
    times: [],
    mistakes: 0,
    hints: 0,
    filled: 0,
    clues: []
  };
}

function finishTierStat(s) {
  return {
    played: s.played,
    completed: s.completed,
    abandoned: s.abandoned,
    active: s.active,
    completionRate: pct(s.completed, s.played),
    avgTime: mean(s.times),
    medianTime: median(s.times),
    bestTime: s.times.length ? Math.min(...s.times) : 0,
    worstTime: s.times.length ? Math.max(...s.times) : 0,
    avgMistakes: pct(s.mistakes, Math.max(1, s.completed)),
    avgHints: pct(s.hints, Math.max(1, s.completed)),
    accuracy: pct(s.filled, s.filled + s.mistakes),
    avgClues: mean(s.clues),
    // seconds per empty cell: comparable across clue counts
    pace: s.times.length ? mean(s.times.map((t, i) => t / Math.max(1, 81 - (s.clues[i] ?? 30)))) : 0
  };
}

/**
 * Full summary of a library.
 * @param {Array} puzzles puzzle records (any status)
 * @param {object} counters { generated, duplicatesRejected }
 */
export function summarize(puzzles, counters = {}) {
  const completed = puzzles.filter((p) => p.status === STATUS.COMPLETED);
  const abandoned = puzzles.filter((p) => p.status === STATUS.ABANDONED);
  const active = puzzles.filter((p) => p.status === STATUS.ACTIVE);

  const tiers = Object.fromEntries(TIER_KEYS.map((k) => [k, emptyTierStat()]));
  const techniqueExposure = {};
  let totalNotesUsers = 0;
  let totalMistakes = 0;
  let totalHints = 0;
  let totalFilled = 0;

  for (const p of puzzles) {
    const t = tiers[p.difficulty] || null;
    if (t) {
      t.played++;
      if (p.status === STATUS.COMPLETED) t.completed++;
      else if (p.status === STATUS.ABANDONED) t.abandoned++;
      else t.active++;
      if (p.clues) t.clues.push(p.clues);
      if (p.status === STATUS.COMPLETED && p.solveTimeMs > 0) t.times.push(p.solveTimeMs);
      t.mistakes += (p.progress && p.progress.mistakes) || 0;
      t.hints += (p.progress && p.progress.hints) || 0;
      t.filled += userFilledCells(p);
    }
    totalMistakes += (p.progress && p.progress.mistakes) || 0;
    totalHints += (p.progress && p.progress.hints) || 0;
    totalFilled += userFilledCells(p);
    if (notesUsed(p)) totalNotesUsers++;

    const hardest = p.rating && p.rating.hardest;
    if (hardest) {
      const info = TECH_BY_KEY[hardest] || { name: hardest, level: 0 };
      const k = hardest;
      if (!techniqueExposure[k]) techniqueExposure[k] = { key: k, name: info.name, level: info.level, puzzles: 0 };
      techniqueExposure[k].puzzles++;
    }
  }

  // Streaks: walk the library by last activity; a completion extends, an
  // abandonment breaks.
  const byActivity = [...puzzles].sort(
    (a, b) => (b.completedAt || b.updatedAt) - (a.completedAt || a.updatedAt)
  );
  let currentStreak = 0;
  let longestStreak = 0;
  let run = 0;
  for (const p of byActivity) {
    if (p.status === STATUS.COMPLETED) {
      run++;
      longestStreak = Math.max(longestStreak, run);
    } else if (p.status === STATUS.ABANDONED) {
      run = 0;
    }
  }
  // current streak = run counted from the most recent record forward
  run = 0;
  for (const p of byActivity) {
    if (p.status === STATUS.COMPLETED) run++;
    else if (p.status === STATUS.ABANDONED) break;
  }
  currentStreak = run;

  // Daily streak over local calendar days with at least one completion.
  const days = new Set(
    completed
      .filter((p) => p.completedAt)
      .map((p) => {
        const d = new Date(p.completedAt);
        return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
      })
  );
  let dailyStreak = 0;
  const cursor = new Date();
  const keyOf = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  if (!days.has(keyOf(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (days.has(keyOf(cursor))) {
    dailyStreak++;
    cursor.setDate(cursor.getDate() - 1);
  }

  // Improvement: mean solve time of the 10 most recent completions vs the 10 before.
  const chrono = completed
    .filter((p) => p.solveTimeMs > 0)
    .sort((a, b) => (a.completedAt || 0) - (b.completedAt || 0));
  const recent = chrono.slice(-10);
  const prior = chrono.slice(-20, -10);
  const recentAvg = mean(recent.map((p) => p.solveTimeMs));
  const priorAvg = mean(prior.map((p) => p.solveTimeMs));
  const trendPct = prior.length ? (priorAvg - recentAvg) / priorAvg : 0;

  const fastest = chrono.length
    ? chrono.reduce((a, b) => (b.solveTimeMs < a.solveTimeMs ? b : a))
    : null;

  return {
    totals: {
      puzzles: puzzles.length,
      completed: completed.length,
      abandoned: abandoned.length,
      active: active.length,
      completionRate: pct(completed.length, puzzles.length),
      generated: counters.generated || 0,
      duplicatesRejected: counters.duplicatesRejected || 0
    },
    perTier: Object.fromEntries(TIER_KEYS.map((k) => [k, finishTierStat(tiers[k])])),
    streaks: { current: currentStreak, longest: longestStreak, daily: dailyStreak },
    accuracy: pct(totalFilled, totalFilled + totalMistakes),
    mistakes: totalMistakes,
    hints: totalHints,
    hintRate: pct(totalHints, Math.max(1, completed.length)),
    notesUsage: pct(totalNotesUsers, puzzles.length),
    trend: {
      recentCount: recent.length,
      priorCount: prior.length,
      recentAvg,
      priorAvg,
      pct: trendPct
    },
    fastest: fastest
      ? { id: fastest.id, difficulty: fastest.difficulty, time: fastest.solveTimeMs, clues: fastest.clues }
      : null,
    techniqueExposure: Object.values(techniqueExposure).sort((a, b) => a.level - b.level)
  };
}

/**
 * Suggest the next tier: the highest tier the player is completing at a decent
 * clip without leaning on hints. Deliberately conservative — it never suggests
 * dropping down.
 */
export function suggestNextTier(summary) {
  const order = TIER_KEYS;
  let best = 'easy';
  for (const k of order) {
    const s = summary.perTier[k];
    if (s.completed >= 2 && s.completionRate >= 0.6 && s.avgHints <= 1.5) best = k;
  }
  const idx = order.indexOf(best);
  const next = order[Math.min(order.length - 1, idx + 1)];
  return { at: best, next, canAdvance: next !== best };
}

/** Human-readable one-line "what this puzzle needed" from its rating. */
export function describeRating(rating) {
  if (!rating) return 'unrated';
  const name = (TECH_BY_KEY[rating.hardest] && TECH_BY_KEY[rating.hardest].name) || rating.hardest;
  if (rating.hardest === 'guess') return 'needs guessing / forcing chains';
  return `${name} (level ${rating.score})`;
}

export { parseGrid };
