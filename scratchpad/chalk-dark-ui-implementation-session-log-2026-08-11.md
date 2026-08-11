# Chalk dark UI implementation — 2026-08-11

## Visual contract locked

- The six approved image-generation mockups are the implementation reference: landing, Overview, Spaces, Space details, Episodes, and Episode Debugger.
- The shared product language is dark graphite, Chalk blue, quiet one-pixel borders, compact tables, direct headings, and one uninterrupted navigation list.
- Eyebrow or kicker labels, active-item bars, decorative sidebar dividers, raw configuration dumps, and non-product dashboard metrics are out.
- Existing API, authentication, Space join, Episode history, dialog, and diagnostic behavior remains the contract underneath the visual rebuild.

## Core surfaces integrated

- Landing, Overview, Spaces, Space details, Episodes, and Episode Debugger now follow the approved mockups.
- Shared dark tokens also cover authentication, Tenant onboarding, loading and error states, settings, API keys, native dialogs, and preview surfaces.
- Integration review removed the active-navigation accent bars, decorative gradients, and remaining fallback eyebrows that survived the first implementation pass.
- Spaces use a full-row details target with a separate Join Space action. Episodes keep an accessible details button and add full-row pointer selection without changing table semantics.
- The debugger uses the same product navigation as the Dashboard and marks Developer active; diagnostic data, filters, export, live evidence, and accessibility behavior remain intact.

## Browser proof

- Verified the landing, Overview, Spaces, Space details, and Episodes against the running local fixture at 1440×1000, plus the landing and Overview at 390×844.
- Every checked route matched its viewport width and exposed zero eyebrow elements. The mobile sidebar remained fully off-canvas until opened.
- The browser pass caught and fixed three legacy leaks: a white Episode table header, a 560px Episode detail width that caused horizontal overflow, and white summary/sidebar dividers.
- Fresh screenshots live outside the public tree in `.private/chalk-ui-implementation-2026-08-12/`.

## Verification

- `pnpm --dir apps/web run check-types` passed.
- Seven focused integration files passed with 33 tests, covering the dark foundation, shell, Overview, Episodes, API keys, and debugger responsive contracts.
