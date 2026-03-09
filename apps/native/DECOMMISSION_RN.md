# Decommission Plan — `apps/mobile` + `apps/mobile2` (React Native)

Decision: delete RN demo apps and replace with native apps (`apps/ios`, `apps/android`).

This file is a checklist so we don’t accidentally lose critical config/knowledge.

Status: hard-deleted from repo.

## Preserve (copy into native apps / docs)

- Bundle IDs / package names + schemes:
  - iOS `ai.q9labs.chalk`, Android `ai.q9labs.chalk`, scheme `chalk`
- Permission strings:
  - iOS camera/mic/Bluetooth usage descriptions, background modes (`audio`, `voip`)
- Known stability constraints (historical):
  - Hermes ON, New Architecture OFF, Reanimated v3 only
- Environment contract:
  - API URL, WS URL, API key, debug flags

## Known breakages to avoid carrying forward

- Root script `mobile:verify` referenced missing `scripts/verify-mobile.ts` (removed alongside RN scripts).

## Delete sequencing (safe)

1. Ensure native docs are complete:
   - `apps/native/FINDINGS.md`, `apps/native/REQUIREMENTS.md`, `apps/native/SPEC.md`
2. Update root scripts that reference RN apps.
3. Delete `apps/mobile` and `apps/mobile2` directories.
4. `bun run lint` + `bun run check-types` + `bun run test` at repo root.
5. (Optional) Copy any last needed config into `apps/native/*` docs.
