import { useCallback, useEffect, useMemo, useState } from "react";
import { EpisodeDiagnosticsApiClient, EpisodeDiagnosticsApiError } from "./api-client";
import { episodeDebuggerPath, isAlternateDiagnosticReference } from "./reference";

const AVAILABILITY_RETRY_DELAYS_MS = [250, 1_000] as const;

export type EpisodeDiagnosticsAvailabilityClient = Pick<EpisodeDiagnosticsApiClient, "resolveAlternate">;

type AvailabilityState = "available" | "checking" | "unavailable";

type EpisodeDiagnosticsAvailabilityOptions = {
  readonly diagnosticReference?: string;
  readonly enabled?: boolean;
  readonly api?: EpisodeDiagnosticsAvailabilityClient;
};

function shouldRetryAvailability(error: unknown): boolean {
  if (!(error instanceof EpisodeDiagnosticsApiError)) return true;
  return ![400, 401, 403].includes(error.status ?? 0);
}

export function useEpisodeDiagnosticsAvailability({ diagnosticReference, enabled = __EPISODE_DIAGNOSTICS_ROUTE_ENABLED__, api: apiInput }: EpisodeDiagnosticsAvailabilityOptions): { readonly path?: string; readonly status: AvailabilityState; readonly supported: boolean; readonly retry: () => void } {
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

  const retry = useCallback(() => {
    setRetryAttempt(0);
    setRetryGeneration((current) => current + 1);
  }, []);

  return { path: enabled && availability === "available" ? path : undefined, status: availability, supported: Boolean(path), retry };
}

export function EpisodeDiagnosticsDeveloperLink({ diagnosticReference, enabled = __EPISODE_DIAGNOSTICS_ROUTE_ENABLED__, api }: EpisodeDiagnosticsAvailabilityOptions) {
  const diagnostics = useEpisodeDiagnosticsAvailability({ diagnosticReference, enabled, api });

  if (!enabled || !diagnosticReference || !diagnostics.supported) return null;
  if (diagnostics.status === "checking") {
    return (
      <span className="episode-diagnostics-availability" role="status">
        Checking Episode Debugger availability…
      </span>
    );
  }
  if (diagnostics.status === "unavailable") {
    return (
      <span className="episode-diagnostics-availability" role="status">
        <span>Episode Debugger unavailable.</span>
        <button className="dashboard-button secondary" type="button" onClick={diagnostics.retry}>
          Retry
        </button>
      </span>
    );
  }

  return (
    <a className="dashboard-button secondary" href={diagnostics.path}>
      Inspect diagnostics
    </a>
  );
}
