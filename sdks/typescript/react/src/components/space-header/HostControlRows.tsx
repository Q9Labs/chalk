import { useRef, useState } from "react";
import type { AdmissionPolicyTarget } from "@q9labsai/chalk-client";
import { ChalkButton } from "../chalk-ui";
import { MenuIcon } from "../chalk-ui/MenuIcon";
import { ShellIcon } from "../control-bar/ShellIcon";
import { RowIcon } from "./RowIcon";
import type { CallHostControls } from "./space-header-contract";

const WHO_CAN_JOIN = [
  { value: "open", label: "Anyone with the link", helper: "People join right away" },
  { value: "knock", label: "Ask to join", helper: "You let each person in" },
] as const satisfies readonly { readonly value: AdmissionPolicyTarget; readonly label: string; readonly helper: string }[];

const people = (count: number) => `${count} ${count === 1 ? "person" : "people"}`;

/** The host's call-wide controls in the call menu: who can join and mute everyone. Each opens in place under its row. */
/** The host-only rows, with the hairline above them. A menu without host controls gets nothing. */
export function HostControlRows({ controls }: { readonly controls?: CallHostControls }) {
  const { whoCanJoin, muteEveryone } = controls ?? {};
  const [joinOpen, setJoinOpen] = useState(false);
  const [joinPending, setJoinPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [muting, setMuting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const joinRow = useRef<HTMLButtonElement>(null);
  const muteRow = useRef<HTMLButtonElement>(null);
  const current = whoCanJoin ? WHO_CAN_JOIN.find((option) => option.value === whoCanJoin.policy) : undefined;
  const unmuted = muteEveryone?.unmutedCount ?? 0;
  const confirmOpen = confirming && unmuted > 0;

  const closeJoin = () => {
    setJoinOpen(false);
    joinRow.current?.focus();
  };
  const changePolicy = async (policy: AdmissionPolicyTarget) => {
    if (!whoCanJoin || joinPending) return;
    if (policy === whoCanJoin.policy) return closeJoin();
    setJoinPending(true);
    setError(null);
    try {
      await whoCanJoin.onChange(policy);
      closeJoin();
    } catch {
      setError("Couldn’t change who can join. Try again.");
    } finally {
      setJoinPending(false);
    }
  };
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

  if (!whoCanJoin && !muteEveryone) return null;

  return (
    <>
      <div className="chalk-shell-sep" />
      {whoCanJoin && current ? (
        <>
          <button
            ref={joinRow}
            type="button"
            className="chalk-shell-detail-action"
            aria-expanded={joinOpen}
            aria-controls="chalk-details-join"
            disabled={joinPending}
            onClick={() => {
              setError(null);
              setJoinOpen(!joinOpen);
            }}
          >
            <span className="chalk-shell-detail-lead">
              <RowIcon name="join" />
            </span>
            <span className="chalk-shell-detail-label">Who can join</span>
            <span className="chalk-shell-detail-value">
              {current.label}
              <ShellIcon name={joinOpen ? "up2" : "down"} size={16} />
            </span>
          </button>
          <div id="chalk-details-join" role="group" aria-label="Who can join" hidden={!joinOpen} className="chalk-shell-options">
            {WHO_CAN_JOIN.map((option) => (
              <button key={option.value} type="button" aria-pressed={option.value === current.value} disabled={joinPending} className="chalk-shell-option" onClick={() => void changePolicy(option.value)}>
                <span className="chalk-shell-option-text">
                  {option.label}
                  <small>{option.helper}</small>
                </span>
                {option.value === current.value ? <MenuIcon name="check" size={16} /> : null}
              </button>
            ))}
          </div>
        </>
      ) : null}
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
      {error ? (
        <p role="alert" className="chalk-shell-detail-error">
          {error}
        </p>
      ) : null}
    </>
  );
}
