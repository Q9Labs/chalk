import { useEffect, useState } from "react";

/** Most drops recover within a second or two, so nothing about a drop shows before this long. */
export const RECONNECT_NOTICE_MS = 2_000;
/** How long "Back in the call" stays up. */
export const RECONNECTED_TOAST_MS = 3_000;

export type ConnectionPhase = { readonly kind: "live" } | { readonly kind: "reconnecting"; readonly since: number } | { readonly kind: "reconnected"; readonly awayMs: number } | { readonly kind: "failed" };

type Status = "idle" | "joining" | "live" | "reconnecting" | "failed" | "leaving" | "left";

/**
 * What the person should see about the link to the call, counted by this page's own clock. A drop that
 * recovers in under 2 s never shows, so the "Back in the call" toast only follows a card that was shown.
 */
export function nextPhase(current: ConnectionPhase, status: Status, now: number): ConnectionPhase {
  if (status === "reconnecting") return current.kind === "reconnecting" ? current : { kind: "reconnecting", since: now };
  if (status === "failed") return current.kind === "failed" ? current : { kind: "failed" };
  if (status === "live" && current.kind === "reconnecting" && now - current.since >= RECONNECT_NOTICE_MS) return { kind: "reconnected", awayMs: now - current.since };
  if (status === "live" && current.kind === "reconnected") return current;
  return current.kind === "live" ? current : { kind: "live" };
}

export function useConnectionPhase(status: Status): ConnectionPhase {
  const [phase, setPhase] = useState<ConnectionPhase>({ kind: "live" });
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-ts -- [transition] Follow the committed connection status with a page-clock timestamp; the phase only changes when the status does.
  useEffect(() => {
    setPhase((current) => nextPhase(current, status, Date.now()));
  }, [status]);
  const reconnected = phase.kind === "reconnected";
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-ts -- [timer] Hide the confirmation after its time; cancel the timeout when the phase changes.
  useEffect(() => {
    if (!reconnected) return;
    const timer = setTimeout(() => setPhase({ kind: "live" }), RECONNECTED_TOAST_MS);
    return () => clearTimeout(timer);
  }, [reconnected]);
  return phase;
}
