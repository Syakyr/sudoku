/**
 * Native-backed storage facade.
 *
 * WHY
 * The whole puzzle library is one localStorage document. Capacitor's storage
 * guide classifies WebView localStorage as explicitly transient: "the OS will
 * reclaim local storage from Web Views if a device is running low on space."
 * navigator.storage.persist() (see app.js) is the cheap signal but only a
 * heuristic. @capacitor/preferences puts the document in a native key/value
 * store that is not subject to WebView eviction.
 *
 * NO BUNDLER
 * This project serves raw ES modules (`<script type="module">`), so a bare
 * `import { Preferences } from '@capacitor/preferences'` cannot resolve at
 * runtime. Verified against @capacitor/core's own bridge source instead:
 * registerPlugin() dispatches to native whenever `cap.PluginHeaders` contains
 * the plugin, and that header list is populated by the *native* side. So the
 * npm package is needed only for `cap sync` to install the Android code -- the
 * JS side is reachable through the global bridge, exactly like the existing
 * isNativeApp() check. No bare specifier ships in the bundle.
 *
 * HOW
 * openStorage() is the only async step, and it resolves BEFORE the store is
 * constructed. What it hands back is a synchronous, localStorage-shaped
 * backend, so store.js and all 24 of its call sites stay untouched.
 *
 *   getItem    reads the in-memory cache (always sync, always populated)
 *   setItem    writes the cache + mirrors to localStorage synchronously,
 *              then queues the native write
 *   removeItem same, inverted
 *
 * The localStorage mirror is not redundant. It is durable *immediately*,
 * which closes the write-behind gap: if the process dies before the native
 * promise settles, the mirror still has the document and the next boot
 * re-converges. Native is the eviction-proof copy; localStorage is the
 * crash-proof one.
 */

import { STORAGE_KEY } from './store.js';

const PLUGIN = 'Preferences';

/**
 * The native Preferences plugin through the Capacitor global bridge, or null
 * when it is not available (plain browser, PWA, older WebView, plugin not
 * installed). Never throws -- a missing bridge is the normal case on the web.
 */
export function nativeBridge() {
  const cap = typeof globalThis !== 'undefined' ? globalThis.Capacitor : null;
  if (!cap || typeof cap.nativePromise !== 'function') return null;

  let available = false;
  try {
    if (typeof cap.isPluginAvailable === 'function') {
      available = Boolean(cap.isPluginAvailable(PLUGIN));
    } else {
      available = (cap.PluginHeaders || []).some((h) => h && h.name === PLUGIN);
    }
  } catch {
    available = false;
  }
  if (!available) return null;

  return {
    get: (key) => cap.nativePromise(PLUGIN, 'get', { key }),
    set: (key, value) => cap.nativePromise(PLUGIN, 'set', { key, value }),
    remove: (key) => cap.nativePromise(PLUGIN, 'remove', { key })
  };
}

function localGet(local, key) {
  if (!local || typeof local.getItem !== 'function') return null;
  try {
    const v = local.getItem(key);
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

function localSet(local, key, value) {
  if (!local || typeof local.setItem !== 'function') return false;
  try {
    local.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function localRemove(local, key) {
  if (!local || typeof local.removeItem !== 'function') return false;
  try {
    local.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/** Newest-write timestamp of a stored document, or 0 if unreadable/absent. */
export function updatedAtOf(raw) {
  if (!raw) return 0;
  try {
    const doc = JSON.parse(raw);
    const t = Number(doc && doc.updatedAt);
    return Number.isFinite(t) ? t : 0;
  } catch {
    return 0;
  }
}

/**
 * Resolve the storage backend to use. Awaited once, at module load.
 *
 * @returns {Promise<{
 *   backend: object|null,  localStorage-shaped: getItem/setItem/removeItem
 *   mode: 'native'|'local'|'memory',
 *   migrated: boolean,     // data was copied up from localStorage this boot
 *   mirrored: boolean,     // writes are also mirrored to localStorage
 *   flush: () => Promise<void>,
 *   pendingCount: () => number
 * }>}
 */
export async function openStorage(opts = {}) {
  const key = opts.key || STORAGE_KEY;
  const has = (k) => Object.prototype.hasOwnProperty.call(opts, k);

  const local = has('local')
    ? opts.local
    : typeof globalThis !== 'undefined'
      ? globalThis.localStorage || null
      : null;
  const native = has('native') ? opts.native : nativeBridge();

  // No native plugin: behave exactly as before. `null` lets store.js fall
  // back to its in-memory backend, which is what already happens in private
  // mode.
  if (!native) {
    return {
      backend: local || null,
      mode: local ? 'local' : 'memory',
      migrated: false,
      mirrored: false,
      flush: () => Promise.resolve(),
      pendingCount: () => 0
    };
  }

  // Read both copies. A native read failure is not fatal -- we still have the
  // mirror, and we keep trying to write native on every save.
  let nativeRaw = null;
  try {
    const res = await native.get(key);
    nativeRaw = res && typeof res.value === 'string' ? res.value : null;
  } catch {
    nativeRaw = null;
  }
  const localRaw = localGet(local, key);

  // Converge on the newest document. This is what makes a rollback safe: if
  // native got wiped or rolled back to an older copy, the fresher mirror wins
  // and gets pushed back down, rather than silently losing the session.
  const nativeT = updatedAtOf(nativeRaw);
  const localT = updatedAtOf(localRaw);
  let chosen = nativeRaw;
  let migrated = false;
  if (!nativeRaw && localRaw) {
    chosen = localRaw;
    migrated = true;
  } else if (nativeRaw && localRaw && localT > nativeT) {
    chosen = localRaw;
    migrated = true;
  }

  const cache = new Map();
  if (chosen != null) {
    cache.set(key, chosen);
    try {
      await native.set(key, chosen);
    } catch {
      /* keep going; writes are retried on every save */
    }
  }
  // Seed/refresh the mirror so it is never behind what the app is holding.
  if (chosen != null) localSet(local, key, chosen);

  const pending = new Set();

  const track = (p) => {
    const settled = Promise.resolve(p)
      .catch(() => {})
      .then(() => {
        pending.delete(settled);
      });
    pending.add(settled);
    return settled;
  };

  return {
    mode: 'native',
    migrated,
    mirrored: Boolean(local),

    getItem(k) {
      return cache.has(k) ? cache.get(k) : null;
    },

    setItem(k, v) {
      const s = String(v);
      cache.set(k, s);
      // Durable now, before the native round-trip.
      localSet(local, k, s);
      track(native.set(k, s));
    },

    removeItem(k) {
      cache.delete(k);
      localRemove(local, k);
      track(native.remove(k));
    },

    flush() {
      return Promise.all([...pending]).then(() => undefined);
    },

    pendingCount() {
      return pending.size;
    }
  };
}
