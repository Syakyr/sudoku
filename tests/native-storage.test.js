import test from 'node:test';
import assert from 'node:assert/strict';
import { openStorage, nativeBridge, updatedAtOf } from '../js/native-storage.js';
import { STORAGE_KEY } from '../js/store.js';

/*
 * The one job that must not regress: a user who already has a library in
 * localStorage must still have it after this migration, on both channels.
 * Every test below is written so that it would actually fail if the behaviour
 * it names were broken.
 */

/** localStorage-shaped in-memory store. */
function memLocal(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k)
  };
}

/** Fake native Preferences that records every call. */
function memNative(initial = {}) {
  const map = new Map(Object.entries(initial));
  const calls = { get: 0, set: 0, remove: 0 };
  return {
    map,
    calls,
    get: async (k) => {
      calls.get++;
      return { value: map.has(k) ? map.get(k) : null };
    },
    set: async (k, v) => {
      calls.set++;
      map.set(k, String(v));
    },
    remove: async (k) => {
      calls.remove++;
      map.delete(k);
    }
  };
}

const doc = (n, updatedAt) =>
  JSON.stringify({ schema: 1, updatedAt, puzzles: { p1: { id: 'p1', grid: 'x'.repeat(81) }, count: n } });

const countOf = (raw) => (raw ? JSON.parse(raw).puzzles.count : null);

test('native path: existing localStorage data is migrated up, not lost', async () => {
  const existing = doc(7, 1000);
  const local = memLocal({ [STORAGE_KEY]: existing });
  const native = memNative();

  const s = await openStorage({ local, native });

  assert.equal(s.mode, 'native');
  assert.equal(s.migrated, true, 'must report that a migration happened');
  assert.equal(countOf(native.map.get(STORAGE_KEY)), 7, 'native must hold the library');
  assert.equal(countOf(s.getItem(STORAGE_KEY)), 7, 'the backend must read it back');
});

test('native path: a fresher localStorage mirror beats a stale native copy', async () => {
  // Rollback safety: native got rewound (failed restore, older backup) while
  // the mirror still holds the newer session. Newest must win.
  const local = memLocal({ [STORAGE_KEY]: doc(9, 5000) });
  const native = memNative({ [STORAGE_KEY]: doc(3, 1000) });

  const s = await openStorage({ local, native });

  assert.equal(s.migrated, true);
  assert.equal(countOf(s.getItem(STORAGE_KEY)), 9, 'newer local must win');
  assert.equal(countOf(native.map.get(STORAGE_KEY)), 9, 'native must be pushed forward');
});

test('native path: native wins when it is the newer copy', async () => {
  const local = memLocal({ [STORAGE_KEY]: doc(2, 1000) });
  const native = memNative({ [STORAGE_KEY]: doc(8, 9000) });

  const s = await openStorage({ local, native });

  assert.equal(s.migrated, false, 'nothing to migrate when native is ahead');
  assert.equal(countOf(s.getItem(STORAGE_KEY)), 8);
  assert.equal(countOf(local.getItem(STORAGE_KEY)), 8, 'mirror is refreshed to match');
});

test('write-through: setItem hits cache, mirror and native', async () => {
  const local = memLocal();
  const native = memNative();
  const s = await openStorage({ local, native });

  s.setItem(STORAGE_KEY, doc(1, 123));

  assert.equal(countOf(s.getItem(STORAGE_KEY)), 1, 'cache updated synchronously');
  assert.equal(countOf(local.getItem(STORAGE_KEY)), 1, 'mirror written synchronously');
  assert.equal(native.calls.set >= 1, true, 'native write queued');
  await s.flush();
  assert.equal(countOf(native.map.get(STORAGE_KEY)), 1, 'native write landed after flush');
});

test('the localStorage mirror is durable before the native write lands', async () => {
  // This is the crash-safety property: if the process dies mid-write the
  // mirror still has the document.
  const local = memLocal();
  let nativeLanded = false;
  const slowNative = {
    get: async () => ({ value: null }),
    set: () => new Promise((r) => setTimeout(() => { nativeLanded = true; r(); }, 50)),
    remove: async () => {}
  };
  const s = await openStorage({ local, native: slowNative });

  s.setItem(STORAGE_KEY, doc(4, 1));
  assert.equal(nativeLanded, false, 'native write must still be in flight');
  assert.equal(countOf(local.getItem(STORAGE_KEY)), 4, 'mirror must already have it');
  await s.flush();
  assert.equal(nativeLanded, true);
});

test('flush() drains the queue and pendingCount reflects it', async () => {
  const s = await openStorage({ local: memLocal(), native: memNative() });
  s.setItem('a', '1');
  s.setItem('b', '2');
  assert.equal(s.pendingCount(), 2, 'two writes in flight');
  await s.flush();
  assert.equal(s.pendingCount(), 0, 'queue drained');
});

test('removeItem clears cache, mirror and native', async () => {
  const local = memLocal({ [STORAGE_KEY]: doc(5, 10) });
  const native = memNative({ [STORAGE_KEY]: doc(5, 10) });
  const s = await openStorage({ local, native });

  s.removeItem(STORAGE_KEY);
  await s.flush();

  assert.equal(s.getItem(STORAGE_KEY), null);
  assert.equal(local.getItem(STORAGE_KEY), null);
  assert.equal(native.map.get(STORAGE_KEY), undefined);
});

test('a rejected native read does not lose the mirror', async () => {
  const local = memLocal({ [STORAGE_KEY]: doc(6, 4000) });
  const native = {
    get: async () => {
      throw new Error('bridge down');
    },
    set: async () => {},
    remove: async () => {}
  };
  const s = await openStorage({ local, native });
  assert.equal(countOf(s.getItem(STORAGE_KEY)), 6, 'mirror must still be usable');
});

test('a rejected native write does not break the backend', async () => {
  const s = await openStorage({
    local: memLocal(),
    native: {
      get: async () => ({ value: null }),
      set: async () => {
        throw new Error('quota');
      },
      remove: async () => {}
    }
  });
  s.setItem(STORAGE_KEY, 'payload');
  assert.equal(s.getItem(STORAGE_KEY), 'payload');
  await s.flush(); // must not reject
});

test('no native plugin: falls back to plain localStorage, unchanged behaviour', async () => {
  const local = memLocal({ [STORAGE_KEY]: doc(3, 1) });
  const s = await openStorage({ local, native: null });

  assert.equal(s.mode, 'local');
  assert.equal(s.migrated, false);
  assert.equal(s.backend, local, 'backend is localStorage itself');
  assert.equal(countOf(s.backend.getItem(STORAGE_KEY)), 3);
});

test('no native and no localStorage: memory mode (store falls back in-memory)', async () => {
  const s = await openStorage({ local: null, native: null });
  assert.equal(s.mode, 'memory');
  assert.equal(s.backend, null);
});

test('updatedAtOf reads the write stamp and survives junk', () => {
  assert.equal(updatedAtOf('{"updatedAt":5000}'), 5000);
  assert.equal(updatedAtOf(null), 0);
  assert.equal(updatedAtOf('not json'), 0);
  assert.equal(updatedAtOf('{}'), 0);
  assert.equal(updatedAtOf('{"updatedAt":"nope"}'), 0);
});

test('nativeBridge returns null with no Capacitor global', () => {
  const had = globalThis.Capacitor;
  delete globalThis.Capacitor;
  try {
    assert.equal(nativeBridge(), null);
  } finally {
    if (had !== undefined) globalThis.Capacitor = had;
  }
});

test('nativeBridge detects the plugin via isPluginAvailable', () => {
  globalThis.Capacitor = {
    isPluginAvailable: (n) => n === 'Preferences',
    nativePromise: async () => ({ value: 'v' })
  };
  try {
    const b = nativeBridge();
    assert.notEqual(b, null, 'must see the plugin');
    const got = b.get('k');
    assert.ok(got instanceof Promise);
  } finally {
    delete globalThis.Capacitor;
  }
});

test('nativeBridge falls back to PluginHeaders when isPluginAvailable is absent', () => {
  globalThis.Capacitor = {
    PluginHeaders: [{ name: 'Other' }, { name: 'Preferences' }],
    nativePromise: async () => ({ value: 'v' })
  };
  try {
    assert.notEqual(nativeBridge(), null);
  } finally {
    delete globalThis.Capacitor;
  }
});

test('nativeBridge returns null when the plugin is not registered', () => {
  globalThis.Capacitor = {
    PluginHeaders: [{ name: 'Keyboard' }],
    nativePromise: async () => ({ value: null })
  };
  try {
    assert.equal(nativeBridge(), null);
  } finally {
    delete globalThis.Capacitor;
  }
});

test('a throwing isPluginAvailable is treated as unavailable, not fatal', () => {
  globalThis.Capacitor = {
    isPluginAvailable: () => {
      throw new Error('nope');
    },
    nativePromise: async () => ({ value: null })
  };
  try {
    assert.equal(nativeBridge(), null);
  } finally {
    delete globalThis.Capacitor;
  }
});
