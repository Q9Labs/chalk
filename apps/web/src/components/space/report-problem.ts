import { useCallback, useState, useSyncExternalStore } from "react";
import { publicAPIBaseURL } from "../../lib/chalk-access";
import { reportCredentialExpiredReason, useProblemReports, useReportCredentialExpired, type ReportProblem } from "../../lib/problem-reports";
import type { Entrance } from "./entrance-machine";

/**
 * The problem report a participant can send from the call or the leave screen. During the call the report rides on the live
 * session's access; on the leave screen it rides on the ended call's.
 */
export function useSpaceReport(entrance: Entrance) {
  const [open, setOpen] = useState(false);
  const [fromCall, setFromCall] = useState<{ readonly send: ReportProblem; readonly diagnostics: string } | null>(null);
  const session = entrance.phase === "admitted" ? entrance.joined.session : undefined;
  const ended = entrance.phase === "ended" ? entrance.call : undefined;
  const subscribe = useCallback((listener: () => void) => session?.subscribe(listener) ?? (() => undefined), [session]);
  const readLiveExpiresAt = useCallback(() => session?.mediaExpiresAt(), [session]);
  const liveExpiresAt = useSyncExternalStore(subscribe, readLiveExpiresAt, readLiveExpiresAt);
  const expired = useReportCredentialExpired(ended?.reportExpiresAt ?? liveExpiresAt);
  const available = useProblemReports(publicAPIBaseURL(), session?.reloadMarker().tenantId ?? ended?.tenantId);
  const openFromCall = useCallback((send: ReportProblem, diagnostics: string) => {
    setFromCall({ send, diagnostics });
    setOpen(true);
  }, []);
  return {
    open,
    setOpen,
    openFromCall,
    available,
    expired,
    send: ended?.reportProblem ?? fromCall?.send,
    diagnostics: ended ? `Connection: ${ended.phase}\nLast error: ${ended.failure?.code ?? "none"}` : (fromCall?.diagnostics ?? ""),
    unavailableReason: expired ? reportCredentialExpiredReason : !available ? "Reporting is temporarily unavailable. Your draft is kept here." : undefined,
  };
}
