import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

/*
 * Shared harness for the two service-worker registration tests.
 *
 * Those tests assert import-time side effects of js/app.js, so each needs its
 * OWN process with globals installed BEFORE the import. Hence one helper used
 * from two separate test files rather than two cases in one file: Node caches
 * modules per specifier, and trying to re-import with cache-busting here is
 * what produced double `load` events and a wedged event loop.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(here, '..', '..', 'index.html'), 'utf8');

const define = (name, value) =>
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

/**
 * Boot jsdom, install the globals app.js expects, optionally stand in the
 * Capacitor native bridge, stub serviceWorker registration, then import the
 * app and fire the `load` event its registration listener waits on.
 *
 * Returns { dom, registerCalls } where registerCalls records every
 * serviceWorker.register() spec.
 */
export async function bootAppEnv({ url = 'https://localhost/', nativeBridge = undefined } = {}) {
  const dom = new JSDOM(html, { url, pretendToBeVisual: true });

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

  // The app's top-level guard is `'serviceWorker' in navigator`, so the
  // property must exist for the PWA path to be reachable at all.
  const registerCalls = [];
  const stub = {
    register(spec) {
      registerCalls.push(spec);
      return Promise.resolve({ waiting: null, installing: null, addEventListener() {} });
    },
    addEventListener() {},
    get controller() {
      return null;
    },
  };
  for (const nav of [globalThis.navigator, dom.window.navigator]) {
    Object.defineProperty(nav, 'serviceWorker', { value: stub, configurable: true });
  }

  if (nativeBridge !== undefined) define('Capacitor', nativeBridge);
  else delete globalThis.Capacitor;

  await import('../../js/app.js');

  // Fire `load` explicitly: jsdom may have fired it before the listener was
  // attached, which would make a "did not register" assertion pass for the
  // wrong reason.
  dom.window.dispatchEvent(new dom.window.Event('load'));
  await new Promise((r) => setTimeout(r, 50));

  return { dom, registerCalls };
}

/** Stop every timer the app started and close the window so the process can exit. */
export function shutdown(dom) {
  try {
    globalThis.sudokuApp?.stopTimer?.();
    globalThis.sudokuApp?.stopUpdates?.();
  } catch {
    /* best effort */
  }
  try {
    dom?.window?.close();
  } catch {
    /* best effort */
  }
}
