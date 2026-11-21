import { useEffect, useState } from "react";
import { Schema } from "effect";
import { buildDiagnosticBundle, ClassifiedError, currentSessionId, lastFailedRequest, newSessionId, uploadDiagnosticBundle, withRequestContext, type AppTelemetry, type Classification, type DiagnosticBundleState, type EventFields, type SpaceClient } from "@q9labsai/chalk-client";
import { apiUrls } from "@q9labsai/chalk-client/effect";
import type { ChalkProps, ReportProblemInput } from "@q9labsai/chalk-react";
import { backoffMs } from "./backoff";

const apiFetch = withRequestContext();
export type ReportProblem = NonNullable<ChalkProps["onReportProblem"]>;
const parseStoredReport = Schema.decodeUnknownSync(Schema.Struct({ sent: Schema.Literal(true), report_id: Schema.String, code: Schema.String }));
/** Classifies the `problem_report.send` outcome and carries its journey to the `report.dialog` send_failed surface. */
export class ReportSendError extends ClassifiedError {
  readonly journeyId: string;
  constructor(classification: Classification, journeyId: string, cause?: unknown) {
    super(classification, cause);
    this.journeyId = journeyId;
  }
}
type SendScope = { readonly set: (fields: Partial<EventFields["problem_report.send"]>) => void };
type ReportConnection = Pick<ReturnType<SpaceClient["getSnapshot"]>["connection"], "lastError"> & { readonly status: string };
export const reportCredentialExpiredReason = "Your call access has expired, so this report cannot be sent. You can copy your text before closing.";
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
 * Whether the call should offer "Report a problem". It stays true until the server answers that reports are
 * off, so a slow or failed probe never hides the item. A failed probe retries, and a send that fails shows its own error.
 */
export function useProblemReports(baseURL: string, tenantId: string | undefined) {
  const [refused, setRefused] = useState(false);
  useEffect(() => {
    setRefused(false);
    if (!tenantId) return;
    const controller = new AbortController();
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let activeProbe: AbortController | undefined;
    const retry = () => {
      failures += 1;
      timer = setTimeout(
        () => {
          void probe();
        },
        backoffMs(failures, 1000, 60_000),
      );
    };
    const probe = async () => {
      clearTimeout(timer);
      activeProbe?.abort();
      const attempt = new AbortController();
      activeProbe = attempt;
      try {
        const response = await apiFetch(apiUrls.problemReportAvailability(baseURL, tenantId), { signal: AbortSignal.any([controller.signal, attempt.signal, AbortSignal.timeout(5000)]) });
        if (!response.ok) throw new Error("Availability probe failed");
        const enabled = parseAvailability(await response.json()).available;
        if (!controller.signal.aborted && !attempt.signal.aborted) setRefused(!enabled);
      } catch {
        if (!controller.signal.aborted && !attempt.signal.aborted) retry();
      }
    };
    const online = () => {
      failures = 0;
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

export function problemReporter({
  baseURL,
  tenantId,
  mediaProof,
  connection,
  telemetry,
  identity,
}: {
  readonly telemetry?: Pick<AppTelemetry, "sessionId" | "sdkVersion" | "problemReported" | "obs">;
  readonly baseURL: string;
  readonly tenantId: string | undefined;
  readonly mediaProof: () => string | undefined;
  readonly connection: () => ReportConnection;
  /** The participant and episode the report and its diagnostic bundle name; the session's reload marker supplies them. */
  readonly identity?: () => { readonly participantId?: string; readonly episodeId?: string } | undefined;
}): ReportProblem {
  const send = async ({ description, diagnostics, pickedSymptom }: ReportProblemInput) => {
    const snapshot = connection();
    const journeyId = newSessionId();
    const symptom = pickedSymptom ?? "unavailable(not_picked)";
    const run = async (scope: SendScope) => {
      const credential = mediaProof();
      if (!credential || !tenantId) throw new ReportSendError({ outcome: "error", code: "report.no_credential" }, journeyId);
      let response: Response;
      try {
        response = await apiFetch(apiUrls.problemReports(baseURL, tenantId), {
          method: "POST",
          signal: AbortSignal.timeout(12000),
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential}` },
          body: JSON.stringify({
            description,
            journey_id: journeyId,
            picked_symptom: symptom,
            // The durable row names the telemetry outbox session (cs_), never the baggage session id.
            client_session_id: telemetry?.sessionId || undefined,
            sdk_version: telemetry?.sdkVersion || undefined,
            ...(diagnostics === undefined
              ? {}
              : {
                  diagnostics: [
                    `Connection: ${snapshot.status}`,
                    `Last error: ${snapshot.lastError?.code ?? "none"}`,
                    `App version: ${__APP_VERSION__}`,
                    `Session: ${currentSessionId() ?? "none"}`,
                    `Client session: ${telemetry?.sessionId || "none"}`,
                    `Last failed request: ${failedRequestLine()}`,
                    `Browser: ${navigator.userAgent.slice(0, 400)}`,
                  ].join("\n"),
                }),
          }),
        });
      } catch (error) {
        throw new ReportSendError({ outcome: "error", code: error instanceof DOMException && error.name === "TimeoutError" ? "report.timeout" : "report.network" }, journeyId, error);
      }
      scope.set({ http_status: response.status });
      if (!response.ok) throw new ReportSendError({ outcome: "error", code: "report.send_refused" }, journeyId);
      try {
        const stored = parseStoredReport(await response.json());
        scope.set({ report_id: stored.report_id, chk_code: stored.code });
        return stored;
      } catch (error) {
        throw new ReportSendError({ outcome: "error", code: "report.send_refused" }, journeyId, error);
      }
    };
    const stored = telemetry?.obs ? await telemetry.obs.op("problem_report.send", { journey_id: journeyId, picked_symptom: symptom }, run) : await run({ set: () => undefined });
    telemetry?.problemReported({ journeyId, reportId: stored.report_id, code: stored.code, pickedSymptom: symptom });
    // The stored report now owns one diagnostic bundle; the dialog shows Sent while the upload runs.
    const ids = identity?.();
    const state: DiagnosticBundleState = {
      connection_status: snapshot.status,
      client_session_id: telemetry?.sessionId || "unavailable(no_outbox)",
      participant_id: ids?.participantId || "unavailable(no_participant)",
      episode_id: ids?.episodeId || "unavailable(no_episode)",
      sdk_version: telemetry?.sdkVersion || "unavailable(no_sdk_version)",
      ...(snapshot.lastError?.code ? { last_error_code: snapshot.lastError.code } : {}),
      app_version: __APP_VERSION__,
      ...(telemetry?.obs?.flagsHash() ? { flags_hash: telemetry.obs.flagsHash()! } : {}),
    };
    if (tenantId)
      void uploadDiagnosticBundle({
        apiBaseURL: baseURL,
        tenantId,
        credential: () => mediaProof(),
        request: { trigger: "report", reportId: stored.report_id },
        bundle: () => buildDiagnosticBundle({ state }),
        obs: telemetry?.obs,
      }).catch(() => undefined);
    return { code: stored.code, journeyId };
  };
  return Object.assign(send, { observe: telemetry?.obs?.surface });
}
