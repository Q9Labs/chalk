# Work Progress 2026-02-14

- Plan (reference)
  - External/internal `kind` naming: `internal` for q9labs first-party apps, `external` for customer/integration.
  - Auth: email magic-link (Resend) required for dashboard access; hard 1:1 `user`<->`tenant` for now.
  - Dashboard: host-only view; meetings table: recording + transcript + metadata; signed URL for recording access.
  - Storage policy: store all meeting metadata; hard-delete recordings after 7 days; keep tombstone (nifact) record.
  - Transcription: always-on; provider default Whisper.

- 13:25 PKT: Prod bug: `chalk.q9labs.ai/dashboard` sometimes 404 while `/` works; Pages deployment URL serves deep links correctly.
- 13:28 PKT: Web fix shipped: add SPA fallback via `_redirects`, and stop CI from deleting it during Pages deploy. Verified Pages deployment deep links work.
- 13:40 PKT: Root-cause narrowed: custom domain returns empty-body 404 for deep links while Pages `pages.dev` deployment returns SPA HTML for any path (rewrite working). Indicates custom-domain edge/rules not honoring SPA fallback.
- 13:45 PKT: Infra fix: add Cloudflare Transform Ruleset (prod) to rewrite HTML document navigations to `/` for host `chalk.q9labs.ai` (preserves browser URL; SPA router handles path).
- 13:52 PKT: Infra apply failed (Cloudflare API token lacks Rulesets permission). Backed out Terraform ruleset; switching to Pages-only fix: `_redirects` rewrite target `/* / 200` (avoid `/index.html` which 404s on custom domain).
- 13:58 PKT: Web redeploy complete; verified `https://chalk.q9labs.ai/dashboard` now returns `200` (deep links no longer 404).
- 14:12 PKT: Regression: SPA redirect rewrote `/assets/*` to HTML (MIME errors for JS/CSS). Fix: keep `/* / 200`, add explicit `/assets/*` passthrough redirect rule, and keep `/assets/*` cache header immutable.
- 14:27 PKT: Stabilization: add client-side auto-reload on chunk-load failures (stale hashed assets after deploy) so long-lived tabs recover automatically.
- 14:40 PKT: API: retention job now expires recordings by deleting storage + marking DB row `status=deleted` (keeps meeting/transcript metadata); add `recordings.deleted_at` + regenerate sqlc.
- 14:44 PKT: API: internal meetings list now includes transcript summary/action-items + metadata fields for dashboard rendering.
- 14:46 PKT: Web DX: remove `wrangler pages dev` local flow (no Pages Functions needed); default `bun run dev` only.
