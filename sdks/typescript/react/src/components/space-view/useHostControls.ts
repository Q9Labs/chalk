import type { AdmissionPolicyTarget, ParticipantsSlice } from "@q9labsai/chalk-client";
import { useCan, useSpaceClient } from "../../bindings/hooks";
import type { SpaceHeaderProps } from "../space-header/space-header-contract";

/**
 * Whether the person manages admission, and the header props that follow from what they may manage: how many people wait,
 * and the call-wide controls the call menu offers. Without the capability a control is absent, so the menu looks as it does for a guest.
 */
export function useHostControls({ roster, admissionPolicy, admissionQueue }: ParticipantsSlice, selfId: string | null | undefined, admissionEnabled: boolean) {
  const client = useSpaceClient();
  const canManageAdmission = useCan("manageAdmission");
  const canMuteOthers = useCan("muteOthers");
  const unmuted = roster.filter((person) => person.participantId !== selfId && person.media.microphone === "active");
  const whoCanJoin = canManageAdmission && admissionEnabled && (admissionPolicy === "open" || admissionPolicy === "knock") ? { policy: admissionPolicy, onChange: (next: AdmissionPolicyTarget) => client.participants.setAdmissionPolicy(next) } : undefined;
  const muteEveryone = canMuteOthers && roster.length > 1 ? { unmutedCount: unmuted.length, onMute: () => Promise.all(unmuted.map((person) => client.participants.mute(person.participantId))).then(() => undefined) } : undefined;
  const hostHeader: Pick<SpaceHeaderProps, "knockCount" | "hostControls"> = {
    knockCount: canManageAdmission ? admissionQueue.length : 0,
    hostControls: whoCanJoin || muteEveryone ? { whoCanJoin, muteEveryone } : undefined,
  };
  return { canManageAdmission, hostHeader };
}
