# Chalk logo motion SDK session log

## 2026-08-21: scope established

- Target is local source only: the React SDK, React Native SDK, and web app. No deployment or production action is authorized.
- The package layer owns the behavior; `apps/web` will consume the React SDK surface instead of carrying an app-only copy.
- The shared worktree already contains substantial unrelated edits across React and web, including likely integration files. Preserve them and keep this change surgical.
- Required behavior: chalk sticks orbit by default, switch to a burst on hover or keyboard focus, and keep the `chalk` wordmark static. React Native needs an equivalent interaction for touch devices because native surfaces do not have hover.

## 2026-08-21: public contract chosen

- Both SDKs will export `Logo` with the same props: `accessibilityLabel?: string | null`, `color?: string`, `height?: number`, `motion?: "orbit-burst" | "none"`, and `variant?: "mark" | "wordmark"`. The package is already the namespace, so `ChalkLogo` would violate the glossary's no-prefix rule.
- React uses CSS for ambient orbit, fine-pointer hover burst, focused ancestor burst, and reduced motion. The SVG wordmark never receives an animation class.
- React Native uses `Animated` for the same stick-only states. Hover, press, or focus starts burst; release or blur returns to orbit. `AccessibilityInfo` disables motion when the OS requests reduced motion.
- Canonical Chalk fallbacks use `Logo`; customer-provided `logoUrl` values remain static images.
- Web product UI consumes the React export. Favicons, metadata, structured data, social images, and manifests remain static assets.

## 2026-08-21: implementation and follow-up verification

- React, React Native, and web now use the stick-only orbit and immediate burst behavior. Focused tests cover the shared public contract, host fallbacks, and static customer logos.
- The floating React control bar no longer fills its outer shell, and both skins add vertical clip allowance around the expanding optional controls. Browser bounds confirmed the raised hover state remains inside its clip region.
- Entrance device selection now opens from the related microphone or camera control. Microphone input and audio output share one disclosure; camera input has its own.
- The SDK preview was using the canonical Entrance surface but dropped device fixtures and defaulted to a dark theme. It now forwards deterministic devices and defaults to the same light classic appearance as the real Entrance.
- Focused React checks passed 30 tests with type checking; focused web preview checks passed 57 tests with type checking. Helium verification confirmed matching layout classes, light classic mode, and both device disclosures on `/space` and `/sdk-preview`.
- The Entrance primary action uses a stable `--chalk-entrance-primary` token instead of palette-specific accents. Its `#202329` fill and white text now remain exact across light and dark themes.
