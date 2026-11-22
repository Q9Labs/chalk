import { existsSync, readFileSync } from "node:fs";

const root = new URL("../../", import.meta.url);
const readJson = (path) => JSON.parse(readFileSync(new URL(path, root), "utf8"));

/**
 * What the observability coverage gate (scripts/gates/obs-coverage.mjs) reads outside observability/: each symptom's fault scenario and
 * emit sites, as the coverage graph names them, and each chain hop's test, as the chain's hops.json names it.
 * @returns {string[]}
 */
function coverageFiles() {
  const { symptoms } = readJson("observability/generated/coverage-graph.json");
  return symptoms.flatMap((symptom) => {
    const hops = `observability/fixtures/${symptom.code}/chain/hops.json`;
    const hopTests = existsSync(new URL(hops, root)) ? readJson(hops).hops.map((hop) => hop.test) : [];
    const emitSites = symptom.events.flatMap((event) => event.emit_sites.map((site) => site.path));
    return [...(symptom.fault_scenario ? [symptom.fault_scenario] : []), ...emitSites, ...hopTests];
  });
}

/**
 * The checker's own files, its thresholds, and the code that writes the rows it reads: the SFU node's events (session outcomes, media stats,
 * unmute legs, negotiation failures), the API's call stats, connection reports, replacements, presence expiry, durable session outcomes and plane
 * changes, and the SDK's report. The same lane runs the observability coverage gate, so its inputs are here too: the registry, rules, fixtures
 * and chains under observability/, and the code the coverage graph names.
 */
export const DIAGNOSE_CALL_INPUTS = [
  "scripts/diagnose-call",
  "observability",
  ...coverageFiles(),
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

/** The lane runs the diagnosis tests and the observability coverage gate with its tests. */
export const DIAGNOSE_CALL_TESTS = ["scripts/diagnose-call/**/*.test.mjs", "scripts/gates/obs-coverage.mjs", "scripts/gates/obs-coverage.test.mjs"];
