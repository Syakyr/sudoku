import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bootAppEnv, shutdown } from './helpers/app-env.mjs';

/*
 * The deployed PWA must STILL register the service worker.
 *
 * This is the counterpart that keeps the native guard honest: suppressing the
 * worker in the APK is only correct if the browser path keeps working, because
 * the worker is the rolling-update mechanism for the site (precached shell +
 * the in-app "Update available" bar). A guard written too broadly -- e.g.
 * dropping the whole block while "fixing" the APK -- would silently take the
 * deployed app's update path away, and this is the test that would catch it.
 *
 * Separate file from native-sw-suppressed.test.js because both assert
 * import-time side effects and must not share a process.
 */

const { dom, registerCalls } = await bootAppEnv({
  // No Capacitor global: a plain browser on an https origin.
  nativeBridge: undefined,
});

// Let the boot-time generation finish before the test ends. Leaving it
// mid-flight is what kept the event loop open and made the file hang after the
// assertion had already passed.
async function waitForGeneration(timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (dom.window.document.getElementById('puzzleMeta').children.length > 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out waiting for the first puzzle to generate');
}

await waitForGeneration();

after(() => shutdown(dom));

test('the PWA registers sw.js on an https origin', () => {
  assert.ok(
    registerCalls.includes('sw.js'),
    `expected the PWA to register sw.js, but register() was called with: ${JSON.stringify(registerCalls)}`,
  );
});
