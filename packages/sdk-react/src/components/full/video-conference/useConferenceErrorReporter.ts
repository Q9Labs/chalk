import { createSupportCode, type ChalkError, type ChalkIncidentInput } from "@q9labs/chalk-core";
import { useCallback, useRef, useState, type MutableRefObject } from "react";

import type { Phase } from "./types";

interface SessionLike {
  reportIncident: (payload: ChalkIncidentInput) => Promise<unknown>;
}

export interface UseConferenceErrorReporterParams {
  session: SessionLike;
  onError?: (error: ChalkError) => void;
  roomIdRef: MutableRefObject<string>;
  phaseRef: MutableRefObject<Phase>;
  pushIncidentBreadcrumb: (category: string, message: string, data?: Record<string, unknown>) => void;
}

export interface UseConferenceErrorReporterReturn {
  supportCode: string | null;
  setSupportCode: (supportCode: string | null) => void;
  emitError: (error: ChalkError, details?: Record<string, unknown>) => void;
}

export function useConferenceErrorReporter({ session, onError, roomIdRef, phaseRef, pushIncidentBreadcrumb }: UseConferenceErrorReporterParams): UseConferenceErrorReporterReturn {
  const [supportCode, setSupportCode] = useState<string | null>(null);
  const supportCodeSequenceRef = useRef(0);

  const emitError = useCallback(
    (errorToReport: ChalkError, details?: Record<string, unknown>) => {
      const detailSupportCode = typeof details?.supportCode === "string" ? details.supportCode : undefined;
      const errorSupportCode = typeof errorToReport.details?.supportCode === "string" ? errorToReport.details.supportCode : undefined;
      const resolvedSupportCode =
        detailSupportCode ??
        errorSupportCode ??
        (() => {
          supportCodeSequenceRef.current += 1;
          return createSupportCode(supportCodeSequenceRef.current);
        })();

      const merged: ChalkError = {
        ...errorToReport,
        details: {
          ...(errorToReport.details ?? {}),
          roomId: roomIdRef.current,
          phase: phaseRef.current,
          ...(details ?? {}),
          supportCode: resolvedSupportCode,
        },
      };
      setSupportCode(resolvedSupportCode);
      pushIncidentBreadcrumb("error", "VideoConference error surfaced", {
        supportCode: resolvedSupportCode,
        code: merged.code,
        message: merged.message,
        phase: phaseRef.current,
      });
      onError?.(merged);
      void session.reportIncident({
        id: resolvedSupportCode,
        source: "video_conference",
        severity: "error",
        code: typeof merged.code === "string" ? merged.code : String(merged.code),
        message: merged.message ?? "Unexpected error",
        phase: phaseRef.current,
        stage: typeof merged.details?.stage === "string" ? merged.details.stage : typeof details?.stage === "string" ? details.stage : undefined,
        retryable: typeof merged.details?.retryable === "boolean" ? merged.details.retryable : typeof details?.retryable === "boolean" ? details.retryable : undefined,
        details: merged.details,
      });
    },
    [onError, phaseRef, pushIncidentBreadcrumb, roomIdRef, session],
  );

  return {
    supportCode,
    setSupportCode,
    emitError,
  };
}
