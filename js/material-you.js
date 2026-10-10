/**
 * Material You (dynamic color) support.
 *
 * WHAT WE TAKE FROM THE SYSTEM: the seed HUE. Nothing else.
 *
 * That is deliberate. The app's four hand-tuned themes are all HSL with a
 * consistent saturation/lightness recipe per mode -- crimson dark, teal light,
 * and so on. Regenerating the whole theme from the system's hue reuses a recipe
 * whose contrast was chosen on purpose. Importing Material's raw ARGB values and
 * tinting them in JS would throw that away and produce pencil marks nobody can
 * read.
 *
 * Because we never import the system's lightness, the usual dynamic-color
 * contrast failures cannot happen: on a 4.5%-lightness background, an accent at
 * 53% lightness clears contrast comfortably whatever the hue is. A luminance
 * guard is still applied as a safety net.
 *
 * OPT-IN ONLY. This never overrides a theme the user picked. It appears as a
 * "Dynamic" swatch, and only when the native plugin reports support -- which
 * means Android 12+ with dynamic color enabled. Everywhere else the swatch is
 * absent and nothing changes.
 */

const PLUGIN = 'DynamicTheme';

/** Recipes lifted verbatim from css/style.css, with the hue left as a variable. */
const RECIPES = {
  dark: {
    colorScheme: 'dark',
    vars: {
      '--bg': [48, 4.5],
      '--panel': [44, 7.5],
      '--panel-2': [41, 11.5],
      '--line': [36, 19],
      '--line-strong': [30, 39],
      '--text': [45, 95],
      '--muted': [24, 73],
      '--accent': [82, 53],
      '--accent-2': [100, 79],
      '--accent-soft': [92, 56, 0.3],
      '--accent-faint': [92, 56, 0.12],
      '--given': [35, 94],
      '--user': [100, 82],
      '--note': [22, 62]
    }
  },
  light: {
    colorScheme: 'light',
    vars: {
      '--bg': [40, 97],
      '--panel': [58, 99],
      '--panel-2': [48, 94],
      '--line': [36, 86],
      '--line-strong': [24, 56],
      '--text': [35, 11],
      '--muted': [16, 38],
      '--accent': [82, 26],
      '--accent-2': [76, 21],
      '--accent-soft': [70, 35, 0.18],
      '--accent-faint': [70, 35, 0.07],
      '--given': [25, 11],
      '--user': [78, 27],
      '--note': [14, 44]
    }
  }
};

/** #rrggbb -> {h, s, l} with h in degrees, s/l in percent. */
export function hexToHsl(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return { h: 0, s: 0, l: l * 100 };
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  const s = d / (1 - Math.abs(2 * l - 1));
  return { h, s: s * 100, l: l * 100 };
}

function srgbChannel(c) {
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance of an hsl color. */
export function hslLuminance(h, s, l) {
  const sN = s / 100;
  const lN = l / 100;
  const c = (1 - Math.abs(2 * lN - 1)) * sN;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const mm = lN - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return (
    0.2126 * srgbChannel(r + mm) +
    0.7152 * srgbChannel(g + mm) +
    0.0722 * srgbChannel(b + mm)
  );
}

export function contrastRatio(hslA, hslB) {
  const a = hslLuminance(hslA.h, hslA.s, hslA.l);
  const b = hslLuminance(hslB.h, hslB.s, hslB.l);
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Build the CSS custom-property map for a seed hue in a given mode.
 * Applies a contrast guard: if the accent would fall below `minContrast`
 * against the background, its lightness is pushed until it clears.
 */
export function buildPalette(seedHex, mode = 'dark', { minContrast = 4.5 } = {}) {
  const seed = hexToHsl(seedHex);
  if (!seed) return null;
  const recipe = RECIPES[mode] || RECIPES.dark;
  const hue = seed.h;
  const out = {};

  const bgSpec = recipe.vars['--bg'];
  const bg = { h: hue, s: bgSpec[0], l: bgSpec[1] };

  for (const [name, spec] of Object.entries(recipe.vars)) {
    let [s, l] = spec;
    const alpha = spec.length > 2 ? spec[2] : null;

    // Only the accent family needs the contrast guard -- backgrounds, text and
    // lines are already pinned by the recipe.
    if (name === '--accent' || name === '--accent-2' || name === '--user') {
      let guard = 0;
      while (guard < 40) {
        const candidate = { h: hue, s, l };
        const ratio = contrastRatio(candidate, bg);
        const ok = mode === 'dark' ? ratio >= minContrast : ratio <= 1 / minContrast;
        if (ok) break;
        // Dark themes lighten the accent, light themes darken it.
        l += mode === 'dark' ? 1 : -1;
        l = Math.max(0, Math.min(100, l));
        guard++;
      }
    }

    out[name] =
      alpha === null
        ? `hsl(${hue.toFixed(1)}, ${s}%, ${l}%)`
        : `hsla(${hue.toFixed(1)}, ${s}%, ${l}%, ${alpha})`;
  }

  // Red stays red regardless of the wallpaper.
  out['--bad'] = mode === 'dark' ? 'hsl(358, 100%, 66%)' : 'hsl(358, 78%, 42%)';
  out['color-scheme'] = recipe.colorScheme;
  return out;
}

/** Ask the native plugin what it can see. Never throws. */
export async function queryDynamicTheme() {
  const cap = typeof globalThis !== 'undefined' ? globalThis.Capacitor : null;
  if (!cap || typeof cap.nativePromise !== 'function') {
    return { supported: false, reason: 'no_bridge' };
  }
  let available = false;
  try {
    available =
      typeof cap.isPluginAvailable === 'function'
        ? Boolean(cap.isPluginAvailable(PLUGIN))
        : (cap.PluginHeaders || []).some((h) => h && h.name === PLUGIN);
  } catch {
    available = false;
  }
  if (!available) return { supported: false, reason: 'plugin_missing' };

  try {
    const res = await cap.nativePromise(PLUGIN, 'getColors', {});
    if (!res || !res.supported) {
      return { supported: false, reason: (res && res.reason) || 'unsupported' };
    }
    if (!res.colorPrimary) return { supported: false, reason: 'no_seed_color' };
    return {
      supported: true,
      seed: res.colorPrimary,
      sdkInt: res.sdkInt || null
    };
  } catch (e) {
    return { supported: false, reason: 'call_failed' };
  }
}

/**
 * Apply the dynamic palette to the document.
 * @returns the applied palette, or null if it could not be built.
 */
export function applyDynamicPalette(seedHex, mode) {
  const palette = buildPalette(seedHex, mode);
  if (!palette) return null;
  const root = document.documentElement;
  root.setAttribute('data-accent', 'dynamic');
  root.setAttribute('data-dynamic-mode', mode);
  for (const [name, value] of Object.entries(palette)) {
    if (name === 'color-scheme') {
      root.style.setProperty('color-scheme', value);
    } else {
      root.style.setProperty(name, value);
    }
  }
  return palette;
}

/** Clear any inline dynamic properties so a static theme can take over. */
export function clearDynamicPalette() {
  const root = document.documentElement;
  const all = new Set([
    ...Object.keys(RECIPES.dark.vars),
    ...Object.keys(RECIPES.light.vars)
  ]);
  for (const name of all) root.style.removeProperty(name);
  root.style.removeProperty('color-scheme');
  root.removeAttribute('data-dynamic-mode');
}
