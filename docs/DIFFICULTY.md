# How difficulty actually works

Extracted from the README. This is the engine's contract; the README only states
the summary.

> **What the guarantee does and does not cover.** A board *accepted* for tier T is
> solvable with T's ladder and not with the tier below it — that part is enforced.
> But the upper tiers are **searched for**, not synthesised: a share of boards
> fall back to whatever the generator actually reached, and the labels are a
> solver-side measure of the *cheapest logical path*, not of how hard a human
> finds the puzzle. Whether the tiers match actual play is unverified and tracked
> in [issue #1](https://github.com/Syakyr/sudoku/issues/1).

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

---

## What the generator can and cannot hit (measured, not assumed)

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
