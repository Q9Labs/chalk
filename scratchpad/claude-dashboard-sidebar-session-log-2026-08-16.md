# Dashboard sidebar redesign — session log 2026-08-16

## Goal

Replace the hand-rolled `.dashboard-sidebar` in the Chalk web dashboard with a shadcn-style sidebar,
tuned to Chalk. Directions chosen by Hasan: chalkboard-dark ink panel on the paper canvas, full
behaviour (icon rail with tooltips, ⌘B/Ctrl+B, cookie persistence, real mobile drawer), and Hugeicons
for the sidebar only.

## What shipped

**`packages/ui` primitives.** `src/sidebar.tsx` is the shadcn sidebar rebuilt on Base UI 1.3.0:
`Drawer` for the mobile sheet, `useRender` in place of Radix `Slot`, our own `Tooltip` for the
collapsed rail. State lives in `SidebarProvider`, persists to the `chalk_sidebar_state` cookie for
7 days, and toggles on ⌘B/Ctrl+B. `src/menu.tsx` wraps Base UI `Menu` with a `tone: default |
sidebar` variant so popups can sit on the dark panel. Both are exported from the barrel and added as
tsup entries with their own `./sidebar` and `./menu` subpath exports.

`src/lib/use-is-mobile.ts` now checks `typeof window.matchMedia === "function"` and falls back to the
desktop layout, because jsdom has no `matchMedia` and the raw call threw inside `SidebarProvider`.

**`apps/web` composition.** `DashboardSidebar.tsx` holds the Chalk-specific arrangement: brand row
with trigger, tenant switcher, a primary "New Space" button, a "Workspace" group (Overview, Spaces,
Episodes), a "Tools" group (Developer), and a footer with tenant settings plus the account menu.
Navigation buttons render as TanStack `Link` through `render=`, carry `aria-current="page"`, and close
the mobile drawer on click. Icons come from `@hugeicons/react` with per-icon default imports.

`DashboardShell.tsx` shrank to a layout: `SidebarProvider` → skip link → `DashboardSidebar` →
`SidebarInset`. The old `<aside>`, `DashboardLink`, backdrop, and the `mobileNavOpen` /
`tenantMenuOpen` state are gone. A `DashboardMobileHeader` mounts only when `useSidebar().isMobile`
is true.

**CSS.** Removed roughly 300 lines of dead sidebar rules from `src/styles/dashboard.css`
(`.dashboard-sidebar`, `.dashboard-nav*`, `.tenant-*`, `.account-switcher`, `.avatar`,
`.dashboard-create-button*`, `.dashboard-main`, the light-patch block, the sidebar media queries).
Kept the skip link, `.dashboard-icon`, and the page rules. Added unconditional
`.dashboard-mobile-header` rules on the app's `--paper`/`--ink` tokens.

## Decisions

- **Chalk tokens stay on the sidebar chrome.** Chalk's `--background` is `#ffffff` while the dashboard
  canvas is `--paper: #f7f6f2`, so putting `chalk-root` on the mobile header would draw a white seam
  and switch the font. The header keeps the dashboard tokens and styles the `SidebarTrigger` through
  two-class rules that outrank the single-class Tailwind utilities.
- **Breakpoint gap closed.** The old CSS hid the sidebar below 760px, but the primitive swaps to a
  drawer below 768px, which left 760–767px with no navigation at all. The mobile header is now driven
  by `useSidebar().isMobile`, so both agree on one breakpoint.
- **No `as` assertions.** Widths ride on CSS custom properties instead of a cast `style` object, and
  Base UI's `any`-typed `onValueChange` is narrowed with `(value: unknown) => typeof value ===
  "string"`.

## Verification

- `packages/ui`: `check-types` clean, 17 files / 31 tests pass, including the new `sidebar.test.tsx`
  (expand/collapse, ⌘B and Ctrl+B with cookie writes, plain `b` ignored, `render=` producing a link).
- `apps/web`: 78 files / 387 tests pass, including the new `DashboardSidebar.test.tsx` (nav order,
  active route marking, switchers, New Space callback, collapse to the rail).
- `apps/web` production build succeeds, prerender included.
- `apps/web` `check-types` reports one error that is not mine:
  `src/lib/chalk-access.test.ts(81,11): TS2322 AccessGrantSource is not assignable to AccessGrant`.
  `git diff HEAD` shows it comes from another agent's staged edit to `chalk-access.ts` and its test.
  Left untouched per the shared-worktree rule.

## Shipped

`e3448201`, live on `https://chalkmeet.com` through Release run 31935876185. The deployed
stylesheet carries `--sidebar:#171a18` and `--sidebar:#121719` with `.bg-sidebar{background-color:
var(--sidebar)}`, and no `.dashboard-sidebar` rule survives in it.

The commit was assembled without touching the shared checkout. The index there already held another
agent's staged API work, so the tree was built in a temporary `GIT_INDEX_FILE` seeded from
`origin/master`, my twelve paths added from the working tree, and the commit written with
`commit-tree`. `NewSpaceDialog.tsx` was excluded: its working-tree change is the
`defaultSpaceMediaPlane` swap that belongs with another agent's `dashboard-api.ts`.

Gated in a throwaway worktree at `.worktrees/sidebar-release`: web build with prerender,
78 files / 386 tests, `packages/ui` 17 files / 31 tests, both `check-types` clean, oxfmt clean
after formatting `sidebar.tsx`, `menu.tsx`, and `DashboardSidebar.tsx`, and the lefthook
quality gate on commit.

## Notes

- The first dispatch, run 31935806948, failed at checkout because I passed the short SHA. The
  workflow wants the full 40 characters.
- The shared checkout's `pnpm-lock.yaml` diff carried an unrelated Expo re-resolution, so the
  lockfile update was regenerated from `origin/master` inside the worktree: six lines, the two
  `@hugeicons` specifiers, with the resolutions already present for the React Native app.
- The main checkout still holds my files as untracked and modified against its own `master`,
  which is behind `origin/master`. Whoever fast-forwards may have to clear
  `DashboardSidebar.tsx`, `sidebar.tsx`, `menu.tsx`, and friends first; the pushed copies are
  authoritative and differ only by formatting.

---

# Themed dashboard: System, Light, Dark

Shipped as `e188252e`, live on production at 09:36 UTC.

## What Hasan reported

Three things after the sidebar landed: the nav labels were barely legible, the tenant switcher
threw Base UI error 31, and there was no theme control anywhere while chalk popups followed the
operating system on their own.

## Diagnosis

- **Invisible labels.** Tailwind v4 puts utilities in a layer. The chalk scoped reset
  (`:where([data-chalk], .chalk-root)`) sat unlayered, and unlayered CSS beats every layer
  regardless of specificity, so it painted over `text-sidebar-foreground`. Moving the reset
  into `@layer base` restores the ordering. `packages/ui/src/styles/index.test.ts` asserts the
  reset is nested inside `@layer base`, since nothing else would catch a regression here.
- **Error 31.** `Menu.GroupLabel` throws `MenuGroupRootContext is missing` without a
  `Menu.Group` ancestor. Added `MenuGroup` to the primitive and wrapped both labelled sections.
- **Desync.** The chalk portals called `resolvePortalThemeFromDocument()` once during render, so
  a popup kept whatever palette it saw at mount, and with no host theme at all they fell through
  to `prefers-color-scheme` while the page stayed light. `usePortalTheme` subscribes through
  `useSyncExternalStore` to a `MutationObserver` on the document element plus the media query.

## Approach

Route-scoped theming with `<html>` as the single source of truth. `THEMED_ROUTE_PREFIXES` decides
which routes wear the app chrome; everything else is pinned light so the landing page cannot
half-flip. `THEME_BOOTSTRAP_SCRIPT` runs inline in `<head>` and reads the `chalk_theme` cookie
before hydration — a server read cannot help here, the shell is prerendered static on Pages —
with `suppressHydrationWarning` on `<html>` to cover the deliberate mismatch. There is no CSP in
`apps/web/public/_headers`, so the inline script is allowed.

The palette keeps two tiers: the marketing `--paper/--ink/--line` family, and a new `--app-*`
family seeded with the dashboard's exact existing literals so light is byte-for-byte what it was.
`:root.dark` overrides both. About a hundred literals in `dashboard.css` were routed through the
tokens by a count-asserted one-shot script, then the leftovers by hand.

## Verification

The dashboard needs auth and the local stack is shared, so the visual check ran off a static
harness: a jsdom test dumped the real `DashboardSidebar` + `SpacesPage` markup (twice, once with
the account menu open), and Playwright's cached chromium screenshotted it against the built
stylesheet in both modes. Caught two spots the sweep missed — `.dashboard-gate-state button`
and `.btn-primary` both drew `#fff` on `var(--ink)`, which is white on white in dark.

Gates: web 79 files / 397 tests, `packages/ui` 19 files / 33 tests, both `check-types` clean
apart from another agent's pre-existing `chalk-access.test.ts` TS2322, build with prerender
green, oxfmt clean.

Release run 31939424899: 1m10s from dispatch to `https://chalkmeet.com/sw.js` reporting
`e188252e89681d982fdc32922cd483331ae60a1e`.

## Left alone

`SpacePage.tsx`'s arrival screen is a hardcoded light island (`bg-[#f7f6f2]`, `bg-white`) on a
themed route. It is internally consistent so nothing is unreadable, but chalk popups over it will
be dark while it is light. The file carries another agent's in-flight change, so tokenizing it
would have meant committing their work.
