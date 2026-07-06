# Chalk Design System

Canonical source of truth for Chalk UI work across `packages/sdk-react`, `apps/web`, and future `apps/mobile`.

## Purpose

This document defines Chalk's current design system and the normalized model we should converge toward.

Use it for:

- working inside `packages/sdk-react`
- working inside `apps/web`
- designing or implementing the mobile theme
- resolving ownership questions before adding new tokens, surfaces, or component styling

This doc is normative. It also records known drift where code does not yet cleanly match the intended system.

## System Model

Chalk currently has two visual layers:

| Layer                  | Owns                                                                                                 | Why                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `sdk-react core`       | lobby, meeting room, controls, panels, overlays, PiP, embedded conferencing UI                       | needs to stay neutral, professional, and white-label friendly for consumer apps |
| `apps/web brand layer` | first-party product shell, dashboards, landing pages, marketing-like surfaces, typography expression | can evolve faster while Chalk brand identity is still forming                   |

Working rule:

- if the UI is part of the embedded meeting experience, start from `sdk-react core`
- if the UI is part of Chalk's first-party product shell, start from `apps/web brand layer`

Future flexibility is intentional:

- a stronger Chalk brand may later flow into both layers
- or remain primarily first-party
- the system shape should support both outcomes without rework

## Canonical Sources

| Source                                                             | Role                                                                                           |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `packages/sdk-react/src/styles/styles.css`                         | core design tokens, semantic colors, meeting-specific surfaces, radii, shadows, motion         |
| `packages/sdk-react/src/utils/theme.ts`                            | theme mode detection and propagation via `data-chalk-theme`, `data-theme`, and root classes    |
| `packages/sdk-react/src/utils/colorGenerator.ts`                   | dynamic participant accent palettes and runtime `--primary` / `--primary-foreground` overrides |
| `packages/sdk-react/src/components/full/video-conference/types.ts` | current public theme API contract                                                              |
| `apps/docs/src/content/docs/sdk/react.mdx`                         | published mirror of the public theme API                                                       |
| `apps/web/src/styles.css`                                          | first-party brand overlay, app/display typography, app-level theme variants like `nord`        |
| `apps/mobile/src/screens/*.tsx`                                    | current native implementation snapshot; not canonical yet                                      |

## Current Design System

### 1. `sdk-react core`: semantic color system

Core meeting UI is driven by semantic tokens scoped to `[data-chalk]`.

| Token                      | Light                        | Dark                         |
| -------------------------- | ---------------------------- | ---------------------------- |
| `--background`             | `oklch(1 0 0)`               | `oklch(0.13 0.028 261.692)`  |
| `--foreground`             | `oklch(0.13 0.028 261.692)`  | `oklch(0.985 0.002 247.839)` |
| `--card`                   | `oklch(1 0 0)`               | `oklch(0.21 0.034 264.665)`  |
| `--card-foreground`        | `oklch(0.13 0.028 261.692)`  | `oklch(0.985 0.002 247.839)` |
| `--popover`                | `oklch(1 0 0)`               | `oklch(0.21 0.034 264.665)`  |
| `--popover-foreground`     | `oklch(0.13 0.028 261.692)`  | `oklch(0.985 0.002 247.839)` |
| `--primary`                | `oklch(0.6 0.1 185)`         | `oklch(0.7 0.12 183)`        |
| `--primary-foreground`     | `oklch(0.98 0.01 181)`       | `oklch(0.28 0.04 193)`       |
| `--secondary`              | `oklch(0.967 0.001 286.375)` | `oklch(0.274 0.006 286.033)` |
| `--secondary-foreground`   | `oklch(0.21 0.006 285.885)`  | `oklch(0.985 0 0)`           |
| `--muted`                  | `oklch(0.967 0.003 264.542)` | `oklch(0.278 0.033 256.848)` |
| `--muted-foreground`       | `oklch(0.551 0.027 264.364)` | `oklch(0.707 0.022 261.325)` |
| `--accent`                 | `oklch(0.967 0.003 264.542)` | `oklch(0.278 0.033 256.848)` |
| `--accent-foreground`      | `oklch(0.21 0.034 264.665)`  | `oklch(0.985 0.002 247.839)` |
| `--destructive`            | `oklch(0.577 0.245 27.325)`  | `oklch(0.704 0.191 22.216)`  |
| `--destructive-foreground` | `oklch(0.98 0.01 0)`         | `oklch(0.985 0 0)`           |
| `--success`                | `oklch(0.72 0.17 162)`       | `oklch(0.72 0.17 162)`       |
| `--warning`                | `oklch(0.8 0.15 85)`         | `oklch(0.8 0.15 85)`         |
| `--border`                 | `oklch(0.928 0.006 264.531)` | `oklch(1 0 0 / 10%)`         |
| `--input`                  | `oklch(0.928 0.006 264.531)` | `oklch(1 0 0 / 15%)`         |
| `--ring`                   | `oklch(0.6 0.1 185)`         | `oklch(0.551 0.027 264.364)` |

Interpretation:

- default core palette is teal/cyan-centered
- semantic roles matter more than raw values
- embedded UI should reference these roles instead of inventing ad hoc colors

### 2. `sdk-react core`: meeting-specific tokens

These define the conferencing feel, beyond generic semantic roles.

| Token group         | Light                       | Dark                        | Notes                            |
| ------------------- | --------------------------- | --------------------------- | -------------------------------- |
| stage background    | `#0f172a`                   | `#0a0a0c`                   | immersive stage base             |
| tile background     | `#111827`                   | `#141418`                   | fallback tile surface            |
| controls background | `rgba(255, 255, 255, 0.92)` | `rgba(26, 26, 26, 0.92)`    | floating control chrome          |
| speaking accent     | `#22c55e` + glow            | same                        | always high-signal               |
| glass surface       | `rgba(255, 255, 255, 0.72)` | `rgba(18, 18, 26, 0.72)`    | overlays / floating panes        |
| tile gradient end   | `#e0f5f3`                   | `#000000`                   | clean fade, no muddy middle stop |
| pill base           | translucent slate           | translucent white-on-dark   | dock / chip controls             |
| lobby gradient      | soft teal-blue blend        | dark teal-blue-violet blend | pre-join identity surface        |
| lobby glass         | light frosted white         | dark frosted black          | pre-join floating chrome         |

Component patterns repeatedly seen in core:

- rounded floating pills
- frosted-glass panels
- radial primary glows for focus moments
- high-contrast stage surfaces
- animated speaking emphasis
- local participant accent injection through runtime `--primary`

### 3. `sdk-react core`: shape, elevation, motion

| Category         | Values                                                                     |
| ---------------- | -------------------------------------------------------------------------- |
| base radius      | `--radius: 0.625rem`                                                       |
| semantic radii   | `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-xl`, `--radius-2xl` |
| Chalk radii      | `0.25rem`, `0.5rem`, `0.75rem`, `1rem`, `9999px`                           |
| shadows light    | `--chalk-shadow-sm/md/lg/xl` from subtle to large slate-tinted elevation   |
| shadows dark     | `--chalk-shadow-sm/md/lg/xl` from subtle to deep black elevation           |
| motion durations | `150ms`, `200ms`, `300ms`                                                  |
| motion curves    | `--chalk-ease-out-expo`, `--chalk-ease-out-back`                           |

Recurring motion families:

- scale / fade entrance
- dock slide
- panel slide
- reaction float / bounce / wiggle
- speaking pulse / glow
- highlight pulse
- shimmer / pulse loading

Motion rule:

- use motion to communicate energy and status
- keep reduced-motion support intact
- avoid decorative motion that obscures legibility in meeting UI

### 4. `sdk-react core`: tactile & auditory feedback

Chalk is a high-latency-sensitive application where interaction feedback is critical to perceived performance.

| Preset      | Context                                           | Feedback Type              |
| ----------- | ------------------------------------------------- | -------------------------- |
| `selection` | toggle mic/camera, open panel, switch tab         | light tap                  |
| `impact`    | reaction burst, hand raise, join meeting          | medium impact              |
| `success`   | meeting joined, invite copied, recording started  | double-tap / rising tone   |
| `error`     | connection lost, hardware error, recording failed | stutter-tap / falling tone |

Rule:

- haptics should respect `prefers-reduced-motion`
- auditory feedback should be tied to the `useSoundEffects` hook
- tactile feedback should be tied to the `useHaptics` hook

### 5. `sdk-react core`: layering & z-index

To prevent "z-index wars", Chalk uses a semantic layering strategy.

| Layer     | Z-Index | Usage                                                  |
| --------- | ------- | ------------------------------------------------------ |
| `base`    | `0`     | background, stage base                                 |
| `tiled`   | `10`    | video tiles, content share                             |
| `overlay` | `20`    | name tags, connection quality, tile-relative chrome    |
| `dock`    | `30`    | floating ControlBar, reaction picker                   |
| `panel`   | `40`    | slide-out sidebars (Chat, Participants, Transcription) |
| `dialog`  | `50`    | settings, invite modal, hardware selector              |
| `popover` | `60`    | tooltips, context menus, dropdowns                     |
| `toast`   | `70`    | notifications, error banners                           |

### 6. `sdk-react core`: structural layout (The "Chalk Shell")

The conferencing UI is organized into four main structural zones.

- **Stage**: The primary immersive area for video tiles and shared content.
- **Dock**: The bottom-centered floating control bar for primary meeting actions.
- **Header**: The top-aligned meeting information and participant count.
- **Chrome**: Identity-linked overlays that persist across layout shifts (PiP, meeting status).

### 7. `sdk-react core`: typography

| Role                | Intent                             | Style                                       |
| ------------------- | ---------------------------------- | ------------------------------------------- |
| `label-participant` | Identity on video tiles            | `text-xs font-medium tracking-tight`        |
| `text-transcript`   | High-readability conversation text | `text-base leading-relaxed tracking-normal` |
| `heading-display`   | Large meeting or room titles       | `text-2xl font-bold tracking-tight`         |
| `mono-system`       | Technical/debug indicators         | `font-mono text-[10px] uppercase`           |

Drift Note: `sdk-react` currently uses `font-app` and `font-display` from the brand layer in some places. These should be aliased to the semantic roles above within the core package.

### 8. `sdk-react core`: status palette

| State         | Signal               | Style                                         |
| ------------- | -------------------- | --------------------------------------------- |
| `active`      | online / joined      | `--success`                                   |
| `speaking`    | high-signal activity | `--chalk-accent-speaking` + pulse animation   |
| `hand-raised` | attention request    | `--warning` + bounce animation                |
| `recording`   | persistent activity  | `oklch(0.577 0.245 27.325)` + recording pulse |
| `muted`       | disabled / offline   | `--muted-foreground`                          |

### 9. `sdk-react core`: glass & surfaces

| Surface          | Transparency | Usage                                     |
| ---------------- | ------------ | ----------------------------------------- |
| `glass-surface`  | `0.72`       | Panels, tooltips, floating bars           |
| `glass-elevated` | `0.92`       | ControlBar, active popovers               |
| `glass-stage`    | `0.40`       | Chrome sitting directly over active video |

### 10. `sdk-react core`: theme behavior

Theme mode rules:

- reads from `data-chalk-theme`
- also supports `data-theme`
- also supports root `light` / `dark` classes
- can fall back to system preference
- propagates to extra surfaces like Picture-in-Picture

Implementation rule:

- new embedded UI should stay inside this theme behavior model
- do not create separate mode logic for lobby / meeting / PiP unless the core system itself changes

### 6. Dynamic participant accent system

Participant color is not the global brand theme. It is a local accent system layered onto core UI.

Current palette families include:

- brand teal
- deep teal
- cyan
- emerald
- sky
- blue
- indigo
- violet
- mint
- green
- rose
- orange
- amber
- fuchsia
- slate

Runtime effect:

- local participant identity can override `--primary`, `--primary-foreground`, and `--ring`
- gradients are used for avatars, tiles, and some loading/joining contexts

Rule:

- treat participant accent as contextual personalization
- not as the base Chalk brand color system

### 7. Public theme API vs actual internal system

Current public API on `VideoConference`:

| Prop                 | Type                   |
| -------------------- | ---------------------- |
| `theme.accentColor`  | `string`               |
| `theme.borderRadius` | `"rounded" \| "sharp"` |

Reality:

- internal visual system is much richer than the public API
- the public API currently under-describes the true styling surface
- implementation wiring for those public props appears limited compared with the internal token system

Contributor rule:

- when changing embedded UI, follow the internal semantic system first
- do not assume the public `Theme` type fully represents Chalk's actual design system

## `apps/web` Brand Layer

This layer owns Chalk's first-party expression.

### Brand tokens currently owned by `apps/web`

| Token            | Value                            |
| ---------------- | -------------------------------- |
| `--font-app`     | `"Figtree Variable", sans-serif` |
| `--font-display` | `"Sora", sans-serif`             |
| `--primary`      | `#1bb6a6` in default web theme   |
| `nord` theme     | blue-grey alternate app theme    |

Brand-layer traits seen in `apps/web`:

- stronger typographic personality
- product-shell polish beyond embedded meeting UI
- route-level themes like `nord`
- dashboard and landing-page expression

Examples of surfaces this layer should influence:

- dashboards
- authenticated product shell
- landing pages
- marketing-like sections
- first-party navigation chrome

Important boundary:

- this layer is not the source of truth for embedded meeting UI
- if `sdk-react` references `font-app`, `font-display`, or app-only token names, document that as drift and prefer moving toward cleaner ownership

## Current Mobile Snapshot

`apps/mobile` is not on the design system yet. It is a hardcoded React Native snapshot.

Current facts:

- uses `StyleSheet.create`
- no shared token package
- no theme provider
- no import from `@q9labsai/chalk-react`
- depends on `@q9labsai/chalk-react-native` runtime only

Repeated native values today:

| Category         | Current values                                                          |
| ---------------- | ----------------------------------------------------------------------- |
| base backgrounds | `#07111d`, `#09111f`                                                    |
| cards            | `#102038`, `#0c1829`, `#0f1c2d`, `#16304d`, `#091521`                   |
| primary CTA      | `#2d7ff9`                                                               |
| accent text      | `#77b7ff`, `#8dbcf5`                                                    |
| primary text     | `#f5fbff`, `#f7fbff`                                                    |
| secondary text   | `#b6c9df`, `#b3c8e0`, `#c6d6ea`, `#dce9f8`                              |
| error            | `#ff9d97`, `#ffd8df`, `#521a24`                                         |
| radii            | `16`, `18`, `22`, `24`, `28`, `999`                                     |
| type scale       | eyebrow `13/700`, body `14-16`, title `28-34/800-900`, CTA `15/700-800` |

Interpretation:

- mobile currently reflects a dark, join-first shell
- it feels adjacent to Chalk, but is not yet sourced from canonical tokens
- none of these hardcoded values should be treated as system truth

## Target Design System Model

This is the normalized structure future work should align to. It is not a redesign brief.

### 1. Foundation layers

The design system should converge on these token families:

- color
- typography
- spacing
- radius
- elevation
- motion

### 2. Semantic roles

Across web and mobile, the same role model should exist:

- app background
- stage background
- panel / card
- floating glass
- interactive control
- muted / secondary text
- focus / ring
- success
- warning
- destructive

### 3. Ownership model

- `core` tokens should be platform-neutral and safe for embedded UI
- `brand` tokens should layer on top of the same shape, not reinvent it
- component aliases should exist only when semantic roles are not enough

### 4. Portability model

Target mapping:

- web uses CSS variables and semantic classes
- mobile maps the same semantic roles into native tokens
- both platforms should speak the same design vocabulary

## Drift And Gaps

Known issues to keep visible:

- public theme API is much thinner than the real internal system
- `sdk-react` typography ownership is incomplete
- `sdk-react` contains references to `apps/web` brand classes and token names
- spacing is not formalized as a first-class token scale
- mobile still hardcodes colors, type, and radii

Classification:

| Type                   | Items                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| intentional separation | neutral embedded core vs first-party brand layer                                                  |
| accidental drift       | app-owned font/token usage leaking into `sdk-react`; incomplete package-owned type/spacing system |

## Mobile Translation Rules

When mobile implementation begins:

- start from `sdk-react core` roles for meeting, lobby, and related conferencing UI
- selectively apply `apps/web` brand overlay only where product-shell branding is intended
- map semantic roles, not web class names
- create mobile token families that mirror system ownership:
  - `core`
  - `brand`
  - `component aliases` only where necessary

Do not:

- freeze current RN hardcoded values as canonical
- copy Tailwind class names into native architecture
- collapse embedded meeting UI and first-party app chrome into one undifferentiated token set

## Working Rules

- if a role already exists semantically, use it instead of adding a raw color
- if a needed role is missing, update this doc before or alongside code
- if ownership is unclear, resolve it here first: `core` or `brand`
- treat participant accent as contextual personalization, not brand foundation
- keep embedded meeting UI neutral unless a conscious system-level change says otherwise

## Summary

Chalk's current design system is one system with two layers:

- `sdk-react core` for neutral embedded conferencing UI
- `apps/web brand layer` for first-party Chalk expression

This document is the source of truth for both the current implementation and the normalized model we want future work to follow.
