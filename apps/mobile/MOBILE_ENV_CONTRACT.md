## Chalk Mobile Env Contract

Release builds should come from controlled CI, not local `.env.local`.

Release client contract:

- `EXPO_PUBLIC_CHALK_BROKER_URL=https://chalkmeet.com/local-chalk`

Rules:

- treat `apps/mobile/.env.local` as dev-only
- never put a tenant, API key, participant credential, or client-session
  credential in an `EXPO_PUBLIC_*` variable; Expo embeds public variables in the
  application bundle
- both meeting creation and invite joins use the broker's opaque client-session
  and `ParticipantAccess` contract
- API and Sync endpoints come from the broker response and are not independently
  configured in the application bundle
- local prod builds must run through `apps/mobile/scripts/run-with-production-mobile-env.ts`
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
