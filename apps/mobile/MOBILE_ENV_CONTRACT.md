## Chalk Mobile Env Contract

Release builds must come from CI, not local `.env.local`.

Required release env:

- `EXPO_PUBLIC_API_URL=https://chalk-api.q9labs.ai`
- `EXPO_PUBLIC_WS_URL=wss://chalk-ws.q9labs.ai/ws`
- `EXPO_PUBLIC_CHALK_API_KEY=${{ secrets.VITE_CHALK_API_KEY }}`

Rules:

- treat `apps/mobile/.env.local` as dev-only
- local prod builds must run through `apps/mobile/scripts/run-with-production-mobile-env.ts`
- `apps/mobile/scripts/verify-production-mobile-host-key.ts` must pass before bundling
- if local mobile host auth drifts, run `bun run mobile:sync-local-env`
- never trust a local host key for Play/TestFlight builds
- Android closed/prod releases: CI artifact only
- Android signing material stays in GitHub Secrets, recreated only on the runner
- Play upload credentials stay in GitHub Secrets or local ignored files, never git

Current Android release workflow:

- `.github/workflows/mobile-android-release.yml`

Current Android publish target:

- package `ai.q9labs.chalk.mobile`
- track `Gamma` for closed testing
