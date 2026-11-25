import type { ParticipantsSlice } from "@q9labsai/chalk-client";
import { useCan, useSpaceClient } from "../../bindings/hooks";
import type { SpaceHeaderProps } from "../space-header/space-header-contract";

/**
 * Whether the person manages admission, and the header props that follow from what they may manage: how many people wait,
 * and the call-wide controls the call menu offers. Without the capability a control is absent, so the menu looks as it does for a guest.
 */
export function useHostControls({ roster, admissionQueue }: ParticipantsSlice, selfId: string | null | undefined) {
  const client = useSpaceClient();
  const canManageAdmission = useCan("manageAdmission");
  const canMuteOthers = useCan("muteOthers");
  const canManageFocus = useCan("focus.manage");
  const unmuted = roster.filter((person) => person.participantId !== selfId && person.media.microphone === "active");
  const muteEveryone = canMuteOthers && roster.length > 1 ? { unmutedCount: unmuted.length, onMute: () => Promise.all(unmuted.map((person) => client.participants.mute(person.participantId))).then(() => undefined) } : undefined;
  const self = roster.find((person) => person.participantId === selfId);
  const focusAllowance = canManageFocus
    ? {
        active: self?.focus?.allowed === true,
        onAllow: (minutes: number) => client.focus.allowOtherTabs(minutes),
        onEnd: () => client.focus.endAllow(),
      }
    : undefined;
  const hostControls = muteEveryone || focusAllowance ? { ...(muteEveryone ? { muteEveryone } : {}), ...(focusAllowance ? { focusAllowance } : {}) } : undefined;
  const hostHeader: Pick<SpaceHeaderProps, "knockCount" | "hostControls"> = {
    knockCount: canManageAdmission ? admissionQueue.length : 0,
    hostControls,
  };
  return { canManageAdmission, hostHeader };
}
