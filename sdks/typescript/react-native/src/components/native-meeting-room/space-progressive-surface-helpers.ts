export type AssignableParticipantRole = "host" | "cohost" | "participant";

export type ParticipantActionKind = "mute" | "requestUnmute" | "requestCamera" | "stopCamera" | "stopScreenShare" | "setRole" | "transferOwnership" | "remove";

export interface ParticipantActionAvailability {
  readonly canMuteParticipants: boolean;
  readonly canRequestMedia: boolean;
  readonly canStopParticipantCamera: boolean;
  readonly canStopParticipantScreenShare: boolean;
  readonly canSetParticipantRole: boolean;
  readonly canTransferHost: boolean;
  readonly canRemoveParticipants: boolean;
}

export interface ParticipantActionDescriptor {
  readonly kind: ParticipantActionKind;
  readonly label: string;
  readonly destructive?: boolean;
}

/**
 * Keep the wire role values at the controller boundary while rendering the
 * glossary vocabulary in the UI.
 */
export function displayParticipantRole(role: AssignableParticipantRole): "owner" | "collaborator" | "observer" {
  if (role === "host") return "owner";
  if (role === "cohost") return "collaborator";
  return "observer";
}

export function nextAssignableRole(role: AssignableParticipantRole): AssignableParticipantRole | null {
  if (role === "host") return null;
  return role === "cohost" ? "participant" : "cohost";
}

export function buildParticipantActionDescriptors(role: AssignableParticipantRole, availability: ParticipantActionAvailability): readonly ParticipantActionDescriptor[] {
  const actions: ParticipantActionDescriptor[] = [];
  if (availability.canMuteParticipants) actions.push({ kind: "mute", label: "Mute microphone" });
  if (availability.canRequestMedia) {
    actions.push({ kind: "requestUnmute", label: "Ask to unmute" });
    actions.push({ kind: "requestCamera", label: "Ask to turn on camera" });
  }
  if (availability.canStopParticipantCamera) actions.push({ kind: "stopCamera", label: "Stop camera" });
  if (availability.canStopParticipantScreenShare) actions.push({ kind: "stopScreenShare", label: "Stop sharing" });
  if (availability.canSetParticipantRole) {
    const nextRole = nextAssignableRole(role);
    if (nextRole) actions.push({ kind: "setRole", label: nextRole === "cohost" ? "Make collaborator" : "Make observer" });
  }
  if (availability.canTransferHost && role !== "host") actions.push({ kind: "transferOwnership", label: "Make owner" });
  if (availability.canRemoveParticipants) actions.push({ kind: "remove", label: "Remove Participant", destructive: true });
  return actions;
}

export function formatChatTimestamp(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  return new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
