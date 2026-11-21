import type { Toast } from "../toast-stack/ToastStack";
import { useEffect, useRef, useState } from "react";
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
  const failed = phase === "failed";
  const cardDue = useTrueFor(waiting, RECONNECT_NOTICE_MS);
  const seconds = useElapsedSeconds(waiting ? since : null);
  const [veiled, setVeiled] = useState(false);
  if ((failed || (waiting && cardDue)) && !veiled) setVeiled(true);
  if (!waiting && !failed && phase !== "reconnected" && veiled) setVeiled(false);
  const copy = waiting ? reconnectingCopy(phase, seconds, pending) : null;
  const showCard = failed || (copy !== null && (cardDue || veiled));
  // Reconnecting, offline and lost are one veil and one card that change in place, so losing the call never replays the fade or the entrance.
  return (
    <>
      <style href="chalk-connection-status" precedence="default">
        {STATUS_CSS}
      </style>
      {veiled ? <div aria-hidden="true" data-lifting={phase === "reconnected" || undefined} className="chalk-connection-dim" /> : null}
      {showCard ? (
        <div
          role={failed ? "alertdialog" : "status"}
          aria-labelledby={failed ? "chalk-connection-lost-title" : undefined}
          aria-describedby={failed ? "chalk-connection-lost-detail" : undefined}
          data-part="connection-status"
          className={failed ? "chalk-connection-card chalk-connection-card-lost" : "chalk-connection-card"}
        >
          {failed ? (
            <FailedContent onRejoin={onRejoin} onLeave={onLeave} onReportProblem={onReportProblem} />
          ) : copy ? (
            <>
              <h3>
                <ConnectionRing />
                {copy.title}
                <span aria-hidden="true" className="chalk-connection-time">
                  {formatElapsed(seconds)}
                </span>
              </h3>
              <p>{copy.detail}</p>
            </>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function FailedContent({ onRejoin, onLeave, onReportProblem }: Pick<ConnectionStatusProps, "onRejoin" | "onLeave" | "onReportProblem">) {
  const content = useRef<HTMLDivElement>(null);
  // The card's own button is what holds focus, so when it goes (Rejoin pressed, or the call returned) focus moves to the dock's Leave button instead of dropping to the page.
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [resource] Hand focus to a stable call control when the focused button leaves the page.
  useEffect(() => {
    const frame = content.current?.closest(".chalk-frame");
    return () => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      frame?.querySelector<HTMLElement>('[data-part="dock-region"] button[aria-label="Leave call"]')?.focus();
    };
  }, []);
  return (
    <div ref={content} style={{ display: "contents" }}>
      <h3 id="chalk-connection-lost-title">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7.5v5.5M12 16.5h.01" />
        </svg>
        Connection lost
      </h3>
      <p id="chalk-connection-lost-detail">We couldn’t get you back into the call. It’s still going, so you can rejoin.</p>
      {onRejoin ? (
        <button type="button" autoFocus className="chalk-connection-rejoin" onClick={onRejoin}>
          Rejoin
        </button>
      ) : null}
      {onLeave || onReportProblem ? (
        <div className="chalk-connection-links">
          {onLeave ? (
            <button type="button" onClick={onLeave}>
              Leave call
            </button>
          ) : null}
          {onReportProblem ? (
            <button type="button" onClick={onReportProblem}>
              Report a problem
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const STATUS_CSS = `.chalk-connection-dim {position:absolute;inset:0;z-index:70;background:color-mix(in srgb, var(--chalk-canvas) 60%, transparent);animation:chalk-connection-veil .3s var(--chalk-ease-out-expo, ease-out) both;}
.chalk-frame:has(.chalk-connection-dim:not([data-lifting])) > :is(.chalk-frame-header, .chalk-frame-stage) {filter:blur(10px) saturate(0);}
.chalk-frame:has(.chalk-connection-dim) > .chalk-frame-dock {z-index:72;}
.chalk-connection-dim[data-lifting] {animation:chalk-connection-veil .3s ease-out reverse forwards;}
@keyframes chalk-connection-veil {from {opacity:0;}}
.chalk-connection-card {position:absolute;z-index:71;left:50%;top:50%;transform:translate(-50%,-50%);width:max-content;max-width:calc(100% - 32px);display:grid;justify-items:center;gap:var(--space-1-5);padding:var(--space-5) var(--space-6);border-radius:var(--corner-2xl);background:var(--chalk-surface);border:1px solid var(--chalk-line);box-shadow:var(--chalk-shadow);color:var(--chalk-text);text-align:center;animation:chalk-connection-veil .3s var(--chalk-ease-out-expo, ease-out) both;}
.chalk-connection-dim.chalk-connection-dim,
.chalk-connection-card:not(.chalk-connection-card-lost) {pointer-events:none;}
.chalk-connection-card h3 {display:flex;gap:var(--space-2-5);align-items:center;font-size:var(--type-lead);font-weight:600;line-height:1.3;}
.chalk-connection-card h3 .chalk-connection-ring {width:20px;height:20px;}
.chalk-connection-time {color:var(--chalk-muted-text);font-weight:400;font-size:var(--type-body);font-variant-numeric:tabular-nums;}
.chalk-connection-card p {color:var(--chalk-muted-text);font-size:var(--type-body-sm);line-height:1.45;text-wrap:balance;}
.chalk-connection-card-lost {width:min(340px, calc(100% - 32px));gap:var(--space-2);pointer-events:auto;}
.chalk-connection-card-lost h3 svg {flex:none;color:var(--chalk-muted-text);}
.chalk-connection-rejoin {justify-self:stretch;height:44px;margin-top:var(--space-2);border-radius:var(--corner-pill);background:var(--chalk-text);color:var(--chalk-canvas);font-size:var(--type-body);font-weight:600;}
.chalk-connection-links {display:flex;flex-wrap:wrap;justify-content:center;gap:var(--space-1) var(--space-2);}
.chalk-connection-links button {min-height:36px;padding:0 var(--space-3);border-radius:var(--corner-pill);color:var(--chalk-muted-text);font-size:var(--type-body-sm);font-weight:500;}
.chalk-connection-links button:hover {background:var(--chalk-hover);color:var(--chalk-text);}
.chalk-connection-card-lost button {outline:none;box-shadow:none;}
.chalk-connection-card-lost button:focus-visible {outline:2px solid var(--chalk-text);outline-offset:2px;}
@media (prefers-reduced-motion: reduce) {.chalk-connection-dim,.chalk-connection-dim[data-lifting],.chalk-connection-card {animation-duration:.01s;}}
[data-connection-lost] [data-part="dock-region"] button:not([aria-label="Leave call"]) {opacity:.38;pointer-events:none;}
`;
