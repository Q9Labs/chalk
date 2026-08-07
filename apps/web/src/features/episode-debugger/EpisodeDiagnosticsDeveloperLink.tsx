import { buttonVariants } from "@q9labsai/chalk-ui";
import { parseDiagnosticReference } from "@chalk/diagnostics-contracts";

export function EpisodeDiagnosticsDeveloperLink({ diagnosticReference, enabled = __EPISODE_DIAGNOSTICS_ROUTE_ENABLED__ }: { diagnosticReference?: string; enabled?: boolean }) {
  if (!enabled || !diagnosticReference) return null;
  try {
    parseDiagnosticReference(diagnosticReference);
  } catch {
    return null;
  }
  return (
    <a className={buttonVariants({ variant: "outline", size: "sm" })} href={`/developer/episode-diagnostics/${encodeURIComponent(diagnosticReference)}`}>
      Open Episode Debugger
    </a>
  );
}
