import { currentSessionId, formatFailureReference, lastFailedRequest, withRequestContext, type AppTelemetry, type SpaceClient } from "@q9labsai/chalk-client";
import { apiUrls } from "@q9labsai/chalk-client/effect";
import type { ChalkProps } from "@q9labsai/chalk-react";

const apiFetch = withRequestContext();
export type ReportProblem = NonNullable<ChalkProps["onReportProblem"]>;
type ReportConnection = Pick<ReturnType<SpaceClient["getSnapshot"]>["connection"], "lastError"> & { readonly status: string };

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
}: {
  readonly telemetry?: Pick<AppTelemetry, "sessionId" | "problemReported">;
  readonly baseURL: string;
  readonly tenantId: string | undefined;
  readonly mediaProof: () => string | undefined;
  readonly connection: () => ReportConnection;
}): ReportProblem {
  return async ({ description, diagnostics }) => {
    const credential = mediaProof();
    const snapshot = connection();
    const reference = formatFailureReference(snapshot.lastError);
    if (!credential || !tenantId) throw new Error("Join the call before sending a report.");
    const response = await apiFetch(apiUrls.problemReports(baseURL, tenantId), {
      method: "POST",
      signal: AbortSignal.timeout(12000),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential}` },
      body: JSON.stringify({
        description,
        // The error line holds no personal data and the call screens no longer print it, so every report carries it; the rest follows the "Include diagnostics" choice.
        ...(diagnostics === undefined && !reference
          ? {}
          : {
              diagnostics: [
                reference,
                ...(diagnostics === undefined
                  ? []
                  : [`Connection: ${snapshot.status}`, `App version: ${__APP_VERSION__}`, `Session: ${currentSessionId() ?? "none"}`, `Client session: ${telemetry?.sessionId || "none"}`, `Last failed request: ${failedRequestLine()}`, `Browser: ${navigator.userAgent.slice(0, 400)}`]),
              ]
                .filter(Boolean)
                .join("\n"),
            }),
      }),
    });
    if (!response.ok) {
      throw new Error("Your report could not be sent. Try again.");
    }
    telemetry?.problemReported();
  };
}
