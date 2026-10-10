import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bootAppEnv, shutdown } from './helpers/app-env.mjs';

/*
 * Regression tests for three Material You bugs reported from a real device:
 *
 *   1. Leaving the app and coming back reverted to azure instead of sticking
 *      with Dynamic. Cause: applyAccent('dynamic') ran before the async seed
 *      arrived, fell back to azure, and WROTE azure to storage -- destroying
 *      the preference before initDynamicTheme() could honour it.
 *   2. Changing the device color scheme did not change the app. Cause: the
 *      seed was only ever read once at boot.
 *   3. (Related) a stored 'dynamic' with no matching CSS rule rendered on
 *      bare defaults.
 *
 * Each test boots with storage pre-seeded to 'dynamic', which is the exact
 * state that triggered the bug.
 */

let currentSeed = '#6750A4'; // Material You purple
let queryCount = 0;

const { dom } = await bootAppEnv({
  seedStorage: { 'sudoku.ui.theme': 'dynamic' },
  nativeBridge: {
    isNativePlatform: () => true,
    isPluginAvailable: (n) => n === 'DynamicTheme' || n === 'Preferences',
    nativePromise: async (plugin, method) => {
      if (plugin === 'DynamicTheme' && method === 'getColors') {
        queryCount++;
        return { supported: true, colorPrimary: currentSeed, sdkInt: 34 };
      }
      return { value: null };
    }
  }
});

after(() => shutdown(dom));

const root = () => dom.window.document.documentElement;
const store = () => dom.window.localStorage.getItem('sudoku.ui.theme');

test('a stored "dynamic" survives boot instead of being overwritten with azure', async () => {
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(
    store(),
    'dynamic',
    'the preference must not be clobbered while the seed is still in flight',
  );
});

test('the dynamic palette is actually applied after boot', async () => {
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(root().getAttribute('data-accent'), 'dynamic');
  const accent = root().style.getPropertyValue('--accent');
  assert.ok(accent.startsWith('hsl'), `expected an inline hsl accent, got "${accent}"`);
  // Purple seed -> hue near 275. If this were azure it would be ~221.
  const m = /hsla?\(([\d.]+)/.exec(accent);
  const hue = Number(m[1]);
  assert.ok(
    hue > 250 && hue < 300,
    `accent hue ${hue} is not derived from the purple seed`,
  );
});

test('storedTheme reports dynamic, not the placeholder', async () => {
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(globalThis.sudokuApp.storedTheme, 'dynamic');
});

test('refreshDynamicTheme picks up a changed device seed', async () => {
  await new Promise((r) => setTimeout(r, 80));
  const before = root().style.getPropertyValue('--accent');

  // Simulate the user changing their wallpaper / accent while backgrounded.
  currentSeed = '#0061A4'; // a blue
  const beforeQueries = queryCount;
  await globalThis.sudokuApp.refreshDynamicTheme();

  assert.ok(queryCount > beforeQueries, 'refresh must actually re-query the native plugin');
  const after = root().style.getPropertyValue('--accent');
  assert.notEqual(after, before, 'the palette must repaint for the new seed');

  const hue = Number(/hsla?\(([\d.]+)/.exec(after)[1]);
  assert.ok(hue > 190 && hue < 230, `accent hue ${hue} is not the new blue seed`);
});

test('refresh is a no-op when the user did not choose dynamic', () => {
  globalThis.sudokuApp.applyAccent('crimson');
  assert.equal(globalThis.sudokuApp.storedTheme, 'crimson');
  const queries = queryCount;
  // Must not even ask the native layer.
  const p = globalThis.sudokuApp.refreshDynamicTheme();
  assert.ok(p === null || p instanceof Promise);
  assert.equal(queryCount, queries, 'must not query when storedTheme is not dynamic');
});

test('switching to a static theme persists and stops dynamic from re-applying', async () => {
  globalThis.sudokuApp.applyAccent('teal');
  assert.equal(store(), 'teal');
  assert.equal(root().getAttribute('data-accent'), 'teal');
  assert.equal(
    root().style.getPropertyValue('--accent'),
    '',
    'inline dynamic vars must be cleared or they override the static theme',
  );
  await globalThis.sudokuApp.refreshDynamicTheme();
  assert.equal(root().getAttribute('data-accent'), 'teal', 'refresh must not hijack back to dynamic');
});
