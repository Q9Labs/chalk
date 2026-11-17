/**
 * The checker's own files, its thresholds, and the code that writes the rows it reads: the SFU node's events (session outcomes, media stats,
 * unmute legs, negotiation failures), the API's call stats, connection reports, replacements, presence expiry, durable session outcomes and plane
 * changes, and the SDK's report.
 */
export const DIAGNOSE_CALL_INPUTS = [
  "scripts/diagnose-call",
  "infrastructure/observability/production-alerts/call-verdict",
  "features/media/sfu/internal/media/events.go",
  "features/media/sfu/internal/media/trail.go",
  "features/media/sfu/internal/media/trail_transport.go",
  "features/media/sfu/internal/media/stats.go",
  "features/media/sfu/internal/media/outcome.go",
  "features/media/sfu/internal/media/unmute.go",
  "features/media/sfu/internal/media/negotiation.go",
  "features/media/sfu/internal/telemetry",
  "apps/api/internal/httpapi/call_stats.go",
  "apps/api/internal/httpapi/connection_reports.go",
  "apps/api/internal/observability/media_replacement.go",
  "apps/api/internal/adapters/postgres/participant_presence.go",
  "apps/api/internal/adapters/postgres/session_outcomes.go",
  "apps/api/internal/adapters/postgres/plane_audit.go",
  "apps/api/internal/observability/media_plane_audit.go",
  "apps/api/db/migrations/20261117090000_media_plane_changes.sql",
  "apps/api/db/migrations/20261117120000_participant_media_sessions.sql",
  "sdks/typescript/client/src/connection/report.ts",
  "sdks/typescript/client/src/media/audio-receive-health.ts",
];
