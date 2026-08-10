import { buttonVariants } from "@q9labsai/chalk-ui";
import { useEffect, useMemo, useState } from "react";
import { EpisodeDiagnosticsApiClient, EpisodeDiagnosticsApiError } from "./api-client";
import { episodeDebuggerPath, isAlternateDiagnosticReference } from "./reference";

const AVAILABILITY_RETRY_DELAYS_MS = [250, 1_000] as const;

export type EpisodeDiagnosticsAvailabilityClient = Pick<EpisodeDiagnosticsApiClient, "resolveAlternate">;

type AvailabilityState = "available" | "checking" | "unavailable";

function shouldRetryAvailability(error: unknown): boolean {
  if (!(error instanceof EpisodeDiagnosticsApiError)) return true;
  return ![400, 401, 403].includes(error.status ?? 0);
}

export function EpisodeDiagnosticsDeveloperLink({ diagnosticReference, enabled = __EPISODE_DIAGNOSTICS_ROUTE_ENABLED__, api: apiInput }: { diagnosticReference?: string; enabled?: boolean; api?: EpisodeDiagnosticsAvailabilityClient }) {
  const reference = diagnosticReference?.trim() ?? "";
  const path = episodeDebuggerPath(reference);
  const alternateReference = isAlternateDiagnosticReference(reference) ? reference : undefined;
  const api = useMemo(() => apiInput ?? new EpisodeDiagnosticsApiClient(), [apiInput]);
  const [availability, setAvailability] = useState<AvailabilityState>(alternateReference ? "checking" : "available");
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [retryGeneration, setRetryGeneration] = useState(0);

  useEffect(() => {
    if (!enabled || !path || !alternateReference) {
      setAvailability(path ? "available" : "unavailable");
      setRetryAttempt(0);
      return;
    }

    let active = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();
    setAvailability("checking");

    void api.resolveAlternate(alternateReference, abort.signal).then(
      () => {
        if (active) setAvailability("available");
      },
      (error: unknown) => {
        if (!active) return;
        const retryDelay = shouldRetryAvailability(error) && retryAttempt < AVAILABILITY_RETRY_DELAYS_MS.length ? AVAILABILITY_RETRY_DELAYS_MS[retryAttempt] : undefined;
        if (retryDelay !== undefined) {
          retryTimer = setTimeout(() => {
            if (active) setRetryAttempt((current) => current + 1);
          }, retryDelay);
          return;
        }
        setAvailability("unavailable");
      },
    );

    return () => {
      active = false;
      abort.abort();
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
  }, [alternateReference, api, enabled, path, retryAttempt, retryGeneration]);

  if (!enabled || !diagnosticReference || !path) return null;
  if (availability === "checking") {
    return (
      <span className="episode-diagnostics-availability" role="status">
        Checking Episode Debugger availability…
      </span>
    );
  }
  if (availability === "unavailable") {
    return (
      <span className="episode-diagnostics-availability" role="status">
        <span>Episode Debugger unavailable.</span>
        <button
          className="dashboard-button secondary"
          type="button"
          onClick={() => {
            setRetryAttempt(0);
            setRetryGeneration((current) => current + 1);
          }}
        >
          Retry
        </button>
      </span>
    );
  }

  return (
    <a className={buttonVariants({ variant: "outline", size: "sm" })} href={path}>
      Open Episode Debugger
    </a>
  );
}
