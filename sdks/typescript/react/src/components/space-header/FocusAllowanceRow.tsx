import { useEffect, useId, useState } from "react";
import { ChalkButton } from "../chalk-ui";
import { ShellIcon } from "../control-bar/ShellIcon";
import { FOCUS_COPY } from "../focus/focus-copy";
import { RowIcon } from "./RowIcon";
import type { CallHostControls } from "./space-header-contract";

const DURATIONS = [5, 10, 20] as const;

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/** Seconds left of the allowance this tab opened, ticking once a second; undefined when the tab doesn't know the end. */
function useSecondsLeft(until: { readonly endsAtMs: number } | undefined) {
  const [now, setNow] = useState(() => Date.now());
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [timer] Refresh the allowance clock each second; clear the interval when the allowance ends or changes.
  useEffect(() => {
    if (!until) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [until]);
  return until ? Math.max(0, Math.ceil((until.endsAtMs - now) / 1000)) : undefined;
}

/**
 * The host's "Allow other tabs" row. It opens like the QR code row, and its controls are the ones the rest of the menu uses:
 * pill buttons on the menu surface, with no inner box.
 */
export function FocusAllowanceRow({ allowance }: { readonly allowance: NonNullable<CallHostControls["focusAllowance"]> }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelId = useId();
  const secondsLeft = useSecondsLeft(allowance.until);
  const total = allowance.until ? allowance.until.minutes * 60 : 0;
  const value = !allowance.active ? FOCUS_COPY.allowanceOff : secondsLeft === undefined ? FOCUS_COPY.allowed : FOCUS_COPY.timeLeft(clock(secondsLeft));
  const run = (action: () => Promise<void>) => {
    setError(null);
    action().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Couldn’t change the allowance."));
  };

  return (
    <>
      <button type="button" className="chalk-shell-detail-action" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)}>
        <span className="chalk-shell-detail-lead">
          <RowIcon name="window" />
        </span>
        <span className="chalk-shell-detail-label">{FOCUS_COPY.allowOtherTabs}</span>
        <span className="chalk-shell-detail-trail chalk-focus-allowance-value" data-active={allowance.active || undefined}>
          {value}
          <ShellIcon name={open ? "up2" : "down"} size={16} />
        </span>
      </button>
      <div id={panelId} hidden={!open} className="chalk-shell-confirm chalk-focus-allowance">
        {allowance.active ? (
          <>
            {secondsLeft === undefined ? null : (
              <div className="chalk-focus-allowance-bar" aria-hidden="true">
                <i style={{ width: `${(secondsLeft / total) * 100}%` }} />
              </div>
            )}
            <p>{FOCUS_COPY.allowanceOn}</p>
            <div className="chalk-shell-confirm-actions">
              <ChalkButton onClick={() => run(allowance.onEnd)}>{FOCUS_COPY.endAllow}</ChalkButton>
            </div>
          </>
        ) : (
          <>
            <p>{FOCUS_COPY.allowOtherTabsHelp}</p>
            <div className="chalk-shell-confirm-actions">
              {DURATIONS.map((minutes) => (
                <ChalkButton key={minutes} onClick={() => run(() => allowance.onAllow(minutes))}>
                  {minutes} min
                </ChalkButton>
              ))}
            </div>
          </>
        )}
        {error ? (
          <p role="alert" className="chalk-shell-detail-error">
            {error}
          </p>
        ) : null}
      </div>
      <style href="chalk-focus-allowance" precedence="default">
        {FOCUS_ALLOWANCE_CSS}
      </style>
    </>
  );
}

const FOCUS_ALLOWANCE_CSS = `.chalk-focus-allowance-value {font-size:var(--type-body-sm);font-variant-numeric:tabular-nums;}
.chalk-focus-allowance-value[data-active] {color:var(--chalk-positive);}
.chalk-focus-allowance p {margin:0 0 var(--space-3);font-size:var(--type-body-sm);color:var(--chalk-soft-text);}
.chalk-focus-allowance .chalk-shell-confirm-actions .chalk-pill-button {flex:1;min-height:44px;}
.chalk-focus-allowance-bar {height:var(--space-1);margin-bottom:var(--space-3);border-radius:var(--chalk-border-radius-full);background:var(--chalk-wash-strong);overflow:hidden;}
.chalk-focus-allowance-bar i {display:block;height:100%;background:var(--chalk-positive);border-radius:inherit;transition:width 1s linear;}
`;
