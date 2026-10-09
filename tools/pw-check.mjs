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

async function scenario(name, viewport, colorScheme, body) {
  let browser;
  try {
    browser = await chromium.launch({ executablePath: EXEC, args: ARGS });
    const page = await browser.newPage({ viewport, colorScheme });
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
  const m = await page.evaluate(() => ({
    hScroll: document.documentElement.scrollWidth > window.innerWidth + 2,
    vScroll: document.documentElement.scrollHeight > window.innerHeight + 2,
    scrollW: document.documentElement.scrollWidth,
    winW: window.innerWidth,
    scrollH: document.documentElement.scrollHeight,
    winH: window.innerHeight,
    cell: Math.round(document.querySelector('#board .cell').getBoundingClientRect().width)
  }));
  results.mobile = m;
  if (m.hScroll) problems.push(`mobile overflows horizontally: ${m.scrollW} > ${m.winW}`);
  if (m.vScroll) problems.push(`mobile overflows vertically: ${m.scrollH} > ${m.winH}`);
});

await scenario('06-landscape', { width: 740, height: 380 }, 'dark', async (page) => {
  const m = await page.evaluate(() => ({
    vScroll: document.documentElement.scrollHeight > window.innerHeight + 2,
    scrollH: document.documentElement.scrollHeight,
    winH: window.innerHeight,
    boardBottom: Math.round(document.getElementById('board').getBoundingClientRect().bottom)
  }));
  results.landscape = m;
  if (m.vScroll) problems.push(`short landscape overflows: ${m.scrollH} > ${m.winH}`);
});

await scenario('06-light', { width: 1280, height: 1000 }, 'light', async (page) => {
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  results.lightBg = bg;
  if (bg === 'rgb(15, 17, 23)') problems.push('light scheme still rendering the dark palette');
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
