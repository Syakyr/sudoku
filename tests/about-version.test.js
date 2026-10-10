import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bootAppEnv, shutdown } from './helpers/app-env.mjs';
import { APP_VERSION, APP_VERSION_LABEL } from '../js/version.js';

/*
 * The version and storage channel have to be visible in Settings -- they are
 * the first two things needed when someone reports a problem.
 *
 * Booted with the native bridge present, i.e. the packaged-app shape, because
 * that is the channel where "which version am I?" actually matters.
 */

const { dom } = await bootAppEnv({
  nativeBridge: {
    isNativePlatform: () => true,
    isPluginAvailable: (n) => n === 'Preferences',
    nativePromise: async () => ({ value: null })
  }
});

after(() => shutdown(dom));

test('version label is derived from the version, not hand-maintained twice', () => {
  assert.equal(APP_VERSION_LABEL, `v${APP_VERSION}`);
  assert.match(APP_VERSION, /^\d+\.\d+\.\d+$/, 'must be a bare semver, no leading v');
});

test('Settings shows the running version', () => {
  const el = dom.window.document.getElementById('aboutVersion');
  assert.ok(el, '#aboutVersion must exist in the settings tab');
  assert.ok(
    el.textContent.includes(APP_VERSION_LABEL),
    `expected the label ${APP_VERSION_LABEL} in: ${el.textContent}`,
  );
});

test('Settings reports the native storage channel when the plugin is present', () => {
  const el = dom.window.document.getElementById('aboutVersion');
  assert.match(el.textContent, /stored on this device/);
  assert.doesNotMatch(el.textContent, /in this browser/);
});

test('the Dynamic swatch is absent when Material You is unavailable', async () => {
  // This boot has no DynamicTheme plugin, which is the browser / pre-Android-12
  // case. initDynamicTheme must remove the swatch rather than offer a theme it
  // cannot paint.
  await new Promise((r) => setTimeout(r, 50));
  const swatch = dom.window.document.querySelector('.swatch[data-accent="dynamic"]');
  assert.equal(swatch, null, 'swatch must be removed, not merely hidden');
  assert.equal(globalThis.sudokuApp.dynamicSeed, null);
});

test('the About row is inside the settings tab, not floating in the drawer', () => {
  const el = dom.window.document.getElementById('aboutVersion');
  const tab = el.closest('#tab-settings');
  assert.ok(tab, 'aboutVersion must live inside #tab-settings');
});
