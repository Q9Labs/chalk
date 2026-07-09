# SDK Preview Session Log - 2026-07-07

- 12:05 PKT: Started wiring a no-auth local preview route in `apps/web` for React SDK lobby and conference components.
- 12:05 PKT: Confirmed Tailwind v4 Vite setup from Context7 docs and npm package metadata before adding `@tailwindcss/vite` to `apps/web`.
- 12:05 PKT: Added `/sdk-preview` route using SDK source imports so local edits in `packages/sdk-react/src` show without rebuilding the package.
- 12:11 PKT: Verified `pnpm --dir apps/web run build`, `pnpm --dir apps/web exec tsc --noEmit`, and `curl -I http://localhost:3071/sdk-preview` all pass. In-app browser was unavailable in this session, so visual click-through was not possible from Codex.
