## Chalk Mobile Env Contract

Release builds should come from controlled CI, not local `.env.local`.

Required release env:

- `EXPO_PUBLIC_API_URL=<production API URL>`
- `EXPO_PUBLIC_WS_URL=<production websocket URL>`
- `EXPO_PUBLIC_CHALK_API_KEY=<host API key from secret manager>`

Rules:

- treat `apps/mobile/.env.local` as dev-only
- local prod builds must run through `apps/mobile/scripts/run-with-production-mobile-env.ts`
- `apps/mobile/scripts/verify-production-mobile-host-key.ts` must pass before bundling
- if local mobile host auth drifts, run `bun run mobile:sync-local-env`
- never trust a local host key for Play/TestFlight builds
- Android closed/prod releases: CI artifact only
- sideloadable production Android APKs: CI artifact only
- Android signing material stays in CI secrets, recreated only on the runner
- Play upload credentials stay in CI secrets or local ignored files, never git

Current Android release workflow:

- private deployment workflow
- output:
  - `mobile-android-release-apk`

Current Android bundle workflow:

- private deployment workflow
- output:
  - `mobile-android-release-aab`

Current Android publish target:

- package and track are set by private release configuration
