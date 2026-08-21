# Landing page rebuild — 2026-08-17

Four rejected passes ("trash", "terrible and basic", "layout is still shit") ended with a
direction change rather than another revision: **build it like usesprout.com**. The chalkboard
conceit is gone from `/`. The app and dashboard are untouched.

## What the reference actually is

Measured off usesprout.com with Playwright rather than guessed at:

- Nunito Sans throughout. H1 64/72 w600 ls -2px, H2 44/48 w600 ls -1.5px, body 16px `#535862`.
- Sections alternate `#FFFFFF` and `#FAFAFA`, 80px block padding.
- Mint `#EAF7F5` carries the eyebrow pills, the final CTA band, and the footer.
- Radii 8/12/16/100px.
- The signature move is a **two-tone headline**: dark first clause, grey second clause, one
  heading. Every section here uses it.

Brand stayed `#0F4C3D` — it reads as a deep green in Sprout's structure and as a chalkboard
green in Chalk's identity, so nothing had to be given up.

## Structure

| Sprout pattern | Chalk content |
| --- | --- |
| 2-up bento | the two front doors (dashboard / SDK) |
| full-width figure + 3-up icon grid | Space vs Episode |
| 3 tinted stat cards | the latency budgets |
| 2-col split | the portable stack |
| grouped chip grid | the 28-item shipped inventory |
| mint band + footer | the close |

Files: `Hero`, `FrontDoors`, `SpaceModel`, `Performance`, `SelfHost`, `Platform`, `Closing`,
`Nav`, `visuals`, plus `Icon`. `Chalked.tsx`, `marks.tsx`, and `styles/board.css` deleted.

## Decisions worth keeping

- **Scoped the whole system under `.site`.** A `comm -12` on the class names of `landing.css`
  and `dashboard.css` found exactly one collision — `.eyebrow` — and `styles.css` imports
  landing before dashboard, so the app's mono label was winning on the marketing page. Only
  that one rule needed the prefix.
- **`Icon.tsx` exists because Hugeicons emits no `aria-hidden`.** Confirmed by reading the
  compiled `HugeiconsIcon.js`: it spreads `...rest` onto the `<svg>` and adds no ARIA. Without
  the wrapper a screen reader walks a page of unlabelled graphics. One abstraction, ~15 callers.
- **`minmax(0, 1fr)`, never bare `1fr`.** A bare `1fr` keeps its `auto` min-content minimum, and
  the Space URL and the `import` line are both unwrappable — either one pushes the grid past
  the viewport.
- **Subgrid across the bento pair** so labels, sentences, and artifacts line up. This is also
  why `align-items: start` had to go: with it the cards shrink-wrapped inside their shared rows
  and stopped ~5px apart, which reads as a bug.
- **`display: inline` on an `h3` + `p` pair** so a bold sentence and a grey continuation read as
  one paragraph without giving up the heading.

## Defects the screenshots caught

Everything below looked fine in the markup and wrong on screen. Slicing the 15,592px capture
into five JPEGs and reading them was the only thing that found any of it.

1. **Timeline bars read as empty text inputs** — hairline border, no fill, four in a row. Filled
   them instead (`#e4e7ea`, brand for live).
2. **The stack diagram's card was invisible** — `.sd` was `--site-paper-2` sitting on a
   `.band-tint` of the same `#fafafa`. Swapped the levels: card white, rungs off-white.
3. **The latency headline broke mid-clause.** `text-wrap: balance` split "Every step on the way /
   in has a number to beat." Restoring the longer second clause ("…it has to beat.") made the
   halves 24 vs 28 and balance found the clause boundary on its own. Copy tuned for the wrap,
   not the wrap for the copy.
4. **Closing band and footer fused** into one tall mint block. Hairline rule between them.
5. **The mobile nav had no way in.** Sign in and Create an account are hidden below 900px and
   the drawer never carried them, so the phone nav offered navigation and nothing else. Added
   both to the drawer.

## State

- Landing: 11 files / 32 tests. Full web suite: 84 files / 421 tests. All green.
- `check-types` clean except `src/lib/chalk-access.test.ts(81,11)`, which belongs to another
  agent's in-flight work — left alone.
- No horizontal overflow at 320/375/390/430/600/768/1024/1280/1440/1920. The 320 hits inside
  `.door-code` are its own `overflow-x: auto`; document `scrollWidth` matches the viewport at
  every width.
- Nothing committed.
