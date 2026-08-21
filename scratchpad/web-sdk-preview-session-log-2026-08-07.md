# Web and SDK preview session log

## 2026-08-07

- Confirmed that `apps/web` has a UI-only local runner at `pnpm --dir apps/web run dev:raw`.
- Confirmed that the SDK preview is a route in the web app and uses the lightweight local Chalk backend, not the full dev profile.
- The local runner stopped before Vite because the SDK type build found missing workspace source modules and `@noble/hashes` types.
- Repaired the ignored dependency links with `pnpm install --frozen-lockfile`.
- Started fixture-only Vite with `pnpm run dev:vite` from `apps/web`; it is serving `http://127.0.0.1:3070/`.
- Verified `/` returns 200 and `/sdk-preview` redirects to its default preview state and returns 200.
