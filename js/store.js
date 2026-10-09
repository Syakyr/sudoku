/**
 * Persistence: the puzzle library.
 *
 * Everything lives in one JSON document under a versioned localStorage key, so
 * export/import is a single blob that carries the whole library between devices.
 *
 * A puzzle record keeps its generation provenance (seed, tier, symmetry, attempt)
 * alongside the board itself. The board is the ground truth; the provenance is
 * what makes the share token re-generable and lets us tell the player where a
 * puzzle came from.
 *
 * Statuses:
 *   active     - started or not yet finished, still playable
 *   completed  - solved
 *   abandoned  - the player quit and asked for a new one; kept for the metrics
 *
 * The storage object is injectable so the whole layer is testable in node without
 * a browser. If localStorage is unavailable (private mode, quota), we degrade to
 * an in-memory store rather than crashing the page.
 */

import { canonicalKey } from './canon.js';
import { parseGrid, gridToString, clueCount, isValidSolution } from './board.js';

export const STORAGE_KEY = 'sudoku.library.v1';
export const SCHEMA_VERSION = 1;
export const STATUS = { ACTIVE: 'active', COMPLETED: 'completed', ABANDONED: 'abandoned' };

/** 9-bit note mask per cell -> 3 hex chars per cell (243 chars total). */
export function encodeNotes(notes) {
  let out = '';
  for (let i = 0; i < 81; i++) out += ((notes[i] | 0) & 0x1ff).toString(16).padStart(3, '0');
  return out;
}

export function decodeNotes(str) {
  const notes = new Array(81).fill(0);
  if (typeof str !== 'string') return notes;
  for (let i = 0; i < 81; i++) {
    const chunk = str.substr(i * 3, 3);
    const v = parseInt(chunk, 16);
    notes[i] = Number.isFinite(v) ? v & 0x1ff : 0;
  }
  return notes;
}

function emptyDoc() {
  const now = Date.now();
  return {
    schema: SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now,
    puzzles: {},
    canonIndex: {},
    counters: { generated: 0, duplicatesRejected: 0 }
  };
}

/** Upgrade an older document to the current schema. */
export function migrate(doc) {
  if (!doc || typeof doc !== 'object') return emptyDoc();
  if (!doc.schema || doc.schema < 1) return emptyDoc();
  const out = {
    schema: SCHEMA_VERSION,
    createdAt: doc.createdAt || Date.now(),
    updatedAt: doc.updatedAt || Date.now(),
    puzzles: doc.puzzles && typeof doc.puzzles === 'object' ? doc.puzzles : {},
    canonIndex: doc.canonIndex && typeof doc.canonIndex === 'object' ? doc.canonIndex : {},
    counters: {
      generated: (doc.counters && doc.counters.generated) || 0,
      duplicatesRejected: (doc.counters && doc.counters.duplicatesRejected) || 0
    }
  };
  // Normalise every record so later code can trust the shape.
  for (const [id, p] of Object.entries(out.puzzles)) {
    if (!p || typeof p !== 'object') {
      delete out.puzzles[id];
      continue;
    }
    p.id = id;
    p.status = [STATUS.ACTIVE, STATUS.COMPLETED, STATUS.ABANDONED].includes(p.status)
      ? p.status
      : STATUS.ACTIVE;
    p.progress = p.progress && typeof p.progress === 'object' ? p.progress : {};
    p.progress.userGrid = typeof p.progress.userGrid === 'string' ? p.progress.userGrid : '';
    p.progress.notes = typeof p.progress.notes === 'string' ? p.progress.notes : '';
    p.progress.elapsedMs = Number(p.progress.elapsedMs) || 0;
    p.progress.mistakes = Number(p.progress.mistakes) || 0;
    p.progress.hints = Number(p.progress.hints) || 0;
    p.progress.undos = Number(p.progress.undos) || 0;
  }
  return out;
}

/**
 * @param {object} opts
 *   storage  a localStorage-shaped object (getItem/setItem/removeItem); defaults
 *            to globalThis.localStorage, falling back to memory
 *   canonMode 'full' (default) folds the entire geometric symmetry group;
 *            'standard' is the cheaper 288-transform version
 */
export function createStore({ storage, canonMode = 'full', now = () => Date.now() } = {}) {
  let mem = null;
  let backend = null;
  const candidate =
    storage ||
    (typeof globalThis !== 'undefined' && globalThis.localStorage
      ? globalThis.localStorage
      : null);
  if (candidate && typeof candidate.getItem === 'function') {
    try {
      candidate.setItem('__sudoku_probe__', '1');
      candidate.removeItem('__sudoku_probe__');
      backend = candidate;
    } catch {
      backend = null;
    }
  }
  if (!backend) {
    const map = new Map();
    backend = {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k)
    };
    mem = true;
  }

  let doc = load();

  function load() {
    try {
      const raw = backend.getItem(STORAGE_KEY);
      if (!raw) return emptyDoc();
      return migrate(JSON.parse(raw));
    } catch {
      return emptyDoc();
    }
  }

  function save() {
    doc.updatedAt = now();
    try {
      backend.setItem(STORAGE_KEY, JSON.stringify(doc));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err && err.name ? err.name : 'write-failed' };
    }
  }

  function newId() {
    // Sortable-ish id: timestamp + random suffix.
    const rnd = Math.floor(Math.random() * 1e6).toString(36).padStart(4, '0');
    return `p${now().toString(36)}${rnd}`;
  }

  /** Look up whether this board is already in the library under symmetry. */
  function findDuplicate(gridStr) {
    const key = canonicalKey(gridStr, canonMode);
    const id = doc.canonIndex[key];
    if (id && doc.puzzles[id]) return { duplicate: true, id, canonKey: key };
    return { duplicate: false, canonKey: key };
  }

  /**
   * Add a generated (or imported) puzzle.
   * Returns { ok, puzzle } or { ok:false, reason:'duplicate', existing }.
   */
  function addPuzzle(puzzle, { allowDuplicate = false } = {}) {
    const gridStr = typeof puzzle.grid === 'string' ? puzzle.grid : gridToString(puzzle.grid);
    const { duplicate, id: existingId, canonKey: key } = findDuplicate(gridStr);
    if (duplicate && !allowDuplicate) {
      doc.counters.duplicatesRejected++;
      save();
      return { ok: false, reason: 'duplicate', existing: doc.puzzles[existingId], canonKey: key };
    }
    const id = puzzle.id || newId();
    const rec = {
      id,
      seed: puzzle.seed || null,
      difficulty: puzzle.difficulty || 'medium',
      symmetry: !!puzzle.symmetry,
      attempt: puzzle.attempt ?? null,
      share: puzzle.share || null,
      grid: gridStr,
      solution: puzzle.solution || null,
      clues: puzzle.clues ?? clueCount(parseGrid(gridStr)),
      rating: puzzle.rating || null,
      canonKey: key,
      source: puzzle.source || 'generated',
      createdAt: puzzle.createdAt || now(),
      updatedAt: now(),
      status: puzzle.status || STATUS.ACTIVE,
      // Takeback mode is fixed at creation and attempts is cumulative history.
      // Both must be in this whitelist or they are silently dropped on the way in.
      mode: puzzle.mode === 'strict' ? 'strict' : 'casual',
      attempts: Number(puzzle.attempts) > 0 ? Number(puzzle.attempts) : 1,
      progress: {
        userGrid: '',
        notes: '',
        elapsedMs: 0,
        mistakes: 0,
        hints: 0,
        undos: 0,
        ...(puzzle.progress || {})
      },
      completedAt: puzzle.completedAt || null,
      solveTimeMs: puzzle.solveTimeMs ?? null
    };
    doc.puzzles[id] = rec;
    doc.canonIndex[key] = id;
    doc.counters.generated++;
    save();
    return { ok: true, puzzle: rec };
  }

  function getPuzzle(id) {
    return doc.puzzles[id] || null;
  }

  function allPuzzles() {
    return Object.values(doc.puzzles).sort((a, b) => b.createdAt - a.createdAt);
  }

  function byStatus(status) {
    return allPuzzles().filter((p) => p.status === status);
  }

  /** Top-level record fields that are not play progress: mode and attempts. */
  function setMeta(id, patch = {}) {
    const p = doc.puzzles[id];
    if (!p) return null;
    if ('mode' in patch) p.mode = patch.mode === 'strict' ? 'strict' : 'casual';
    if ('attempts' in patch) p.attempts = Math.max(1, Number(patch.attempts) || 1);
    p.updatedAt = now();
    save();
    return p;
  }

  function updateProgress(id, patch) {
    const p = doc.puzzles[id];
    if (!p) return null;
    Object.assign(p.progress, patch);
    p.updatedAt = now();
    save();
    return p;
  }

  function complete(id, { solveTimeMs, mistakes, hints } = {}) {
    const p = doc.puzzles[id];
    if (!p) return null;
    p.status = STATUS.COMPLETED;
    p.completedAt = now();
    p.solveTimeMs = solveTimeMs ?? p.progress.elapsedMs ?? 0;
    if (mistakes !== undefined) p.progress.mistakes = mistakes;
    if (hints !== undefined) p.progress.hints = hints;
    p.updatedAt = now();
    save();
    return p;
  }

  function abandon(id) {
    const p = doc.puzzles[id];
    if (!p) return null;
    p.status = STATUS.ABANDONED;
    p.updatedAt = now();
    save();
    return p;
  }

  function remove(id) {
    const p = doc.puzzles[id];
    if (!p) return false;
    delete doc.puzzles[id];
    for (const [k, v] of Object.entries(doc.canonIndex)) {
      if (v === id) delete doc.canonIndex[k];
    }
    save();
    return true;
  }

  function clearAll() {
    doc = emptyDoc();
    save();
  }

  /** Portable snapshot of the whole library. */
  function exportAll() {
    return JSON.stringify(
      {
        app: 'sudoku',
        schema: SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        counters: doc.counters,
        puzzles: Object.values(doc.puzzles)
      },
      null,
      2
    );
  }

  /**
   * Import a snapshot. With merge=true existing ids are kept and only new puzzles
   * are added; with merge=false the library is replaced.
   * Symmetry duplicates are skipped either way so a merge cannot poison the
   * uniqueness registry.
   */
  function importAll(json, { merge = true } = {}) {
    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch {
      return { ok: false, reason: 'not-valid-json' };
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.puzzles)) {
      return { ok: false, reason: 'missing-puzzles' };
    }
    if (!merge) {
      doc = emptyDoc();
    }
    const result = { added: 0, skippedDuplicate: 0, skippedInvalid: 0, updated: 0 };
    for (const raw of parsed.puzzles) {
      if (!raw || typeof raw !== 'object' || typeof raw.grid !== 'string') {
        result.skippedInvalid++;
        continue;
      }
      let gridStr;
      try {
        gridStr = gridToString(parseGrid(raw.grid));
      } catch {
        result.skippedInvalid++;
        continue;
      }
      const { duplicate, id: existingId } = findDuplicate(gridStr);
      if (duplicate) {
        if (merge && doc.puzzles[existingId] && raw.status === STATUS.COMPLETED) {
          // Keep the better-progressed copy.
          const cur = doc.puzzles[existingId];
          if (cur.status !== STATUS.COMPLETED) {
            cur.status = STATUS.COMPLETED;
            cur.completedAt = raw.completedAt || now();
            cur.solveTimeMs = raw.solveTimeMs ?? cur.solveTimeMs ?? 0;
            result.updated++;
          }
        } else {
          result.skippedDuplicate++;
        }
        continue;
      }
      const res = addPuzzle({ ...raw, grid: gridStr }, { allowDuplicate: true });
      if (res.ok) result.added++;
      else result.skippedInvalid++;
    }
    save();
    return { ok: true, ...result };
  }

  return {
    get inMemory() {
      return !!mem;
    },
    get doc() {
      return doc;
    },
    save,
    reload: () => {
      doc = load();
      return doc;
    },
    findDuplicate,
    addPuzzle,
    getPuzzle,
    allPuzzles,
    byStatus,
    updateProgress,
    setMeta,
    complete,
    abandon,
    remove,
    clearAll,
    exportAll,
    importAll
  };
}

export { isValidSolution };
