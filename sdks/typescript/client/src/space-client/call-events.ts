import type { IncomingMediaRequest, Participant, SpaceSnapshot } from "./types";

/** Something that happened in a live call, which a UI may announce. `SpaceClient` emits these as `callEvent`. */
export type CallEvent =
  | { readonly kind: "joined"; readonly participant: Participant }
  | { readonly kind: "left"; readonly participant: Participant }
  | { readonly kind: "handRaised"; readonly participant: Participant }
  | { readonly kind: "shareStopped"; readonly participant: Participant }
  /** `previousHost` is the host who left, when the new host took over from one. */
  | { readonly kind: "hostChanged"; readonly previousHost: Participant | null }
  /** The microphone went off without the person asking. `by` is the one participant who could have muted it, if there is exactly one. */
  | { readonly kind: "mutedByHost"; readonly by: Participant | null }
  | { readonly kind: "mediaRequest"; readonly request: IncomingMediaRequest }
  | { readonly kind: "recordingStarted" }
  | { readonly kind: "recordingStopped" }
  | { readonly kind: "recordingFailed"; readonly failureCode: string | null }
  /** The selected device vanished and the client switched to another one. Labels may be empty. */
  | { readonly kind: "deviceSwitched"; readonly source: "microphone" | "camera"; readonly from: string; readonly to: string };

/**
 * The call events between two snapshots. Only changes inside a live call count, so the roster
 * arriving on join or emptying on leave says nothing, and nothing the local participant did to
 * themselves is reported except through `ownMicrophoneOff`. `ownMicrophoneOff` is true when the
 * person turned their own microphone off, so it is not reported as a host mute.
 */
export function callEvents(previous: SpaceSnapshot, next: SpaceSnapshot, ownMicrophoneOff = false): readonly CallEvent[] {
  if (previous.connection.status !== "live" || next.connection.status !== "live") return [];
  return [...rosterEvents(previous, next), ...mutedByHostEvents(previous, next, ownMicrophoneOff), ...mediaRequestEvents(previous, next), ...recordingEvents(previous, next), ...deviceEvents(previous, next)];
}

function rosterEvents(previous: SpaceSnapshot, next: SpaceSnapshot): CallEvent[] {
  const self = next.self.participantId;
  const before = new Map(previous.participants.roster.map((participant) => [participant.participantId, participant]));
  const after = new Map(next.participants.roster.map((participant) => [participant.participantId, participant]));
  const events: CallEvent[] = [];

  const departed = [...before.values()].filter((participant) => !after.has(participant.participantId) && participant.participantId !== self);
  const becameHost = !previous.self.can("endEpisode") && next.self.can("endEpisode");
  const departedHost = becameHost ? departed.find((participant) => participant.capabilities.includes("endEpisode")) : undefined;
  if (becameHost) events.push({ kind: "hostChanged", previousHost: departedHost ?? null });

  for (const participant of after.values()) {
    if (participant.participantId === self) continue;
    const old = before.get(participant.participantId);
    if (!old) events.push({ kind: "joined", participant });
    else events.push(...changedParticipantEvents(old, participant));
  }
  for (const participant of departed) if (participant !== departedHost) events.push({ kind: "left", participant });
  return events;
}

function changedParticipantEvents(old: Participant, participant: Participant): CallEvent[] {
  const events: CallEvent[] = [];
  if (!old.handRaised && participant.handRaised) events.push({ kind: "handRaised", participant });
  if (old.media.screenShare === "active" && participant.media.screenShare === "inactive") events.push({ kind: "shareStopped", participant });
  return events;
}

function mutedByHostEvents(previous: SpaceSnapshot, next: SpaceSnapshot, ownMicrophoneOff: boolean): CallEvent[] {
  if (previous.media.local.microphone.state !== "enabled" || next.media.local.microphone.state !== "disabled" || ownMicrophoneOff) return [];
  const muters = next.participants.roster.filter((participant) => participant.participantId !== next.self.participantId && participant.capabilities.includes("muteOthers"));
  return [{ kind: "mutedByHost", by: muters.length === 1 ? (muters[0] ?? null) : null }];
}

function mediaRequestEvents(previous: SpaceSnapshot, next: SpaceSnapshot): CallEvent[] {
  const knownRequests = new Set(previous.media.incomingRequests.map((request) => request.requestId));
  return next.media.incomingRequests.filter((request) => !knownRequests.has(request.requestId)).map((request) => ({ kind: "mediaRequest", request }));
}

function recordingEvents(previous: SpaceSnapshot, next: SpaceSnapshot): CallEvent[] {
  const events: CallEvent[] = [];
  const wasRecording = previous.recording.current?.status === "recording";
  const isRecording = next.recording.current?.status === "recording";
  if (!wasRecording && isRecording) events.push({ kind: "recordingStarted" });
  if (wasRecording && !isRecording && next.recording.current?.status !== "failed") events.push({ kind: "recordingStopped" });
  const failure = next.recording.current;
  if (failure?.status === "failed" && (previous.recording.current?.status !== "failed" || previous.recording.current.recordingId !== failure.recordingId)) events.push({ kind: "recordingFailed", failureCode: failure.failureCode });
  return events;
}

function deviceEvents(previous: SpaceSnapshot, next: SpaceSnapshot): CallEvent[] {
  const events: CallEvent[] = [];
  for (const source of ["microphone", "camera"] as const) {
    const wasSelected = previous.media.selection[source];
    if (wasSelected === next.media.selection[source]) continue;
    const devices = source === "camera" ? next.media.devices.cameras : next.media.devices.microphones;
    const oldDevices = source === "camera" ? previous.media.devices.cameras : previous.media.devices.microphones;
    const disconnected = oldDevices.find((device) => device.deviceId === wasSelected);
    if (!disconnected || devices.some((device) => device.deviceId === disconnected.deviceId)) continue;
    const selected = devices.find((device) => device.deviceId === next.media.selection[source]);
    if (selected) events.push({ kind: "deviceSwitched", source, from: disconnected.label, to: selected.label });
  }
  return events;
}
