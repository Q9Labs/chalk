import type { IncomingMediaRequest, Participant, SpaceSnapshot } from "@q9labsai/chalk-client";

/** A call event worth a notice, read from the difference between two snapshots. */
export type Notice =
  | { readonly kind: "joined"; readonly name: string }
  | { readonly kind: "left"; readonly name: string }
  | { readonly kind: "mutedByHost"; readonly by: string | null }
  | { readonly kind: "mediaRequest"; readonly request: IncomingMediaRequest }
  | { readonly kind: "newHost"; readonly previousHost: string }
  | { readonly kind: "shareStopped"; readonly name: string }
  | { readonly kind: "recordingStarted" }
  | { readonly kind: "recordingStopped" };

/**
 * Notices for what changed between `previous` and `next`. Only changes inside a live call count,
 * so the roster arriving on join or emptying on leave says nothing. `ownMicrophoneChange` is true
 * when the person turned their own microphone off since the last snapshot.
 */
export function callNotices(previous: SpaceSnapshot, next: SpaceSnapshot, ownMicrophoneChange: boolean): readonly Notice[] {
  if (previous.connection.status !== "live" || next.connection.status !== "live") return [];
  const self = next.self.participantId;
  const before = new Map(previous.participants.roster.map((participant) => [participant.participantId, participant]));
  const after = new Map(next.participants.roster.map((participant) => [participant.participantId, participant]));
  const notices: Notice[] = [];

  const departed = [...before.values()].filter((participant) => !after.has(participant.participantId) && participant.participantId !== self);
  const becameHost = !previous.self.can("endEpisode") && next.self.can("endEpisode");
  const departedHost = becameHost ? departed.find(isHost) : undefined;
  if (departedHost) notices.push({ kind: "newHost", previousHost: firstName(departedHost.displayName) });

  for (const participant of after.values()) if (!before.has(participant.participantId) && participant.participantId !== self) notices.push({ kind: "joined", name: participant.displayName });
  for (const participant of departed) if (participant !== departedHost) notices.push({ kind: "left", name: participant.displayName });

  for (const participant of after.values()) {
    if (participant.participantId === self) continue;
    if (before.get(participant.participantId)?.media.screenShare === "active" && participant.media.screenShare !== "active") notices.push({ kind: "shareStopped", name: firstName(participant.displayName) });
  }

  if (previous.media.local.microphone.state === "enabled" && next.media.local.microphone.state === "disabled" && !ownMicrophoneChange) {
    const muters = next.participants.roster.filter((participant) => participant.participantId !== self && participant.capabilities.includes("muteOthers"));
    notices.push({ kind: "mutedByHost", by: muters.length === 1 && muters[0] ? firstName(muters[0].displayName) : null });
  }

  const known = new Set(previous.media.incomingRequests.map((request) => request.requestId));
  for (const request of next.media.incomingRequests) if (!known.has(request.requestId)) notices.push({ kind: "mediaRequest", request });

  const wasRecording = previous.recording.current?.status === "recording";
  const isRecording = next.recording.current?.status === "recording";
  if (!wasRecording && isRecording) notices.push({ kind: "recordingStarted" });
  if (wasRecording && !isRecording) notices.push({ kind: "recordingStopped" });

  return notices;
}

function isHost(participant: Participant): boolean {
  return participant.capabilities.includes("endEpisode");
}

/** The mockup names people by their first name in notices that ask something of you. */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}
