/**
 * Regenerate og-image.png (1200x630) for link previews.
 *
 * The card is rendered from the app's own palette so the preview matches the
 * site rather than being a random graphic. Re-run this after changing the
 * title or the feature list in index.html.
 *
 * Run (fonts are mandatory here -- without FONTCONFIG_PATH the text renders
 * with zero metrics and the card comes out blank):
 *
 *   LD_LIBRARY_PATH=/home/linuxbrew/.linuxbrew/lib \
 *   FONTCONFIG_PATH=/home/linuxbrew/.linuxbrew/etc/fonts \
 *   node tools/make-og-image.mjs [outPath]
 */
import pw from '/home/coder/Codebase/browser-unlocker/node_modules/playwright/index.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = pw; // CJS: no named exports under Node 26

const OUT =
  process.argv[2] ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'og-image.png');

const EXEC =
  process.env.PW_CHROMIUM ||
  `${process.env.HOME}/.cache/ms-playwright/chromium-1244/chrome-linux64/chrome`;

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  :root {
    --bg: #0f1117; --panel: #171a23; --panel-2: #1e2230;
    --line: #2a2f3f; --line-strong: #4a5268;
    --text: #e6e9f2; --muted: #9aa3b8;
    --accent: #4f8cff; --user: #7fb3ff; --good: #3ecf8e;
  }
  * { box-sizing: border-box; margin: 0; }
  body {
    width: 1200px; height: 630px; overflow: hidden;
    background: radial-gradient(120% 140% at 88% 8%, #1a2340 0%, var(--bg) 58%);
    color: var(--text);
    font-family: "DejaVu Sans", system-ui, sans-serif;
    display: flex; align-items: center; gap: 64px;
    padding: 0 64px;
  }
  .copy { flex: 1 1 auto; min-width: 0; }
  h1 { font-size: 76px; line-height: 1.02; letter-spacing: -1px; }
  h1 .thin { display: block; font-size: 34px; font-weight: 400; color: var(--accent);
             letter-spacing: 0; margin-top: 10px; }
  p.lede { margin-top: 22px; font-size: 25px; line-height: 1.42; color: var(--muted);
           max-width: 560px; }
  ul { list-style: none; margin-top: 26px; display: flex; flex-wrap: wrap; gap: 10px; }
  li {
    font-size: 18px; padding: 7px 14px; border-radius: 999px;
    background: var(--panel-2); border: 1px solid var(--line); color: var(--text);
  }
  li.key { border-color: var(--accent); color: var(--user); }
  .grid {
    flex: 0 0 auto; width: 400px; height: 400px;
    display: grid; grid-template-columns: repeat(9, 1fr); grid-template-rows: repeat(9, 1fr);
    border: 3px solid var(--line-strong); border-radius: 10px; overflow: hidden;
    box-shadow: 0 24px 60px rgba(0,0,0,.5);
    background: var(--panel);
  }
  .c { display: flex; align-items: center; justify-content: center;
       font-size: 27px; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); }
  .c:nth-child(9n) { border-right: none; }
  .c:nth-child(n+73) { border-bottom: none; }
  .c[data-c="2"], .c[data-c="5"] { border-right: 3px solid var(--line-strong); }
  .c[data-r="2"], .c[data-r="5"] { border-bottom: 3px solid var(--line-strong); }
  .c.g { color: var(--text); font-weight: 700; }
  .c.u { color: var(--user); }
  .c.h { background: rgba(79,140,255,.16); color: var(--good); font-weight: 700; }
  .foot { position: absolute; left: 64px; bottom: 34px; font-size: 17px; color: var(--muted); }
  .foot code { color: var(--user); }
</style>
</head>
<body>
  <div class="copy">
    <h1>Sudoku<span class="thin">seeded generator &amp; puzzle library</span></h1>
    <p class="lede">Puzzles generated to a difficulty contract rather than a vibe,
       with every solution checked for uniqueness.</p>
    <ul>
      <li class="key">Seeded &amp; deterministic</li>
      <li class="key">Unique solutions, verified</li>
      <li>5 tiers graded by technique</li>
      <li>Explained hints</li>
      <li>Plays offline</li>
      <li>No backend, no build step</li>
    </ul>
  </div>
  <div class="grid" id="g"></div>
  <div class="foot"><code>syakyr.github.io/sudoku</code> · open source</div>
<script>
  // A valid solved grid, with some cells shown as givens, some as user input,
  // and one highlighted as the hinted cell.
  const SOLVED =
    '534678912672195348198342567859761423426853791713924856961537284287419635345286179';
  const GIVENS = new Set([0,2,5,10,14,20,26,33,36,44,52,54,62,63,69,75,78,80]);
  const HINT = 40;
  const g = document.getElementById('g');
  for (let i = 0; i < 81; i++) {
    const d = document.createElement('div');
    d.className = 'c' + (i === HINT ? ' h' : GIVENS.has(i) ? ' g' : i % 3 === 1 ? ' u' : '');
    d.dataset.r = String(Math.floor(i / 9) % 3);
    d.dataset.c = String(i % 9 % 3);
    d.textContent = i === HINT ? SOLVED[i] : (GIVENS.has(i) || i % 3 === 1 ? SOLVED[i] : '');
    g.appendChild(d);
  }
</script>
</body>
</html>`;

const browser = await chromium.launch({
  executablePath: EXEC,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-crash-reporter', '--no-zygote']
});
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.setContent(HTML, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelectorAll('.c').length === 81, null, { timeout: 15000 });
  await page.screenshot({ path: OUT, type: 'png' });
  console.log('wrote', OUT);
} finally {
  await browser.close();
}
