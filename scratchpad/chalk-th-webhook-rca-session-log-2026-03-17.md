2026-03-17 01:20 PKT
- investigating TH missing webhook ingress vs Chalk 200 deliveries
- parallel tracks: TH prod runtime via AWS, TH webhook path analysis, Chalk Axiom blindspots
- current strongest read: some TH 200 responses not visible in TH app Axiom stream; likely runtime/logging drift or alternate serving path
- planned code work: improve Chalk webhook delivery wide events; patch TH webhook logging/correlation/error coverage after code analysis

2026-03-17 21:33 PKT
- started TH implementation in `/Users/macmini/Desktop/Code/th-lms/th-lms-server`
- patched `src/server.ts` env bootstrap order to load `.env` and env-specific files before logger/app modules
- patched `src/config/logger.ts` runtime env classification for `dev`/`development` vs prod-like envs
- patched Chalk webhook middleware/handler for delivery-id correlation, richer `webhook.complete`, explicit skip branches, and explicit last-error persistence failure logging
- patched recording ingest helper to use contextual logger for request/session/delivery correlation
- added one focused node:test file for webhook observability helpers

2026-03-17 08:41 PKT
- hardened `packages/sdk-core` Express webhook adapter so Chalk core now owns strict content-type/raw-body/parser handling, header normalization, request correlation fields, and exact verifier status mapping
- added focused sdk-core webhook adapter tests for 415/401/400/413 behavior plus request enrichment and raw-hex signature compatibility
- verified `packages/sdk-core` with `bun run lint`, `bun run check-types`, `bun run build`, and `bun test ./src/__tests__/webhooks.test.ts`

2026-03-17 08:49 PKT
- release tag `v0.0.77` failed SDK publish because pruned release installs still ran root `postinstall`, but the mobile-only RealtimeKit patch script was absent / inapplicable in the pruned tree
- patched `scripts/patch-realtimekit-react-native.ts` to no-op when `apps/mobile` or `@cloudflare/realtimekit-react-native` is absent, which makes pruned SDK publish installs safe without suppressing all scripts
- verified skip path by executing the patch script from a no-mobile temp cwd and verified repo-root execution still exits cleanly
