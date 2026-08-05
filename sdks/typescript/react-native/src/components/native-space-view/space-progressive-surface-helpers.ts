export type ParticipantActionKind = "mute" | "requestUnmute" | "requestCamera" | "stopCamera" | "stopScreenShare" | "remove";

export interface ParticipantActionAvailability {
  readonly canMuteParticipants: boolean;
  readonly canRequestMedia: boolean;
  readonly canStopParticipantCamera: boolean;
  readonly canStopParticipantScreenShare: boolean;
  readonly canRemoveParticipants: boolean;
}

export interface ParticipantActionDescriptor {
  readonly kind: ParticipantActionKind;
  readonly label: string;
  readonly destructive?: boolean;
}

export function buildParticipantActionDescriptors(availability: ParticipantActionAvailability): readonly ParticipantActionDescriptor[] {
  const actions: ParticipantActionDescriptor[] = [];
  if (availability.canMuteParticipants) actions.push({ kind: "mute", label: "Mute microphone" });
  if (availability.canRequestMedia) {
    actions.push({ kind: "requestUnmute", label: "Ask to unmute" });
    actions.push({ kind: "requestCamera", label: "Ask to turn on camera" });
  }
  if (availability.canStopParticipantCamera) actions.push({ kind: "stopCamera", label: "Stop camera" });
  if (availability.canStopParticipantScreenShare) actions.push({ kind: "stopScreenShare", label: "Stop sharing" });
  if (availability.canRemoveParticipants) actions.push({ kind: "remove", label: "Remove Participant", destructive: true });
  return actions;
}

export function formatChatTimestamp(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  return new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
