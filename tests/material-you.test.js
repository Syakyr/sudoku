import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  hexToHsl,
  hslLuminance,
  contrastRatio,
  buildPalette,
  applyDynamicPalette,
  clearDynamicPalette,
  queryDynamicTheme
} from '../js/material-you.js';

/*
 * The native half of Material You cannot be exercised here (no device). The
 * derivation half can, and that is where the real risk lives: a dynamic accent
 * that is unreadable against the background is a worse outcome than no dynamic
 * accent at all.
 */

test('hexToHsl matches known values', () => {
  const red = hexToHsl('#ff0000');
  assert.equal(Math.round(red.h), 0);
  assert.equal(Math.round(red.s), 100);
  assert.equal(Math.round(red.l), 50);

  const azure = hexToHsl('#4f8cff');
  assert.ok(Math.abs(azure.h - 221) < 2, `azure hue was ${azure.h}`);

  const grey = hexToHsl('#808080');
  assert.equal(grey.s, 0);

  const white = hexToHsl('#ffffff');
  assert.equal(Math.round(white.l), 100);
});

test('hexToHsl rejects junk rather than producing a bogus hue', () => {
  for (const bad of [null, undefined, '', 'zzz', '#12', '#gggggg', 42, {}]) {
    assert.equal(hexToHsl(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test('contrastRatio: black on white is 21:1, same colour is 1:1', () => {
  const white = { h: 0, s: 0, l: 100 };
  const black = { h: 0, s: 0, l: 0 };
  assert.equal(contrastRatio(white, black).toFixed(1), '21.0');
  assert.equal(contrastRatio(white, white).toFixed(2), '1.00');
});

test('buildPalette produces every var the app needs, for both modes', () => {
  const required = [
    '--bg', '--panel', '--panel-2', '--line', '--line-strong', '--text',
    '--muted', '--accent', '--accent-2', '--accent-soft', '--accent-faint',
    '--given', '--user', '--note', '--bad'
  ];
  for (const mode of ['dark', 'light']) {
    const p = buildPalette('#6750a4', mode); // Material You purple seed
    assert.ok(p, `${mode} palette must build`);
    for (const k of required) {
      assert.ok(p[k], `${mode} is missing ${k}`);
      assert.match(p[k], /^hsla?\(/, `${mode} ${k} is not an hsl value: ${p[k]}`);
    }
    assert.equal(p['color-scheme'], mode);
  }
});

test('the dynamic accent clears WCAG AA against its own background (dark)', () => {
  // Sweep every hue: the point of using the app's own recipe is that no hue can
  // produce an unreadable accent.
  for (let h = 0; h < 360; h += 10) {
    const hex = hslToHexApprox(h, 70, 55);
    const p = buildPalette(hex, 'dark', { minContrast: 4.5 });
    const bg = hslFromVar(p['--bg']);
    const accent = hslFromVar(p['--accent']);
    const ratio = contrastRatio(accent, bg);
    assert.ok(
      ratio >= 4.5,
      `hue ${h}: accent/bg contrast ${ratio.toFixed(2)} is below 4.5`,
    );
  }
});

test('the contrast guard actually fires when the bar is raised', () => {
  const hex = '#6750a4';
  const lax = buildPalette(hex, 'dark', { minContrast: 1 });
  const strict = buildPalette(hex, 'dark', { minContrast: 9 });
  // A stricter bar must push the accent lighter, proving the guard is live and
  // not a no-op that always passes.
  const laxL = hslFromVar(lax['--accent']).l;
  const strictL = hslFromVar(strict['--accent']).l;
  assert.ok(strictL > laxL, `guard did nothing: ${laxL} -> ${strictL}`);
  const ratio = contrastRatio(hslFromVar(strict['--accent']), hslFromVar(strict['--bg']));
  assert.ok(ratio >= 9, `guard stopped short at ${ratio.toFixed(2)}`);
});

test('buildPalette returns null on an unusable seed', () => {
  assert.equal(buildPalette(null, 'dark'), null);
  assert.equal(buildPalette('nonsense', 'light'), null);
});

test('red stays red: --bad is not derived from the seed hue', () => {
  const a = buildPalette('#ff0000', 'dark');
  const b = buildPalette('#00ff00', 'dark');
  assert.equal(a['--bad'], b['--bad']);
  assert.match(a['--bad'], /358/);
});

test('queryDynamicTheme degrades cleanly with no bridge', async () => {
  const had = globalThis.Capacitor;
  delete globalThis.Capacitor;
  try {
    const r = await queryDynamicTheme();
    assert.equal(r.supported, false);
    assert.equal(r.reason, 'no_bridge');
  } finally {
    if (had !== undefined) globalThis.Capacitor = had;
  }
});

test('queryDynamicTheme reports the seed when the plugin answers', async () => {
  globalThis.Capacitor = {
    isPluginAvailable: (n) => n === 'DynamicTheme',
    nativePromise: async () => ({ supported: true, colorPrimary: '#6750A4', sdkInt: 34 })
  };
  try {
    const r = await queryDynamicTheme();
    assert.equal(r.supported, true);
    assert.equal(r.seed, '#6750A4');
    assert.equal(r.sdkInt, 34);
  } finally {
    delete globalThis.Capacitor;
  }
});

test('queryDynamicTheme propagates a native "unsupported" reason', async () => {
  globalThis.Capacitor = {
    isPluginAvailable: () => true,
    nativePromise: async () => ({ supported: false, reason: 'android_version' })
  };
  try {
    const r = await queryDynamicTheme();
    assert.equal(r.supported, false);
    assert.equal(r.reason, 'android_version');
  } finally {
    delete globalThis.Capacitor;
  }
});

test('a rejected native call does not propagate out of queryDynamicTheme', async () => {
  globalThis.Capacitor = {
    isPluginAvailable: () => true,
    nativePromise: async () => {
      throw new Error('bridge died');
    }
  };
  try {
    const r = await queryDynamicTheme();
    assert.equal(r.supported, false);
    assert.equal(r.reason, 'call_failed');
  } finally {
    delete globalThis.Capacitor;
  }
});

test('a plugin that answers with no seed colour is treated as unsupported', async () => {
  globalThis.Capacitor = {
    isPluginAvailable: () => true,
    nativePromise: async () => ({ supported: true })
  };
  try {
    const r = await queryDynamicTheme();
    assert.equal(r.supported, false);
    assert.equal(r.reason, 'no_seed_color');
  } finally {
    delete globalThis.Capacitor;
  }
});

test('applyDynamicPalette writes the vars inline and marks the root', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const savedDoc = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const p = applyDynamicPalette('#6750a4', 'dark');
    const root = dom.window.document.documentElement;
    assert.ok(p);
    assert.equal(root.getAttribute('data-accent'), 'dynamic');
    assert.equal(root.getAttribute('data-dynamic-mode'), 'dark');
    assert.ok(root.style.getPropertyValue('--accent').startsWith('hsl'));
    assert.ok(root.style.getPropertyValue('--bg').startsWith('hsl'));
  } finally {
    globalThis.document = savedDoc;
    dom.window.close();
  }
});

test('clearDynamicPalette removes every inline var so a static theme can win', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const savedDoc = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    applyDynamicPalette('#6750a4', 'dark');
    const root = dom.window.document.documentElement;
    assert.ok(root.style.getPropertyValue('--accent'));
    clearDynamicPalette();
    assert.equal(root.style.getPropertyValue('--accent'), '');
    assert.equal(root.style.getPropertyValue('--bg'), '');
    assert.equal(root.getAttribute('data-dynamic-mode'), null);
  } finally {
    globalThis.document = savedDoc;
    dom.window.close();
  }
});

/* --- helpers local to this test file --- */

function hslFromVar(v) {
  const m = /hsla?\(([\d.]+),\s*([\d.]+)%,\s*([\d.]+)%/.exec(v);
  if (!m) throw new Error(`not an hsl var: ${v}`);
  return { h: Number(m[1]), s: Number(m[2]), l: Number(m[3]) };
}

function hslToHexApprox(h, s, l) {
  const sN = s / 100;
  const lN = l / 100;
  const c = (1 - Math.abs(2 * lN - 1)) * sN;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lN - c / 2;
  let r, g, b;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = (v) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}
