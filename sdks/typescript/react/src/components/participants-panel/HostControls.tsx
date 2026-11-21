import { useState } from "react";
import type { AdmissionPolicyTarget } from "@q9labsai/chalk-client";
import { ChalkButton, ChalkMenu, ChalkMenuItem, ChalkPopover, ChalkPopoverPrimitive as Popover } from "../chalk-ui";

const WHO_CAN_JOIN = [
  { value: "open", label: "Anyone with the link", helper: "People join right away" },
  { value: "knock", label: "Ask to join", helper: "You let each person in" },
] as const satisfies readonly { readonly value: AdmissionPolicyTarget; readonly label: string; readonly helper: string }[];

interface HostControlsProps {
  readonly canChooseWhoCanJoin: boolean;
  /** The call's current "Who can join" value. A host can change it only while it is one of the two the call offers. */
  readonly admissionPolicy?: AdmissionPolicyTarget;
  readonly onAdmissionPolicyChange?: (policy: AdmissionPolicyTarget) => Promise<void>;
  readonly onMuteEveryone?: () => Promise<void>;
  readonly participantCount: number;
  readonly unmutedCount: number;
  readonly onError: (message: string | null) => void;
}

/** The host's two controls above the people list: who can join and mute everyone. */
export function HostControls({ canChooseWhoCanJoin, admissionPolicy, onAdmissionPolicyChange, onMuteEveryone, participantCount, unmutedCount, onError }: HostControlsProps) {
  const [muting, setMuting] = useState(false);
  const [policyPending, setPolicyPending] = useState(false);
  const whoCanJoin = canChooseWhoCanJoin && onAdmissionPolicyChange && admissionPolicy ? WHO_CAN_JOIN.find((option) => option.value === admissionPolicy) : undefined;
  const canMuteEveryone = Boolean(onMuteEveryone) && participantCount > 1;
  if (!whoCanJoin && !canMuteEveryone) return null;

  const changePolicy = async (policy: AdmissionPolicyTarget) => {
    if (!onAdmissionPolicyChange || policyPending || policy === admissionPolicy) return;
    setPolicyPending(true);
    onError(null);
    try {
      await onAdmissionPolicyChange(policy);
    } catch {
      onError("Couldn’t change who can join. Try again.");
    } finally {
      setPolicyPending(false);
    }
  };
  const muteEveryone = async () => {
    if (!onMuteEveryone || muting) return;
    setMuting(true);
    onError(null);
    try {
      await onMuteEveryone();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "Couldn’t mute everyone.");
    } finally {
      setMuting(false);
    }
  };

  return (
    <div className="call-host-controls">
      {whoCanJoin ? (
        <ChalkMenu
          trigger={
            <ChalkButton aria-label={`Who can join: ${whoCanJoin.label}`} disabled={policyPending}>
              {whoCanJoin.label}
            </ChalkButton>
          }
        >
          {WHO_CAN_JOIN.map((option) => (
            <ChalkMenuItem key={option.value} checked={option.value === whoCanJoin.value} onClick={() => void changePolicy(option.value)}>
              <span className="call-who-option">
                {option.label}
                <small>{option.helper}</small>
              </span>
            </ChalkMenuItem>
          ))}
        </ChalkMenu>
      ) : null}
      {canMuteEveryone ? (
        <ChalkPopover label="Mute everyone" trigger={<ChalkButton disabled={muting || unmutedCount === 0}>Mute everyone</ChalkButton>}>
          <div className="call-mute-confirm">
            <b>Mute everyone?</b>
            <p>
              {unmutedCount} {unmutedCount === 1 ? "person" : "people"} will be muted. They can unmute themselves.
            </p>
            <div className="call-mute-actions">
              <Popover.Close render={<ChalkButton disabled={muting} />}>Cancel</Popover.Close>
              <Popover.Close render={<ChalkButton variant="solid" disabled={muting} onClick={() => void muteEveryone()} />}>{muting ? "Muting…" : `Mute ${unmutedCount} ${unmutedCount === 1 ? "person" : "people"}`}</Popover.Close>
            </div>
          </div>
        </ChalkPopover>
      ) : null}
    </div>
  );
}
