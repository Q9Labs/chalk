## Chalk Mobile Env Contract

Release builds should come from controlled CI, not local `.env.local`.

Required release env:

- `EXPO_PUBLIC_API_URL=<production API URL>`
- `EXPO_PUBLIC_WS_URL=<production websocket URL>`

Rules:

- treat `apps/mobile/.env.local` as dev-only
- never put a tenant or host API key in an `EXPO_PUBLIC_*` variable; Expo embeds
  public variables in the application bundle
- production mobile meeting creation remains disabled until Chalk has a native
  participant-access broker
- invite-link participants may still join through the public join-token exchange
- local prod builds must run through `apps/mobile/scripts/run-with-production-mobile-env.ts`
- if local mobile host auth drifts, run `pnpm run mobile:sync-local-env`
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
