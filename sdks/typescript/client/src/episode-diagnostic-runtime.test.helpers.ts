import { EpisodeDiagnosticRuntime } from "./space-client/episode-diagnostic-runtime";

export function diagnosticRuntime(): EpisodeDiagnosticRuntime {
  let identifier = 0;
  const diagnostics = new EpisodeDiagnosticRuntime({
    apiBaseUrl: "https://api.chalk.video",
    createId: () => `diagnostic-${++identifier}`,
    now: () => Date.parse("2026-08-04T12:00:00.000Z"),
    setTimeout: () => undefined,
    clearTimeout: () => undefined,
  });
  diagnostics.rotateCredential({
    token: `${btoa("header")}.${btoa(JSON.stringify({ aud: "chalk-diagnostics" }))}.signature`,
    expiresAt: "2026-08-04T12:05:00.000Z",
    generation: 1,
    intakePath: "/_internal/episode-diagnostic-events",
  });
  return diagnostics;
}
