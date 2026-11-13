import type { Toast } from "../toast-stack/ToastStack";
import { useState } from "react";
import { ConnectionRing } from "./ConnectionRing";
import { RECONNECT_NOTICE_MS } from "./use-connection-phase";
import { useElapsedSeconds, useTrueFor } from "../../internal/useTrueFor";

export interface ConnectionStatusProps {
  readonly phase: "reconnecting" | "offline" | "reconnected" | "failed";
  /** When the drop began, by this page's clock. The count on the card starts here, not when the card appears. */
  readonly since: number | null;
  /** Queued chat, named for people ("3 messages"), which will send once the call is back. */
  readonly pending?: string | null;
  readonly onRejoin?: () => void;
  readonly onLeave?: () => void;
  readonly onReportProblem?: () => void;
}

/** After this long offline-or-not, the copy admits it is taking a while. */
const LONG_WAIT_SECONDS = 20;

export const formatElapsed = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

export function reconnectingCopy(phase: "reconnecting" | "offline", seconds: number, pending: string | null | undefined): { readonly title: string; readonly detail: string } {
  const queued = pending ? `${pending} will send when you’re back. ` : "";
  if (phase === "offline") return { title: "You’re offline", detail: `${queued}You’ll rejoin when your connection is back.` };
  if (seconds >= LONG_WAIT_SECONDS) return { title: "Still reconnecting…", detail: `${queued}Check your Wi-Fi or mobile data.` };
  return { title: "Reconnecting…", detail: `${queued}You’ll be back in the call on your own.` };
}

/** The return confirmation joins the bottom notices, so it never drops in over a face at the top of the call. */
export function reconnectedToast(awayMs: number): Toast {
  return { id: "connection-back", type: "success", duration: Infinity, message: `Back in the call · Away ${Math.max(1, Math.round(awayMs / 1000))} s` };
}

/**
 * Everything the call says about a lost link. The header and the stage keep their last picture under one static blur and
 * desaturation with a veil, the card sits at the centre of the call rather than on a tile, and the dock stays sharp and
 * usable above it. When the call comes back the blur drops at once and the veil fades over 300ms.
 */
export function ConnectionStatus({ phase, since, pending, onRejoin, onLeave, onReportProblem }: ConnectionStatusProps) {
  const waiting = phase === "reconnecting" || phase === "offline";
  const cardDue = useTrueFor(waiting, RECONNECT_NOTICE_MS);
  const seconds = useElapsedSeconds(waiting ? since : null);
  const [veiled, setVeiled] = useState(false);
  if (waiting && cardDue && !veiled) setVeiled(true);
  if (!waiting && phase !== "reconnected" && veiled) setVeiled(false);
  const copy = waiting ? reconnectingCopy(phase, seconds, pending) : null;
  return (
    <>
      <style href="chalk-connection-status" precedence="default">
        {STATUS_CSS}
      </style>
      {veiled && phase !== "failed" ? <div aria-hidden="true" data-lifting={phase === "reconnected" || undefined} className="chalk-connection-dim" /> : null}
      {copy && cardDue ? (
        <div role="status" data-part="connection-status" className="chalk-connection-card">
          <h3>
            <ConnectionRing />
            {copy.title}
            <span aria-hidden="true" className="chalk-connection-time">
              {formatElapsed(seconds)}
            </span>
          </h3>
          <p>{copy.detail}</p>
        </div>
      ) : null}
      {phase === "failed" ? (
        <>
          <div aria-hidden="true" className="chalk-connection-dim" />
          <FailedCard onRejoin={onRejoin} onLeave={onLeave} onReportProblem={onReportProblem} />
        </>
      ) : null}
    </>
  );
}

function FailedCard({ onRejoin, onLeave, onReportProblem }: Pick<ConnectionStatusProps, "onRejoin" | "onLeave" | "onReportProblem">) {
  return (
    <div role="alertdialog" aria-labelledby="chalk-connection-lost-title" aria-describedby="chalk-connection-lost-detail" data-part="connection-status" className="chalk-connection-card chalk-connection-card-lost">
      <div>
        <h3 id="chalk-connection-lost-title">Connection lost</h3>
        <p id="chalk-connection-lost-detail">We couldn’t get you back into the call. The call is still going, so you can rejoin.</p>
      </div>
      <div className="chalk-connection-actions">
        {onRejoin ? (
          <button type="button" autoFocus className="chalk-connection-rejoin" onClick={onRejoin}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
            Rejoin
          </button>
        ) : null}
        {onLeave ? (
          <button type="button" className="chalk-connection-leave" onClick={onLeave}>
            Leave
          </button>
        ) : null}
      </div>
      {/* The failure code goes into the report, never onto the card. */}
      {onReportProblem ? (
        <div className="chalk-connection-links">
          <button type="button" onClick={onReportProblem}>
            Report a problem
          </button>
        </div>
      ) : null}
    </div>
  );
}

const STATUS_CSS = `.chalk-connection-dim {position:absolute;inset:0;z-index:70;pointer-events:none;background:color-mix(in srgb, var(--chalk-canvas) 60%, transparent);animation:chalk-connection-veil .3s var(--chalk-ease-out-expo, ease-out) both;}
.chalk-frame:has(.chalk-connection-dim:not([data-lifting])) > :is(.chalk-frame-header, .chalk-frame-stage) {filter:blur(10px) saturate(0);}
.chalk-frame:has(.chalk-connection-dim) > .chalk-frame-dock {z-index:72;}
.chalk-connection-dim[data-lifting] {animation:chalk-connection-veil .3s ease-out reverse forwards;}
@keyframes chalk-connection-veil {from {opacity:0;}}
.chalk-connection-card {position:absolute;z-index:71;left:50%;top:50%;transform:translate(-50%,-50%);width:max-content;max-width:calc(100% - 32px);display:grid;justify-items:center;gap:var(--space-1-5);padding:var(--space-5) var(--space-6);border-radius:var(--corner-2xl);background:var(--chalk-surface);border:1px solid var(--chalk-line);box-shadow:var(--chalk-shadow);color:var(--chalk-text);text-align:center;pointer-events:none;animation:chalk-connection-veil .3s var(--chalk-ease-out-expo, ease-out) both;}
.chalk-connection-card h3 {display:flex;gap:var(--space-2-5);align-items:center;font-size:var(--type-lead);font-weight:600;line-height:1.3;}
.chalk-connection-card h3 .chalk-connection-ring {width:20px;height:20px;}
.chalk-connection-time {color:var(--chalk-muted-text);font-weight:400;font-size:var(--type-body);font-variant-numeric:tabular-nums;}
.chalk-connection-card p {color:var(--chalk-muted-text);font-size:var(--type-body-sm);line-height:1.45;text-wrap:balance;}
.chalk-connection-card-lost {display:flex;flex-direction:column;align-items:stretch;gap:var(--space-3);width:min(360px, calc(100% - 32px));padding:var(--space-5);text-align:start;pointer-events:auto;}
.chalk-connection-card-lost h3 {font-size:var(--type-lead);}
.chalk-connection-card-lost p {margin-top:var(--space-0-5);text-wrap:pretty;}
.chalk-connection-actions {display:flex;gap:var(--space-2);margin-top:var(--space-1);}
.chalk-connection-actions button {height:40px;padding:0 var(--space-4);border-radius:var(--corner-pill);font-weight:600;font-size:var(--type-body);display:inline-flex;align-items:center;justify-content:center;gap:var(--space-2);}
.chalk-connection-rejoin {flex:1;background:var(--chalk-text);color:var(--chalk-canvas);}
.chalk-connection-leave {background:var(--chalk-hover);}
.chalk-connection-links {display:grid;justify-items:center;margin-top:var(--space-1);color:var(--chalk-muted-text);font-size:var(--type-caption);}
.chalk-connection-links button {text-decoration:underline;text-underline-offset:3px;}
@media (prefers-reduced-motion: reduce) {.chalk-connection-dim,.chalk-connection-dim[data-lifting],.chalk-connection-card {animation-duration:.01s;}}
[data-connection-lost] [data-part="dock-region"] button:not([aria-label="Leave call"]) {opacity:.38;pointer-events:none;}
`;
