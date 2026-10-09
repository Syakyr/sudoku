# Sudoku — seeded generator, uniqueness-checked, local-first

A single-page Sudoku that generates puzzles **to a difficulty contract rather than
a vibe**, refuses to hand you a puzzle you have already played (even in a rotated,
relabelled disguise), and keeps the whole library in your browser with
import/export so it can move between devices.

No build step, no framework, no backend. Static files: `index.html`, `css/`, `js/`.

---

## Features

**Playing**
- 9×9 board with pencil marks, undo, erase, mistake tracking, pause-able timer
- Keyboard: `1-9` place · `0`/`Backspace` erase · `N` notes · `U` undo · `H` hint ·
  `P` pause · arrows move
- Hints are *explained*: the solver names the technique it used and which cells
  the elimination touches, rather than just dumping a digit
- Auto-solve detection, auto-save on every change, resume where you left off

**Generating**
- Five tiers: Easy / Medium / Hard / Expert / Extreme
- Optional 180° rotational clue symmetry (the newspaper look)
- Every removal is checked for a unique solution, so no puzzle here has two answers
- Seeded: the same seed + tier + symmetry always yields the identical board
- Duplicate rejection against your entire library under the full symmetry group

**Library**
- In progress / Completed / Abandoned, with per-puzzle rating, times, mistakes
- Abandoning keeps the puzzle (and your stats about it) instead of deleting it
- Share token per puzzle: `sdk-7K3P9QX2-hS-3`
- Whole-library JSON export/import (merge or replace)

**Metrics** — completion rate, win streak, day streak, per-tier average/best
time, accuracy, hint rate, notes usage, pace per empty cell, recent-vs-prior
trend, fastest solve, "what your puzzles actually needed" technique exposure,
and a next-tier suggestion.

---

## How difficulty actually works

Difficulty is measured the way Sudoku Explainer measures it: **the hardest named
technique the cheapest logical solve path requires** — not the clue count. A
puzzle's rating is its single worst step, not a sum of steps.

The solver applies techniques cheapest-first and always takes the cheapest
available step:

| Level | Technique |
|---|---|
| 1.0 | Naked Single |
| 1.5 | Hidden Single |
| 2.0 | Pointing (locked candidates) |
| 2.2 | Claiming (box/line reduction) |
| 2.6 | Naked Pair |
| 3.0 | Naked Triple |
| 3.2 | Hidden Pair |
| 3.4 | X-Wing |
| 3.6 | Hidden Triple |
| 3.8 | Swordfish |
| 4.2 | XY-Wing |
| 4.4 | XYZ-Wing |
| 4.6 | BUG+1 |
| 4.8 | Simple Colouring |
| 5.0 | Jellyfish |
| 7.0+ | Guessing / forcing chain (logic stalled) |

> These numbers are **our** ladder, ordered consistently with the published
> technique ordering. We do not claim exact Sudoku Explainer parity — SE's own
> table is not published in a form we can verify offline, so inventing agreement
> would be worse than saying "ours".

**The tier contract.** A board is accepted for tier T only if it is solvable with
T's ladder **and provably not solvable with the tier below it**. That is what
makes "Hard" mean something: two boards one clue apart can be entirely different
puzzles, and a board that quietly collapses to singles never gets labelled Hard.

### What the generator can and cannot hit (measured, not assumed)

Construction is the standard *fill then dig*: generate a complete random grid,
then pull clues out in random order, keeping only removals that leave exactly one
solution.

Random digging turns out to be **overwhelmingly singles-dominated**. Measured over
40 randomly dug grids, the hardest level the dig ever reached was:

| Hardest level reached | Grids (of 40) |
|---|---|
| 1.0 (naked singles) | 40 (all pass through it) |
| 1.5 (hidden singles) | 31 |
| 2.0 | 3 |
| 2.6 | 1 |
| 3.0 | 1 |
| 4.2 / 4.4 / 4.8 | 1 each |
| logic failure (99) | 5 |

So the upper tiers are reached by **searching for grids whose dig trajectory
passes through the band**, not by pretending one dig can steer there. The dig
stops when the target level is reached and *reverts* any removal that overshoots
the ceiling. End-to-end, over 10 seeds per tier with a 4s budget:

| Tier | Symmetric | Asymmetric |
|---|---|---|
| Easy | 10/10 · ~2 ms | 10/10 · ~2 ms |
| Medium | 10/10 · ~34 ms | 10/10 · ~19 ms |
| Hard | 8/10 · ~126 ms | 9/10 · ~337 ms |
| Expert | 10/10 · ~19 ms | 10/10 · ~47 ms |
| Extreme | 10/10 · ~35 ms | 10/10 · ~21 ms |

When a tier cannot be reached inside the budget the app **says so** and shows what
the board actually rated, with a `fallback` badge in the library. It never
silently mislabels a Medium board as Hard.

---

## Uniqueness: "unique against everything I've already generated"

There are 6,670,903,752,021,072,936,960 ≈ 6.67×10²¹ completed grids, but only
**5,472,730,538** essentially different ones, because each equivalence class has

```
3,359,232 (geometric symmetries) × 362,880 (digit relabelings) = 1,218,998,177,280
```

representations. The geometric group is 1296 structure-preserving row orders
(6 band orders × 6³ within-band row orders) × 1296 column orders × 2 (transpose).

The registry stores a canonical representative of each puzzle's equivalence class
and refuses to hand you a second puzzle from a class you already have. Two modes:

- **`standard`** (288 transforms) — the symmetries a player names out loud:
  rotations, reflections, band/stack swaps, digit relabel. ~1 ms.
- **`full`** (3,359,232 transforms, the entire geometric group, including
  permuting rows inside a band and columns inside a stack) — **this is the
  default**. ~100–145 ms per puzzle, made affordable by a lexicographic early
  abort: a candidate is abandoned the moment one character exceeds the incumbent,
  which on a sparse board happens after a handful of cells.

The registry stores a 64-bit hash of the canonical string. For a few thousand
puzzles the collision chance is ~10⁻¹²; the full canonical string is still
computable via `canonicalString()` when debugging.

Verified in tests: `standard` canonical is invariant across all 288 board
transforms × digit relabelings; `full` additionally equates within-band row
swaps that `standard` deliberately misses, and survives random deep transforms.

---

## Seeds and sharing

A puzzle is identified by **(seed, tier, symmetry, attempt)**. The attempt index is
part of the identity on purpose: generation is a search, so pinning where the
search stopped is what makes a shared seed resolve to *the same board* rather
than "some board of the same tier".

```
sdk-<seed>-<tier letter><S|A>-<attempt>
sdk-7K3P9QX2-hS-3   → seed 7K3P9QX2, hard, symmetric, attempt 3
```

Paste it into **Import a shared puzzle** and you get a bit-identical board. All
randomness in the generation path comes from a seeded sfc32 PRNG — no
`Math.random()`, no clock — so it is reproducible across browsers and machines.
(Seed alphabet is Crockford-style: no `I`, `L`, `O`, `U`.)

## Moving between devices

**Data → Download JSON** writes the whole library (puzzles, progress, ratings,
canonical keys, counters). **Upload JSON** merges it into another device, or
replaces the library entirely. Imports are symmetry-checked, so merging two
devices that independently generated the same puzzle does not poison the
uniqueness registry — and a completed copy wins over an unfinished one.

Storage is one versioned document under `sudoku.library.v1` with a migration
path. If `localStorage` is unavailable or throws (private mode, quota), the app
degrades to an in-memory store and says so in the header instead of crashing.

---

## Layout

```
index.html            single page
css/style.css         theme, responsive board
js/prng.js          seeded sfc32 PRNG + readable seed encoding
js/board.js         grid model, peer/unit tables, candidate bitmasks
js/solver.js        technique ladder, rating, solution counting (uniqueness)
js/generator.js     fill + dig, tier contract, share tokens
js/canon.js         symmetry canonicalisation (standard / full) + hashing
js/store.js         localStorage library, schema + migration, import/export
js/metrics.js       all statistics, pure functions over records
js/app.js           UI controller
tests/              node --test suite (62 tests)
```

The engine and store are browser-agnostic and tested in node; only `app.js`
touches the DOM.

## Development

```bash
npm install     # jsdom, dev-only (the shipped app has zero dependencies)
npm test        # node --test tests/
npm run serve   # python3 -m http.server 8080  → http://localhost:8080
```

ES modules need `http://`, not `file://` — use `npm run serve` locally.

## Deploying to GitHub Pages

`.github/workflows/ci.yml` runs the test suite on every push and PR, and on
pushes to `main` publishes the repo root as a Pages site (no build step — the
artifact is just the static files). Enable **Settings → Pages → Source: GitHub
Actions** once, then push.

---

## Honest limitations

- **Hard/expert tiers are searched, not guaranteed.** Roughly 1 seed in 10 misses
  Hard on the first pass; the generator burns attempts until it lands in band or
  the time budget expires, then tells you what it actually got.
- **The rating ladder has a floor of "logic failed".** Past simple colouring and
  jellyfish we detect *that* the ladder stalled, not *which* exotic chain a human
  would need. Extreme-tier ratings are `7.0 + f(search work)`, a coarse proxy.
- **Hints use the cheapest step, not the best hint.** On a board with several
  available moves the hint may not be the one you were stuck on.
- **`full` canonicalisation costs ~100–145 ms per puzzle.** Fine on desktop; on a
  slow phone it is a visible pause. `canonMode: 'standard'` is available if that
  ever matters.
- **Storage is per-browser and unencrypted.** Anyone with the export file has your
  whole library. That is the design, not an oversight — but do not commit one.
