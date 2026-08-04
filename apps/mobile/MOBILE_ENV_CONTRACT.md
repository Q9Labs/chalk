## Chalk Mobile Env Contract

Release builds should come from controlled CI, not local `.env.local`.

Release client contract:

- `EXPO_PUBLIC_CHALK_BROKER_URL=https://chalkmeet.com/local-chalk`
- `EXPO_PUBLIC_CHALK_TELEMETRY_ENABLED=true` is an explicit per-deployment opt-in; any other value, including an unset variable, keeps mobile journey telemetry disabled.

Rules:

- treat `apps/mobile/.env.local` as dev-only
- never put a tenant, API key, participant credential, or AccessGrant in an
  `EXPO_PUBLIC_*` variable; Expo embeds public variables in the application bundle
- Local Space entry and Space-link access create or resume a broker-issued participant
  credential, then forward its opaque `AccessGrant` response unchanged to Chalk
- Mobile entry does not create a durable Space; the local route targets the existing
  broker Space and retains an optional label only for the current view
- API and Sync endpoint selection stays inside the Chalk native adapter and is not
  independently configured in the application bundle
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
