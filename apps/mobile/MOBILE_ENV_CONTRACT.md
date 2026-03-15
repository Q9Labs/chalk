## Chalk Mobile Env Contract

Release builds must come from CI, not local `.env.local`.

Required release env:

- `EXPO_PUBLIC_API_URL=https://chalk-api.q9labs.ai`
- `EXPO_PUBLIC_WS_URL=wss://chalk-ws.q9labs.ai/ws`
- `EXPO_PUBLIC_CHALK_API_KEY=${{ secrets.VITE_CHALK_API_KEY }}`

Rules:

- treat `apps/mobile/.env.local` as dev-only
- never trust a local host key for Play/TestFlight builds
- Android signing material stays in GitHub Secrets, recreated only on the runner
- Play upload credentials stay in GitHub Secrets or local ignored files, never git

Current Android release workflow:

- `.github/workflows/mobile-android-release.yml`

Current Android publish target:

- package `ai.q9labs.chalk.mobile`
- track `internal`
