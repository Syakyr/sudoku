import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

/*
 * requestPersistentStorage() is the only defence against the OS reclaiming the
 * puzzle library. Capacitor's own docs say WebView localStorage "must be
 * considered transient... the OS will reclaim local storage from Web Views if
 * a device is running low on space" -- and the whole library is one
 * localStorage document, so that reclaim is a user's data vanishing.
 *
 * The function takes the storage object as a parameter precisely so each branch
 * below can be exercised. Every case here can fail; none are decoration.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(here, '..', 'index.html'), 'utf8');

const define = (name, value) =>
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

const dom = new JSDOM(html, { url: 'https://localhost/', pretendToBeVisual: true });
define('window', dom.window);
define('document', dom.window.document);
define('navigator', dom.window.navigator);
define('location', dom.window.location);
define('localStorage', dom.window.localStorage);
define('HTMLElement', dom.window.HTMLElement);
define('Event', dom.window.Event);
define('Blob', dom.window.Blob);
define('URL', dom.window.URL);
define('FileReader', dom.window.FileReader);
define('confirm', () => true);
dom.window.confirm = globalThis.confirm;

await import('../js/app.js');

after(() => {
  globalThis.sudokuApp?.stopTimer?.();
  globalThis.sudokuApp?.stopUpdates?.();
  dom.window.close();
});

const request = () => globalThis.sudokuApp.requestPersistentStorage;

test('unsupported when there is no storage object at all', async () => {
  const r = await request()(undefined);
  assert.deepEqual(r, { supported: false, persisted: false });
});

test('unsupported when persist() is absent', async () => {
  const r = await request()({ persisted: async () => false });
  assert.equal(r.supported, false);
  assert.equal(r.persisted, false);
});

test('calls persist() and reports the grant', async () => {
  let calls = 0;
  const storage = {
    persisted: async () => false,
    persist: async () => {
      calls++;
      return true;
    },
  };
  const r = await request()(storage);
  assert.equal(calls, 1, 'persist() must actually be called when not already persisted');
  assert.deepEqual(r, { supported: true, persisted: true });
});

test('does not re-call persist() when already persisted', async () => {
  let calls = 0;
  const storage = {
    persisted: async () => true,
    persist: async () => {
      calls++;
      return true;
    },
  };
  const r = await request()(storage);
  assert.equal(calls, 0, 'an already-persisted origin must not be re-requested');
  assert.deepEqual(r, { supported: true, persisted: true });
});

test('a denied persist() is reported as not persisted, not as an error', async () => {
  const storage = { persisted: async () => false, persist: async () => false };
  const r = await request()(storage);
  assert.equal(r.supported, true);
  assert.equal(r.persisted, false);
  assert.notEqual(r.failed, true);
});

test('a throwing persist() is swallowed -- persistence is never a precondition for playing', async () => {
  const storage = {
    persisted: async () => {
      throw new Error('boom');
    },
    persist: async () => true,
  };
  const r = await request()(storage);
  assert.equal(r.supported, true);
  assert.equal(r.persisted, false);
  assert.equal(r.failed, true);
});

test('a persist() that rejects does not propagate', async () => {
  const storage = {
    persisted: async () => false,
    persist: async () => {
      throw new Error('quota');
    },
  };
  const r = await request()(storage);
  assert.equal(r.failed, true);
  assert.equal(r.persisted, false);
});
