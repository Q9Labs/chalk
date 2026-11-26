import { useEffect, useState } from "react";
import { Schema } from "effect";
import { withRequestContext } from "@q9labsai/chalk-client";
import { apiUrls } from "@q9labsai/chalk-client/effect";
import { backoffMs } from "./backoff";

export type { ReportProblem } from "./send-problem-report";

const apiFetch = withRequestContext();
export const reportCredentialExpiredReason = "Your call access has expired, so this report cannot be sent. You can copy your text before closing.";
const parseAvailability = Schema.decodeUnknownSync(Schema.Struct({ available: Schema.Boolean }));

export function useReportCredentialExpired(expiresAt: number | undefined) {
  const [expiredAt, setExpiredAt] = useState<number>();
  useEffect(() => {
    setExpiredAt(undefined);
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
