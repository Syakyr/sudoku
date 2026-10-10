#!/usr/bin/env node
/*
 * Assemble the app bundle in dist/ for packaging.
 *
 * The repo root IS the web app, which is convenient for GitHub Pages but wrong
 * for a packaged target: pointing a bundler's webDir at "." would drag in
 * node_modules, tests, tools, scratch, the native project and the website-only
 * files (robots.txt, sitemap.xml, og-image.png). So the bundle is an explicit
 * allowlist, and this script is the single place that knows what "the app" is.
 *
 * Deliberately NOT included:
 *   sw.js  -- the service worker is the PWA's rolling-update mechanism. The
 *             packaged app's assets are already local, so a worker would only
 *             add a cache layer over files that cannot change under it. The
 *             registration is guarded off on native too (see js/app.js); this
 *             is the belt to that braces.
 *
 * Usage: node tools/build-dist.mjs [outDir]   (default: dist)
 */

import { cp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(process.argv[2] || join(ROOT, 'dist'));

/** Everything the app needs at runtime, relative to the repo root. */
const BUNDLE = [
  'index.html',
  'manifest.webmanifest',
  'js',
  'css',
  'icons',
];

/**
 * Files the bundle must never contain. Checked after the copy so a mistake in
 * BUNDLE (or a stray file appearing inside one of its directories) fails the
 * build instead of shipping.
 */
const FORBIDDEN = [
  'node_modules',
  'tests',
  'tools',
  'scratch',
  'android',
  'sw.js',
  '.git',
];

async function* walk(dir) {
  const { readdir } = await import('node:fs/promises');
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const missing = BUNDLE.filter((p) => !existsSync(join(ROOT, p)));
  if (missing.length) {
    throw new Error(`Bundle source(s) missing from repo root: ${missing.join(', ')}`);
  }

  for (const item of BUNDLE) {
    await cp(join(ROOT, item), join(OUT, item), { recursive: true });
  }

  const violations = [];
  for await (const file of walk(OUT)) {
    const rel = file.slice(OUT.length + 1);
    if (FORBIDDEN.some((bad) => rel === bad || rel.startsWith(`${bad}/`))) {
      violations.push(rel);
    }
  }
  if (violations.length) {
    throw new Error(
      `Bundle contains forbidden paths (would ship dead weight or secrets):\n  ` +
        violations.join('\n  '),
    );
  }

  let bytes = 0;
  const { stat } = await import('node:fs/promises');
  const listed = [];
  for await (const file of walk(OUT)) {
    const { size } = await stat(file);
    bytes += size;
    listed.push(`${String(size).padStart(8)}  ${file.slice(OUT.length + 1)}`);
  }
  listed.sort();
  console.log(listed.join('\n'));
  console.log(`\n${listed.length} files, ${bytes} bytes (${(bytes / 1024).toFixed(1)} KiB) -> ${OUT}`);

  // Record what went in, so a packaged APK can be traced back to a bundle
  // without diffing the whole repo.
  await writeFile(
    join(OUT, 'BUNDLE-MANIFEST.json'),
    JSON.stringify(
      {
        generatedBy: 'tools/build-dist.mjs',
        sources: BUNDLE,
        excluded: FORBIDDEN,
        files: listed.length,
        bytes,
      },
      null,
      2,
    ) + '\n',
  );
}

await main();
