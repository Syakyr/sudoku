import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { bootAppEnv, shutdown } from './helpers/app-env.mjs';

/*
 * The packaged (Capacitor) app must NOT register the service worker.
 *
 * Why this is a real risk rather than a theoretical one: Capacitor serves the
 * bundle from a local `https://localhost` (androidScheme defaults to https),
 * so the previous `location.protocol === 'https:'` guard alone would let the
 * worker register inside the APK -- caching files that are already local and
 * cannot change underneath it, and resurrecting an update bar that has nothing
 * to update from.
 *
 * Separate file from pwa-sw-registers.test.js because both assert import-time
 * side effects and must not share a process.
 */

const { dom, registerCalls } = await bootAppEnv({
  nativeBridge: { isNativePlatform: () => true },
});

// Let the boot-time generation finish before the test ends, so nothing is
// mid-flight when the file tears down.
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

test('the packaged app never registers a service worker', () => {
  assert.deepEqual(
    registerCalls,
    [],
    `native app must not register a service worker, but register() was called with: ${JSON.stringify(registerCalls)}`,
  );
});

test('the packaged app leaves the update bar hidden', () => {
  // #updateBar starts hidden and is only ever revealed by a registered
  // worker's offer(). No worker means no button that cannot do anything.
  assert.equal(dom.window.document.getElementById('updateBar').hidden, true);
});
