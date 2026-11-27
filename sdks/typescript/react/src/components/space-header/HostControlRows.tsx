import { useRef, useState } from "react";
import { ChalkButton } from "../chalk-ui";
import { ShellIcon } from "../control-bar/ShellIcon";
import { RowIcon } from "./RowIcon";
import { FOCUS_COPY } from "../focus/focus-copy";
import type { CallHostControls } from "./space-header-contract";

const people = (count: number) => `${count} ${count === 1 ? "person" : "people"}`;

/** The host-only rows, with the hairline above them. A menu without host controls gets nothing. */
export function HostControlRows({ controls }: { readonly controls?: CallHostControls }) {
  const muteEveryone = controls?.muteEveryone;
  const focusAllowance = controls?.focusAllowance;
  const [confirming, setConfirming] = useState(false);
  const [muting, setMuting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const muteRow = useRef<HTMLButtonElement>(null);
  const unmuted = muteEveryone?.unmutedCount ?? 0;
  const confirmOpen = confirming && unmuted > 0;

  const closeConfirm = () => {
    setConfirming(false);
    muteRow.current?.focus();
  };
  const toggleConfirm = () => {
    setError(null);
    setConfirming(!confirming);
  };
  const muteAll = async () => {
    if (!muteEveryone || muting) return;
    setMuting(true);
    setError(null);
    try {
      await muteEveryone.onMute();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn’t mute everyone.");
    } finally {
      setMuting(false);
      closeConfirm();
    }
  };

  if (!muteEveryone && !focusAllowance) return null;

  return (
    <>
      <div className="chalk-shell-sep" />
      {muteEveryone ? (
        <>
          <button ref={muteRow} type="button" className="chalk-shell-detail-action" aria-expanded={confirmOpen} aria-controls="chalk-details-mute" disabled={muting || unmuted === 0} onClick={toggleConfirm}>
            <span className="chalk-shell-detail-lead">
              <RowIcon name="micOff" />
            </span>
            <span className="chalk-shell-detail-label">Mute everyone</span>
            <span className="chalk-shell-detail-trail">
              <ShellIcon name={confirmOpen ? "up2" : "down"} size={16} />
            </span>
          </button>
          <div id="chalk-details-mute" role="group" aria-label="Mute everyone" hidden={!confirmOpen} className="chalk-shell-confirm">
            <b>Mute everyone?</b>
            <p>{people(unmuted)} will be muted. They can unmute themselves.</p>
            <div className="chalk-shell-confirm-actions">
              <ChalkButton
                disabled={muting}
                onClick={() => {
                  setError(null);
                  closeConfirm();
                }}
              >
                Cancel
              </ChalkButton>
              <ChalkButton variant="solid" disabled={muting} onClick={() => void muteAll()}>
                {muting ? "Muting…" : `Mute ${people(unmuted)}`}
              </ChalkButton>
            </div>
          </div>
        </>
      ) : null}
      {focusAllowance ? (
        <>
          <div className="chalk-shell-detail-helper" style={{ paddingTop: "var(--space-1)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: "var(--space-3)", alignItems: "center" }}>
              <span>
                <b style={{ color: "var(--chalk-text)" }}>{FOCUS_COPY.allowOtherTabs}</b>
                <br />
                {FOCUS_COPY.allowOtherTabsHelp}
              </span>
              {focusAllowance.active ? <span className="chalk-shell-detail-value">{FOCUS_COPY.allowanceOn}</span> : null}
            </div>
            <div style={{ display: "flex", gap: "var(--space-1-5)", marginTop: "var(--space-2)", flexWrap: "wrap" }}>
              {[5, 10, 20].map((minutes) => (
                <ChalkButton key={minutes} disabled={focusAllowance.active} onClick={() => void focusAllowance.onAllow(minutes)}>
                  {minutes} min
                </ChalkButton>
              ))}
              {focusAllowance.active ? (
                <ChalkButton variant="solid" onClick={() => void focusAllowance.onEnd()}>
                  {FOCUS_COPY.endAllow}
                </ChalkButton>
              ) : null}
            </div>
          </div>
        </>
      ) : null}
      {error ? (
        <p role="alert" className="chalk-shell-detail-error">
          {error}
        </p>
      ) : null}
    </>
  );
}
