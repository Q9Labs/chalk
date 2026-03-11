# Work Progress 2026-02-13

- 00:30 PKT: Continued incident follow-up. Scoped to production/stress observability for transcript pipeline + capacity downsizing decisions.
- 00:37 pkt: added whisper worker custom cloudwatch metrics + queue wait telemetry; added prod monitoring alarms/widgets for whisper queue, failures, and duration.
- 00:43 PKT: Expanded stress-test dashboard (ALB 5xx + ECS saturation), added terraform outputs for infra metric dimensions.
- 00:46 PKT: Added `collect-infra-snapshot.sh` and integrated per-step capture into `run-sweep.sh` with non-blocking behavior.
- 00:49 PKT: Ran verification gates (python/shell/terraform module validate + monorepo lint/typecheck/test); captured blockers from unrelated dirty-tree type failure in sdk-react-native.
- 14:38 PKT: Dashboard plan kickoff: locked tenant model `external|internal`, host-only dashboard via email magic-link (Resend), opaque join links, signed share links, 7d hard-delete recordings.
- 14:39 PKT: Implemented API groundwork: `tenant_kind` + user/session/claim schema, and gated `/api/v1/recordings/*` behind `CanRecord` permission; ran full gates (go test + turbo lint/typecheck/test).
- 17:49 PKT: Prod web issue: direct navigation to `/dashboard` 404 on Cloudflare Pages; add SPA fallback via `apps/web/public/_redirects` to serve `index.html` for client-side routes.
- 17:52 PKT: CI fix: stop deleting `_redirects` during Cloudflare Pages deploy (`.github/workflows/web.yml`), otherwise SPA routes still 404 in prod.
  Pushed spa fallback + ci keep redirects; web ci green; curl /dashboard 200
