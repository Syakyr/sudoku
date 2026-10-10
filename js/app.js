/**
 * UI controller.
 *
 * Everything here is presentation and plumbing: the engine (board/solver/
 * generator/canon) and the store are browser-agnostic and already tested in node.
 * This file wires them to the DOM.
 *
 * Generation runs in yielded chunks so a long search for an in-band, not-already-
 * played board never freezes the page.
 */

import {
  generatePuzzle,
  TIERS,
  TIER_ORDER,
  encodeShare,
  rebuildFromShare
} from './generator.js';
import { randomSeedString } from './prng.js';
import { parseGrid, gridToString, PEERS, rowOf, colOf } from './board.js';
import { solveLogic, TECH_BY_KEY } from './solver.js';
import { createStore, STATUS, encodeNotes, decodeNotes } from './store.js';
import { openStorage } from './native-storage.js';
import { APP_VERSION_LABEL } from './version.js';
import { summarize, suggestNextTier, describeRating, formatDuration, formatPct } from './metrics.js';

/*
 * One async boundary, taken before the store exists, so that everything
 * downstream keeps a synchronous storage API. index.html loads app.js as
 * type="module", so top-level await is legal here.
 *
 * openStorage() resolves to native @capacitor/preferences when the plugin is
 * present (eviction-proof), and to plain localStorage otherwise -- so the PWA
 * path is byte-for-byte the old behaviour. It also migrates any existing
 * localStorage document up to native on first launch, so an upgraded app does
 * not start empty.
 */
const storageInfo = await openStorage();
const store = createStore({ storage: storageInfo.backend });

// Write-behind means a save can still be in flight when the app is backgrounded
// or killed. The localStorage mirror is already durable synchronously, so this
// flush is belt-and-braces for the native copy specifically.
const flushStorage = () => {
  storageInfo.flush().catch(() => {});
};
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushStorage);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushStorage();
  });
}

const state = {
  puzzle: null,
  values: new Uint8Array(81),
  notes: new Array(81).fill(0),
  selected: -1,
  notesMode: false,
  paused: false,
  timerStart: 0,
  elapsedBase: 0,
  interval: null,
  undoStack: [],
  mistakes: 0,
  hints: 0,
  libraryFilter: 'active',
  statsMode: 'all',
  generating: false
};

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/* ------------------------------------------------------------------ *
 * boot
 * ------------------------------------------------------------------ */

function init() {
  buildBoard();
  buildNumpad();
  buildDifficultySelect();
  wireControls();
  updateStorageBadge();
  renderAbout();
  renderLibrary();
  renderStats();

  const resumable = store.byStatus(STATUS.ACTIVE);
  if (resumable.length) {
    loadPuzzle(resumable[0]);
    toast('Resumed your last unfinished puzzle');
  } else {
    startGeneration({ difficulty: 'easy', symmetry: true });
  }
}

/*
 * About row: the version the user is actually running, plus where their library
 * is kept. Both are the first things you need when someone reports a problem,
 * and neither was visible anywhere before.
 *
 * The version comes from js/version.js, which CI overwrites from the git tag
 * during the APK build -- so a packaged app cannot display a version that
 * disagrees with what shipped. package.json is deliberately NOT the source:
 * it has sat at 1.0.0 across the whole v0.2.x line.
 */
function renderAbout() {
  const el = $('aboutVersion');
  if (!el) return;
  const channel =
    storageInfo.mode === 'native'
      ? 'library stored on this device'
      : storageInfo.mode === 'local'
        ? 'library stored in this browser'
        : 'library in memory only (not saved)';
  el.textContent = `Sudoku ${APP_VERSION_LABEL} · ${channel}`;
}

function updateStorageBadge() {
  // The single-pane layout keeps this in the drawer's Data tab; the old top-bar
  // element name is still supported if a layout ever puts it back.
  const badge = $('storageBadge') || $('storageNote');
  if (!badge) return;
  const n = store.allPuzzles().length;
  if (store.inMemory) {
    badge.textContent = `⚠ Storage unavailable — this session only (${n} puzzle${n === 1 ? '' : 's'}). Export before closing the tab.`;
    badge.classList.add('gen-status', 'bad');
  } else if (storageInfo.mode === 'native') {
    badge.textContent = `${n} puzzle${n === 1 ? '' : 's'} saved on this device. Export to move them to another device.`;
  } else {
    badge.textContent = `${n} puzzle${n === 1 ? '' : 's'} saved in this browser under ${'sudoku.library.v1'}. Export to move them to another device.`;
  }
}

/* ------------------------------------------------------------------ *
 * board rendering
 * ------------------------------------------------------------------ */

const cellNodes = [];

function buildBoard() {
  const board = $('board');
  board.innerHTML = '';
  cellNodes.length = 0;
  for (let i = 0; i < 81; i++) {
    const c = el('div', 'cell');
    c.dataset.index = String(i);
    c.dataset.row = String(rowOf(i) % 3);
    c.dataset.col = String(colOf(i) % 3);
    c.setAttribute('role', 'gridcell');
    c.addEventListener('click', () => selectCell(i));
    board.appendChild(c);
    cellNodes.push(c);
  }
  renderBoard();
}

function renderBoard() {
  const sol = state.puzzle && state.puzzle.solution ? parseGrid(state.puzzle.solution) : null;
  const given = state.puzzle ? parseGrid(state.puzzle.grid) : new Uint8Array(81);
  const selDigit = state.selected >= 0 ? state.values[state.selected] : 0;

  for (let i = 0; i < 81; i++) {
    const node = cellNodes[i];
    const v = state.values[i];
    const isGiven = given[i] !== 0;
    const wrong = v !== 0 && !isGiven && conflictsAt(i);

    node.className = 'cell';
    node.dataset.row = String(rowOf(i) % 3);
    node.dataset.col = String(colOf(i) % 3);
    if (isGiven) node.classList.add('given');
    else if (v !== 0) node.classList.add(wrong ? 'wrong' : 'user');

    if (i === state.selected) node.classList.add('selected');
    else if (state.selected >= 0 && PEERS[state.selected].includes(i)) node.classList.add('peer');
    if (selDigit && v === selDigit && i !== state.selected) node.classList.add('same-digit');

    node.textContent = '';
    if (v !== 0) {
      node.textContent = String(v);
    } else if (state.notes[i]) {
      const n = el('div', 'notes');
      for (let d = 1; d <= 9; d++) {
        n.appendChild(el('span', null, state.notes[i] & (1 << d) ? String(d) : ''));
      }
      node.appendChild(n);
    }
  }
  updateCounters();
  updateNumpadDepletion();
}

function updateCounters() {
  $('mistakeCount').textContent = String(state.mistakes);
  $('hintCount').textContent = String(state.hints);
  let filled = 0;
  let blanks = 0;
  const given = state.puzzle ? parseGrid(state.puzzle.grid) : new Uint8Array(81);
  for (let i = 0; i < 81; i++) {
    if (given[i] === 0) blanks++;
    if (state.values[i] !== 0 && given[i] === 0) filled++;
  }
  $('filledCount').textContent = String(filled);
  // Denominator is the blanks you have to fill, not all 81 cells. Counting only
  // user-entered cells over a fixed 81 meant the chip could never reach full on
  // a solved board -- it topped out at (81 - clues)/81.
  const total = $('filledTotal');
  if (total) total.textContent = String(blanks);
}

function buildNumpad() {
  const pad = $('numpad');
  pad.innerHTML = '';
  for (let d = 1; d <= 9; d++) {
    const b = el('button', null, String(d));
    b.type = 'button';
    b.dataset.digit = String(d);
    b.addEventListener('click', () => inputDigit(d));
    pad.appendChild(b);
  }
}

function updateNumpadDepletion() {
  const counts = new Array(10).fill(0);
  for (let i = 0; i < 81; i++) counts[state.values[i]]++;
  for (const b of $('numpad').children) {
    const d = Number(b.dataset.digit);
    b.classList.toggle('depleted', counts[d] >= 9);
  }
}

function selectCell(i) {
  state.selected = i;
  renderBoard();
}

/* ------------------------------------------------------------------ *
 * input
 * ------------------------------------------------------------------ */

function inputDigit(d) {
  if (!state.puzzle || state.paused) return;
  const i = state.selected;
  if (i < 0) return;
  const given = parseGrid(state.puzzle.grid);
  if (given[i] !== 0) return;

  pushUndo();
  if (state.notesMode) {
    state.notes[i] ^= 1 << d;
    saveProgress();
    renderBoard();
    return;
  }
  if (state.values[i] === d) return;
  state.values[i] = d;
  state.notes[i] = 0;
  // pencil-mark housekeeping: clear this digit from peers' notes
  for (const p of PEERS[i]) {
    if (state.notes[p]) state.notes[p] &= ~(1 << d);
  }
  const sol = state.puzzle.solution ? parseGrid(state.puzzle.solution) : null;
  if (conflictsAt(i)) state.mistakes++;
  cellNodes[i].classList.add('just-placed');
  saveProgress();
  renderBoard();
  advanceSelection();
  checkComplete();
}

function advanceSelection() {
  for (let k = 1; k <= 81; k++) {
    const j = (state.selected + k) % 81;
    const given = parseGrid(state.puzzle.grid);
    if (given[j] === 0 && state.values[j] === 0) {
      state.selected = j;
      return;
    }
  }
}

function erase() {
  if (!state.puzzle || state.selected < 0) return;
  const i = state.selected;
  const given = parseGrid(state.puzzle.grid);
  if (given[i] !== 0) return;
  if (state.values[i] === 0 && state.notes[i] === 0) return;
  pushUndo();
  state.values[i] = 0;
  state.notes[i] = 0;
  saveProgress();
  renderBoard();
}

function pushUndo() {
  state.undoStack.push({
    values: Uint8Array.from(state.values),
    notes: state.notes.slice(),
    mistakes: state.mistakes,
    selected: state.selected
  });
  if (state.undoStack.length > 200) state.undoStack.shift();
}

function undo() {
  // Strict mode: the cheap invisible takeback is off. Reset is still available,
  // because throwing away a whole puzzle is a deliberate, recorded act.
  if (state.puzzle && state.puzzle.mode === 'strict') {
    toast('Strict puzzle — undo is not available. Use Reset to start over.', 'bad');
    return;
  }
  const snap = state.undoStack.pop();
  if (!snap) return;
  state.values = snap.values;
  state.notes = snap.notes;
  state.mistakes = snap.mistakes;
  state.selected = snap.selected;
  saveProgress();
  renderBoard();
}

/**
 * Clear the puzzle back to its givens and start a new attempt. This never
 * deletes history -- it increments `attempts`, so a clean run (attempt 1) stays
 * permanently distinguishable from one that was wiped and retried. That is what
 * keeps strict mode from becoming self-reported theatre.
 */
function resetPuzzle() {
  if (!state.puzzle) return;
  if (!confirm('Reset this puzzle? Your digits, pencil marks, timer and mistake count are cleared and the attempt counter goes up by one.')) {
    return;
  }
  const given = parseGrid(state.puzzle.grid);
  state.values = new Uint8Array(given);
  state.notes = new Array(81).fill(0);
  state.mistakes = 0;
  state.hints = 0;
  state.undoStack = [];
  state.selected = -1;
  state.puzzle.attempts = (state.puzzle.attempts || 1) + 1;
  $('hintBox').hidden = true;
  // attempts is a top-level record field, not play progress -- updateProgress
  // only writes into `progress`, so it must go through setMeta or it is lost.
  store.setMeta(state.puzzle.id, { attempts: state.puzzle.attempts });
  store.updateProgress(state.puzzle.id, {
    userGrid: gridToString(state.values),
    notes: '',
    elapsedMs: 0,
    mistakes: 0,
    hints: 0
  });
  startTimer(0);
  renderBoard();
  renderMeta();
  renderLibrary();
  closeDrawer();
  toast(`Reset — attempt ${state.puzzle.attempts}`, 'good');
}

function toggleNotes() {
  state.notesMode = !state.notesMode;
  $('notesBtn').setAttribute('aria-pressed', String(state.notesMode));
}

/* ------------------------------------------------------------------ *
 * hints
 * ------------------------------------------------------------------ */

function hint() {
  if (!state.puzzle) return;
  const current = parseGrid(state.puzzle.grid);
  for (let i = 0; i < 81; i++) {
    if (state.values[i] !== 0) {
      const sol = state.puzzle.solution ? parseGrid(state.puzzle.solution)[i] : 0;
      if (state.values[i] === sol) current[i] = state.values[i];
    }
  }
  const res = solveLogic(current, { maxLevel: 5.0 });
  const box = $('hintBox');
  box.hidden = false;
  state.hints++;
  saveProgress();

  if (res.solved && res.steps.length) {
    const step = res.steps[0];
    if (step.cell !== undefined && step.targets === undefined) {
      const i = step.cell;
      state.selected = i;
      cellNodes[i].classList.add('hint');
      box.textContent = `${TECH_BY_KEY[step.technique].name}: ${step.text} → ${step.digit} goes in R${rowOf(i) + 1}C${colOf(i) + 1}.`;
    } else {
      box.textContent = `${TECH_BY_KEY[step.technique].name}: ${step.text}`;
    }
  } else if (state.puzzle.solution) {
    // Logic ladder exhausted (extreme tier): fall back to a direct reveal.
    const sol = parseGrid(state.puzzle.solution);
    const empties = [];
    for (let i = 0; i < 81; i++) if (state.values[i] === 0) empties.push(i);
    if (!empties.length) return;
    const i = empties[Math.floor(Math.random() * empties.length)];
    state.values[i] = sol[i];
    state.selected = i;
    box.textContent = 'No logical step left at this level — this puzzle needs search. Revealed one cell instead.';
    saveProgress();
    renderBoard();
    checkComplete();
  }
  renderBoard();
}

/* ------------------------------------------------------------------ *
 * timer
 * ------------------------------------------------------------------ */

/** Pause label keeps its mnemonic highlight, so it can't be a plain textContent. */
function setPauseLabel(paused) {
  $('pauseBtn').innerHTML = paused
    ? 'Resume'
    : '<span class="key">P</span>ause';
}

function startTimer(baseMs) {
  stopTimer();
  state.elapsedBase = baseMs || 0;
  state.timerStart = Date.now();
  state.paused = false;
  setPauseLabel(false);
  state.interval = setInterval(renderTimer, 500);
  renderTimer();
}

function stopTimer() {
  if (state.interval) clearInterval(state.interval);
  state.interval = null;
}

function elapsed() {
  return state.elapsedBase + (state.paused ? 0 : Date.now() - state.timerStart);
}

function renderTimer() {
  const ms = elapsed();
  // formatDuration returns an em-dash for zero, which reads as "no puzzle" on a
  // clock that is simply at the start.
  $('timerText').textContent = ms > 0 ? formatDuration(ms) : '0m 00s';
}

function togglePause() {
  if (state.paused) {
    state.paused = false;
    state.timerStart = Date.now();
    state.interval = setInterval(renderTimer, 500);
    setPauseLabel(false);
  } else {
    state.elapsedBase = elapsed();
    state.paused = true;
    stopTimer();
    setPauseLabel(true);
    saveProgress();
  }
  renderTimer();
}

/* ------------------------------------------------------------------ *
 * puzzle lifecycle
 * ------------------------------------------------------------------ */

/** Reflect the takeback mode: the undo control must not look available in strict. */
function syncModeUi() {
  const strict = $('modeSelect').value === 'strict';
  $('modeHint').textContent = strict
    ? 'Strict: every placement is final. Undo is off; Erase and Reset still work, and a reset is recorded as a new attempt.'
    : 'Casual: undo as much as you like. The mistake count is not a score here, since any charge can be taken back.';
  const ub = $('undoBtn');
  const currentStrict = state.puzzle && state.puzzle.mode === 'strict';
  ub.disabled = !!currentStrict;
  ub.title = currentStrict ? 'Strict puzzle — undo is not available' : 'Undo (U)';
  // The footer carries the mode badge, so refresh it here too.
  renderMeta();
}

function loadPuzzle(record) {
  state.puzzle = record;
  state.values = parseGrid(record.progress.userGrid || record.grid);
  // ensure givens are present
  const given = parseGrid(record.grid);
  for (let i = 0; i < 81; i++) if (given[i] !== 0) state.values[i] = given[i];
  state.notes = decodeNotes(record.progress.notes || '');
  state.mistakes = record.progress.mistakes || 0;
  state.hints = record.progress.hints || 0;
  state.undoStack = [];
  state.selected = -1;
  $('hintBox').hidden = true;
  renderBoard();
  renderMeta();
  renderLibrary();
  syncModeUi();
  startTimer(record.progress.elapsedMs || 0);
  // Whatever we just did (generate, import, resume), get out of the way.
  closeDrawer();
}

function saveProgress() {
  if (!state.puzzle) return;
  store.updateProgress(state.puzzle.id, {
    userGrid: gridToString(state.values),
    notes: encodeNotes(state.notes),
    elapsedMs: elapsed(),
    mistakes: state.mistakes,
    hints: state.hints
  });
}

/**
 * Live error feedback is based on visible conflicts only: a digit is flagged when
 * it duplicates another placed digit in the same row, column or box. It is NOT
 * flagged for merely diverging from the stored solution.
 *
 * That distinction is the whole game. A cell that contradicts the solution but
 * conflicts with nothing cannot be justified from what the player can see, so
 * marking it red hands out the answer and leaves the player with an
 * unexplainable "wrong". A duplicate, by contrast, explains itself -- you can
 * look across the band and see the other 5. Fill the board with no conflicts and
 * you have the unique solution anyway.
 */
function conflictsAt(i) {
  const v = state.values[i];
  if (!v) return false;
  for (const j of PEERS[i]) if (state.values[j] === v) return true;
  return false;
}

function checkComplete() {
  if (!state.puzzle || !state.puzzle.solution) return;
  const sol = parseGrid(state.puzzle.solution);
  for (let i = 0; i < 81; i++) if (state.values[i] !== sol[i]) return;
  stopTimer();
  const time = elapsed();
  store.complete(state.puzzle.id, { solveTimeMs: time, mistakes: state.mistakes, hints: state.hints });
  state.puzzle.status = STATUS.COMPLETED;
  state.puzzle.solveTimeMs = time;
  // Mistakes are still STORED (issue #1 needs them for calibration) -- just not
  // thrown in the player's face on the one screen that should be a win.
  const who = state.puzzle.seed ? `${state.puzzle.seed} solved` : 'Puzzle solved';
  toast(`${who} in ${formatDuration(time)}`, 'good');
  renderMeta();
  renderLibrary();
  renderStats();
  updateStorageBadge();
}

function abandonCurrent() {
  if (!state.puzzle || state.puzzle.status === STATUS.COMPLETED) return;
  saveProgress();
  store.abandon(state.puzzle.id);
  stopTimer();
  toast('Marked abandoned — keeping it for your stats');
  renderLibrary();
  renderStats();
  startGeneration({
    difficulty: state.puzzle.difficulty,
    symmetry: state.puzzle.symmetry
  });
}

/* ------------------------------------------------------------------ *
 * generation (chunked, deduplicated)
 * ------------------------------------------------------------------ */

const yieldFrame = () => new Promise((r) => setTimeout(r, 0));

async function startGeneration({ seed, difficulty, symmetry, mode }) {
  if (state.generating) return;
  state.generating = true;
  const status = $('genStatus');
  status.hidden = false;
  status.className = 'gen-status';
  const btn = $('generateBtn');
  btn.disabled = true;

  const useSeed = seed || randomSeedString(`${Date.now()}-${Math.random()}`);
  const start = Date.now();
  const maxAttempts = 120;
  const budgetMs = 9000;
  let closest = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let p;
    try {
      p = generatePuzzle({ seed: useSeed, difficulty, symmetry, attempt });
      // The takeback mode is fixed for the life of the puzzle. Choosing it up
      // front is what makes strict mode mean anything: switching to casual after
      // a bad mistake would be exactly the takeback strict mode exists to forbid.
      p.mode = mode === 'strict' ? 'strict' : 'casual';
      p.attempts = 1;
    } catch (err) {
      status.textContent = `Generation failed: ${err.message}`;
      status.classList.add('bad');
      state.generating = false;
      btn.disabled = false;
      return;
    }
    if (p.accepted) {
      const dup = store.findDuplicate(p.grid);
      if (!dup.duplicate) {
        const res = store.addPuzzle(p);
        if (res.ok) {
          status.textContent = `Found in ${attempt} attempt${attempt === 1 ? '' : 's'} · ${p.clues} clues · ${describeRating(p.rating)}`;
          status.classList.add('ok');
          loadPuzzle(res.puzzle);
          updateStorageBadge();
          state.generating = false;
          btn.disabled = false;
          $('seedInput').value = p.seed;
          return;
        }
      } else {
        closest = closest || { p, duplicate: true };
      }
    } else if (!closest) {
      closest = { p, duplicate: false };
    }

    status.textContent = `Searching for an in-band, never-before-seen board… attempt ${attempt}${p.accepted ? ' (already played)' : ` (${p.reason})`}`;
    await yieldFrame();
    if (Date.now() - start > budgetMs) break;
  }

  state.generating = false;
  btn.disabled = false;
  if (closest && !closest.duplicate) {
    const res = store.addPuzzle(closest.p);
    if (res.ok) {
      status.textContent = `Could not reach ${TIERS[difficulty].label} in the time budget — closest match is ${describeRating(closest.p.rating)}. Playing it; the tier badge shows what it really is.`;
      status.classList.add('bad');
      loadPuzzle(res.puzzle);
      updateStorageBadge();
      return;
    }
  }
  status.textContent =
    'Every board we found at that tier is already in your library. Try a different seed or another difficulty.';
  status.classList.add('bad');
}

function importToken() {
  const token = $('importTokenInput').value.trim();
  if (!token) return;
  try {
    const p = rebuildFromShare(token);
    const dup = store.findDuplicate(p.grid);
    if (dup.duplicate) {
      toast('That puzzle is already in your library', 'bad');
      loadPuzzle(store.getPuzzle(dup.id));
      return;
    }
    const res = store.addPuzzle({ ...p, source: 'imported' });
    if (res.ok) {
      toast(`Imported ${describeRating(p.rating)}`, 'good');
      loadPuzzle(res.puzzle);
      updateStorageBadge();
    }
  } catch (err) {
    toast(`Could not import: ${err.message}`, 'bad');
  }
}

/* ------------------------------------------------------------------ *
 * meta / library / stats rendering
 * ------------------------------------------------------------------ */

function renderMeta() {
  const box = $('puzzleMeta');
  box.innerHTML = '';
  if (!state.puzzle) return;
  const p = state.puzzle;
  const kv = (label, value, isCode) => {
    const d = el('div', 'kv');
    d.appendChild(el('span', null, label));
    if (isCode) d.appendChild(el('code', null, value));
    else d.appendChild(el('b', null, value));
    return d;
  };
  box.appendChild(kv('Difficulty', TIERS[p.difficulty] ? TIERS[p.difficulty].label : p.difficulty));
  box.appendChild(kv('Clues', String(p.clues)));
  box.appendChild(kv('Rating', describeRating(p.rating)));
  box.appendChild(kv('Seed', p.seed || '—', true));
  box.appendChild(kv('Symmetry', p.symmetry ? '180°' : 'none'));
  box.appendChild(kv('Mode', p.mode === 'strict' ? 'Strict · no undo' : 'Casual'));
  if ((p.attempts || 1) > 1) box.appendChild(kv('Attempt', String(p.attempts)));
  box.appendChild(kv('Share token', p.share || '—', true));
}

function renderLibrary() {
  const list = $('puzzleList');
  list.innerHTML = '';
  const items = store.byStatus(state.libraryFilter);
  $('libraryEmpty').hidden = items.length > 0;
  for (const p of items) {
    const li = el('li', 'puzzle-item');
    if (state.puzzle && state.puzzle.id === p.id) li.classList.add('current');
    const title = el('div', 'title');
    const badge = el('span', `badge ${p.difficulty}`, TIERS[p.difficulty] ? TIERS[p.difficulty].label : p.difficulty);
    title.appendChild(badge);
    if (p.rating && p.rating.hardest === 'guess' && p.difficulty !== 'extreme') {
      title.appendChild(el('span', 'badge unverified', 'fallback'));
    }
    title.appendChild(el('span', null, ` ${p.clues} clues`));
    li.appendChild(title);

    const row = el('div', 'row');
    const open = el('button', 'ghost', p.status === STATUS.COMPLETED ? 'View' : 'Resume');
    open.addEventListener('click', () => loadPuzzle(p));
    const share = el('button', 'ghost', 'Token');
    share.addEventListener('click', () => copy(p.share || '', 'Share token copied'));
    const del = el('button', 'ghost', 'Delete');
    del.addEventListener('click', () => {
      if (!confirm('Delete this puzzle and its progress?')) return;
      store.remove(p.id);
      renderLibrary();
      renderStats();
      updateStorageBadge();
    });
    row.appendChild(share);
    row.appendChild(open);
    row.appendChild(del);
    li.appendChild(row);

    const sub = el('div', 'sub');
    const bits = [describeRating(p.rating)];
    if (p.status === STATUS.COMPLETED) bits.push(`solved ${formatDuration(p.solveTimeMs)}`);
    else if ((p.progress && p.progress.elapsedMs) > 0) bits.push(`${formatDuration(p.progress.elapsedMs)} played`);
    if (p.progress && p.progress.mistakes) bits.push(`${p.progress.mistakes} mistakes`);
    if (p.source === 'imported') bits.push('imported');
    bits.push(new Date(p.createdAt).toLocaleString());
    sub.textContent = bits.join(' · ');
    li.appendChild(sub);
    list.appendChild(li);
  }
}

/**
 * Records predating takeback modes have no `mode`, and their numbers are not
 * comparable to either kind -- so they get their own bucket rather than being
 * silently blended into casual or strict.
 */
function modeOf(p) {
  return p.mode === 'strict' || p.mode === 'casual' ? p.mode : 'unspecified';
}

function puzzlesForStats() {
  const all = store.allPuzzles();
  if (state.statsMode === 'all') return all;
  return all.filter((p) => modeOf(p) === state.statsMode);
}

function renderStats() {
  const puzzles = puzzlesForStats();
  const s = summarize(puzzles, store.doc.counters);
  const grid = $('statGrid');
  grid.innerHTML = '';
  const counts = { casual: 0, strict: 0, unspecified: 0 };
  for (const p of store.allPuzzles()) counts[modeOf(p)]++;
  const note = $('statsModeNote');
  if (note) {
    note.textContent =
      state.statsMode === 'all'
        ? `Casual ${counts.casual} · Strict ${counts.strict} · Unspecified ${counts.unspecified}. ` +
          'Casual and strict numbers are not comparable, so read them separately.'
        : `${counts[state.statsMode]} puzzle(s) in this mode. Unspecified records predate takeback modes and are excluded here.`;
  }
  const add = (label, value, sub) => {
    const d = el('div', 'stat');
    d.appendChild(el('div', 'label', label));
    d.appendChild(el('div', 'value', value));
    if (sub) d.appendChild(el('div', 'sub', sub));
    grid.appendChild(d);
  };
  add('Completed', String(s.totals.completed), `${formatPct(s.totals.completionRate)} of ${s.totals.puzzles} started`);
  add('Abandoned', String(s.totals.abandoned));
  add('In progress', String(s.totals.active));
  add('Win streak', String(s.streaks.current), `best ${s.streaks.longest}`);
  add('Day streak', String(s.streaks.daily));
  add('Accuracy', formatPct(s.accuracy, 1), `${s.mistakes} mistakes`);
  // A strict solve that took three tries is not a clean solve. Counting it as one
  // would let retried runs masquerade as first-pass successes.
  const cleanSolves = puzzles.filter(
    (p) => p.status === STATUS.COMPLETED && (p.attempts || 1) === 1
  ).length;
  add('Clean solves', String(cleanSolves), 'completed on attempt 1');
  add('Hint rate', s.hintRate.toFixed(2), 'hints per solved puzzle');
  add('Notes usage', formatPct(s.notesUsage), 'of puzzles use pencil marks');
  if (s.fastest) add('Fastest', formatDuration(s.fastest.time), s.fastest.difficulty);
  const trend = s.trend.priorCount
    ? `${s.trend.pct >= 0 ? '▲' : '▼'} ${formatPct(Math.abs(s.trend.pct))}`
    : '—';
  add('Trend', trend, 'last 10 vs previous 10');
  const uniq = `generated ${s.totals.generated} · ${s.totals.duplicatesRejected} duplicate${s.totals.duplicatesRejected === 1 ? '' : 's'} blocked`;
  add('Uniqueness', formatPct(s.totals.generated + s.totals.duplicatesRejected === 0 ? 1 : s.totals.generated / (s.totals.generated + s.totals.duplicatesRejected)), uniq);

  const tbody = $('tierTable').querySelector('tbody');
  tbody.innerHTML = '';
  for (const k of TIER_ORDER) {
    const t = s.perTier[k];
    const tr = document.createElement('tr');
    const cell = (txt) => {
      const td = document.createElement('td');
      td.textContent = txt;
      return td;
    };
    tr.appendChild(cell(TIERS[k].label));
    tr.appendChild(cell(`${t.completed}/${t.played}`));
    tr.appendChild(cell(t.completed ? formatDuration(t.avgTime) : '—'));
    tr.appendChild(cell(t.completed ? formatDuration(t.bestTime) : '—'));
    tr.appendChild(cell(t.played ? formatPct(t.accuracy) : '—'));
    tr.appendChild(cell(t.completed ? t.avgHints.toFixed(1) : '—'));
    tbody.appendChild(tr);
  }

  const tech = $('techList');
  tech.innerHTML = '';
  if (!s.techniqueExposure.length) {
    tech.appendChild(el('li', null, 'nothing yet'));
  }
  for (const t of s.techniqueExposure) {
    tech.appendChild(el('li', null, `${t.name} — ${t.puzzles} puzzle${t.puzzles === 1 ? '' : 's'}`));
  }

  const next = suggestNextTier(s);
  if (next.canAdvance) {
    const li = el('li', null, `Suggested next: ${TIERS[next.next].label}`);
    tech.appendChild(li);
  }
}

/* ------------------------------------------------------------------ *
 * data: export / import
 * ------------------------------------------------------------------ */

function downloadJson() {
  const blob = new Blob([store.exportAll()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sudoku-library-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Library downloaded');
}

function handleImportFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const merge = document.querySelector('input[name="mergeMode"]:checked').value === 'merge';
    const res = store.importAll(String(reader.result), { merge });
    const report = $('importReport');
    if (!res.ok) {
      report.textContent = `Import failed: ${res.reason}`;
      toast('Import failed', 'bad');
      return;
    }
    report.textContent =
      `Added ${res.added} · duplicates skipped ${res.skippedDuplicate} · invalid ${res.skippedInvalid}` +
      (res.updated ? ` · progress updated ${res.updated}` : '');
    toast(`Imported ${res.added} puzzle${res.added === 1 ? '' : 's'}`, 'good');
    renderLibrary();
    renderStats();
    updateStorageBadge();
  };
  reader.readAsText(file);
}

/* ------------------------------------------------------------------ *
 * drawer (the single pane stays put; everything else slides in over it)
 * ------------------------------------------------------------------ */

function isDrawerOpen() {
  return $('drawer').classList.contains('open');
}

function openDrawer() {
  $('drawer').classList.add('open');
  $('drawer').setAttribute('aria-hidden', 'false');
  $('menuBtn').setAttribute('aria-expanded', 'true');
  const bd = $('backdrop');
  bd.hidden = false;
  requestAnimationFrame(() => bd.classList.add('show'));
}

function closeDrawer() {
  const bd = $('backdrop');
  $('drawer').classList.remove('open');
  $('drawer').setAttribute('aria-hidden', 'true');
  $('menuBtn').setAttribute('aria-expanded', 'false');
  bd.classList.remove('show');
  setTimeout(() => {
    bd.hidden = true;
  }, 220);
}

/* ------------------------------------------------------------------ *
 * toast + clipboard
 * ------------------------------------------------------------------ */

let toastTimer = null;
function toast(msg, kind = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.hidden = true;
  }, 3200);
}

function copy(text, okMsg) {
  if (!text) {
    toast('Nothing to copy', 'bad');
    return;
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      () => toast(okMsg),
      () => fallbackCopy(text, okMsg)
    );
  } else {
    fallbackCopy(text, okMsg);
  }
}

function fallbackCopy(text, okMsg) {
  const ta = el('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    toast(okMsg);
  } catch {
    toast('Copy failed — select and copy manually', 'bad');
  }
  document.body.removeChild(ta);
}

/* ------------------------------------------------------------------ *
 * wiring
 * ------------------------------------------------------------------ */

function buildDifficultySelect() {
  const sel = $('difficultySelect');
  for (const k of TIER_ORDER) {
    const o = document.createElement('option');
    o.value = k;
    o.textContent = TIERS[k].label;
    sel.appendChild(o);
  }
  sel.value = 'easy';
  sel.addEventListener('change', () => {
    $('tierHint').textContent = TIERS[sel.value].hint;
  });
  $('tierHint').textContent = TIERS.easy.hint;
}

/**
 * Accent theme. Orthogonal to light/dark, which stays on prefers-color-scheme.
 * The inline script in index.html already applied the stored value before first
 * paint; this only keeps the DOM, the swatch states and storage in step.
 */
const THEME_KEY = 'sudoku.ui.theme';
const ACCENTS = ['azure', 'crimson', 'amber', 'teal'];
const THEME_MODE = { azure: 'dark', crimson: 'dark', amber: 'light', teal: 'light' };

function currentAccent() {
  const a = document.documentElement.getAttribute('data-accent');
  return ACCENTS.includes(a) ? a : 'azure';
}

function applyAccent(name) {
  if (!ACCENTS.includes(name)) name = 'azure';
  document.documentElement.setAttribute('data-accent', name);
  try { localStorage.setItem(THEME_KEY, name); } catch (e) { /* storage blocked */ }
  for (const s of document.querySelectorAll('.swatch')) {
    s.setAttribute('aria-checked', String(s.dataset.accent === name));
  }
  const note = $('themeNote');
  if (note) {
    note.textContent = `Theme "${name}" saved. Picking a theme overrides your system light/dark setting.`;
  }
}

function wireControls() {
  $('generateBtn').addEventListener('click', () => {
    const seed = $('seedInput').value.trim() || undefined;
    startGeneration({
      seed,
      difficulty: $('difficultySelect').value,
      symmetry: $('symmetryCheck').checked,
      mode: $('modeSelect').value
    });
  });
  $('resetBtn').addEventListener('click', resetPuzzle);
  $('statsModeFilter').addEventListener('click', (e) => {
    const b = e.target.closest('.subtab');
    if (!b) return;
    for (const t of $('statsModeFilter').children) t.classList.toggle('active', t === b);
    state.statsMode = b.dataset.mode;
    renderStats();
  });
  $('modeSelect').addEventListener('change', syncModeUi);
  syncModeUi();
  $('importTokenBtn').addEventListener('click', importToken);
  $('importTokenInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') importToken();
  });
  $('abandonBtn').addEventListener('click', abandonCurrent);
  $('copyShareBtn').addEventListener('click', () =>
    copy(state.puzzle ? state.puzzle.share : '', 'Share token copied — others can import the exact same board')
  );
  $('notesBtn').addEventListener('click', toggleNotes);
  $('undoBtn').addEventListener('click', undo);
  $('eraseBtn').addEventListener('click', erase);
  $('hintBtn').addEventListener('click', hint);
  $('pauseBtn').addEventListener('click', togglePause);

  $('sideTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    for (const t of $('sideTabs').children) t.classList.toggle('active', t === btn);
    for (const id of ['generate', 'library', 'stats', 'settings']) {
      $(`tab-${id}`).hidden = id !== btn.dataset.tab;
    }
  });

  $('themeGroups').addEventListener('click', (e) => {
    const s = e.target.closest('.swatch');
    if (s) applyAccent(s.dataset.accent);
  });
  applyAccent(currentAccent());

  $('menuBtn').addEventListener('click', () => {
    if (isDrawerOpen()) closeDrawer();
    else openDrawer();
  });
  $('closeDrawerBtn').addEventListener('click', closeDrawer);
  $('backdrop').addEventListener('click', closeDrawer);

  $('statusTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.subtab');
    if (!btn) return;
    for (const t of $('statusTabs').children) t.classList.toggle('active', t === btn);
    state.libraryFilter = btn.dataset.status;
    renderLibrary();
  });

  $('exportBtn').addEventListener('click', downloadJson);
  $('copyExportBtn').addEventListener('click', () => copy(store.exportAll(), 'Library JSON copied to clipboard'));
  $('importFile').addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) handleImportFile(e.target.files[0]);
  });
  $('wipeBtn').addEventListener('click', () => {
    if (!confirm('Delete the entire library, including completed puzzles and stats?')) return;
    store.clearAll();
    renderLibrary();
    renderStats();
    updateStorageBadge();
    toast('Library wiped');
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key >= '1' && e.key <= '9') {
      inputDigit(Number(e.key));
    } else if (e.key === 'Backspace' || e.key === 'Delete' || e.key === '0') {
      e.preventDefault();
      erase();
    } else if (e.key.toLowerCase() === 'e') {
      erase();
    } else if (e.key.toLowerCase() === 'n') {
      toggleNotes();
    } else if (e.key.toLowerCase() === 'u') {
      undo();
    } else if (e.key.toLowerCase() === 'h') {
      hint();
    } else if (e.key.toLowerCase() === 'p') {
      togglePause();
    } else if (e.key === 'Escape') {
      closeDrawer();
    } else if (e.key.startsWith('Arrow')) {
      moveSelection(e.key);
    }
  });

  window.addEventListener('beforeunload', saveProgress);
}

function moveSelection(key) {
  if (state.selected < 0) {
    selectCell(0);
    return;
  }
  let r = rowOf(state.selected);
  let c = colOf(state.selected);
  if (key === 'ArrowUp') r = (r + 8) % 9;
  if (key === 'ArrowDown') r = (r + 1) % 9;
  if (key === 'ArrowLeft') c = (c + 8) % 9;
  if (key === 'ArrowRight') c = (c + 1) % 9;
  selectCell(r * 9 + c);
}

init();

/* ------------------------------------------------------------------ *
 * update channel
 *
 * The worker used to call skipWaiting() the moment it installed, so a
 * deploy swapped the shell underneath a live game without anyone agreeing
 * to it -- and with assets served cache-first, the new build only surfaced
 * on the *second* load anyway, which is why a hard refresh felt like the
 * only honest option. Now a new worker parks in `waiting`, the page offers
 * the update, and the user's tap is what takes effect.
 *
 * Deps are injectable because jsdom has no service worker and no reload.
 * ------------------------------------------------------------------ */
let updatePollTimer = null;

/*
 * Running inside the packaged (Capacitor) app?
 *
 * The native bridge sets `window.Capacitor` and puts `isNativePlatform: () =>
 * true` on it (verified in @capacitor/android's native-bridge.js: `cap.isNativePlatform =
 * isNativePlatform`); a plain browser has no such global. Read off `globalThis`
 * rather than importing @capacitor/core so the PWA that ships from this repo
 * stays free of any native dependency -- the same js/app.js is served to both.
 */
function isNativeApp() {
  const cap = globalThis.Capacitor;
  return Boolean(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
}

function stopUpdates() {
  if (updatePollTimer) {
    clearInterval(updatePollTimer);
    updatePollTimer = null;
  }
}

function initUpdates(deps = {}) {
  const sw = 'sw' in deps ? deps.sw : navigator.serviceWorker;
  const register = deps.register || (() => sw.register('sw.js'));
  const reload = deps.reload || (() => location.reload());
  if (!sw) return stopUpdates;

  // Clear any timer left by a previous run before this one starts its own.
  //
  // `load` can fire more than once (a real reload racing a listener attach; a
  // test dispatching it manually), and without this the second run overwrote the
  // module-level updatePollTimer with a fresh interval while the old one kept
  // running -- an orphan 60s timer that stopUpdates() could not reach, because
  // it only knows about the latest. That is what made the PWA test process
  // hang: the assertion passed, then the file never exited.
  //
  // Clearing rather than early-returning, because the UI tests deliberately
  // re-init with different fakes; blocking re-entry would break those.
  stopUpdates();

  let offered = false;
  let requested = false;

  const offer = (worker) => {
    if (offered) return;
    offered = true;
    const bar = $('updateBar');
    const btn = $('updateBtn');
    bar.hidden = false;
    btn.disabled = false;
    btn.textContent = 'Update';
    btn.addEventListener('click', () => {
      if (requested) return;
      requested = true;
      btn.disabled = true;
      btn.textContent = 'Updating…';
      worker.postMessage({ type: 'SKIP_WAITING' });
    });
    $('updateDismiss').addEventListener('click', () => {
      bar.hidden = true;
    });
  };

  Promise.resolve()
    .then(register)
    .then((reg) => {
      if (reg.waiting) offer(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          // 'installed' only means "an update is waiting" if we already had a
          // controller. On a first install it just means the shell got cached,
          // and there is nothing to update *from*.
          if (nw.state === 'installed' && sw.controller) offer(nw);
        });
      });
      // Nothing else re-checks sw.js for a session that never re-navigates,
      // which is exactly the long-lived tab that would otherwise never learn a
      // new version exists.
      const check = () => Promise.resolve().then(() => reg.update()).catch(() => {});
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) check();
      });
      updatePollTimer = setInterval(check, 60000);
    })
    .catch(() => {
      /* offline support is an enhancement; never break the app over it */
    });

  sw.addEventListener('controllerchange', () => {
    // A first install claims the page straight away. Reloading on that would
    // loop, so only the update the user actually asked for reloads.
    if (requested) reload();
  });

  return stopUpdates;
}

/*
 * Ask the OS not to evict this origin's storage.
 *
 * Capacitor's storage guide is blunt about the default: WebView localStorage
 * "must be considered transient, meaning your app needs to expect that the
 * data will be lost eventually... the OS will reclaim local storage from Web
 * Views if a device is running low on space." The entire puzzle library is
 * one localStorage document (sudoku.library.v1), so that reclaim is a user's
 * library disappearing with no warning.
 *
 * navigator.storage.persist() is the standard signal: on Android it opts the
 * origin out of eviction. It is heuristic and NOT a guarantee -- which is why
 * the result is surfaced rather than assumed. Measured cost of a puzzle record
 * is ~792 bytes, so ~6.6k puzzles fit in the usual 5 MiB quota; eviction,
 * not quota, is the failure mode being addressed here.
 *
 * Deliberately never throws: these APIs are absent in older WebViews and in
 * some private modes, and persistence is an enhancement, not a precondition
 * for playing.
 */
async function requestPersistentStorage(storage = globalThis.navigator?.storage) {
  if (!storage || typeof storage.persist !== 'function') {
    return { supported: false, persisted: false };
  }
  try {
    if (typeof storage.persisted === 'function' && (await storage.persisted())) {
      return { supported: true, persisted: true };
    }
    const granted = await storage.persist();
    return { supported: true, persisted: Boolean(granted) };
  } catch {
    return { supported: true, persisted: false, failed: true };
  }
}

// Fire-and-forget at startup, in both the PWA and the packaged app: the
// eviction risk exists in both, and the call is harmless where persistence is
// already automatic. The warn is the only visible signal that a user's library
// is in the reclaimable set, so it is worth the one line.
requestPersistentStorage().then((r) => {
  if (r.supported && !r.persisted) {
    console.warn(
      'persistent storage not granted: the puzzle library may be evicted if the device runs low on space',
    );
  }
});

// PWA only. The service worker is the rolling-update mechanism for the deployed
// site: it precaches the shell and lets a new deploy be offered in-app. In the
// packaged app the assets are already local and frozen into the APK, so a worker
// would only add a cache over files that cannot change underneath it.
//
// The platform check is required, not cosmetic: Capacitor serves from a local
// `https://localhost` (androidScheme defaults to https), so the protocol test
// alone would happily let the worker register inside the APK. Guard on the
// platform, not the scheme.
//
// This also keeps the in-app update bar out of the packaged app: `#updateBar`
// starts `hidden` and is only ever revealed by offer(), which only runs from a
// registered worker. No worker, no bar -- so a button that could never fire is
// not shipped.
if (!isNativeApp() && 'serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => initUpdates());
}

/**
 * Debug handle: `sudokuApp` in the browser console lets you inspect live state,
 * and lets the DOM test harness shut the clock down so the process can exit.
 */
globalThis.sudokuApp = {
  state,
  store,
  stopTimer,
  startGeneration,
  PEERS,
  syncModeUi,
  initUpdates,
  stopUpdates,
  isNativeApp,
  requestPersistentStorage,
  storageInfo,
  flushStorage
};
