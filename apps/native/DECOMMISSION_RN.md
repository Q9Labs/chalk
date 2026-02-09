# Decommission Plan — `apps/mobile` + `apps/mobile2` (React Native)

Decision: delete RN demo apps and replace with native apps (`apps/ios`, `apps/android`).

This file is a checklist so we don’t accidentally lose critical config/knowledge.

## Preserve (copy into native apps / docs)

- Bundle IDs / package names + schemes:
  - iOS `bundleIdentifier`, Android `package` (`apps/mobile2/app.json`)
- Permission strings:
  - iOS camera/mic/Bluetooth, background modes (`apps/mobile2/app.json`)
- Known stability constraints (historical):
  - Hermes ON, New Architecture OFF, Reanimated v3 only (`apps/mobile2/README.md`)
- Environment contract:
  - API URL, WS URL, API key, debug flags (`apps/mobile2/.env.example`, `apps/mobile2/lib/env.ts`)

## Known breakages to avoid carrying forward

- `apps/mobile2/index.js` imports missing `./devtools` (remove or implement if reusing).
- Root script `mobile:verify` references missing `scripts/verify-mobile.ts` (remove/fix when RN apps removed).

## Delete sequencing (safe)

1) Ensure native docs are complete:
   - `apps/native/FINDINGS.md`, `apps/native/REQUIREMENTS.md`, `apps/native/SPEC.md`
2) Update root scripts that reference RN apps.
3) Delete `apps/mobile` and `apps/mobile2` directories.
4) `bun run lint` + `bun run check-types` + `bun run test` at repo root.

## Open question (before deletion)

Do we want to keep `apps/mobile2/app.json` around as a reference-only artifact (moved into `apps/native/`) or hard-delete it with the app?

