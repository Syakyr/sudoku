import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { createStore, STATUS } from '../js/store.js';
import { PEERS } from '../js/board.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(here, '..', 'index.html'), 'utf8');

const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
const define = (name, value) =>
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

define('window', dom.window);
define('document', dom.window.document);
define('navigator', dom.window.navigator);
define('localStorage', dom.window.localStorage);
define('HTMLElement', dom.window.HTMLElement);
define('Event', dom.window.Event);
define('Blob', dom.window.Blob);
define('URL', dom.window.URL);
define('FileReader', dom.window.FileReader);
define('confirm', () => true);
dom.window.confirm = globalThis.confirm;

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout = 20000, label = 'condition') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (fn()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// The app boots on import and immediately generates an easy puzzle.
await import('../js/app.js');
await waitFor(() => $('puzzleMeta').children.length > 0, 20000, 'first puzzle to generate');

test('board renders 81 cells with the givens filled in', () => {
  const cells = document.querySelectorAll('#board .cell');
  assert.equal(cells.length, 81);
  const givens = document.querySelectorAll('#board .cell.given');
  assert.ok(givens.length >= 20, `expected a normal clue count, got ${givens.length}`);
  for (const c of givens) assert.match(c.textContent, /^[1-9]$/);
});

test('puzzle meta shows seed, share token and rating', () => {
  const text = $('puzzleMeta').textContent;
  assert.match(text, /Seed/);
  assert.match(text, /Share token/);
  assert.match(text, /sdk-/);
  assert.match(text, /Rating/);
});

test('typing a digit into an empty cell fills it', () => {
  const empty = [...document.querySelectorAll('#board .cell:not(.given)')][0];
  empty.click();
  const digit = '5';
  const btn = [...$('numpad').children].find((b) => b.dataset.digit === digit);
  btn.click();
  assert.equal(empty.textContent, digit);
  assert.ok(empty.classList.contains('user') || empty.classList.contains('wrong'));
});

test('notes mode stores pencil marks instead of a value', () => {
  const empty = [...document.querySelectorAll('#board .cell:not(.given)')].find(
    (c) => c.textContent === ''
  );
  empty.click();
  if (!$('notesBtn').getAttribute('aria-pressed') || $('notesBtn').getAttribute('aria-pressed') === 'false') {
    $('notesBtn').click();
  }
  const btn = [...$('numpad').children].find((b) => b.dataset.digit === '7');
  btn.click();
  const notes = empty.querySelector('.notes');
  assert.ok(notes, 'pencil marks should render');
  assert.equal(notes.textContent, '7');
  // toggle the same mark off
  btn.click();
  assert.equal(empty.querySelector('.notes'), null);
  $('notesBtn').click(); // leave notes mode
});

test('undo restores the previous board state', () => {
  const empty = [...document.querySelectorAll('#board .cell:not(.given)')].find((c) => c.textContent === '');
  empty.click();
  const before = empty.textContent;
  [...$('numpad').children].find((b) => b.dataset.digit === '3').click();
  assert.equal(empty.textContent, '3');
  $('undoBtn').click();
  assert.equal(empty.textContent, before);
});

test('erase clears a filled cell', () => {
  const filled = [...document.querySelectorAll('#board .cell.user, #board .cell.wrong')][0];
  if (!filled) return;
  filled.click();
  $('eraseBtn').click();
  assert.equal(filled.textContent, '');
});

test('hint reveals a logical step and increments the hint counter', () => {
  const before = Number($('hintCount').textContent);
  $('hintBtn').click();
  assert.equal(Number($('hintCount').textContent), before + 1);
  assert.equal($('hintBox').hidden, false);
  assert.ok($('hintBox').textContent.length > 10);
});

test('library lists the generated puzzle and stats render', () => {
  const items = document.querySelectorAll('#puzzleList .puzzle-item');
  assert.ok(items.length >= 1);
  assert.match(items[0].textContent, /clues/);
  $('sideTabs').querySelector('[data-tab="stats"]').click();
  assert.equal($('tab-stats').hidden, false);
  assert.ok($('statGrid').children.length >= 6);
  assert.equal($('tierTable').querySelectorAll('tbody tr').length, 5);
});

test('share token round trips through the import box', async () => {
  const codes = $('puzzleMeta').querySelectorAll('code');
  const token = codes[codes.length - 1].textContent.trim();
  assert.match(token, /^sdk-/);
  $('importTokenInput').value = token;
  $('importTokenBtn').click();
  await waitFor(() => /already in your library/.test($('toast').textContent), 5000, 'duplicate-import toast');
  assert.ok(/already in your library/.test($('toast').textContent));
});

test('export produces a parseable snapshot of what the app saved', () => {
  // A second store instance reads the same jsdom localStorage the app writes to.
  const reader = createStore();
  const parsed = JSON.parse(reader.exportAll());
  assert.equal(parsed.app, 'sudoku');
  assert.equal(parsed.schema, 1);
  assert.ok(Array.isArray(parsed.puzzles));
  assert.ok(parsed.puzzles.length >= 1);
  assert.ok(parsed.puzzles[0].grid.length === 81);
  assert.ok(parsed.puzzles[0].canonKey);
});

test('playing every cell correctly completes the puzzle and records it', async () => {
  const { state, store } = globalThis.sudokuApp;
  const given = state.puzzle.grid;
  const solution = state.puzzle.solution;
  let moves = 0;
  for (let i = 0; i < 81; i++) {
    if (given[i] !== '.') continue;
    document.querySelectorAll('#board .cell')[i].click();
    [...$('numpad').children].find((b) => b.dataset.digit === solution[i]).click();
    moves++;
  }
  await sleep(50);
  assert.equal(moves, given.split('.').length - 1, 'every empty cell should have been played');
  assert.equal(state.puzzle.status, 'completed');
  assert.ok(state.puzzle.solveTimeMs >= 0);
  assert.equal(store.byStatus('completed').length, 1);
  assert.match($('toast').textContent, /Solved in/);
  // The completed puzzle must show up under the Completed filter.
  $('statusTabs').querySelector('[data-status="completed"]').click();
  assert.equal(document.querySelectorAll('#puzzleList .puzzle-item').length, 1);
});

test('difficulty select offers all five tiers with hints', () => {
  const opts = [...$('difficultySelect').children].map((o) => o.value);
  assert.deepEqual(opts, ['easy', 'medium', 'hard', 'expert', 'extreme']);
  $('difficultySelect').value = 'hard';
  $('difficultySelect').dispatchEvent(new dom.window.Event('change'));
  assert.match($('tierHint').textContent, /Hidden pairs|X-Wing/);
});

test('wiping the library clears the list', () => {
  $('sideTabs').querySelector('[data-tab="settings"]').click();
  $('wipeBtn').click();
  assert.equal(document.querySelectorAll('#puzzleList .puzzle-item').length, 0);
  assert.match($('storageNote').textContent, /0 puzzles/);
});

after(() => {
  // The running clock would otherwise hold the event loop open forever.
  if (globalThis.sudokuApp) {
    globalThis.sudokuApp.stopTimer();
    globalThis.sudokuApp.stopUpdates();
  }
  dom.window.close();
});

test('wrong-flagging follows visible conflicts, not the stored solution', async () => {
  // Fresh board: prior tests may have solved or dirtied the current puzzle.
  $('generateBtn').click();
  await waitFor(() => {
    const cells = [...document.querySelectorAll('#board .cell')];
    return cells.filter((c) => !c.classList.contains('given') && !c.textContent.trim()).length > 20;
  }, 30000, 'a fresh unsolved board');

  // Read the givens off the DOM: that is what the player can actually see.
  const arr = new Array(81).fill('.');
  for (const c of document.querySelectorAll('#board .cell')) {
    if (c.classList.contains('given')) arr[Number(c.dataset.index)] = c.textContent.trim();
  }
  const grid = arr.join('');
  const rec = createStore({ storage: localStorage })
    .allPuzzles()
    .find((p) => p.grid === grid && p.solution);
  assert.ok(rec, 'current puzzle located in the library by its visible givens');
  const sol = rec.solution;

  const cellAt = (i) => document.querySelector(`#board .cell[data-index="${i}"]`);
  const digit = (d) => [...$('numpad').children].find((b) => b.dataset.digit === String(d));

  // 1. A move that differs from the solution but clashes with nothing visible.
  //    The old code compared against the solution and flagged this, which handed
  //    out the answer with no visible justification.
  let fair = -1;
  let fairD = 0;
  for (let i = 0; i < 81 && fair < 0; i++) {
    if (grid[i] !== '.') continue;
    for (let d = 1; d <= 9; d++) {
      if (String(d) === sol[i]) continue;
      if (PEERS[i].some((j) => grid[j] === String(d))) continue;
      fair = i;
      fairD = d;
      break;
    }
  }
  assert.ok(fair >= 0, 'a non-conflicting, solution-divergent move exists');
  cellAt(fair).click();
  digit(fairD).click();
  assert.ok(
    !cellAt(fair).classList.contains('wrong'),
    'a digit that conflicts with nothing must not be flagged wrong'
  );
  assert.equal($('mistakeCount').textContent, '0', 'no mistake for a non-conflicting placement');

  // 2. A real duplicate IS flagged, so the check exists rather than being off.
  let dup = -1;
  let dupD = 0;
  for (let i = 0; i < 81 && dup < 0; i++) {
    if (grid[i] !== '.') continue;
    for (let d = 1; d <= 9; d++) {
      if (PEERS[i].some((j) => grid[j] === String(d))) {
        dup = i;
        dupD = d;
        break;
      }
    }
  }
  assert.ok(dup >= 0, 'a conflicting move exists');
  cellAt(dup).click();
  digit(dupD).click();
  assert.ok(
    cellAt(dup).classList.contains('wrong'),
    'a duplicate inside a unit must still be flagged'
  );
  assert.equal($('mistakeCount').textContent, '1', 'the duplicate counts as one mistake');
});

/* ------------------------------------------------------------------ *
 * update channel. jsdom has no service worker, so the container, the
 * registration and the reload are all faked and handed to initUpdates.
 * ------------------------------------------------------------------ */

test('a waiting service worker offers an update, and Update hands over then reloads', async () => {
  $('updateBar').hidden = true;
  const posted = [];
  const worker = { postMessage: (m) => posted.push(m) };
  const reg = new dom.window.EventTarget();
  reg.waiting = worker;
  reg.update = () => Promise.resolve();
  const container = new dom.window.EventTarget();
  let reloads = 0;

  const stop = globalThis.sudokuApp.initUpdates({
    sw: container,
    register: () => Promise.resolve(reg),
    reload: () => {
      reloads++;
    }
  });

  await waitFor(() => !$('updateBar').hidden, 2000, 'update bar to appear');
  assert.equal($('updateBtn').textContent, 'Update');

  $('updateBtn').click();
  assert.deepEqual(posted, [{ type: 'SKIP_WAITING' }], 'Update must send SKIP_WAITING');
  assert.equal($('updateBtn').disabled, true, 'the button is spent once pressed');
  assert.equal(reloads, 0, 'nothing reloads before the worker has actually taken over');

  container.dispatchEvent(new dom.window.Event('controllerchange'));
  await waitFor(() => reloads === 1, 2000, 'reload once the new worker claims control');
  stop();
});

test('a first-install controller claim does not reload the page', async () => {
  $('updateBar').hidden = true;
  const reg = new dom.window.EventTarget();
  reg.update = () => Promise.resolve();
  const container = new dom.window.EventTarget();
  let reloads = 0;

  const stop = globalThis.sudokuApp.initUpdates({
    sw: container,
    register: () => Promise.resolve(reg),
    reload: () => {
      reloads++;
    }
  });
  await sleep(50);
  assert.equal($('updateBar').hidden, true, 'nothing to offer when no worker is waiting');

  container.dispatchEvent(new dom.window.Event('controllerchange'));
  await sleep(50);
  assert.equal(reloads, 0, 'the initial claim must not reload, or the page loops');
  stop();
});

test('a newly installed worker with an existing controller offers the update', async () => {
  $('updateBar').hidden = true;
  const worker = new dom.window.EventTarget();
  worker.state = 'installed';
  worker.postMessage = () => {};
  const reg = new dom.window.EventTarget();
  reg.installing = worker;
  reg.update = () => Promise.resolve();
  const container = new dom.window.EventTarget();
  container.controller = {}; // a shell is already in control, so this is an update

  const stop = globalThis.sudokuApp.initUpdates({
    sw: container,
    register: () => Promise.resolve(reg),
    reload: () => {}
  });
  await sleep(20);
  reg.dispatchEvent(new dom.window.Event('updatefound'));
  worker.dispatchEvent(new dom.window.Event('statechange'));
  await waitFor(() => !$('updateBar').hidden, 2000, 'update bar from updatefound');

  $('updateDismiss').click();
  assert.equal($('updateBar').hidden, true, 'dismissing hides the notice');
  stop();
});

test('a first install is not offered as an update', async () => {
  $('updateBar').hidden = true;
  const worker = new dom.window.EventTarget();
  worker.state = 'installed';
  const reg = new dom.window.EventTarget();
  reg.installing = worker;
  reg.update = () => Promise.resolve();
  const container = new dom.window.EventTarget(); // controller stays null

  const stop = globalThis.sudokuApp.initUpdates({
    sw: container,
    register: () => Promise.resolve(reg),
    reload: () => {}
  });
  await sleep(20);
  reg.dispatchEvent(new dom.window.Event('updatefound'));
  worker.dispatchEvent(new dom.window.Event('statechange'));
  await sleep(50);
  assert.equal($('updateBar').hidden, true, 'there is nothing to update *from* on a first install');
  stop();
});
