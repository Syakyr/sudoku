import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createStore,
  encodeNotes,
  decodeNotes,
  migrate,
  STATUS,
  STORAGE_KEY
} from '../js/store.js';
import { generatePuzzle } from '../js/generator.js';
import { summarize, suggestNextTier, describeRating, formatDuration } from '../js/metrics.js';

function memStorage() {
  const m = new Map();
  return {
    map: m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k)
  };
}

function makePuzzle(seed, difficulty = 'easy') {
  return generatePuzzle({ seed, difficulty, symmetry: true, maxAttempts: 30, timeBudgetMs: 5000 });
}

test('notes encode/decode round trip', () => {
  const notes = new Array(81).fill(0);
  notes[0] = 0b111111111;
  notes[40] = 0b000000010;
  notes[80] = 0b101010101;
  const enc = encodeNotes(notes);
  assert.equal(enc.length, 243);
  assert.deepEqual(decodeNotes(enc), notes);
  assert.deepEqual(decodeNotes(''), new Array(81).fill(0));
  assert.deepEqual(decodeNotes(null), new Array(81).fill(0));
});

test('store starts empty and persists across instances on the same backend', () => {
  const backend = memStorage();
  const s1 = createStore({ storage: backend });
  assert.deepEqual(s1.allPuzzles(), []);
  const p = makePuzzle('STORE1');
  const res = s1.addPuzzle(p);
  assert.ok(res.ok);
  const s2 = createStore({ storage: backend });
  assert.equal(s2.allPuzzles().length, 1);
  assert.equal(s2.getPuzzle(res.puzzle.id).seed, 'STORE1');
});

test('duplicate boards are rejected by symmetry, not just by exact string', () => {
  const store = createStore({ storage: memStorage() });
  const p = makePuzzle('DUP1');
  assert.ok(store.addPuzzle(p).ok);
  const same = { ...p, id: 'other', grid: p.grid };
  const dup = store.addPuzzle(same);
  assert.equal(dup.ok, false);
  assert.equal(dup.reason, 'duplicate');
  assert.equal(store.allPuzzles().length, 1);
  assert.equal(store.doc.counters.duplicatesRejected, 1);
});

test('status transitions: active -> completed / abandoned', () => {
  const store = createStore({ storage: memStorage() });
  const a = store.addPuzzle(makePuzzle('S-A')).puzzle;
  const b = store.addPuzzle(makePuzzle('S-B')).puzzle;
  assert.equal(store.byStatus(STATUS.ACTIVE).length, 2);
  store.complete(a.id, { solveTimeMs: 5000 });
  store.abandon(b.id);
  assert.equal(store.byStatus(STATUS.COMPLETED)[0].id, a.id);
  assert.equal(store.byStatus(STATUS.ABANDONED)[0].id, b.id);
  assert.equal(store.getPuzzle(a.id).solveTimeMs, 5000);
});

test('progress updates persist and merge', () => {
  const store = createStore({ storage: memStorage() });
  const p = store.addPuzzle(makePuzzle('PROG')).puzzle;
  store.updateProgress(p.id, { userGrid: '123456789'.repeat(9), elapsedMs: 1234 });
  store.updateProgress(p.id, { elapsedMs: 4321 });
  const got = store.getPuzzle(p.id);
  assert.equal(got.progress.elapsedMs, 4321);
  assert.equal(got.progress.userGrid.length, 81);
});

test('export/import round trips the whole library', () => {
  const src = createStore({ storage: memStorage() });
  src.addPuzzle(makePuzzle('EXP1'));
  src.addPuzzle(makePuzzle('EXP2'));
  const [a, b] = src.allPuzzles();
  src.complete(a.id, { solveTimeMs: 9000 });
  const blob = src.exportAll();

  const dst = createStore({ storage: memStorage() });
  const res = dst.importAll(blob);
  assert.ok(res.ok);
  assert.equal(res.added, 2);
  assert.equal(dst.allPuzzles().length, 2);
  const completed = dst.byStatus(STATUS.COMPLETED);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].solveTimeMs, 9000);
});

test('import merge skips duplicates already present', () => {
  const store = createStore({ storage: memStorage() });
  const p = makePuzzle('MERGE1');
  store.addPuzzle(p);
  const blob = JSON.stringify({ puzzles: [p, makePuzzle('MERGE2')] });
  const res = store.importAll(blob, { merge: true });
  assert.equal(res.added, 1);
  assert.equal(res.skippedDuplicate, 1);
  assert.equal(store.allPuzzles().length, 2);
});

test('import rejects garbage without corrupting the library', () => {
  const store = createStore({ storage: memStorage() });
  store.addPuzzle(makePuzzle('KEEP1'));
  assert.equal(store.importAll('not json').ok, false);
  assert.equal(store.importAll('{}').ok, false);
  assert.equal(store.importAll(JSON.stringify({ puzzles: [{ grid: 'zzz' }] })).skippedInvalid, 1);
  assert.equal(store.allPuzzles().length, 1);
});

test('import with merge=false replaces the library', () => {
  const store = createStore({ storage: memStorage() });
  store.addPuzzle(makePuzzle('OLD1'));
  const blob = JSON.stringify({ puzzles: [makePuzzle('NEW1')] });
  store.importAll(blob, { merge: false });
  const all = store.allPuzzles();
  assert.equal(all.length, 1);
  assert.equal(all[0].seed, 'NEW1');
});

test('migrate normalises junk records instead of throwing', () => {
  const doc = migrate({
    schema: 1,
    puzzles: {
      good: { grid: '1'.repeat(81), status: 'completed', progress: { elapsedMs: '3' } },
      bad: null
    }
  });
  assert.ok(doc.puzzles.good);
  assert.equal(doc.puzzles.bad, undefined);
  assert.equal(doc.puzzles.good.progress.elapsedMs, 3);
  assert.equal(migrate(null).puzzles !== undefined, true);
  assert.equal(migrate({}).schema, 1);
});

test('remove clears the puzzle and its canon index entry', () => {
  const store = createStore({ storage: memStorage() });
  const p = store.addPuzzle(makePuzzle('DEL1')).puzzle;
  assert.equal(store.remove(p.id), true);
  assert.equal(store.allPuzzles().length, 0);
  assert.equal(store.findDuplicate(p.grid).duplicate, false);
  assert.equal(store.remove('nope'), false);
});

test('clearAll wipes everything', () => {
  const store = createStore({ storage: memStorage() });
  store.addPuzzle(makePuzzle('W1'));
  store.clearAll();
  assert.equal(store.allPuzzles().length, 0);
  assert.equal(Object.keys(store.doc.canonIndex).length, 0);
});

test('store falls back to memory when the backend throws', () => {
  const broken = {
    getItem() {
      throw new Error('quota');
    },
    setItem() {
      throw new Error('quota');
    },
    removeItem() {}
  };
  const store = createStore({ storage: broken });
  const res = store.addPuzzle(makePuzzle('MEM1'));
  assert.ok(res.ok, 'add must still work in-memory');
  assert.equal(store.inMemory, true);
});

/* ------------------------------ metrics ------------------------------ */

function synth(id, status, difficulty, { time = 60000, mistakes = 0, hints = 0, daysAgo = 0, notes = false } = {}) {
  const now = Date.now();
  return {
    id,
    status,
    difficulty,
    clues: 30,
    grid: '.'.repeat(81),
    rating: { score: 2, hardest: 'pointing' },
    createdAt: now - daysAgo * 86400000,
    updatedAt: now - daysAgo * 86400000,
    completedAt: status === STATUS.COMPLETED ? now - daysAgo * 86400000 : null,
    solveTimeMs: status === STATUS.COMPLETED ? time : null,
    progress: {
      userGrid: status === STATUS.COMPLETED ? '1'.repeat(51).padEnd(81, '.') : '',
      notes: notes ? encodeNotes([3, 0, 0]) : '',
      elapsedMs: time,
      mistakes,
      hints
    }
  };
}

test('summarize counts statuses and completion rate', () => {
  const s = summarize([
    synth('a', STATUS.COMPLETED, 'easy'),
    synth('b', STATUS.ABANDONED, 'easy'),
    synth('c', STATUS.ACTIVE, 'hard')
  ]);
  assert.equal(s.totals.puzzles, 3);
  assert.equal(s.totals.completed, 1);
  assert.equal(s.totals.abandoned, 1);
  assert.equal(s.totals.active, 1);
  assert.equal(s.totals.completionRate, 1 / 3);
});

test('per-tier stats include best/avg time and accuracy', () => {
  const s = summarize([
    synth('a', STATUS.COMPLETED, 'easy', { time: 30000, mistakes: 2 }),
    synth('b', STATUS.COMPLETED, 'easy', { time: 90000, mistakes: 0 }),
    synth('c', STATUS.COMPLETED, 'hard', { time: 200000, mistakes: 5 })
  ]);
  assert.equal(s.perTier.easy.completed, 2);
  assert.equal(s.perTier.easy.bestTime, 30000);
  assert.equal(s.perTier.easy.avgTime, 60000);
  assert.equal(s.perTier.hard.completed, 1);
  assert.ok(s.perTier.easy.accuracy > 0.9);
});

test('streaks break on abandonment', () => {
  const s = summarize([
    synth('old', STATUS.COMPLETED, 'easy', { daysAgo: 5 }),
    synth('mid', STATUS.ABANDONED, 'easy', { daysAgo: 3 }),
    synth('n1', STATUS.COMPLETED, 'easy', { daysAgo: 2 }),
    synth('n2', STATUS.COMPLETED, 'easy', { daysAgo: 1 })
  ]);
  assert.equal(s.streaks.current, 2);
  assert.equal(s.streaks.longest, 2);
});

test('daily streak counts consecutive calendar days with a completion', () => {
  const s = summarize([
    synth('today', STATUS.COMPLETED, 'easy', { daysAgo: 0 }),
    synth('yday', STATUS.COMPLETED, 'easy', { daysAgo: 1 }),
    synth('gap', STATUS.COMPLETED, 'easy', { daysAgo: 3 })
  ]);
  assert.equal(s.streaks.daily, 2);
});

test('trend compares the last ten completions against the ten before', () => {
  const items = [];
  for (let i = 0; i < 20; i++) {
    items.push(synth(`p${i}`, STATUS.COMPLETED, 'easy', { time: i < 10 ? 120000 : 60000, daysAgo: 20 - i }));
  }
  const s = summarize(items);
  assert.equal(s.trend.recentCount, 10);
  assert.equal(s.trend.priorCount, 10);
  assert.ok(s.trend.pct > 0.4, 'should report a big improvement');
});

test('technique exposure lists what puzzles actually demanded', () => {
  const s = summarize([synth('a', STATUS.COMPLETED, 'easy'), synth('b', STATUS.COMPLETED, 'easy')]);
  assert.equal(s.techniqueExposure.length, 1);
  assert.equal(s.techniqueExposure[0].name, 'Pointing Pair');
  assert.equal(s.techniqueExposure[0].puzzles, 2);
});

test('notes usage and hint rate are tracked', () => {
  const s = summarize([
    synth('a', STATUS.COMPLETED, 'easy', { notes: true, hints: 2 }),
    synth('b', STATUS.COMPLETED, 'easy', { notes: false, hints: 0 })
  ]);
  assert.equal(s.notesUsage, 0.5);
  assert.equal(s.hints, 2);
});

test('suggestNextTier advances only when the player is ready', () => {
  const ready = summarize([
    synth('a', STATUS.COMPLETED, 'easy', { time: 40000 }),
    synth('b', STATUS.COMPLETED, 'easy', { time: 50000 })
  ]);
  const r = suggestNextTier(ready);
  assert.equal(r.at, 'easy');
  assert.equal(r.next, 'medium');
  assert.ok(r.canAdvance);

  const nowhere = summarize([]);
  assert.equal(suggestNextTier(nowhere).at, 'easy');
});

test('describeRating and formatDuration are human readable', () => {
  assert.equal(describeRating({ hardest: 'guess', score: 7 }), 'needs guessing / forcing chains');
  assert.match(describeRating({ hardest: 'x-wing', score: 3.4 }), /X-Wing/);
  assert.equal(describeRating(null), 'unrated');
  assert.equal(formatDuration(0), '—');
  assert.equal(formatDuration(65000), '1m 05s');
  assert.equal(formatDuration(3725000), '1h 02m');
});

test('takeback mode and attempt count survive the store round-trip', () => {
  const ls = memStorage();
  const s = createStore({ storage: ls });
  const p = generatePuzzle({ seed: 'MODESEED', difficulty: 'easy' });
  const res = s.addPuzzle({ ...p, mode: 'strict', attempts: 1 });
  assert.ok(res.ok, 'puzzle added');
  assert.equal(res.puzzle.mode, 'strict', 'addPuzzle whitelist must keep mode');
  assert.equal(res.puzzle.attempts, 1, 'addPuzzle whitelist must keep attempts');

  s.setMeta(res.puzzle.id, { attempts: 3 });
  const reloaded = createStore({ storage: ls });
  const rec = reloaded.getPuzzle(res.puzzle.id);
  assert.equal(rec.attempts, 3, 'attempts must persist across a reload');
  assert.equal(rec.mode, 'strict', 'mode must persist across a reload');

  // Junk normalises rather than persisting, so modeOf never sees a third value.
  s.setMeta(res.puzzle.id, { mode: 'whatever' });
  assert.equal(s.getPuzzle(res.puzzle.id).mode, 'casual');
});

test('stats do not blend casual and strict records', () => {
  const s = createStore({ storage: memStorage() });
  const a = generatePuzzle({ seed: 'SPLIT-A', difficulty: 'easy' });
  const b = generatePuzzle({ seed: 'SPLIT-B', difficulty: 'easy' });
  const ra = s.addPuzzle({ ...a, mode: 'casual' });
  const rb = s.addPuzzle({ ...b, mode: 'strict' });
  assert.ok(ra.ok && rb.ok, 'both puzzles stored');
  s.complete(ra.puzzle.id, { solveTimeMs: 60000, mistakes: 5, hints: 0 });
  s.complete(rb.puzzle.id, { solveTimeMs: 61000, mistakes: 0, hints: 0 });
  // accuracy is filled/(filled+mistakes), so the fixture needs real user cells
  // or every bucket collapses to 0 and the comparison proves nothing.
  s.updateProgress(ra.puzzle.id, { userGrid: a.solution });
  s.updateProgress(rb.puzzle.id, { userGrid: b.solution });

  const all = summarize(s.allPuzzles(), s.doc.counters);
  const casual = summarize(s.allPuzzles().filter((p) => p.mode === 'casual'), s.doc.counters);
  const strict = summarize(s.allPuzzles().filter((p) => p.mode === 'strict'), s.doc.counters);

  assert.equal(all.mistakes, 5, 'blended total');
  assert.equal(casual.mistakes, 5, 'casual bucket carries its own mistakes');
  assert.equal(strict.mistakes, 0, 'strict bucket must not absorb casual mistakes');
  assert.notEqual(all.accuracy, strict.accuracy, 'blended accuracy must differ from strict-only');
});
