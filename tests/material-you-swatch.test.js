import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bootAppEnv, shutdown } from './helpers/app-env.mjs';

/*
 * Swatch gating: the Dynamic option must appear ONLY when the native plugin
 * reports support, and must actually paint the page when picked.
 *
 * This is its own file because it needs a boot with the DynamicTheme bridge
 * present; the "absent" case is asserted in about-version.test.js, which
 * boots without it.
 */

const { dom } = await bootAppEnv({
  nativeBridge: {
    isNativePlatform: () => true,
    isPluginAvailable: (n) => n === 'DynamicTheme' || n === 'Preferences',
    nativePromise: async (plugin, method) => {
      if (plugin === 'DynamicTheme' && method === 'getColors') {
        return { supported: true, colorPrimary: '#6750A4', sdkInt: 34 };
      }
      return { value: null };
    }
  }
});

after(() => shutdown(dom));

test('the Dynamic swatch is revealed when the plugin reports support', async () => {
  // initDynamicTheme runs during boot; give the awaited bridge a tick.
  await new Promise((r) => setTimeout(r, 50));
  const swatch = dom.window.document.querySelector('.swatch[data-accent="dynamic"]');
  assert.ok(swatch, 'the Dynamic swatch must exist');
  assert.equal(swatch.hidden, false, 'and must be visible when Material You is available');
});

test('the seed is held after a successful query', async () => {
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(globalThis.sudokuApp.dynamicSeed, '#6750A4');
});

test('picking Dynamic paints the page with a derived palette', () => {
  const root = dom.window.document.documentElement;
  globalThis.sudokuApp.applyAccent('dynamic');
  assert.equal(root.getAttribute('data-accent'), 'dynamic');
  assert.ok(
    root.style.getPropertyValue('--accent').startsWith('hsl'),
    'the accent must be set inline from the derived palette',
  );
  assert.ok(root.style.getPropertyValue('--bg').startsWith('hsl'));
  // And it must be remembered.
  assert.equal(dom.window.localStorage.getItem('sudoku.ui.theme'), 'dynamic');
});

test('switching back to a static theme clears the inline dynamic vars', () => {
  const root = dom.window.document.documentElement;
  globalThis.sudokuApp.applyAccent('crimson');
  assert.equal(root.getAttribute('data-accent'), 'crimson');
  assert.equal(
    root.style.getPropertyValue('--accent'),
    '',
    'leftover inline dynamic vars would override the static theme',
  );
  assert.equal(dom.window.localStorage.getItem('sudoku.ui.theme'), 'crimson');
});
