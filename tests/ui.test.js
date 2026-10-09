import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { createStore } from '../js/store.js';

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
  $('sideTabs').querySelector('[data-tab="data"]').click();
  $('wipeBtn').click();
  assert.equal(document.querySelectorAll('#puzzleList .puzzle-item').length, 0);
  assert.match($('storageNote').textContent, /0 puzzles/);
});

after(() => {
  // The running clock would otherwise hold the event loop open forever.
  if (globalThis.sudokuApp) globalThis.sudokuApp.stopTimer();
  dom.window.close();
});
