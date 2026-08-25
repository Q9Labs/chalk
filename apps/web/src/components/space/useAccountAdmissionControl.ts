import type { ChalkAdmissionControl, ChalkAdmissionRequest } from "@q9labsai/chalk-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AccountSpaceCredential, PublicSpaceCredential } from "../../lib/chalk-access";
import { approveSpacePublicAdmissionRequest, denySpacePublicAdmissionRequest, listSpacePublicAdmissionRequests } from "../../lib/dashboard-api";
import type { useWebTelemetry } from "../../lib/web-telemetry-context";

const publicAdmissionPollIntervalMS = 1_000;

export function useAccountAdmissionControl(credential: AccountSpaceCredential | PublicSpaceCredential, journey: ReturnType<typeof useWebTelemetry>["journey"]): ChalkAdmissionControl | undefined {
  const tenantID = "tenantID" in credential ? credential.tenantID : undefined;
  const spaceID = tenantID ? credential.space : undefined;
  const [requests, setRequests] = useState<readonly ChalkAdmissionRequest[]>([]);
  const [loading, setLoading] = useState(Boolean(tenantID));
  const decidedHandles = useRef(new Set<string>());

  useEffect(() => {
    decidedHandles.current.clear();
    if (!tenantID || !spaceID) {
      setRequests([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    let failureReported = false;
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      try {
        const page = await listSpacePublicAdmissionRequests({ tenantID, spaceID });
        if (!cancelled) {
          failureReported = false;
          setRequests(page.requests.filter((request) => !decidedHandles.current.has(request.request_handle)).map((request) => ({ id: request.request_handle, displayName: request.display_name, requestedAt: new Date(request.requested_at) })));
        }
      } catch {
        if (!cancelled && !failureReported) {
          failureReported = true;
          journey.recordDiagnostic({ category: "network", code: "space.public_admission_poll_failed", phase: "signaling", state: "failed" });
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          timer = globalThis.setTimeout(poll, publicAdmissionPollIntervalMS);
        }
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) globalThis.clearTimeout(timer);
    };
  }, [journey, spaceID, tenantID]);

  const decide = useCallback(
    async (requestHandle: string, decision: "admit" | "deny"): Promise<void> => {
      if (!tenantID || !spaceID) throw new Error("Public admission is unavailable for this Space.");
      if (decision === "admit") {
        await approveSpacePublicAdmissionRequest({ tenantID, spaceID, requestHandle });
      } else {
        await denySpacePublicAdmissionRequest({ tenantID, spaceID, requestHandle });
      }
      decidedHandles.current.add(requestHandle);
      setRequests((current) => current.filter((request) => request.id !== requestHandle));
    },
    [spaceID, tenantID],
  );

  return useMemo(
    () =>
      tenantID
        ? {
            requests,
            loading,
            admit: (requestHandle: string) => decide(requestHandle, "admit"),
            deny: (requestHandle: string) => decide(requestHandle, "deny"),
          }
        : undefined,
    [decide, loading, requests, tenantID],
  );
}
