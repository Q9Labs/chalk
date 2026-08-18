# Landing illustration pass — 2026-08-17

## Orientation and audit

Hasan asked for a site-wide visual lift in `apps/web`: replace the reliance on
coded diagrams with a coherent set of generated illustrations, include the CTA
and footer, and simplify the bloated “Everything here already works.” section.

The desktop and mobile audit found that the shipped-capabilities section is the
main rhythm break: 28 equal-weight pills make it 1,282px tall on desktop and
2,202px on mobile. The rest of the page has useful coded product proof, but only
the hero has a substantial raster image.

Hasan is not content with the legacy marketing assets. They are history and a
negative reference only. None will be reused or matched.

## Visual direction

The first direction used editorial paper-clay miniature worlds. Hasan rejected
it because the soft, literal scenes and faceless figures felt like generic
friendly SaaS. None of that set was integrated, and its workspace copies were
removed while the generated originals stayed recoverable under Codex storage.

The replacement direction is **abstract systems, sharp and alive**: high
contrast, strong crops, spatial depth, signal paths, and tension. It excludes
people, rooms, clay figures, beige softness, and literal product diagrams.

Hasan approved an editorial ribbon styleframe on a warm-white ground. Its
layered green, mint, blue, yellow, and coral planes became the shared grammar
for the final seven-image set.

## Integration and browser proof

The final art now carries the hero, both product entry points, the Space model,
self-hosting, shipped capabilities, the closing CTA, and a quiet footer echo.
The live product link card, SDK sample, Episode timeline, and performance
numbers remain real HTML so proof stays crisp and selectable.

The capabilities section is now four clear system groups instead of 28
equal-weight pills. At 390px it fell from 2,202px to about 1,598px. The full
page has no horizontal overflow, all generated images load at desktop and
mobile widths, and the browser console is clean.

Final local visual proof:

- `scratchpad/screenshots/landing-illustrations-desktop-final-20260818.png`
- `scratchpad/screenshots/landing-illustrations-mobile-20260818.png`

## Verification

The focused landing suite passes 23 tests. The remote web run passes all 420
tests with coverage and completes the production build and prerender. A clean
desktop and 390px mobile dogfood pass covered form errors, navigation, every
section, CTA routes, footer links, loading, and overflow.

The repository gate reaches its affected-workspace type check, then stops on an
existing `AccessGrantSource` assignment in `apps/web/src/lib/chalk-access.test.ts`.
That file is outside this change and the same error reproduces without the
landing diff, so it was left for its current owner.
