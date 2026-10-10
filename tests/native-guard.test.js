import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

/*
 * isNativeApp() is the single check that keeps PWA-only behaviour out of the
 * packaged app. It reads the native bridge off globalThis at CALL time (not
 * import time), so all three cases can share one app instance.
 *
 * The registration side effects are covered by their own files --
 * native-sw-suppressed.test.js and pwa-sw-registers.test.js -- one app
 * instance per process, because those are import-time side effects and must
 * not be tangled together.
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
  if (globalThis.sudokuApp) {
    globalThis.sudokuApp.stopTimer();
    globalThis.sudokuApp.stopUpdates();
  }
  dom.window.close();
});

test('isNativeApp is false with no Capacitor global (plain browser / PWA)', () => {
  delete globalThis.Capacitor;
  assert.equal(globalThis.sudokuApp.isNativeApp(), false);
});

test('isNativeApp is true when the native bridge reports a native platform', () => {
  define('Capacitor', { isNativePlatform: () => true });
  assert.equal(globalThis.sudokuApp.isNativeApp(), true);
});

test('isNativeApp is false when Capacitor exists without isNativePlatform', () => {
  define('Capacitor', {});
  assert.equal(globalThis.sudokuApp.isNativeApp(), false);
});

test('isNativeApp is false when isNativePlatform is not callable', () => {
  define('Capacitor', { isNativePlatform: 'yes' });
  assert.equal(globalThis.sudokuApp.isNativeApp(), false);
});
