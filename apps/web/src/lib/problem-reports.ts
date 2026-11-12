import { useEffect, useState } from "react";
import { Schema } from "effect";
import { currentSessionId, lastFailedRequest, withRequestContext, type SpaceClient } from "@q9labsai/chalk-client";
import type { ChalkProps } from "@q9labsai/chalk-react";

const apiFetch = withRequestContext();
export type ReportProblem = NonNullable<ChalkProps["onReportProblem"]>;
type ReportConnection = Pick<ReturnType<SpaceClient["getSnapshot"]>["connection"], "lastError"> & { readonly status: string };
export const reportCredentialExpiredReason = "Your call access has expired, so this report cannot be sent. You can copy your text before closing.";
const reportsOffReason = "Reporting is temporarily unavailable. Your draft is kept here.";

/** Why a report cannot be sent right now, or nothing. "Report a problem" stays visible either way, and the dialog says why it cannot send. */
export function reportUnavailableReason(reportsAvailable: boolean, credentialExpired: boolean): string | undefined {
  if (credentialExpired) return reportCredentialExpiredReason;
  return reportsAvailable ? undefined : reportsOffReason;
}
const parseAvailability = Schema.decodeUnknownSync(Schema.Struct({ available: Schema.Boolean }));

export function useReportCredentialExpired(expiresAt: number | undefined) {
  const [expiredAt, setExpiredAt] = useState<number>();
  useEffect(() => {
    if (expiresAt === undefined) return;
    const timer = globalThis.setTimeout(() => setExpiredAt(expiresAt), Math.max(0, expiresAt - Date.now()));
    return () => globalThis.clearTimeout(timer);
  }, [expiresAt]);
  return expiresAt !== undefined && (expiredAt === expiresAt || expiresAt <= Date.now());
}

/**
 * Whether reports can be sent. It stays true until the server answers that reports are off, so a slow or
 * failed probe never blocks a send. A failed probe retries, and a send that fails shows its own error.
 */
export function useProblemReports(baseURL: string, tenantId: string | undefined) {
  const [refused, setRefused] = useState(false);
  useEffect(() => {
    setRefused(false);
    if (!tenantId) return;
    const controller = new AbortController();
    let retryDelay = 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let activeProbe: AbortController | undefined;
    const retry = () => {
      timer = setTimeout(() => {
        void probe();
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 60_000);
    };
    const probe = async () => {
      clearTimeout(timer);
      activeProbe?.abort();
      const attempt = new AbortController();
      activeProbe = attempt;
      try {
        const response = await apiFetch(`${baseURL.replace(/\/$/, "")}/v1/tenants/${encodeURIComponent(tenantId)}/problem-reports/availability`, { signal: AbortSignal.any([controller.signal, attempt.signal, AbortSignal.timeout(5000)]) });
        if (!response.ok) throw new Error("Availability probe failed");
        const enabled = parseAvailability(await response.json()).available;
        if (!controller.signal.aborted && !attempt.signal.aborted) setRefused(!enabled);
      } catch {
        if (!controller.signal.aborted && !attempt.signal.aborted) retry();
      }
    };
    const online = () => {
      retryDelay = 1000;
      void probe();
    };
    window.addEventListener("online", online);
    void probe();
    return () => {
      controller.abort();
      activeProbe?.abort();
      clearTimeout(timer);
      window.removeEventListener("online", online);
    };
  }, [baseURL, tenantId]);
  return !refused;
}

function failedRequestLine(): string {
  const failed = lastFailedRequest();
  return failed ? `${failed.journeyId} (HTTP ${failed.status})` : "none";
}

export function problemReporter({ baseURL, tenantId, mediaProof, connection }: { readonly baseURL: string; readonly tenantId: string | undefined; readonly mediaProof: () => string | undefined; readonly connection: () => ReportConnection }): ReportProblem {
  return async ({ description, diagnostics }) => {
    const credential = mediaProof();
    const snapshot = connection();
    if (!credential || !tenantId) throw new Error("Join the call before sending a report.");
    const response = await apiFetch(`${baseURL.replace(/\/$/, "")}/v1/tenants/${encodeURIComponent(tenantId)}/problem-reports`, {
      method: "POST",
      signal: AbortSignal.timeout(12000),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential}` },
      body: JSON.stringify({
        description,
        ...(diagnostics === undefined
          ? {}
          : {
              diagnostics: [`Connection: ${snapshot.status}`, `Last error: ${snapshot.lastError?.code ?? "none"}`, `App version: ${__APP_VERSION__}`, `Session: ${currentSessionId() ?? "none"}`, `Last failed request: ${failedRequestLine()}`, `Browser: ${navigator.userAgent.slice(0, 400)}`].join(
                "\n",
              ),
            }),
      }),
    });
    if (!response.ok) {
      throw new Error("Your report could not be sent. Try again.");
    }
  };
}
