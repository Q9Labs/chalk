/** The checker's own files, its thresholds, and the code that writes the rows it reads: the SFU node's events, the API's call stats, connection reports, replacements and presence expiry, and the SDK's report. */
export const DIAGNOSE_CALL_INPUTS = [
  "scripts/diagnose-call",
  "infrastructure/observability/production-alerts/call-verdict",
  "features/media/sfu/internal/media/events.go",
  "features/media/sfu/internal/media/trail.go",
  "features/media/sfu/internal/telemetry",
  "apps/api/internal/httpapi/call_stats.go",
  "apps/api/internal/httpapi/connection_reports.go",
  "apps/api/internal/observability/media_replacement.go",
  "apps/api/internal/adapters/postgres/participant_presence.go",
  "sdks/typescript/client/src/connection/report.ts",
  "sdks/typescript/client/src/media/audio-receive-health.ts",
];
