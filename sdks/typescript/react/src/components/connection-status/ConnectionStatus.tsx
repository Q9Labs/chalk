import { ConnectionRing } from "./ConnectionRing";
import { RECONNECT_NOTICE_MS } from "./use-connection-phase";
import { useElapsedSeconds, useTrueFor } from "../../internal/useTrueFor";

export interface ConnectionStatusProps {
  readonly phase: "reconnecting" | "offline" | "reconnected" | "failed";
  /** When the drop began, by this page's clock. The count on the card starts here, not when the card appears. */
  readonly since: number | null;
  /** How long the person was away; the "Back in the call" confirmation says it. */
  readonly awayMs?: number;
  /** Queued chat, named for people ("3 messages"), which will send once the call is back. */
  readonly pending?: string | null;
  /** The code that identifies a failure for support. */
  readonly errorCode?: string;
  readonly onRejoin?: () => void;
  readonly onLeave?: () => void;
  readonly onReportProblem?: () => void;
}

/** After this long offline-or-not, the copy admits it is taking a while. */
const LONG_WAIT_SECONDS = 20;

export const formatElapsed = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

export function reconnectingCopy(phase: "reconnecting" | "offline", seconds: number, pending: string | null | undefined): { readonly title: string; readonly detail: string } {
  const queued = pending ? `${pending} will send when you’re back. ` : "";
  if (phase === "offline") return { title: "You’re offline", detail: `${queued}You’ll rejoin as soon as your connection is back.` };
  if (seconds >= LONG_WAIT_SECONDS) return { title: "Still reconnecting…", detail: `${queued}People can’t see or hear you yet. Check your Wi-Fi or mobile data.` };
  return { title: "Reconnecting…", detail: `${queued}You’ll be back in the call on your own.` };
}

/**
 * Everything the call says about a lost link. The stage keeps its last picture, dimmed, and the dock stays
 * usable, so this is one calm card, one confirmation, or (after a failure) one card with a way back.
 */
export function ConnectionStatus({ phase, since, awayMs = 0, pending, errorCode, onRejoin, onLeave, onReportProblem }: ConnectionStatusProps) {
  const waiting = phase === "reconnecting" || phase === "offline";
  const cardDue = useTrueFor(waiting, RECONNECT_NOTICE_MS);
  const seconds = useElapsedSeconds(waiting ? since : null);
  return (
    <>
      <style href="chalk-connection-status" precedence="default">
        {STATUS_CSS}
      </style>
      {waiting && cardDue ? (
        <>
          <div aria-hidden="true" className="chalk-connection-dim" />
          <div role="status" data-part="connection-status" className="chalk-connection-card">
            <ConnectionRing />
            <div>
              <h3>
                {reconnectingCopy(phase, seconds, pending).title}
                <span aria-hidden="true" className="chalk-connection-time">
                  {formatElapsed(seconds)}
                </span>
              </h3>
              <p>{reconnectingCopy(phase, seconds, pending).detail}</p>
            </div>
          </div>
        </>
      ) : null}
      {phase === "reconnected" ? (
        <div role="status" data-part="connection-status" className="chalk-connection-toast">
          <span className="chalk-connection-toast-ok" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
              <path d="m5 12 5 5 9-10" />
            </svg>
          </span>
          Back in the call
          <small>Away {Math.max(1, Math.round(awayMs / 1000))} s</small>
        </div>
      ) : null}
      {phase === "failed" ? (
        <>
          <div aria-hidden="true" className="chalk-connection-dim" />
          <FailedCard errorCode={errorCode} onRejoin={onRejoin} onLeave={onLeave} onReportProblem={onReportProblem} />
        </>
      ) : null}
    </>
  );
}

function FailedCard({ errorCode, onRejoin, onLeave, onReportProblem }: Pick<ConnectionStatusProps, "errorCode" | "onRejoin" | "onLeave" | "onReportProblem">) {
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
      <div className="chalk-connection-links">
        {onReportProblem ? (
          <button type="button" onClick={onReportProblem}>
            Report a problem
          </button>
        ) : null}
        {errorCode ? <code dir="ltr">{errorCode}</code> : null}
      </div>
    </div>
  );
}

const STATUS_CSS = `.chalk-connection-dim {position:absolute;inset:0;z-index:40;pointer-events:none;background:color-mix(in srgb, var(--chalk-canvas) 50%, transparent);backdrop-filter:saturate(.55);}
.chalk-connection-card {position:absolute;z-index:41;left:50%;top:50%;transform:translate(-50%,-50%);width:min(340px, calc(100% - 32px));display:flex;align-items:flex-start;gap:var(--space-3);padding:var(--space-4) var(--space-5) var(--space-4) var(--space-4);border-radius:var(--corner-2xl);background:var(--chalk-surface);border:1px solid var(--chalk-line-strong);box-shadow:var(--chalk-shadow);color:var(--chalk-text);pointer-events:none;}
.chalk-connection-card .chalk-connection-ring {margin-top:1px;}
.chalk-connection-card h3 {display:flex;gap:var(--space-2);align-items:baseline;font-size:var(--type-body-lg);font-weight:600;line-height:1.3;}
.chalk-connection-time {color:var(--chalk-muted-text);font-weight:400;font-size:var(--type-body-sm);font-variant-numeric:tabular-nums;}
.chalk-connection-card p {margin-top:var(--space-0-5);color:var(--chalk-muted-text);font-size:var(--type-body-sm);line-height:1.45;}
.chalk-connection-card-lost {flex-direction:column;align-items:stretch;gap:var(--space-3);width:min(360px, calc(100% - 32px));padding:var(--space-5);pointer-events:auto;}
.chalk-connection-card-lost h3 {font-size:var(--type-lead);}
.chalk-connection-actions {display:flex;gap:var(--space-2);margin-top:var(--space-1);}
.chalk-connection-actions button {height:40px;padding:0 var(--space-4);border-radius:var(--corner-pill);font-weight:600;font-size:var(--type-body);display:inline-flex;align-items:center;justify-content:center;gap:var(--space-2);}
.chalk-connection-rejoin {flex:1;background:var(--chalk-text);color:var(--chalk-canvas);}
.chalk-connection-leave {background:var(--chalk-hover);}
.chalk-connection-links {display:grid;justify-items:center;gap:var(--space-1-5);margin-top:var(--space-1);color:var(--chalk-muted-text);font-size:var(--type-caption);}
.chalk-connection-links button {text-decoration:underline;text-underline-offset:3px;}
.chalk-connection-links code {color:var(--chalk-faint-text);user-select:text;}
.chalk-connection-toast {position:absolute;z-index:42;left:50%;top:var(--space-2);transform:translateX(-50%);display:inline-flex;align-items:center;gap:var(--space-2-5);height:40px;padding:0 var(--space-4) 0 var(--space-2-5);border-radius:var(--corner-pill);background:var(--chalk-popover);border:1px solid var(--chalk-line-strong);box-shadow:var(--chalk-shadow);color:var(--chalk-text);font-size:var(--type-body-sm);font-weight:600;white-space:nowrap;pointer-events:none;}
.chalk-connection-toast-ok {width:22px;height:22px;border-radius:50%;display:grid;place-items:center;background:var(--chalk-tint-positive);color:var(--chalk-positive);}
.chalk-connection-toast small {color:var(--chalk-muted-text);font-weight:400;font-size:var(--type-body-sm);}
[data-connection-lost] [data-part="dock-region"] button:not([aria-label="Leave call"]) {opacity:.38;pointer-events:none;}
`;
