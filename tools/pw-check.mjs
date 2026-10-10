/**
 * Visual + console verification of the Sudoku page in real Chromium.
 *
 * One fresh browser per scenario: resizing a page or spawning a second page on
 * this host's swiftshader setup crashes Chromium, so we never resize — each
 * scenario gets its own browser launched at its final viewport.
 *
 * Run:
 *   LD_LIBRARY_PATH=/home/linuxbrew/.linuxbrew/lib \
 *   node tools/pw-check.mjs [baseUrl] [outDir]
 *
 * Needs a static server for the repo root (ES modules require http://):
 *   python3 -m http.server 8123
 */
import pw from '/home/coder/Codebase/browser-unlocker/node_modules/playwright/index.js';
import fs from 'node:fs';

const { chromium } = pw; // playwright is CommonJS: no named exports under Node 26

const BASE = process.argv[2] || 'http://localhost:8123';
const OUT = process.argv[3] || 'shots';
fs.mkdirSync(OUT, { recursive: true });

const EXEC =
  process.env.PW_CHROMIUM ||
  `${process.env.HOME}/.cache/ms-playwright/chromium-1244/chrome-linux64/chrome`;

const ARGS = [
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--disable-crash-reporter',
  '--no-zygote'
];

const problems = [];
const results = {};

async function openMenu(page) {
  await page.click('#menuBtn');
  await page.waitForFunction(() => {
    const dr = document.getElementById('drawer');
    if (!dr.classList.contains('open')) return false;
    // The slide-in is a CSS transition; don't measure until it has settled.
    const r = dr.getBoundingClientRect();
    return r.left >= 0 && r.right <= window.innerWidth + 1;
  }, null, { timeout: 5000 });
}

async function scenario(name, viewport, colorScheme, body, opts = {}) {
  let browser;
  try {
    browser = await chromium.launch({ executablePath: EXEC, args: ARGS });
    const page = await browser.newPage({
      viewport,
      colorScheme,
      hasTouch: !!opts.touch,
      isMobile: !!opts.touch
    });
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') {
        problems.push(`${name} console.${m.type()}: ${m.text()}`);
      }
    });
    page.on('pageerror', (e) => problems.push(`${name} pageerror: ${e.message}`));
    page.on('requestfailed', (r) =>
      problems.push(`${name} requestfailed: ${r.url()} ${r.failure()?.errorText}`)
    );
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForFunction(
      () => document.getElementById('board')?.children.length === 81,
      null,
      { timeout: 30000 }
    );
    await body(page);
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
    console.log(`  ✔ ${name}`);
  } catch (err) {
    problems.push(`${name} FAILED: ${String(err.message).split('\n')[0]}`);
    console.log(`  ✘ ${name}: ${String(err.message).split('\n')[0]}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

console.log('verifying', BASE);

await scenario('01-desktop', { width: 1280, height: 1000 }, 'dark', async (page) => {
  await page.waitForFunction(
    () => document.getElementById('puzzleMeta')?.children.length > 0,
    null,
    { timeout: 30000 }
  );
  const geom = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('#board .cell')];
    const r0 = cells[0].getBoundingClientRect();
    const r5 = cells[5].getBoundingClientRect();
    return {
      count: cells.length,
      cellW: Math.round(r0.width),
      cellH: Math.round(r0.height),
      givens: document.querySelectorAll('#board .cell.given').length,
      hScroll: document.documentElement.scrollWidth > window.innerWidth + 2,
      vScroll: document.documentElement.scrollHeight > window.innerHeight + 2,
      scrollH: document.documentElement.scrollHeight,
      winH: window.innerHeight,
      boardFits: document.getElementById('board').getBoundingClientRect().bottom < window.innerHeight
    };
  });
  results.desktop = geom;
  if (geom.count !== 81) problems.push(`expected 81 cells, got ${geom.count}`);
  if (Math.abs(geom.cellW - geom.cellH) > 2) problems.push(`cells not square: ${geom.cellW}x${geom.cellH}`);
  if (geom.hScroll) problems.push('page scrolls horizontally at 1280px');
  if (geom.vScroll) problems.push(`page scrolls vertically: ${geom.scrollH} > ${geom.winH}`);
  if (!geom.boardFits) problems.push('board bottom is below the fold');

  // Desktop keeps the 9-wide number row: the numpad change is touch-only.
  const pad = await page.evaluate(() => {
    const n = document.getElementById('numpad');
    return {
      cols: getComputedStyle(n).gridTemplateColumns.split(' ').length,
      coarse: matchMedia('(pointer: coarse)').matches,
      keybarShown: getComputedStyle(document.querySelector('.keybar')).display !== 'none'
    };
  });
  results.desktopPad = pad;
  if (pad.cols !== 9) problems.push(`desktop numpad should be 9 columns, got ${pad.cols}`);
  if (pad.coarse) problems.push('desktop unexpectedly reports a coarse pointer');
  if (!pad.keybarShown) problems.push('desktop shortcut strip went missing');
});

await scenario('02-interaction', { width: 1280, height: 1000 }, 'dark', async (page) => {
  const idx = await page.evaluate(() => {
    const c = [...document.querySelectorAll('#board .cell:not(.given)')][0];
    c.click();
    return Number(c.dataset.index);
  });
  await page.keyboard.press('5');
  await page.waitForTimeout(150);
  const typed = await page.evaluate(
    (i) => document.querySelectorAll('#board .cell')[i].textContent,
    idx
  );
  results.typedDigit = typed;
  if (typed !== '5') problems.push('typed digit did not render into the selected cell');

  await page.keyboard.press('n'); // notes mode
  const empty = await page.evaluate(() => {
    const c = [...document.querySelectorAll('#board .cell:not(.given)')].find((x) => x.textContent === '');
    if (!c) return null;
    c.click();
    return Number(c.dataset.index);
  });
  if (empty === null) throw new Error('no empty cell available for the notes check');
  await page.keyboard.press('7');
  await page.waitForTimeout(150);
  const notes = await page.evaluate(
    (i) => !!document.querySelectorAll('#board .cell')[i].querySelector('.notes'),
    empty
  );
  results.notesRendered = notes;
  if (!notes) problems.push('pencil marks did not render in notes mode');
  await page.keyboard.press('n');
});

await scenario('03-stats', { width: 1280, height: 1000 }, 'dark', async (page) => {
  await openMenu(page);
  await page.click('[data-tab="stats"]');
  await page.waitForTimeout(250);
  const s = await page.evaluate(() => ({
    visible: !document.getElementById('tab-stats').hidden,
    cards: document.getElementById('statGrid').children.length,
    tierRows: document.querySelectorAll('#tierTable tbody tr').length
  }));
  results.stats = s;
  if (!s.visible) problems.push('stats tab did not become visible');
  if (s.cards < 6) problems.push('stats grid looks empty');
  if (s.tierRows !== 5) problems.push(`expected 5 tier rows, got ${s.tierRows}`);
});

await scenario('04-drawer', { width: 1280, height: 1000 }, 'dark', async (page) => {
  await openMenu(page);
  const d = await page.evaluate(() => {
    const dr = document.getElementById('drawer');
    const r = dr.getBoundingClientRect();
    return {
      open: dr.classList.contains('open'),
      width: Math.round(r.width),
      onScreen: r.left >= 0 && r.right <= window.innerWidth + 1,
      generateVisible: !document.getElementById('tab-generate').hidden,
      backdropShown: document.getElementById('backdrop').classList.contains('show')
    };
  });
  results.drawer = d;
  if (!d.open || !d.onScreen) problems.push('drawer did not slide on screen');
  if (!d.generateVisible) problems.push('generate tab is not the default drawer pane');
  if (!d.backdropShown) problems.push('backdrop did not appear');
  await page.screenshot({ path: `${OUT}/04b-drawer-open.png`, fullPage: true });
  // Escape closes it, and the board is still the single pane behind it.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  results.drawerClosedByEsc = await page.evaluate(
    () => !document.getElementById('drawer').classList.contains('open')
  );
  if (!results.drawerClosedByEsc) problems.push('Escape did not close the drawer');
});

await scenario('05-mobile', { width: 390, height: 844 }, 'dark', async (page) => {
  const m = await page.evaluate(() => {
    const g = (sel) => {
      const b = document.querySelector(sel).getBoundingClientRect();
      return { h: +b.height.toFixed(1), t: +b.top.toFixed(1), b: +b.bottom.toFixed(1) };
    };
    const pad = document.getElementById('numpad');
    const btn = pad.querySelector('button');
    const stage = g('.stage');
    const controls = g('.controls');
    const de = document.documentElement;
    return {
      hScroll: de.scrollWidth > window.innerWidth + 2,
      vScroll: de.scrollHeight > window.innerHeight + 2,
      scrollW: de.scrollWidth,
      winW: window.innerWidth,
      scrollH: de.scrollHeight,
      winH: window.innerHeight,
      cell: Math.round(document.querySelector('#board .cell').getBoundingClientRect().width),
      coarse: matchMedia('(pointer: coarse)').matches,
      padCols: getComputedStyle(pad).gridTemplateColumns.split(' ').length,
      padBtnH: +btn.getBoundingClientRect().height.toFixed(1),
      padBtnW: +btn.getBoundingClientRect().width.toFixed(1),
      toolCols: getComputedStyle(document.querySelector('.tool-buttons')).gridTemplateColumns.split(' ').length,
      keybarHidden: getComputedStyle(document.querySelector('.keybar')).display === 'none',
      // The stage clips, so "fits" means nothing pokes past its box.
      clipTop: +(stage.t - g('#board').t).toFixed(1),
      clipBottom: +(controls.b - stage.b).toFixed(1)
    };
  });
  results.mobile = m;
  if (m.hScroll) problems.push(`mobile overflows horizontally: ${m.scrollW} > ${m.winW}`);
  if (m.vScroll) problems.push(`mobile overflows vertically: ${m.scrollH} > ${m.winH}`);
  if (!m.coarse) problems.push('mobile scenario is not emulating a coarse pointer');
  if (m.padCols !== 3) problems.push(`mobile numpad should be a 3x3 pad, got ${m.padCols} columns`);
  if (m.padBtnH < 40) problems.push(`pad button is only ${m.padBtnH}px tall - under the 40px thumb floor`);
  if (m.toolCols !== 4) problems.push(`tool buttons should be one row of 4, got ${m.toolCols}`);
  if (!m.keybarHidden) problems.push('shortcut strip is shown to a touch device');
  if (m.clipTop > 0) problems.push(`board is clipped ${m.clipTop}px at the top of the stage`);
  if (m.clipBottom > 0) problems.push(`controls are clipped ${m.clipBottom}px at the bottom of the stage`);

  // The pad must still place digits, not just look right.
  const idx = await page.evaluate(() => {
    const c = [...document.querySelectorAll('#board .cell:not(.given)')].find((x) => x.textContent === '');
    c.click();
    return Number(c.dataset.index);
  });
  await page.locator('#numpad button[data-digit="7"]').tap();
  await page.waitForTimeout(120);
  const placed = await page.evaluate(
    (i) => document.querySelectorAll('#board .cell')[i].textContent,
    idx
  );
  results.mobileTapPlaces = { idx, placed };
  if (placed !== '7') problems.push(`tapping pad digit 7 placed "${placed}"`);
}, { touch: true });

// Small phones: the footer wraps harder and the board is height-bound, so this
// is where a fixed pad budget would clip first.
await scenario('05b-small-phone', { width: 320, height: 568 }, 'dark', async (page) => {
  const m = await page.evaluate(() => {
    const g = (sel) => {
      const b = document.querySelector(sel).getBoundingClientRect();
      return { t: +b.top.toFixed(1), b: +b.bottom.toFixed(1), h: +b.height.toFixed(1) };
    };
    const stage = g('.stage');
    return {
      cell: +document.querySelector('#board .cell').getBoundingClientRect().width.toFixed(1),
      padBtnH: +document.querySelector('#numpad button').getBoundingClientRect().height.toFixed(1),
      foot: g('.foot').h,
      clipTop: +(stage.t - g('#board').t).toFixed(1),
      clipBottom: +(g('.controls').b - stage.b).toFixed(1)
    };
  });
  results.smallPhone = m;
  if (m.clipTop > 0) problems.push(`320x568: board clipped ${m.clipTop}px at the top`);
  if (m.clipBottom > 0) problems.push(`320x568: controls clipped ${m.clipBottom}px at the bottom`);
  if (m.padBtnH < 40) problems.push(`320x568: pad button ${m.padBtnH}px is under the 40px thumb floor`);
}, { touch: true });

// The menu on a phone is a full-screen sheet, not a side panel with the board
// still peeking out from behind it.
await scenario('05c-mobile-menu', { width: 390, height: 844 }, 'dark', async (page) => {
  await openMenu(page);
  const d = await page.evaluate(() => {
    const dr = document.getElementById('drawer');
    const r = dr.getBoundingClientRect();
    const close = document.getElementById('closeDrawerBtn').getBoundingClientRect();
    const body = document.querySelector('.drawer-body');
    return {
      w: Math.round(r.width),
      h: Math.round(r.height),
      left: Math.round(r.left),
      right: Math.round(r.right),
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      winW: window.innerWidth,
      winH: window.innerHeight,
      closeVisible: close.width > 0 && close.height > 0 && close.left >= 0 && close.right <= window.innerWidth && close.top >= 0,
      bodyScrollable: getComputedStyle(body).overflowY === 'auto',
      bodyFits: body.scrollHeight <= body.clientHeight || body.clientHeight > 0
    };
  });
  results.mobileMenu = d;
  if (d.w !== d.winW) problems.push(`menu should span the viewport: ${d.w} vs ${d.winW}`);
  if (d.h !== d.winH) problems.push(`menu should fill the viewport height: ${d.h} vs ${d.winH}`);
  if (d.left !== 0 || d.top !== 0) problems.push(`menu is offset: left=${d.left} top=${d.top}`);
  if (!d.closeVisible) problems.push('close button is off-screen');
  if (!d.bodyScrollable) problems.push('menu body cannot scroll');
  await page.screenshot({ path: `${OUT}/05c-mobile-menu.png` });

  // And a tab other than the default must render inside it.
  await page.click('[data-tab="library"]');
  await page.waitForTimeout(250);
  const lib = await page.evaluate(() => ({
    visible: !document.getElementById('tab-library').hidden,
    rows: document.getElementById('puzzleList').children.length
  }));
  results.mobileMenuLibrary = lib;
  if (!lib.visible) problems.push('library tab did not open inside the full-screen menu');
}, { touch: true });

await scenario('06-landscape', { width: 740, height: 380 }, 'dark', async (page) => {
  const m = await page.evaluate(() => ({
    vScroll: document.documentElement.scrollHeight > window.innerHeight + 2,
    scrollH: document.documentElement.scrollHeight,
    winH: window.innerHeight,
    boardBottom: Math.round(document.getElementById('board').getBoundingClientRect().bottom),
    padCols: getComputedStyle(document.getElementById('numpad')).gridTemplateColumns.split(' ').length
  }));
  results.landscape = m;
  if (m.vScroll) problems.push(`short landscape overflows: ${m.scrollH} > ${m.winH}`);
  // A landscape phone has no room for a 3-row pad next to the board, so it
  // keeps the wide row. If this ever flips to 3, the height budget broke.
  if (m.padCols !== 9) problems.push(`landscape touch should keep the 9-wide row, got ${m.padCols}`);
}, { touch: true });

await scenario('06-theme-mode', { width: 1280, height: 1000 }, 'light', async (page) => {
  // Themes fix their own light/dark mode. A dark theme must stay dark even when
  // the OS asks for light, and a light theme must go light regardless.
  const bgOf = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const azureBg = await bgOf();
  results.themeMode = { systemLight: { azureBg } };
  if (azureBg !== 'rgb(15, 17, 23)') {
    problems.push(`azure should stay dark under a light system, got ${azureBg}`);
  }

  await openMenu(page);
  await page.click('[data-tab="settings"]');
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/06-picker.png` });

  await page.click('.swatch[data-accent="amber"]');
  await page.waitForTimeout(250);
  const amberBg = await bgOf();
  results.themeMode.systemLight.amberBg = amberBg;
  if (amberBg === azureBg) problems.push('amber did not switch to a light palette');

  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/06-amber-light.png` });
});

await scenario('07-crimson-dark', { width: 1280, height: 1000 }, 'light', async (page) => {
  // Crimson under a *light* system: must still be fully dark, and the whole
  // surface ladder must be red-tinted, not just the accent.
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-accent', 'crimson');
  });
  await page.waitForTimeout(250);
  const pal = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const g = (v) => cs.getPropertyValue(v).trim();
    return { bg: g('--bg'), panel: g('--panel'), line: g('--line'), text: g('--text'), accent: g('--accent') };
  });
  results.crimsonPalette = pal;
  if (pal.bg === 'rgb(15, 17, 23)') problems.push('crimson did not recolour the ground');
  await page.screenshot({ path: `${OUT}/07-crimson-dark.png` });
});

// Text actually rasterises? (this host ships zero fonts by default)
await scenario('07-textcheck', { width: 1280, height: 1000 }, 'dark', async (page) => {
  const t = await page.evaluate(() => {
    const c = document.querySelector('#board .cell.given');
    const r = c.getBoundingClientRect();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.font = `${Math.round(r.height * 0.5)}px sans-serif`;
    const w = ctx.measureText(c.textContent).width;
    return { glyph: c.textContent, measuredWidth: Math.round(w) };
  });
  results.textCheck = t;
  if (!t.measuredWidth) {
    problems.push('text measures zero width — headless Chromium needs FONTCONFIG_PATH pointing at a real fonts.conf');
  }
});

await scenario('08-data', { width: 1280, height: 1000 }, 'dark', async (page) => {
  await openMenu(page);
  await page.click('[data-tab="settings"]');
  await page.waitForTimeout(250);
  const btns = await page.evaluate(() => {
    const pick = (sel) => {
      const n = document.querySelector(sel);
      if (!n) return null;
      const s = getComputedStyle(n);
      return {
        text: n.textContent.trim().slice(0, 14),
        border: s.borderTopWidth + ' ' + s.borderTopColor,
        radius: s.borderTopLeftRadius,
        pad: s.paddingTop,
        bg: s.backgroundColor
      };
    };
    return {
      download: pick('#exportBtn'),
      copy: pick('#copyExportBtn'),
      upload: pick('.file-btn')
    };
  });
  results.dataButtons = btns;
  const d = btns.download;
  const u = btns.upload;
  if (!u) problems.push('upload control missing');
  else {
    for (const prop of ['border', 'radius', 'pad']) {
      if (d[prop] !== u[prop]) {
        problems.push(`upload button differs on ${prop}: ${u[prop]} vs download ${d[prop]}`);
      }
    }
  }
  await page.screenshot({ path: `${OUT}/08-data-tab.png`, fullPage: true });
});

await scenario('10-themes', { width: 1280, height: 1000 }, 'dark', async (page) => {
  // Select a cell first so the accent-tinted selection background is measurable.
  // NB: data-row/data-col are within-box (0-2); board position is data-index.
  await page.click('.cell[data-index="40"]');
  await openMenu(page);
  await page.click('[data-tab="settings"]');
  await page.waitForTimeout(250);
  const themes = {};
  for (const name of ['azure', 'crimson', 'amber', 'teal']) {
    await page.click(`.swatch[data-accent="${name}"]`);
    await page.waitForTimeout(120);
    themes[name] = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      const sel = document.querySelector('.cell.selected');
      return {
        attr: document.documentElement.getAttribute('data-accent'),
        stored: localStorage.getItem('sudoku.ui.theme'),
        checked: [...document.querySelectorAll('.swatch')]
          .filter((s) => s.getAttribute('aria-checked') === 'true')
          .map((s) => s.dataset.accent),
        accent: cs.getPropertyValue('--accent').trim(),
        selectedBg: sel ? getComputedStyle(sel).backgroundColor : 'no selection'
      };
    });
    if (themes[name].attr !== name) problems.push(`${name}: data-accent is ${themes[name].attr}`);
    if (themes[name].stored !== name) problems.push(`${name}: not persisted`);
    if (themes[name].checked.length !== 1 || themes[name].checked[0] !== name) {
      problems.push(`${name}: swatch checked state is ${JSON.stringify(themes[name].checked)}`);
    }
    await page.screenshot({ path: `${OUT}/10-theme-${name}.png` });
  }
  results.themes = themes;
});

await scenario('11-mode-reset', { width: 1280, height: 1000 }, 'dark', async (page) => {
  page.on('dialog', (d) => d.accept());
  const opts = await page.$$eval('#modeSelect option', (os) => os.map((o) => o.value));
  if (opts.join(',') !== 'casual,strict') problems.push(`mode select wrong: ${opts}`);

  // Generate a real strict puzzle through the UI, then reload. This is the path
  // that was broken: addPuzzle's record whitelist dropped mode and attempts, so
  // nothing survived a reload.
  await openMenu(page);
  await page.selectOption('#modeSelect', 'strict');
  await page.selectOption('#difficultySelect', 'easy');
  await page.click('#generateBtn');
  await page.waitForFunction(
    () => sudokuApp.state.puzzle && sudokuApp.state.puzzle.mode === 'strict',
    { timeout: 40000 }
  );
  const generatedId = await page.evaluate(() => sudokuApp.state.puzzle.id);
  const persisted = await page.evaluate(
    (id) => {
      const rec = sudokuApp.store.getPuzzle(id);
      return { mode: rec.mode, attempts: rec.attempts };
    },
    generatedId
  );
  if (persisted.mode !== 'strict') {
    problems.push(`strict mode not persisted to the record: ${persisted.mode}`);
  }
  if (persisted.attempts !== 1) problems.push(`fresh puzzle attempts=${persisted.attempts}, expected 1`);

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const afterReload = await page.evaluate(
    (id) => {
      const rec = sudokuApp.store.getPuzzle(id);
      return {
        mode: rec.mode,
        undoDisabled: document.getElementById('undoBtn').disabled,
        footer: document.getElementById('puzzleMeta').textContent
      };
    },
    generatedId
  );
  if (afterReload.mode !== 'strict') problems.push('strict mode lost across reload');
  if (!afterReload.undoDisabled) problems.push('undo still enabled for a strict puzzle after reload');
  if (!/Strict/.test(afterReload.footer)) problems.push('footer does not show the mode after reload');

  // Conflicting placement must charge, and the U key must not revoke it.
  const placed = await page.evaluate(() => {
    const st = sudokuApp.state;
    const g = st.puzzle.grid;
    for (let i = 0; i < 81; i++) {
      if (g[i] !== '.') continue;
      for (let d = 1; d <= 9; d++) {
        if (sudokuApp.PEERS[i].some((j) => g[j] === String(d))) return { i, d };
      }
    }
    return null;
  });
  if (!placed) {
    problems.push('could not construct a conflicting placement to test strict mode');
  } else {
    await page.click(`.cell[data-index="${placed.i}"]`);
    await page.click(`#numpad [data-digit="${placed.d}"]`);
    await page.waitForTimeout(200);
    const afterPlace = await page.evaluate(() => sudokuApp.state.mistakes);
    if (afterPlace !== 1) problems.push(`conflicting placement charged ${afterPlace}, expected 1`);
    await page.keyboard.press('u');
    await page.waitForTimeout(200);
    const afterUndo = await page.evaluate(() => sudokuApp.state.mistakes);
    if (afterUndo !== 1) problems.push(`U key changed the mistake count in strict mode: ${afterUndo}`);
  }

  // Reset: board cleared, attempt bumped, and the bump survives a reload.
  await openMenu(page);
  await page.click('#resetBtn');
  await page.waitForTimeout(500);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const afterReset = await page.evaluate(
    (id) => {
      const rec = sudokuApp.store.getPuzzle(id);
      return {
        attempts: rec.attempts,
        mistakes: rec.progress.mistakes,
        filled: [...sudokuApp.state.values].filter(
          (v, i) => v !== 0 && sudokuApp.state.puzzle.grid[i] === '.'
        ).length,
        footer: document.getElementById('puzzleMeta').textContent
      };
    },
    generatedId
  );
  results.modeReset = { persisted, afterReload, placed, afterReset };
  if (afterReset.attempts !== 2) problems.push(`attempts after reset+reload = ${afterReset.attempts}, expected 2`);
  if (afterReset.mistakes !== 0) problems.push('reset did not clear the persisted mistake count');
  if (afterReset.filled !== 0) problems.push('reset left user digits on the board');
  if (!/Attempt/.test(afterReset.footer)) problems.push('footer does not show the attempt counter');

  // Stats split: switching the mode filter must change which records are counted.
  await openMenu(page);
  await page.click('[data-tab="stats"]');
  await page.waitForTimeout(250);
  const readStat = () =>
    page.evaluate(() => document.getElementById('statGrid').textContent.replace(/\s+/g, ' '));
  const allStats = await readStat();
  await page.click('#statsModeFilter [data-mode="strict"]');
  await page.waitForTimeout(250);
  const strictStats = await readStat();
  const strictNote = await page.evaluate(() => document.getElementById('statsModeNote').textContent);
  results.statsSplit = { allLen: allStats.length, strictLen: strictStats.length, strictNote };
  if (!/^1 puzzle\(s\) in this mode/.test(strictNote)) problems.push(`strict filter note wrong: ${strictNote}`);
  if (allStats === strictStats) problems.push('strict filter did not change the rendered stats');
  await page.screenshot({ path: `${OUT}/11-stats-strict.png` });
});

await browserlessSummary();

async function browserlessSummary() {
  console.log('\n=== results ===');
  console.log(JSON.stringify(results, null, 2));
  console.log('\n=== problems ===');
  if (!problems.length) console.log('none');
  else problems.forEach((p) => console.log(' -', p));
  fs.writeFileSync(`${OUT}/report.json`, JSON.stringify({ results, problems }, null, 2));
}

process.exit(problems.length ? 1 : 0);
