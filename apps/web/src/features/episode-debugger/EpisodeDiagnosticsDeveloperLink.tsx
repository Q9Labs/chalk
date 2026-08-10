import { buttonVariants } from "@q9labsai/chalk-ui";
import { episodeDebuggerPath } from "./reference";

export function EpisodeDiagnosticsDeveloperLink({ diagnosticReference, enabled = __EPISODE_DIAGNOSTICS_ROUTE_ENABLED__ }: { diagnosticReference?: string; enabled?: boolean }) {
  if (!enabled || !diagnosticReference) return null;
  const path = episodeDebuggerPath(diagnosticReference);
  if (!path) return null;
  return (
    <a className={buttonVariants({ variant: "outline", size: "sm" })} href={path}>
      Open Episode Debugger
    </a>
  );
}
